import { initBundles, syncBundles, bundledRecord, bundleStatus } from './bundles.js';
import {
  asAttendanceError,
  configuredWorkerUrl,
  fetchAttendance,
  loadSession,
  loadSnapshot,
  loginAttendance,
  logoutAttendance,
  saveSession,
  saveSnapshot,
  clearSession,
  summarizeAttendance,
} from "./attendance.js";
import {
  addDays,
  formatDots,
  formatStamp,
  isValidIso,
  mondayOf,
  monthNames,
  moscowInstant,
  moscowIso,
  semesterRange,
  splitIso,
  visibleWeekDays,
  weekdayName,
} from "./dates.js";
import { apiBase } from "./config.js";
import { APP_CHANGES, APP_DATE, APP_VERSION, isNewer, normalizeVersionInfo, reloadAllowed } from "./version.js";
import { fetchText } from "./net.js";
import {
  lessonMatchesSubgroup,
  lessonSubgroup,
  subjectMatchesSubgroup,
  subjectSubgroup,
  subgroupBadgeLabel,
} from "./parse.js";
import {
  dismissInstallTip,
  loadGroup,
  loadInstallDismissed,
  loadNotify,
  loadRecent,
  loadRecord,
  loadSubgroup,
  mergeRecords,
  pruneGroupHistory,
  readCachedRecord,
  rememberRecent,
  saveGroup,
  saveNotify,
  saveRecord,
  saveSubgroup,
} from "./store.js";
import {
  loadCurrentTeacher,
  loadFavorites,
  loadTeacherList,
  loadTeacherRecent,
  loadTeacherRecord,
  mergeTeacherDays,
  normalizeTeacherList,
  rememberTeacher,
  saveCurrentTeacher,
  saveTeacherList,
  saveTeacherRecord,
  searchTeachers,
  toggleFavorite,
} from "./teachers.js";
import { PAIRS, buildingLabel, buildingOf, loadRoomsCache, pairAt, pairById, saveRoomsCache, sortBuildings, splitRooms } from "./rooms.js";
import { canvasBlob, drawShareImage, shareFileName } from "./share.js";
import {
  LEAD_OPTIONS,
  QUIET_OPTIONS,
  currentSubscription,
  lastPushReceived,
  loadPushSettings,
  permissionState,
  pushSupport,
  savePushSettings,
  serverStatus,
  subscribePush,
  testPush,
  unsubscribePush,
} from "./push.js";
import { attachGestures, haptic } from "./gestures.js";

// Прокси (functions/schedule.js, functions/groups.js) ходит к kis.vgltu.ru.
// На pages.dev — тот же домен, с зеркала GitHub Pages — https://rasp-is2-241.pages.dev.
const API_BASE = apiBase();
const LIVE_SCHEDULE = `${API_BASE}schedule`;
const LIVE_GROUPS = `${API_BASE}groups`;
const LIVE_TEACHERS = `${API_BASE}teachers`;
const LIVE_ROOMS = `${API_BASE}rooms`;
const ROOMS_BUILDING_KEY = "rasp.roomsBuilding";
const ROOMS_LIST_KEY = "rasp.roomsBuildings";
const TEACHERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TEACHER_FRESH_MS = 45 * 60 * 1000;
const LIVE_WINDOWS = 1;
const LIVE_TIMEOUT_MS = 12000;
const GROUPS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_GROUP = "ИС2-241-ОБ";

const app = document.getElementById("app");

const state = {
  group: "",
  groups: [],
  record: null,
  mode: "today",
  follow: "today",
  anchor: null,
  query: DEFAULT_GROUP,
  pickerOpen: false,
  pickerCanClose: false,
  dateError: "",
  subgroup: "all",
  loading: false,
  liveIssue: "",
  swReady: false,
  installEvent: null,
  notifyNote: "",
  seenToday: "",
  lastRefresh: 0,
  update: {
    // Новая версия с сайта: { version, date, changes }.
    available: null,
    // Новый service worker скачан и ждёт кнопку «Обновить».
    waiting: false,
    // Новый worker уже управляет страницей (другая вкладка или старая версия обновилась сама).
    activated: false,
    applying: false,
    checking: false,
    dismissed: 0,
    note: "",
    // «Обновлено до версии N» — один раз после обновления.
    justUpdated: false,
  },
  teacher: {
    list: [],
    listAt: "",
    listLoading: false,
    listIssue: "",
    name: "",
    record: null,
    loading: false,
    issue: "",
    query: "",
    picking: false,
    week: "",
  },
  rooms: {
    buildings: null,
    building: "",
    date: "",
    pair: 1,
    loading: false,
    done: 0,
    total: 0,
    entries: [],
    fetchedAt: "",
    issue: "",
    open: "",
  },
  push: {
    settings: null,
    permission: "default",
    subscribed: false,
    server: null,
    received: null,
    busy: false,
    note: "",
    checkedAt: 0,
  },
  actions: null,
  scrollKey: "",
  share: {
    date: "",
    open: false,
    source: "group",
    range: "today",
    url: "",
    file: null,
    note: "",
    busy: false,
  },
  attendance: {
    error: "",
    loading: false,
    scope: "semester",
    from: "",
    to: "",
    snapshot: null,
    session: null,
  },
};

let refreshToken = 0;
let notifyTimer = 0;

const LOOKALIKE = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function fold(value) {
  return String(value)
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/[a-z]/g, (char) => LOOKALIKE[char] || char);
}

function resolveGroup(query) {
  const trimmed = query.trim();
  if (!trimmed) return "";
  const folded = fold(trimmed);
  const exact = state.groups.find((group) => fold(group) === folded);
  return exact || trimmed;
}

function filterGroups(query) {
  const needle = fold(query);
  const source = state.groups.length ? state.groups : [DEFAULT_GROUP];
  if (!needle) {
    const near = source.filter((group) => fold(group).includes("ис2-24"));
    return [DEFAULT_GROUP, ...near.filter((group) => group !== DEFAULT_GROUP)].slice(0, 12);
  }
  return source
    .filter((group) => fold(group).includes(needle))
    .sort((a, b) => Number(!fold(a).startsWith(needle)) - Number(!fold(b).startsWith(needle)) || a.localeCompare(b, "ru"))
    .slice(0, 20);
}

function activeIso() {
  const today = moscowIso();
  if (state.follow === "today") return today;
  if (state.follow === "tomorrow") return addDays(today, 1);
  return state.anchor || today;
}

function dayByDate(iso) {
  return state.record?.days?.find((day) => day.date === iso) || null;
}

function standalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function phaseOf(iso, lesson) {
  if (iso !== moscowIso()) return "";
  const now = Date.now();
  const start = moscowInstant(iso, lesson.start).getTime();
  const end = moscowInstant(iso, lesson.end).getTime();
  if (now >= start && now < end) return "now";
  if (now >= end) return "past";
  return "";
}

function findNextLesson(record, now = new Date(), subgroup = state.subgroup) {
  if (!record?.days) return null;
  const today = moscowIso(now);
  const candidates = [];
  for (const iso of [today, addDays(today, 1)]) {
    const day = record.days.find((item) => item.date === iso);
    if (!day) continue;
    for (const lesson of day.lessons) {
      if (!lessonMatchesSubgroup(lesson, subgroup)) continue;
      const start = moscowInstant(iso, lesson.start);
      if (start.getTime() > now.getTime()) candidates.push({ iso, lesson, start });
    }
  }
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0] || null;
}

// Запасной вариант: напоминание, пока приложение открыто. Тег совпадает с серверным,
// поэтому если пришло и то и другое — на телефоне останется одно уведомление.
function planNotification(record) {
  clearTimeout(notifyTimer);
  const push = loadPushSettings();
  if (!(push.enabled || loadNotify()) || !("Notification" in window) || Notification.permission !== "granted" || !record) return;
  const leadMs = (push.enabled ? push.lead : 10) * 60 * 1000;
  const next = findNextLesson(record, new Date(), push.enabled && push.subgroup ? push.subgroup : state.subgroup);
  if (!next) return;
  const key = `${next.iso}|${next.lesson.time}|${next.lesson.subject}|${next.lesson.subgroup || ""}`;
  if (sessionStorage.getItem("rasp.notified") === key) return;
  const show = () => {
    sessionStorage.setItem("rasp.notified", key);
    const room = next.lesson.room ? ` · ${next.lesson.room}` : "";
    const badge = subgroupBadgeLabel(lessonSubgroup(next.lesson));
    const subgroup = badge ? ` · ${badge}` : "";
    const title = `Через ${Math.round(leadMs / 60000)} мин: ${next.lesson.subject}`;
    const options = {
      body: `${next.lesson.time}${subgroup}${room}`,
      lang: "ru",
      tag: `pair-${next.iso}-${next.lesson.start}`,
      renotify: false,
      icon: "./icons/icon-192.png",
      data: { url: `./?date=${next.iso}`, date: next.iso },
    };
    // На Android new Notification() запрещён — только через service worker.
    if (swRegistration?.showNotification) swRegistration.showNotification(title, options).catch(() => {});
    else {
      try {
        new Notification(title, options);
      } catch {
        /* iOS и встроенные браузеры могут молча отказать. */
      }
    }
  };
  const delay = next.start.getTime() - leadMs - Date.now();
  if (delay <= 0 && next.start.getTime() > Date.now()) show();
  else if (delay > 0 && delay < 24 * 60 * 60 * 1000) notifyTimer = setTimeout(show, delay);
}

function groupsFromStorage() {
  try {
    const cached = JSON.parse(localStorage.getItem("rasp.groups") || "null");
    if (Array.isArray(cached) && cached.length) return cached.map(String);
  } catch {
    /* Повреждённый кэш игнорируем. */
  }
  return [DEFAULT_GROUP, "ИС2-242-ОБ", "ИС2-243-ОБ", "ИС2-244-ОБ"];
}

function groupsStamp() {
  const value = Date.parse(localStorage.getItem("rasp.groupsAt") || "");
  return Number.isNaN(value) ? 0 : value;
}

function rememberGroups(groups, fetchedAt) {
  state.groups = groups;
  try {
    localStorage.setItem("rasp.groups", JSON.stringify(groups));
    const stamp = Date.parse(fetchedAt || "");
    localStorage.setItem("rasp.groupsAt", new Date(Number.isNaN(stamp) ? Date.now() : stamp).toISOString());
  } catch {
    /* Память телефона может быть заполнена. */
  }
  const list = document.getElementById("suggest");
  if (list && state.pickerOpen) list.innerHTML = suggestHtml(state.query);
}

async function loadGroupList(url, ms) {
  const response = await fetchText(url, {}, ms);
  if (!response.ok) return null;
  const data = JSON.parse(response.text);
  const groups = Array.isArray(data) ? data : data.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  return { groups: groups.map(String), fetchedAt: Array.isArray(data) ? "" : data.fetchedAt };
}

async function refreshGroups() {
  const stamp = groupsStamp();
  try {
    const bundled = await loadGroupList("./data/groups.json");
    const bundledAt = Date.parse(bundled?.fetchedAt || "");
    if (bundled && (!stamp || state.groups.length < 10 || bundledAt > stamp)) rememberGroups(bundled.groups, bundled.fetchedAt);
  } catch {
    /* Список в памяти телефона остаётся. */
  }
  if (!navigator.onLine || Date.now() - groupsStamp() < GROUPS_MAX_AGE_MS) return;
  try {
    const live = await loadGroupList(LIVE_GROUPS, LIVE_TIMEOUT_MS);
    if (live) rememberGroups(live.groups, live.fetchedAt);
  } catch {
    /* Нет связи или ВГЛТУ не ответил — список в памяти телефона остаётся. */
  }
}

class LiveError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

// Окно с понедельника недели: текущая и ещё три недели вперёд одним запросом.
async function fetchLive(group, iso) {
  const url = `${LIVE_SCHEDULE}?date=${mondayOf(iso)}&group=${encodeURIComponent(group)}&windows=${LIVE_WINDOWS}`;
  let response;
  try {
    response = await fetchText(url, {}, LIVE_TIMEOUT_MS);
  } catch {
    throw new LiveError("offline");
  }
  let data = null;
  try {
    data = JSON.parse(response.text);
  } catch {
    data = null;
  }
  // Не JSON (ответ service worker «нет копии», обрыв) — до сервера не достучались.
  if (!data || typeof data !== "object") throw new LiveError("offline");
  if (!response.ok || !Array.isArray(data.days) || !data.days.length) throw new LiveError("upstream");
  const fallback = response.headers?.get?.("X-Rasp-Fallback") || "";
  return {
    issue: fallback === "offline" || fallback === "upstream" ? fallback : data.stale ? "upstream" : "",
    record: {
      group,
      fetchedAt: data.fetchedAt || new Date().toISOString(),
      source: data.source || "https://kis.vgltu.ru/schedule",
      origin: "live",
      days: data.days,
    },
  };
}

async function fetchSnapshot(group) {
  try {
    const response = await fetchText(`./data/schedules/${encodeURIComponent(group)}.json`);
    if (!response.ok) return null;
    const data = JSON.parse(response.text);
    data.group = data.group || group;
    data.origin = data.origin || "snapshot";
    return data;
  } catch {
    return null;
  }
}

async function refresh(iso, force) {
  if (!state.group) return;
  const online = navigator.onLine;
  if (!online && state.record?.days?.length) return;
  if (online && !force && Date.now() - state.lastRefresh < 10 * 60 * 1000 && dayByDate(iso)) return;
  const token = ++refreshToken;
  const group = state.group;
  if (online) state.lastRefresh = Date.now();
  state.loading = true;
  render();
  const snapPromise = state.record?.days?.length ? Promise.resolve(null) : fetchSnapshot(group);
  const livePromise = online
    ? fetchLive(group, iso).catch((error) => ({ issue: error?.kind || "offline", record: null }))
    : Promise.resolve({ issue: "offline", record: null });
  const snap = await snapPromise;
  if (token !== refreshToken) return;
  if (snap) {
    state.record = await saveRecord(group, mergeRecords(state.record, snap));
    render();
  }
  const live = await livePromise;
  if (token !== refreshToken) return;
  if (live.record) {
    const saved = await saveRecord(group, mergeRecords(state.record, live.record));
    const start = mondayOf(moscowIso());
    // Calendar browsing outside the offline range remains available online,
    // but these dates never expand persistent group storage.
    state.record = iso < start || iso > addDays(start, 13) ? live.record : saved;
  }
  state.liveIssue = live.issue || "";
  state.loading = false;
  render();
  planNotification(state.record);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Two shared files, independent of how many groups have been opened on this device.
async function prefetchRecent() {
  await syncBundles(() => {
    const start = mondayOf(moscowIso());
    if (state.group && activeIso() >= start && activeIso() <= addDays(start, 13)) {
      state.record = mergeRecords(state.record, bundledRecord(state.group));
    }
    render();
  });
}

function offlineNow() {
  return !navigator.onLine || state.liveIssue === "offline";
}

function statusText() {
  if (!dayByDate(activeIso())) return "Для выбранной даты нет сохранённых свежих данных. Подключитесь к интернету.";
  if (bundleStatus) return `${navigator.onLine ? "" : "Нет сети. "}${bundleStatus} Копия группы: ${formatStamp(state.record.fetchedAt)}.`;
  if (state.loading) return "Обновляем расписание…";
  if (!state.record?.fetchedAt) {
    if (offlineNow()) {
      return "Для этой группы ещё нет сохранённой копии. Подключитесь к интернету и дождитесь сохранения всех групп.";
    }
    if (state.liveIssue === "upstream") return "Сайт ВГЛТУ не ответил, а сохранённой копии для этой группы ещё нет. Попробуйте «Обновить» чуть позже.";
    return "Расписание ещё не загружено.";
  }
  const stamp = formatStamp(state.record.fetchedAt);
  if (offlineNow()) return `Нет связи с сервером — показано сохранённое расписание от ${stamp}.`;
  if (state.liveIssue === "upstream") return `Сайт ВГЛТУ не ответил, показана копия от ${stamp}.`;
  if (state.record.origin === "live") return `Обновлено с сайта ВГЛТУ ${stamp}.`;
  return `Копия от ${stamp}.`;
}

function dateHero(iso) {
  const today = moscowIso();
  const dots = formatDots(iso);
  const todayDots = formatDots(today);
  const week = state.mode === "week";
  const days = week ? visibleWeekDays(iso, today) : [];
  let kicker = `<p class="kicker">${week ? "Неделя" : "Сегодня"}</p>`;
  let back = "";
  const weekIsCurrent = week && days[0] === today;
  if (!weekIsCurrent && iso !== today) {
    const kind = week ? "Неделя" : iso === addDays(today, 1) ? "Завтра" : "Выбранная дата";
    kicker = `<p class="kicker warn">${kind} · сегодня ${esc(todayDots)}</p>`;
    back = `<button type="button" class="text-btn" data-action="go-today">К сегодня</button>`;
  }
  let title = `<h1 class="hero-date"><button type="button" class="date-tap" data-action="pick-date" aria-label="Выбрать дату">${esc(dots)}<span class="date-tap-icon" aria-hidden="true">▾</span></button></h1>`;
  let sub = `<p class="weekday">${esc(weekdayName(iso))}</p>`;
  if (week && days.length > 1) {
    title = `<h1 class="hero-date hero-range"><button type="button" class="date-tap" data-action="pick-date" aria-label="Выбрать дату">${esc(formatDots(days[0]))} – ${esc(formatDots(days[days.length - 1]))}<span class="date-tap-icon" aria-hidden="true">▾</span></button></h1>`;
    sub = `<p class="weekday">${esc(weekdayName(days[0]))} – ${esc(weekdayName(days[days.length - 1]))}</p>`;
  } else if (week && days.length === 1) {
    title = `<h1 class="hero-date">${esc(formatDots(days[0]))}</h1>`;
    sub = `<p class="weekday">${esc(weekdayName(days[0]))}</p>`;
  } else if (week) {
    title = `<h1 class="hero-date hero-range">Неделя прошла</h1>`;
    sub = `<p class="weekday">Дни до сегодняшнего по Москве не показываем</p>`;
  }
  const quick = `<input class="quick-date" id="quick-date" type="date" value="${esc(iso)}" min="2020-01-01" max="2036-12-31" tabindex="-1" aria-hidden="true" data-quick-date />`;
  return `<div class="hero">${kicker}${title}${quick}${sub}<div class="hero-actions">${back}<button type="button" class="text-btn share-link" data-action="share-open" data-source="group">Поделиться картинкой</button></div></div>`;
}

// «Фамилия И.О.» — ссылка на расписание преподавателя; «Вакансия…» и прочее — просто текст.
function looksLikeTeacher(name) {
  return /^[А-ЯЁ][А-Яа-яЁё'-]+(?:\s[А-ЯЁ][а-яё'-]+)?\s[А-ЯЁ]\.\s?(?:[А-ЯЁ]\.)?$/.test(String(name || "").trim());
}

function lessonCard(iso, lesson, next = "", ring = false) {
  const phase = phaseOf(iso, lesson);
  const typeClass = lesson.type || "none";
  const badge = state.subgroup === "all" ? subgroupBadgeLabel(lessonSubgroup(lesson)) : "";
  const chips = [
    lesson.type ? `<span class="chip ${esc(lesson.type)}">${esc(lesson.type)}</span>` : "",
    badge ? `<span class="chip subgroup">${esc(badge)}</span>` : "",
    phase === "now" ? `<span class="chip now">сейчас</span>` : "",
  ].join("");
  const bits = [];
  if (lesson.teacher && !looksLikeTeacher(lesson.teacher)) bits.push(`<span>${esc(lesson.teacher)}</span>`);
  else if (lesson.teacher) {
    bits.push(`<button type="button" class="link-btn" data-action="open-teacher" data-teacher="${esc(lesson.teacher)}" title="Расписание преподавателя">${esc(lesson.teacher)}</button>`);
  }
  if (lesson.room) {
    if (bits.length) bits.push(`<span class="dot">·</span>`);
    bits.push(`<a href="https://kis.vgltu.ru/map/rasp?auditory=${encodeURIComponent(lesson.room)}" target="_blank" rel="noopener">${esc(lesson.room)}</a>`);
  }
  const index = dayByDate(iso)?.lessons.indexOf(lesson) ?? -1;
  return `<article class="card ${esc(typeClass)} ${phase}${ring ? " next" : ""}" data-press="group" data-iso="${esc(iso)}" data-idx="${index}">
    <div class="card-top">
      <p class="time">${esc(lesson.start)}<span class="time-sep">–</span>${esc(lesson.end)}</p>
      <div class="chips">${chips}${next ? `<span class="chip next-chip">${esc(next)}</span>` : ""}</div>
    </div>
    <h2 class="subject">${esc(lesson.subject)}</h2>
    ${bits.length ? `<p class="meta-line">${bits.join("")}</p>` : ""}
    ${phase === "now" ? `<div class="card-progress" style="--p:${progressOf(iso, lesson)}%"></div>` : ""}
  </article>`;
}

function progressOf(iso, lesson) {
  const start = moscowInstant(iso, lesson.start).getTime();
  const end = moscowInstant(iso, lesson.end).getTime();
  return Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)));
}

function minutesUntil(iso, lesson) {
  return Math.round((moscowInstant(iso, lesson.start).getTime() - Date.now()) / 60000);
}

function nextLabel(minutes) {
  if (minutes <= 0) return "";
  if (minutes < 60) return `через ${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `через ${h} ч ${m} мин` : `через ${h} ч`;
}

function nowHHMM() {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function dayBody(iso) {
  const day = dayByDate(iso);
  if (!day) {
    if (state.loading) {
      return `<div class="card skeleton"></div><div class="card skeleton"></div><div class="card skeleton"></div>`;
    }
    const hint = offlineNow()
      ? "Нет связи с сервером. Откройте эту дату, когда будет интернет, — потом она будет доступна офлайн."
      : state.liveIssue === "upstream"
        ? "Сайт ВГЛТУ не ответил. Нажмите «Обновить» чуть позже."
        : "Нажмите «Обновить», чтобы загрузить расписание.";
    return `<div class="empty"><p class="empty-title">Нет расписания на ${esc(formatDots(iso))}</p><p>${esc(hint)}</p></div>`;
  }
  if (!day.lessons.length) return `<div class="empty"><p class="empty-title">Нет пар</p><p>В этот день занятий нет.</p></div>`;
  const lessons = day.lessons.filter((lesson) => lessonMatchesSubgroup(lesson, state.subgroup));
  if (!lessons.length) {
    const label = state.subgroup === "1" || state.subgroup === "2" ? `${state.subgroup} пг` : "этой подгруппы";
    return `<div class="empty"><p class="empty-title">Нет пар для ${esc(label)}</p><p>В этот день есть только занятия другой подгруппы.</p></div>`;
  }
  if (iso !== moscowIso()) return lessons.map((lesson) => lessonCard(iso, lesson)).join("");
  // Сегодня: «сейчас» — полоса прогресса на текущей паре, иначе линия «сейчас» перед следующей.
  const hasNow = lessons.some((lesson) => phaseOf(iso, lesson) === "now");
  const nextIndex = lessons.findIndex((lesson) => phaseOf(iso, lesson) === "" && minutesUntil(iso, lesson) > 0);
  const nowLine = `<div class="now-line" aria-label="Сейчас ${esc(nowHHMM())}"><span>сейчас ${esc(nowHHMM())}</span></div>`;
  let out = "";
  lessons.forEach((lesson, index) => {
    if (!hasNow && index === nextIndex && index > 0) out += nowLine;
    out += lessonCard(iso, lesson, index === nextIndex ? nextLabel(minutesUntil(iso, lesson)) : "", !hasNow && index === nextIndex);
  });
  if (!hasNow && nextIndex === -1 && lessons.length) out += `<div class="now-line done"><span>пары на сегодня закончились</span></div>`;
  return out;
}

function dateControls(iso) {
  const parts = splitIso(iso);
  const months = monthNames()
    .map((name, index) => `<option value="${index + 1}" ${index + 1 === parts.month ? "selected" : ""}>${esc(name)}</option>`)
    .join("");
  const monthLabel = monthNames()[parts.month - 1] || "";
  return `<form class="date-card" data-date-form>
    <div class="date-card-head">
      <button class="shift" type="button" data-action="shift-day" data-delta="-1" aria-label="Предыдущий день">‹</button>
      <div><p>Другая дата</p><strong>${esc(formatDots(iso))}</strong></div>
      <button class="shift" type="button" data-action="shift-day" data-delta="1" aria-label="Следующий день">›</button>
    </div>
    <div class="date-grid">
      <label class="field">День<input id="day" name="day" inputmode="numeric" min="1" max="31" value="${parts.day}" required /></label>
      <label class="field">Год<input id="year" name="year" inputmode="numeric" min="2020" max="2036" value="${parts.year}" required /></label>
      <label class="field field-month">Месяц<select id="month" name="month" title="${esc(monthLabel)}">${months}</select></label>
    </div>
    ${state.dateError ? `<p class="date-error">${esc(state.dateError)}</p>` : ""}
    <button class="primary" type="submit">Показать эту дату</button>
  </form>`;
}

function scheduleView() {
  const iso = activeIso();
  const week = state.mode === "week";
  let body = "";
  if (week) {
    const days = visibleWeekDays(iso, moscowIso());
    if (!days.length) {
      body = `<div class="week"><div class="empty"><p class="empty-title">Нет дней впереди</p><p>До сегодняшнего по Москве эта неделя уже прошла.</p></div></div>`;
    } else {
      body = `<div class="week">${days
        .map((dayIso) => {
          const todayMark = dayIso === moscowIso() ? ` <span class="chip">сегодня</span>` : "";
          return `<section>
        <h2><button type="button" class="day-jump" data-action="open-day" data-date="${esc(dayIso)}">${esc(weekdayName(dayIso))}, ${esc(formatDots(dayIso))}</button>${todayMark}</h2>
        ${dayBody(dayIso)}
      </section>`;
        })
        .join("")}</div>`;
    }
  } else {
    body = `<div class="lessons">${dayBody(iso)}</div>`;
  }
  return `${scheduleSwitch()}${subgroupSwitch()}${dateHero(iso)}
  ${body}
  <section class="panel">
    ${dateControls(iso)}
    <div class="status-row">
      <p class="status" role="status">${esc(statusText())}</p>
      <button class="text-btn" type="button" data-action="refresh">Обновить</button>
    </div>
  </section>
  ${installTip()}`;
}

function installTip() {
  if (standalone() || loadInstallDismissed()) return "";
  const action = state.installEvent ? `<button class="primary" type="button" data-action="install">Установить</button>` : "";
  return `<aside class="tip">
    <p><strong>На экран.</strong> Android: меню Chrome → «Установить». iPhone: Safari → «Поделиться» → «На экран Домой».</p>
    ${action}
    <button class="ghost" type="button" data-action="dismiss-tip">Скрыть</button>
  </aside>`;
}

function attendanceRange() {
  const today = moscowIso();
  if (state.attendance.scope === "dates" && isValidIso(state.attendance.from) && isValidIso(state.attendance.to)) {
    return { scope: "dates", label: "Выбранные даты", from: state.attendance.from, to: state.attendance.to };
  }
  return { scope: "semester", ...semesterRange(today) };
}

function attendanceDateIso(value) {
  const text = String(value || "").trim();
  if (isValidIso(text)) return text;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (!match) return "";
  const iso = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return isValidIso(iso) ? iso : "";
}

function lessonsOn(dateLabel) {
  const iso = attendanceDateIso(dateLabel);
  if (!iso) return [];
  return dayByDate(iso)?.lessons || [];
}

function visibleAttendanceDays(days) {
  return (days || [])
    .map((day) => ({
      ...day,
      subjects: (day.subjects || []).filter((subject) => subjectMatchesSubgroup(subject, state.subgroup, lessonsOn(day.date))),
    }))
    .filter((day) => state.subgroup === "all" || day.subjects.length);
}

function attendanceDaysHtml(snapshot) {
  const source = snapshot?.days || [];
  const days = visibleAttendanceDays(source);
  if (!days.length) {
    const filtered = state.subgroup !== "all" && source.some((day) => (day.subjects || []).length);
    const title = filtered ? `Нет занятий для ${state.subgroup} пг` : "Нет отметок";
    const text = filtered ? "В журнале за этот период остались только занятия другой подгруппы." : "За этот период кабинет ничего не вернул.";
    return `<div class="empty"><p class="empty-title">${esc(title)}</p><p>${esc(text)}</p></div>`;
  }
  return days
    .map((day) => {
      const rows = (day.subjects || [])
        .map((subject) => {
          const mark = subject.mark === "absent" ? "Нет" : subject.mark === "present" ? "Был" : "—";
          const markClass = subject.mark === "absent" ? "abs" : subject.mark === "present" ? "ok" : "";
          const badge = state.subgroup === "all" ? subgroupBadgeLabel(subjectSubgroup(subject, lessonsOn(day.date))) : "";
          return `<article class="att-card ${subject.mark === "absent" ? "abs" : ""}">
            <div class="att-top"><h3>${esc(subject.name || "Занятие")}</h3><span class="mark ${markClass}">${mark}</span></div>
            ${subject.type || badge ? `<p class="meta-line">${subject.type ? `<span>${esc(subject.type)}</span>` : ""}${subject.type && badge ? `<span class="dot">·</span>` : ""}${badge ? `<span class="chip subgroup">${esc(badge)}</span>` : ""}</p>` : ""}
          </article>`;
        })
        .join("");
      const label = isValidIso(day.date) ? formatDots(day.date) : day.date;
      return `<section class="att-day"><h3>${esc(label)}</h3>${rows || `<p class="status">Нет занятий</p>`}</section>`;
    })
    .join("");
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
  return `${text}%`;
}

function studentHeading(name) {
  if (!name) return "";
  return `<p class="student-name"><span class="student-label">Студент</span>${esc(name)}</p>`;
}

function summaryCard(snapshot) {
  const days = visibleAttendanceDays(snapshot.days);
  const stats = summarizeAttendance(days);
  const range = `${formatDotsSafe(snapshot.from)} – ${formatDotsSafe(snapshot.to)}`;
  const who = studentHeading(snapshot.name || state.attendance.session?.name);
  const subgroupNote = state.subgroup === "all" ? "" : ` Учитываются общие занятия и ${state.subgroup} пг.`;
  const formula = stats.unmarked
    ? `По занятиям: (всего − пропуски) / всего. Строка журнала — одно занятие, часы кабинет не присылает. «Н» — отсутствие. ${stats.unmarked} без отметки входят в «всего» и не считаются пропуском.${subgroupNote}`
    : `По занятиям: (всего − пропуски) / всего. Строка журнала — одно занятие, часы кабинет не присылает. «Н» — отсутствие.${subgroupNote}`;
  if (!stats.total) {
    const filteredOut = state.subgroup !== "all" && (snapshot.days || []).some((day) => (day.subjects || []).length);
    return `<article class="summary">
      ${who}
      <p class="summary-kicker">${esc(snapshot.label || "Журнал")} · ${esc(range)}</p>
      <p class="summary-empty">${filteredOut ? `Нет занятий для ${esc(state.subgroup)} пг` : "В журнале нет занятий"}</p>
      <p class="formula">${esc(formula)}</p>
    </article>`;
  }
  return `<article class="summary">
    ${who}
    <p class="summary-kicker">${esc(snapshot.label || "Журнал")} · ${esc(range)}</p>
    <p class="summary-percent">${esc(formatPercent(stats.percent))}</p>
    <p class="summary-caption">посещаемость</p>
    <div class="summary-grid">
      <div><strong>${stats.absent}</strong><span>пропусков «Н»</span></div>
      <div><strong>${stats.attended} из ${stats.total}</strong><span>без пропуска</span></div>
    </div>
    <p class="formula">${esc(formula)}</p>
  </article>`;
}

function attendanceBlock() {
  const session = state.attendance.session;
  const snapshot = state.attendance.snapshot;
  const range = attendanceRange();
  const copy = snapshot?.fetchedAt
    ? `<p class="status">Копия от ${esc(formatStamp(snapshot.fetchedAt))}${snapshot.login ? ` · ID ${esc(snapshot.login)}` : ""}.${navigator.onLine ? "" : " Нет сети."}</p>`
    : "";
  const summary = snapshot ? summaryCard(snapshot) : "";
  const list = snapshot
    ? `<h2 class="list-title">Занятия</h2><div class="att-list">${attendanceDaysHtml(snapshot)}</div>${copy}`
    : "";
  const journal = `${summary}${state.attendance.loading ? `<div class="card skeleton"></div>` : ""}${list}`;
  if (!session) {
    return `<article class="block">
      <h2>Посещаемость</h2>
      <p>Журнал как в личном кабинете: за семестр или за выбранные даты. Войдите с ID студента и паролем кабинета ВГЛТУ.</p>
      <form data-attendance-form>
        <label class="field">ID студента
          <input name="login" autocomplete="username" inputmode="text" required />
        </label>
        <label class="field">Пароль
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        ${state.attendance.error ? `<p class="date-error">${esc(state.attendance.error)}</p>` : ""}
        <button class="primary" type="submit" ${state.attendance.loading ? "disabled" : ""}>${state.attendance.loading ? "Входим…" : "Войти"}</button>
      </form>
      <p><a href="https://vgltu.ru/lc/attendance" target="_blank" rel="noopener">Открыть посещаемость на vgltu.ru</a></p>
    </article>
    ${journal}`;
  }
  const dates = state.attendance.scope === "dates"
    ? `<label class="field">С даты<input id="att-from" type="date" value="${esc(state.attendance.from)}" /></label>
       <label class="field">По дату<input id="att-to" type="date" value="${esc(state.attendance.to)}" /></label>
       <button class="ghost" type="button" data-action="att-apply">Показать даты</button>`
    : "";
  return `<article class="block">
    <h2>Посещаемость</h2>
    ${studentHeading(session.name || snapshot?.name)}
    ${state.attendance.error ? `<p class="date-error">${esc(state.attendance.error)}</p>` : ""}
  </article>
  ${state.attendance.loading && !snapshot ? `<div class="card skeleton"></div><div class="card skeleton"></div>` : summary}
  <article class="block">
    <div class="seg">
      <button type="button" data-action="att-scope" data-scope="semester" aria-pressed="${state.attendance.scope === "semester" ? "true" : "false"}">Семестр</button>
      <button type="button" data-action="att-scope" data-scope="dates" aria-pressed="${state.attendance.scope === "dates" ? "true" : "false"}">Даты</button>
    </div>
    ${dates}
    <p class="status">${esc(range.label)} · ${esc(formatDots(range.from))} – ${esc(formatDots(range.to))}</p>
    <button class="primary" type="button" data-action="att-refresh">Обновить</button>
    <button class="ghost" type="button" data-action="att-logout">Выйти</button>
    <p><a href="https://vgltu.ru/lc/attendance" target="_blank" rel="noopener">Открыть на vgltu.ru</a></p>
  </article>
  ${list}`;
}

function formatDotsSafe(iso) {
  return isValidIso(iso) ? formatDots(iso) : String(iso || "");
}

function attendanceView() {
  return `<section class="more att-screen">${attendanceBlock()}</section>`;
}

function scheduleSwitch() {
  const items = [
    ["today", "Сегодня"],
    ["tomorrow", "Завтра"],
    ["week", "Неделя"],
  ];
  return `<div class="seg schedule-seg">${items
    .map(([mode, label]) => `<button type="button" data-action="mode" data-mode="${mode}" aria-pressed="${state.mode === mode ? "true" : "false"}">${label}</button>`)
    .join("")}</div>`;
}

function subgroupSwitch() {
  const items = [
    ["all", "Все"],
    ["1", "1 пг"],
    ["2", "2 пг"],
  ];
  return `<div class="subgroup-wrap">
    <p class="subgroup-kicker">Подгруппа</p>
    <div class="seg subgroup-seg" role="group" aria-label="Подгруппа">${items
      .map(([value, label]) => `<button type="button" data-action="subgroup" data-subgroup="${value}" aria-pressed="${state.subgroup === value ? "true" : "false"}">${label}</button>`)
      .join("")}</div>
  </div>`;
}

function moreView() {
  return `<section class="more">
    <h1>Ещё</h1>
    ${themeBlock()}
    <article class="block tool-block">
      <h2>Свободные аудитории</h2>
      <p>Какие аудитории корпуса свободны на нужной паре — по официальному расписанию ВГЛТУ.</p>
      <button class="primary" type="button" data-action="mode" data-mode="rooms">Найти свободную аудиторию</button>
    </article>
    ${versionBlock()}
    ${notifyBlock()}
    <article class="block">
      <h2>На экран телефона</h2>
      <ol>
        <li>Android, Chrome: меню ⋮ → «Установить приложение» или «Добавить на главный экран».</li>
        <li>iPhone, только Safari: «Поделиться» → «На экран Домой» → «Добавить».</li>
      </ol>
      ${state.installEvent ? `<button class="primary" type="button" data-action="install">Установить</button>` : ""}
      <p>${state.swReady ? "Офлайн-копия приложения сохранена." : "После первой загрузки с сетью расписание откроется и без интернета."}</p>
    </article>
    <article class="block">
      <h2>Откуда пары</h2>
      <p>Дата «сегодня» всегда считается по часам телефона в поясе Europe/Moscow: день, месяц и год. Чужой день из формы на сайте ВГЛТУ не подставляется.</p>
      <p>Группу можно сменить. Сейчас: ${esc(state.group || "не выбрана")}.</p>
      <p><a href="https://vgltu.ru/obuchayushchimsya/raspisanie-zanyatij/interaktivnoe-raspisanie/" target="_blank" rel="noopener">Официальное интерактивное расписание</a></p>
    </article>
  </section>`;
}

function activeTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function themeBlock() {
  return `<article class="block"><h2>Оформление</h2>
    <p>Тема сохраняется на этом устройстве и работает без сети.</p>
    <div class="seg theme-options" role="group" aria-label="Оформление">${[['light', 'Светлая'], ['dark', 'Тёмная'], ['forest', 'Лес']].map(([value, label]) =>
      `<button type="button" data-action="theme" data-theme="${value}" aria-pressed="${activeTheme() === value}">${label}</button>`).join('')}</div>
  </article>`;
}

function changeTheme(value) {
  if (!['light', 'dark', 'forest'].includes(value)) return;
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('rasp.theme', value); } catch { /* Current session still applies. */ }
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.removeAttribute('media');
    meta.content = { light: '#f4f0e8', dark: '#141816', forest: '#162d23' }[value];
  }
  render();
}

function suggestHtml(query) {
  const items = filterGroups(query);
  if (!items.length) return `<li><p class="status">В списке нет такой группы. Можно сохранить введённый код кнопкой ниже.</p></li>`;
  return items
    .map((group) => `<li><button type="button" data-action="pick-group" data-group="${esc(group)}">${esc(group)}</button></li>`)
    .join("");
}

function pickerHtml() {
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="picker-title">
    <div class="sheet-card">
      <div class="grabber"></div>
      <h2 id="picker-title">Группа</h2>
      <p class="lead">Любой код ВГЛТУ. Например, ${esc(DEFAULT_GROUP)}.</p>
      <form data-group-form>
        <label class="field">Код группы
          <input class="search" id="group-query" name="group" value="${esc(state.query)}" autocomplete="off" autocapitalize="characters" enterkeyhint="search" />
        </label>
        <ul class="suggest" id="suggest">${suggestHtml(state.query)}</ul>
        <button class="primary" type="submit">Показать расписание</button>
        ${state.pickerCanClose ? `<button class="ghost" type="button" data-action="close-picker">Отмена</button>` : ""}
      </form>
    </div>
  </div>`;
}

function navIcon(name) {
  const common = `viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const paths = {
    today: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none"/>`,
    tomorrow: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M10 15h4"/>`,
    week: `<path d="M5 7h14M5 12h14M5 17h9"/>`,
    schedule: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none"/>`,
    attendance: `<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 12.2l2.2 2.2L16 9"/>`,
    teachers: `<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.8-3.6 3.3-5.6 6.5-5.6s5.7 2 6.5 5.6"/>`,
    more: `<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/>`,
  };
  return `<svg ${common}>${paths[name]}</svg>`;
}

function navSection() {
  if (state.mode === "more") return "more";
  if (state.mode === "attendance") return "attendance";
  if (state.mode === "teachers") return "teachers";
  if (state.mode === "rooms") return "more";
  return "schedule";
}

function nav() {
  const current = navSection();
  const items = [
    ["schedule", "Расписание"],
    ["attendance", "Посещаемость"],
    ["teachers", "Преподаватели"],
    ["more", "Ещё"],
  ];
  return `<nav class="nav">${items
    .map(([mode, label]) => `<button type="button" data-action="mode" data-mode="${mode}" ${current === mode ? 'aria-current="page"' : ""}>${navIcon(mode)}${label}</button>`)
    .join("")}</nav>`;
}

function changesHtml(changes) {
  if (!changes?.length) return "";
  return `<ul class="update-changes">${changes.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function updateBanner() {
  const update = state.update;
  if (update.justUpdated) {
    return `<div class="update-banner" role="status">
      <p class="update-title">Обновлено до версии ${APP_VERSION}</p>
      <p class="update-date">от ${esc(formatDots(APP_DATE))}</p>
      ${changesHtml(APP_CHANGES)}
      <div class="update-actions"><button type="button" class="primary" data-action="seen-update">Понятно</button></div>
    </div>`;
  }
  const info = update.available;
  const pending = update.activated || update.waiting || isNewer(info);
  if (!pending) return "";
  if (!update.applying && update.dismissed && update.dismissed >= (info?.version || 0)) return "";
  const title = info?.version ? `Доступно обновление — версия ${info.version}` : "Доступно обновление";
  return `<div class="update-banner" role="alert">
    <p class="update-title">${esc(title)}</p>
    ${info?.date ? `<p class="update-date">от ${esc(formatDots(info.date))}</p>` : ""}
    ${changesHtml(info?.changes)}
    ${update.note ? `<p class="update-note">${esc(update.note)}</p>` : ""}
    <div class="update-actions">
      <button type="button" class="primary" data-action="apply-update" ${update.applying ? "disabled" : ""}>${update.applying ? "Обновляем…" : "Обновить"}</button>
      ${update.applying ? "" : `<button type="button" class="ghost" data-action="later-update">Позже</button>`}
    </div>
  </div>`;
}

function versionBlock() {
  const update = state.update;
  const newer = isNewer(update.available);
  const note = update.checking
    ? "Проверяем…"
    : update.note || (newer ? `Доступно обновление — версия ${update.available.version}.` : "");
  return `<article class="block">
      <h2>Приложение</h2>
      <p>Версия ${APP_VERSION} от ${esc(formatDots(APP_DATE))}.</p>
      <button class="ghost" type="button" data-action="check-update" ${update.checking ? "disabled" : ""}>Проверить обновления</button>
      <button class="ghost" type="button" data-action="repair-app" ${update.repairing ? "disabled" : ""}>${update.repairing ? "Скачиваем файлы…" : "Восстановить файлы приложения"}</button>
      <p class="status">Повторно скачает файлы приложения. Расписания, посещаемость и настройки сохранятся.</p>
      ${newer ? `<button class="primary" type="button" data-action="apply-update">Обновить до версии ${update.available.version}</button>` : ""}
      ${note ? `<p class="status" role="status">${esc(note)}</p>` : ""}
    </article>`;
}

// ===== Преподаватели =====

function teacherListStamp() {
  const value = Date.parse(state.teacher.listAt || "");
  return Number.isNaN(value) ? 0 : value;
}

async function ensureTeacherList(force = false) {
  const t = state.teacher;
  if (!t.list.length) {
    const saved = loadTeacherList();
    if (saved?.teachers?.length) {
      t.list = saved.teachers;
      t.listAt = saved.fetchedAt;
    } else {
      // Копия из репозитория — список есть сразу и без сети.
      try {
        const response = await fetchText("./data/teachers.json", {}, 8000);
        const data = JSON.parse(response.text);
        const names = normalizeTeacherList(data);
        if (names.length) {
          t.list = names;
          t.listAt = String(data.fetchedAt || "");
          if (state.mode === "teachers") refreshTeacherSuggest();
        }
      } catch {
        /* нет копии — ниже попробуем сеть */
      }
    }
  }
  if (!navigator.onLine) return;
  if (!force && t.list.length && Date.now() - teacherListStamp() < TEACHERS_MAX_AGE_MS) return;
  if (t.listLoading) return;
  t.listLoading = true;
  try {
    const response = await fetchText(LIVE_TEACHERS, {}, 20000);
    const data = JSON.parse(response.text);
    const names = normalizeTeacherList(data);
    if (!response.ok || names.length < 50) throw new Error("bad list");
    t.list = names;
    t.listAt = String(data.fetchedAt || new Date().toISOString());
    t.listIssue = "";
    saveTeacherList(names, t.listAt);
  } catch {
    t.listIssue = t.list.length ? "" : "Не удалось загрузить список преподавателей с сайта ВГЛТУ. Попробуйте позже.";
  } finally {
    t.listLoading = false;
  }
  if (state.mode === "teachers") refreshTeacherSuggest();
}

function teacherWeekDays(monday) {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function teacherDay(iso) {
  return state.teacher.record?.days?.find((day) => day.date === iso) || null;
}

function teacherWeekLoaded(monday) {
  return teacherWeekDays(monday).slice(0, 6).every((iso) => teacherDay(iso));
}

async function loadTeacherWeek(monday, force = false) {
  const t = state.teacher;
  const name = t.name;
  if (!name) return;
  const fresh = Date.now() - (Date.parse(t.record?.fetchedAt || "") || 0) < TEACHER_FRESH_MS;
  if (!force && teacherWeekLoaded(monday) && fresh) return;
  if (!navigator.onLine) {
    t.issue = "offline";
    if (state.mode === "teachers") render();
    return;
  }
  t.loading = true;
  t.issue = "";
  if (state.mode === "teachers") render();
  const url = `${LIVE_SCHEDULE}?date=${monday}&teacher=${encodeURIComponent(name)}&windows=1`;
  let issue = "";
  try {
    const response = await fetchText(url, {}, 25000);
    let data = null;
    try {
      data = JSON.parse(response.text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") issue = "offline";
    else if (!response.ok || !Array.isArray(data.days) || !data.days.length) issue = "upstream";
    else {
      if (t.name !== name) return;
      const fallback = response.headers?.get?.("X-Rasp-Fallback") || "";
      if (fallback === "offline" || fallback === "upstream") issue = fallback;
      else if (data.stale) issue = "upstream";
      const record = {
        teacher: name,
        fetchedAt: data.fetchedAt || new Date().toISOString(),
        source: data.source || "https://kis.vgltu.ru/schedule",
        days: mergeTeacherDays(t.record, data.days, addDays(mondayOf(moscowIso()), -35)),
      };
      t.record = record;
      saveTeacherRecord(name, record);
    }
  } catch {
    issue = "offline";
  }
  if (t.name !== name) return;
  t.loading = false;
  t.issue = issue;
  if (state.mode === "teachers") render();
}

function openTeacher(name) {
  const t = state.teacher;
  const clean = String(name || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  t.name = clean;
  t.picking = false;
  t.query = "";
  t.issue = "";
  t.record = loadTeacherRecord(clean);
  t.week = mondayOf(moscowIso());
  saveCurrentTeacher(clean);
  rememberTeacher(clean);
  state.mode = "teachers";
  render();
  window.scrollTo?.(0, 0);
  loadTeacherWeek(t.week);
  ensureTeacherList();
}

function teacherButton(name, favorites) {
  const star = favorites.includes(name) ? `<span class="star" aria-label="в избранном">★</span>` : "";
  return `<li><button type="button" data-action="pick-teacher" data-teacher="${esc(name)}">${esc(name)}${star}</button></li>`;
}

function teacherSuggestHtml() {
  const t = state.teacher;
  const favorites = loadFavorites();
  if (t.query.trim()) {
    const found = searchTeachers(t.list, t.query);
    if (!t.list.length) {
      return `<li><p class="status">${esc(t.listIssue || "Загружаем список преподавателей…")}</p></li>`;
    }
    if (!found.length) return `<li><p class="status">Не нашли «${esc(t.query.trim())}». Проверьте фамилию — достаточно первых букв.</p></li>`;
    return found.map((name) => teacherButton(name, favorites)).join("");
  }
  const recent = loadTeacherRecent().filter((name) => !favorites.includes(name));
  const parts = [];
  if (favorites.length) parts.push(`<li class="suggest-head">Избранные</li>${favorites.map((name) => teacherButton(name, favorites)).join("")}`);
  if (recent.length) parts.push(`<li class="suggest-head">Недавние</li>${recent.map((name) => teacherButton(name, favorites)).join("")}`);
  if (!parts.length) {
    const count = t.list.length ? `В списке ${t.list.length} преподавателей.` : esc(t.listIssue || "Загружаем список преподавателей…");
    parts.push(`<li><p class="status">Начните вводить фамилию, например «Гон». ${count}</p></li>`);
  }
  return parts.join("");
}

function refreshTeacherSuggest() {
  const list = document.getElementById("teacher-suggest");
  if (list) list.innerHTML = teacherSuggestHtml();
}

function teacherPickerHtml() {
  const t = state.teacher;
  return `<section class="more teacher-screen">
    <h1>Преподаватели</h1>
    <form class="block teacher-search" data-teacher-form>
      <label class="field">Фамилия преподавателя
        <input class="search" id="teacher-query" name="teacher" value="${esc(t.query)}" placeholder="Например, Гонца" autocomplete="off" enterkeyhint="search" />
      </label>
      <ul class="suggest" id="teacher-suggest">${teacherSuggestHtml()}</ul>
      ${t.name ? `<button class="ghost" type="button" data-action="teacher-cancel">Назад к ${esc(t.name)}</button>` : ""}
    </form>
    <p class="status teacher-source">Расписание преподавателей с сайта ВГЛТУ (kis.vgltu.ru), как и у групп.</p>
  </section>`;
}

function teacherLessonCard(iso, lesson) {
  const phase = phaseOf(iso, lesson);
  const badge = subgroupBadgeLabel(lessonSubgroup(lesson));
  const chips = [
    lesson.type ? `<span class="chip ${esc(lesson.type)}">${esc(lesson.type)}</span>` : "",
    badge ? `<span class="chip subgroup">${esc(badge)}</span>` : "",
    phase === "now" ? `<span class="chip now">сейчас</span>` : "",
  ].join("");
  const bits = [];
  const groups = (lesson.groups || []).filter(Boolean);
  if (groups.length) bits.push(`<span>${esc(groups.join(", "))}</span>`);
  if (lesson.room) {
    if (bits.length) bits.push(`<span class="dot">·</span>`);
    bits.push(`<a href="https://kis.vgltu.ru/map/rasp?auditory=${encodeURIComponent(lesson.room)}" target="_blank" rel="noopener">${esc(lesson.room)}</a>`);
  }
  const index = teacherDay(iso)?.lessons.indexOf(lesson) ?? -1;
  return `<article class="card ${esc(lesson.type || "none")} ${phase}" data-press="teacher" data-iso="${esc(iso)}" data-idx="${index}">
    <div class="card-top">
      <p class="time">${esc(lesson.start)}<span class="time-sep">–</span>${esc(lesson.end)}</p>
      <div class="chips">${chips}</div>
    </div>
    <h2 class="subject">${esc(lesson.subject)}</h2>
    ${bits.length ? `<p class="meta-line">${bits.join("")}</p>` : ""}
    ${phase === "now" ? `<div class="card-progress" style="--p:${progressOf(iso, lesson)}%"></div>` : ""}
  </article>`;
}

function teacherStatus() {
  const t = state.teacher;
  if (t.loading) return "Загружаем расписание преподавателя…";
  const stamp = t.record?.fetchedAt ? formatStamp(t.record.fetchedAt) : "";
  if (t.issue === "offline") return stamp ? `Нет связи с сервером — показана копия от ${stamp}.` : "Нет связи с сервером, а сохранённой копии ещё нет. Откройте, когда будет интернет.";
  if (t.issue === "upstream") return stamp ? `Сайт ВГЛТУ не ответил — показана копия от ${stamp}.` : "Сайт ВГЛТУ не ответил. Нажмите «Обновить» чуть позже.";
  return stamp ? `Обновлено с сайта ВГЛТУ ${stamp}.` : "Расписание ещё не загружено.";
}

function teacherWeekHtml() {
  const t = state.teacher;
  const today = moscowIso();
  const days = teacherWeekDays(t.week).filter((iso, index) => index < 6 || teacherDay(iso)?.lessons?.length);
  return days
    .map((iso) => {
      const day = teacherDay(iso);
      const mark = iso === today ? ` <span class="chip">сегодня</span>` : "";
      let body;
      if (!day) {
        body = t.loading
          ? `<div class="card skeleton"></div>`
          : `<div class="empty"><p class="empty-title">Нет данных</p><p>${t.issue ? "Нет связи — откройте этот день, когда будет интернет." : "Нажмите «Обновить»."}</p></div>`;
      } else if (!day.lessons.length) body = `<div class="empty"><p class="empty-title">Нет пар</p></div>`;
      else body = day.lessons.map((lesson) => teacherLessonCard(iso, lesson)).join("");
      return `<section class="${iso < today ? "past-day" : ""}"><h2>${esc(weekdayName(iso))}, ${esc(formatDots(iso))}${mark}</h2>${body}</section>`;
    })
    .join("");
}

function teacherView() {
  const t = state.teacher;
  if (!t.name || t.picking) return teacherPickerHtml();
  const favorite = loadFavorites().includes(t.name);
  const monday = t.week;
  const sunday = addDays(monday, 6);
  const current = monday === mondayOf(moscowIso());
  return `<div class="hero teacher-hero">
      <p class="kicker">Преподаватель</p>
      <h1 class="hero-date hero-range teacher-name">${esc(t.name)}</h1>
      <div class="teacher-actions">
        <button type="button" class="text-btn" data-action="teacher-fav" aria-pressed="${favorite ? "true" : "false"}">${favorite ? "★ В избранном" : "☆ В избранное"}</button>
        <button type="button" class="text-btn" data-action="teacher-change">Сменить</button>
        <button type="button" class="text-btn share-link icon-only" data-action="share-open" data-source="teacher" aria-label="Поделиться картинкой" title="Поделиться картинкой"></button>
      </div>
    </div>
    <div class="date-card teacher-week-nav">
      <div class="date-card-head">
        <button class="shift" type="button" data-action="teacher-week" data-delta="-7" aria-label="Предыдущая неделя">‹</button>
        <div><p>${current ? "Эта неделя" : "Неделя"}</p><strong>${esc(formatDots(monday))} – ${esc(formatDots(sunday))}</strong></div>
        <button class="shift" type="button" data-action="teacher-week" data-delta="7" aria-label="Следующая неделя">›</button>
      </div>
      ${current ? "" : `<button type="button" class="text-btn" data-action="teacher-week" data-delta="0">К текущей неделе</button>`}
    </div>
    <div class="week teacher-week">${teacherWeekHtml()}</div>
    <section class="panel">
      <div class="status-row">
        <p class="status" role="status">${esc(teacherStatus())}</p>
        <button class="text-btn" type="button" data-action="teacher-refresh">Обновить</button>
      </div>
    </section>`;
}

// ===== Свободные аудитории =====

function roomsDefaults() {
  const r = state.rooms;
  if (r.date) return;
  const hhmm = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  let date = moscowIso();
  let pair = pairAt(hhmm);
  if (!pair) {
    date = addDays(date, 1);
    pair = 1;
  }
  if (weekdayName(date) === "воскресенье") {
    date = addDays(date, 1);
    pair = 1;
  }
  r.date = date;
  r.pair = pair;
  r.building = r.building || localStorage.getItem(ROOMS_BUILDING_KEY) || "Гл";
}

async function loadBuildings() {
  const r = state.rooms;
  if (!r.buildings) {
    try {
      r.buildings = JSON.parse(localStorage.getItem(ROOMS_LIST_KEY) || "null");
    } catch {
      r.buildings = null;
    }
  }
  if (r.buildings && Object.keys(r.buildings).length) return;
  try {
    const response = await fetchText(LIVE_ROOMS, {}, 30000);
    const data = JSON.parse(response.text);
    if (response.ok && data?.buildings) {
      r.buildings = data.buildings;
      localStorage.setItem(ROOMS_LIST_KEY, JSON.stringify(data.buildings));
    } else r.issue = data?.message || "Сайт ВГЛТУ не отдал список аудиторий.";
  } catch {
    r.issue = "Нет связи с сервером — список аудиторий не загрузился.";
  }
}

let roomsToken = 0;

async function loadRooms(force = false) {
  const r = state.rooms;
  const token = ++roomsToken;
  const { building, date } = r;
  const cached = loadRoomsCache(building, date);
  r.entries = cached?.rooms || [];
  r.fetchedAt = cached?.fetchedAt || "";
  r.total = cached?.total || r.entries.length;
  r.done = r.entries.length;
  r.issue = "";
  r.open = "";
  const fresh = cached && cached.complete && Date.now() - (Date.parse(cached.savedAt || "") || 0) < 60 * 60 * 1000;
  if ((fresh && !force) || !navigator.onLine) {
    if (!navigator.onLine) r.issue = cached ? "offline" : "Нет сети, а сохранённой копии для этого дня и корпуса нет.";
    if (state.mode === "rooms") render();
    return;
  }
  r.loading = true;
  if (state.mode === "rooms") render();
  const collected = [];
  let parts = 1;
  let total = 0;
  let fetchedAt = "";
  let failedParts = 0;
  for (let part = 0; part < parts; part += 1) {
    const url = `${LIVE_ROOMS}?building=${encodeURIComponent(building)}&date=${date}&part=${part}`;
    try {
      const response = await fetchText(url, {}, 75000);
      const data = JSON.parse(response.text);
      if (!response.ok || !data?.ok) throw new Error(data?.message || "bad");
      parts = data.parts;
      total = data.total;
      fetchedAt = fetchedAt && fetchedAt < data.fetchedAt ? fetchedAt : data.fetchedAt;
      collected.push(...data.rooms);
    } catch {
      failedParts += 1;
      if (part === 0) break;
    }
    if (token !== roomsToken) return;
    r.entries = collected.length ? [...collected] : r.entries;
    r.done = collected.length;
    r.total = total || r.total;
    if (state.mode === "rooms") render();
  }
  if (token !== roomsToken) return;
  r.loading = false;
  if (!collected.length) {
    r.issue = cached ? "upstream" : "Сайт ВГЛТУ не отдал расписание аудиторий. Попробуйте чуть позже.";
  } else {
    r.fetchedAt = fetchedAt;
    if (failedParts) r.issue = "partial";
    saveRoomsCache(building, date, { rooms: collected, total, fetchedAt, savedAt: new Date().toISOString(), complete: !failedParts });
  }
  if (state.mode === "rooms") render();
}

function openRooms() {
  roomsDefaults();
  state.mode = "rooms";
  render();
  window.scrollTo?.(0, 0);
  loadBuildings().then(() => {
    const keys = Object.keys(state.rooms.buildings || {});
    if (keys.length && !keys.includes(state.rooms.building)) state.rooms.building = sortBuildings(keys)[0];
    render();
    loadRooms();
  });
}

function roomsStatus() {
  const r = state.rooms;
  if (r.loading) return `Проверяем аудитории: ${r.done} из ${r.total || "…"}. Первый раз за день это может занять до минуты.`;
  const stamp = r.fetchedAt ? formatStamp(r.fetchedAt) : "";
  if (r.issue === "offline") return `Нет сети — показана копия от ${stamp}.`;
  if (r.issue === "upstream") return `Сайт ВГЛТУ не ответил — показана копия от ${stamp}.`;
  if (r.issue === "partial") return `Часть аудиторий не загрузилась. Данные расписания от ${stamp}.`;
  if (r.issue) return r.issue;
  return stamp ? `Расписание аудиторий от ${stamp}.` : "";
}

function roomRow(item, kind) {
  let hint = "";
  if (kind === "free") hint = item.until ? `свободна до ${item.until}` : "свободна до конца дня";
  else if (kind === "busy") {
    const lesson = item.busy;
    const who = [(lesson.groups || []).join(", "), lesson.teacher].filter(Boolean).join(" · ");
    hint = `занята до ${item.until}: ${lesson.type ? `${lesson.type}. ` : ""}${lesson.subject}${who ? ` (${who})` : ""}`;
  } else hint = "нет данных";
  return `<li><button type="button" class="room-row ${kind}" data-action="room-open" data-room="${esc(item.room)}">
    <span class="room-name">${esc(item.room)}</span><span class="room-hint">${esc(hint)}</span></button></li>`;
}

function roomsView() {
  const r = state.rooms;
  roomsDefaults();
  const keys = sortBuildings(Object.keys(r.buildings || {}));
  const pair = pairById(r.pair);
  const { free, busy, unknown } = splitRooms(r.entries, pair[1], pair[2]);
  const buildings = keys.length
    ? `<div class="chip-scroll">${keys
        .map((key) => `<button type="button" data-action="rooms-building" data-building="${esc(key)}" aria-pressed="${key === r.building ? "true" : "false"}">${esc(buildingLabel(key))}<small>${r.buildings[key].length}</small></button>`)
        .join("")}</div>`
    : `<p class="status">${esc(r.issue || "Загружаем список корпусов…")}</p>`;
  const pairs = `<div class="chip-scroll pairs">${PAIRS.map(([id, start]) => `<button type="button" data-action="rooms-pair" data-pair="${id}" aria-pressed="${id === r.pair ? "true" : "false"}">${id} пара<small>${start}</small></button>`).join("")}</div>`;
  const today = moscowIso();
  const dayKind = r.date === today ? "Сегодня" : r.date === addDays(today, 1) ? "Завтра" : weekdayName(r.date);
  let lists = "";
  if (r.entries.length) {
    lists = `<h2 class="rooms-head">Свободны · ${free.length}</h2>
      ${free.length ? `<ul class="room-list">${free.map((item) => roomRow(item, "free")).join("")}</ul>` : `<div class="empty"><p>На этой паре все проверенные аудитории заняты.</p></div>`}
      ${busy.length ? `<details class="room-busy"><summary>Заняты · ${busy.length}</summary><ul class="room-list">${busy.map((item) => roomRow(item, "busy")).join("")}</ul></details>` : ""}
      ${unknown.length ? `<details class="room-busy"><summary>Нет данных · ${unknown.length}</summary><ul class="room-list">${unknown.map((item) => roomRow(item, "unknown")).join("")}</ul></details>` : ""}`;
  } else if (r.loading) lists = `<div class="card skeleton"></div><div class="card skeleton"></div>`;
  return `<section class="more rooms-screen">
    <h1>Свободные аудитории</h1>
    <p class="rooms-note">По официальному расписанию ВГЛТУ (kis.vgltu.ru). Аудитория может быть закрыта или занята мероприятием вне расписания.</p>
    ${buildings}
    <div class="date-card rooms-date">
      <div class="date-card-head">
        <button class="shift" type="button" data-action="rooms-day" data-delta="-1" aria-label="Предыдущий день">‹</button>
        <div><p>${esc(dayKind)}</p><strong>${esc(formatDots(r.date))}</strong></div>
        <button class="shift" type="button" data-action="rooms-day" data-delta="1" aria-label="Следующий день">›</button>
      </div>
    </div>
    ${pairs}
    <p class="rooms-pair-time">${pair[0]} пара: ${pair[1]}–${pair[2]} · ${esc(buildingLabel(r.building))}</p>
    ${r.loading ? `<div class="progress inline" aria-hidden="true"></div>` : ""}
    ${lists}
    <div class="status-row">
      <p class="status" role="status">${esc(roomsStatus())}</p>
      <button class="text-btn" type="button" data-action="rooms-refresh">Обновить</button>
    </div>
  </section>`;
}

function roomSheetHtml() {
  const r = state.rooms;
  const entry = r.entries.find((item) => item.room === r.open);
  const lessons = entry?.ok ? [...entry.lessons].sort((a, b) => a.start.localeCompare(b.start)) : null;
  const body = !lessons
    ? `<p class="status">Для этой аудитории нет данных — сайт ВГЛТУ её не отдал.</p>`
    : !lessons.length
      ? `<div class="empty"><p class="empty-title">Нет пар</p><p>По расписанию аудитория свободна весь день.</p></div>`
      : lessons
          .map((lesson) => {
            const meta = [(lesson.groups || []).join(", "), lesson.teacher].filter(Boolean).join(" · ");
            return `<article class="card ${esc(lesson.type || "none")}">
              <div class="card-top"><p class="time">${esc(lesson.start)}<span class="time-sep">–</span>${esc(lesson.end)}</p>
              <div class="chips">${lesson.type ? `<span class="chip ${esc(lesson.type)}">${esc(lesson.type)}</span>` : ""}</div></div>
              <h2 class="subject">${esc(lesson.subject)}</h2>${meta ? `<p class="meta-line">${esc(meta)}</p>` : ""}</article>`;
          })
          .join("");
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="room-title">
    <div class="sheet-card">
      <div class="grabber"></div>
      <h2 id="room-title">${esc(r.open)}</h2>
      <p class="lead">${esc(weekdayName(r.date))}, ${esc(formatDots(r.date))} · ${esc(buildingLabel(r.building))}</p>
      <div class="room-day">${body}</div>
      <p class="rooms-note">По официальному расписанию; мероприятия вне расписания здесь не видны.</p>
      <a class="ghost link-ghost" href="https://kis.vgltu.ru/map/rasp?auditory=${encodeURIComponent(r.open)}" target="_blank" rel="noopener">Аудитория на карте ВГЛТУ</a>
      <button class="primary" type="button" data-action="room-close">Закрыть</button>
    </div>
  </div>`;
}

// ===== Картинка «Поделиться» =====

function shareDays(range, source) {
  const today = moscowIso();
  if (range === "date" && state.share.date) return [state.share.date];
  if (range === "today") return [today];
  if (range === "tomorrow") return [addDays(today, 1)];
  let monday = source === "teacher" ? state.teacher.week || mondayOf(today) : mondayOf(today);
  if (source !== "teacher" && weekdayName(today) === "воскресенье") monday = addDays(monday, 7);
  return Array.from({ length: 6 }, (_, index) => addDays(monday, index));
}

function shareModel(source, range) {
  const isTeacher = source === "teacher";
  const isos = shareDays(range, source);
  const find = (iso) => (isTeacher ? teacherDay(iso) : dayByDate(iso));
  const days = isos.map((iso) => {
    const day = find(iso);
    const label = `${weekdayName(iso)}, ${formatDots(iso)}`;
    if (!day) return { label, lessons: null };
    const lessons = (isTeacher ? day.lessons : day.lessons.filter((lesson) => lessonMatchesSubgroup(lesson, state.subgroup))).map((lesson) => ({
      start: lesson.start,
      end: lesson.end,
      type: lesson.type,
      subject: lesson.subject,
      badge: subgroupBadgeLabel(lessonSubgroup(lesson)),
      meta: (isTeacher ? [(lesson.groups || []).join(", "), lesson.room] : [lesson.room, lesson.teacher]).filter(Boolean).join(" · "),
    }));
    return { label, lessons };
  });
  // Неделя: пустую субботу без данных не рисуем.
  const trimmed = range === "week" ? days.filter((day, index) => index < 5 || day.lessons?.length) : days;
  const rangeLabel = range === "week" ? `${formatDots(isos[0])} – ${formatDots(isos[isos.length - 1])}` : range === "today" ? `Сегодня, ${formatDots(isos[0])}` : range === "tomorrow" ? `Завтра, ${formatDots(isos[0])}` : `${weekdayName(isos[0])}, ${formatDots(isos[0])}`;
  const sub = !isTeacher && state.subgroup !== "all" ? ` · ${state.subgroup} подгруппа` : "";
  const record = isTeacher ? state.teacher.record : state.record;
  return {
    kicker: isTeacher ? "Преподаватель · ВГЛТУ" : "Группа · ВГЛТУ",
    title: isTeacher ? state.teacher.name : state.group,
    subtitle: `${rangeLabel}${sub}`,
    days: trimmed,
    footer: "Пары · rasp-is2-241.pages.dev",
    stamp: record?.fetchedAt ? `Расписание ВГЛТУ от ${formatStamp(record.fetchedAt)}` : "",
    fileRange: range === "week" ? `${isos[0]}_${isos[isos.length - 1]}` : isos[0],
  };
}

async function buildShare() {
  const sh = state.share;
  sh.busy = true;
  sh.note = "";
  try {
    const model = shareModel(sh.source, sh.range);
    const canvas = drawShareImage(model);
    const blob = await canvasBlob(canvas);
    if (sh.url) URL.revokeObjectURL(sh.url);
    sh.url = URL.createObjectURL(blob);
    sh.file = new File([blob], shareFileName(model.title, model.fileRange), { type: "image/png" });
  } catch {
    sh.note = "Не получилось нарисовать картинку.";
  }
  sh.busy = false;
  if (sh.open) render();
}

function canShareFile(file) {
  try {
    return Boolean(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

function shareSheetHtml() {
  const sh = state.share;
  const ranges = [
    ["today", "Сегодня"],
    ["tomorrow", "Завтра"],
    ["week", "Неделя"],
  ];
  const today = moscowIso();
  if (sh.date && sh.date !== today && sh.date !== addDays(today, 1)) ranges.unshift(["date", formatDots(sh.date).slice(0, 5)]);
  const native = canShareFile(sh.file);
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
    <div class="sheet-card share-card">
      <div class="grabber"></div>
      <h2 id="share-title">Поделиться картинкой</h2>
      <div class="seg">${ranges.map(([value, label]) => `<button type="button" data-action="share-range" data-range="${value}" aria-pressed="${sh.range === value ? "true" : "false"}">${label}</button>`).join("")}</div>
      <div class="share-preview">${sh.url ? `<img src="${esc(sh.url)}" alt="Картинка с расписанием" />` : `<div class="card skeleton"></div>`}</div>
      ${sh.note ? `<p class="status" role="status">${esc(sh.note)}</p>` : ""}
      ${native ? `<button class="primary" type="button" data-action="share-send">Поделиться</button>` : ""}
      <button class="${native ? "ghost" : "primary"}" type="button" data-action="share-download">Сохранить картинку</button>
      ${native ? "" : `<p class="rooms-note">Этот браузер не умеет отправлять картинки напрямую — сохраните её и отправьте из галереи.</p>`}
      <button class="ghost" type="button" data-action="share-close">Закрыть</button>
    </div>
  </div>`;
}

function openShare(source, date = "") {
  const sh = state.share;
  sh.open = true;
  sh.date = date || (state.mode === "day" ? activeIso() : "");
  sh.source = source === "teacher" ? "teacher" : "group";
  const today = moscowIso();
  sh.range = date
    ? date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : "date"
    : state.mode === "week" ? "week" : state.mode === "tomorrow" ? "tomorrow" : source === "teacher" ? "week" : state.mode === "day" && sh.date !== today ? "date" : "today";
  sh.url = "";
  sh.file = null;
  render();
  buildShare();
}

async function sendShare() {
  const sh = state.share;
  if (!sh.file) return;
  try {
    await navigator.share({ files: [sh.file], title: "Расписание", text: "Расписание пар ВГЛТУ" });
  } catch (error) {
    if (error?.name !== "AbortError") {
      sh.note = "Не удалось поделиться — сохраните картинку.";
      render();
    }
  }
}

function downloadShare() {
  const sh = state.share;
  if (!sh.url || !sh.file) return;
  const link = document.createElement("a");
  link.href = sh.url;
  link.download = sh.file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  sh.note = `Картинка сохранена: ${sh.file.name}`;
  render();
}

// ===== Уведомления о парах (Web Push) =====

function pushSettings() {
  if (!state.push.settings) state.push.settings = loadPushSettings();
  return state.push.settings;
}

function stampShort(iso) {
  if (!iso) return "";
  try {
    return formatStamp(iso);
  } catch {
    return iso;
  }
}

function permissionLabel(value) {
  return { granted: "разрешены", denied: "запрещены в браузере", default: "ещё не спрашивали", unsupported: "браузер не умеет" }[value] || value;
}

function notifyTips(support) {
  const browser = support.yandex ? "Яндекс Браузер" : "Chrome";
  return `<details class="tips">
      <summary>Не приходят? Советы для Android${support.honor ? " / HONOR" : ""}</summary>
      <ol>
        <li>Разрешите уведомления браузеру: Настройки телефона → Приложения → ${esc(browser)} → Уведомления → включить (и категорию «Сайты»).</li>
        <li>Если в браузере уведомления сайта запрещены: откройте ${esc(location.host)}, нажмите на значок слева от адреса → Уведомления → «Разрешить».</li>
        <li>HONOR / Huawei: Настройки → Приложения → ${esc(browser)} → «Запуск приложений» → «Управлять вручную» и включите «Автозапуск», «Косвенный запуск», «Работа в фоне».</li>
        <li>Батарея: Настройки → Батарея → Оптимизация (или «Ещё настройки батареи») — для ${esc(browser)} «Не оптимизировать». Иначе система усыпляет браузер, и уведомления опаздывают или приходят пачкой.</li>
        <li>VPN: уведомления идут через сервис Google (Chrome) или браузера, обычно VPN не мешает. Если с VPN не приходят, а без него приходят — добавьте браузер в исключения VPN.</li>
        <li>${support.yandex ? "Яндекс Браузер на Android не ставит сайты как отдельное приложение (только ярлык), и в фоне его чаще усыпляют. Надёжнее всего — Chrome: откройте rasp-is2-241.pages.dev в Chrome → ⋮ → «Установить приложение» → включите уведомления там." : "Лучше всего уведомления работают в приложении, установленном из Chrome: ⋮ → «Установить приложение»."}</li>
        <li>Нажмите «Прислать тестовое». Если тестовое пришло при закрытом приложении — напоминания о парах тоже придут.</li>
      </ol>
    </details>`;
}

function notifyBlock() {
  const p = state.push;
  const settings = pushSettings();
  const support = pushSupport();
  const permission = permissionState();
  const can = support.sw && support.push && support.notification;
  const subgroup = settings.subgroup || state.subgroup || "all";
  const seg = (action, current, items) =>
    `<div class="seg seg-wrap">${items
      .map(([value, label]) => `<button type="button" data-action="${action}" data-value="${esc(value)}" aria-pressed="${String(value) === String(current) ? "true" : "false"}">${esc(label)}</button>`)
      .join("")}</div>`;
  const server = p.server;
  const serverLine = !settings.enabled
    ? "—"
    : !p.subscribed
      ? "в браузере подписки нет"
      : !server
        ? "проверяем…"
        : server.ok === false
          ? "нет связи с сервером"
          : server.subscribed
            ? `сохранена${server.updatedAt ? ` ${stampShort(server.updatedAt)}` : ""}`
            : "не найдена — выключите и включите ещё раз";
  const lastSent = server?.last ? `${stampShort(server.last.at)} — ${server.last.status >= 200 && server.last.status < 300 ? "доставлено в сервис" : `ошибка ${server.last.status}`}` : "ещё не было";
  const received = p.received ? `${stampShort(p.received.at)} — ${p.received.title}` : "ещё не было";
  const warn = !can
    ? `<p class="notify-warn">Этот браузер не поддерживает push-уведомления${support.ios ? " (на iPhone — только если приложение добавлено на экран «Домой», iOS 16.4+)" : ""}. Пока приложение открыто, напоминание всё равно покажется.</p>`
    : permission === "denied"
      ? `<p class="notify-warn">Уведомления для этого сайта запрещены. Нажмите на значок слева от адреса → Уведомления → «Разрешить», затем включите переключатель.</p>`
      : support.yandex
        ? `<p class="notify-hint">Яндекс Браузер поддерживает уведомления сайтов, но в фоне Android его часто усыпляет. Если тестовое не приходит при закрытом браузере — используйте Chrome (советы ниже).</p>`
        : "";
  return `<article class="block notify-block" id="notify">
      <div class="notify-head">
        <h2>Уведомления о парах</h2>
        <button type="button" class="switch" role="switch" data-action="push-toggle" aria-checked="${settings.enabled ? "true" : "false"}" aria-label="Уведомления о парах" ${p.busy || !can ? "disabled" : ""}><span></span></button>
      </div>
      <p>Приходят с сервера, даже когда приложение закрыто: пара, время, аудитория, преподаватель.</p>
      ${warn}
      <p class="field-label">За сколько минут до пары</p>
      ${seg("push-lead", settings.lead, LEAD_OPTIONS.map((value) => [value, `${value}`]))}
      <p class="field-label">Подгруппа</p>
      ${seg("push-subgroup", subgroup, [["all", "Все"], ["1", "1 пг"], ["2", "2 пг"]])}
      <p class="field-label">Не беспокоить</p>
      ${seg("push-quiet", settings.quiet, QUIET_OPTIONS)}
      <button type="button" class="check-row" role="switch" data-action="push-first" aria-checked="${settings.firstOnly ? "true" : "false"}"><span class="check-box" aria-hidden="true">${settings.firstOnly ? "✓" : ""}</span>Только первая пара дня</button>
      <button class="ghost" type="button" data-action="push-test" ${settings.enabled && p.subscribed && !p.busy ? "" : "disabled"}>Прислать тестовое</button>
      ${p.note ? `<p class="status notify-note" role="status">${esc(p.note)}</p>` : ""}
      <dl class="diag">
        <dt>Группа</dt><dd>${esc(state.group || "не выбрана")}</dd>
        <dt>Разрешение</dt><dd>${esc(permissionLabel(permission))}</dd>
        <dt>Подписка в браузере</dt><dd>${p.subscribed ? "есть" : "нет"}</dd>
        <dt>На сервере</dt><dd>${esc(serverLine)}</dd>
        <dt>Последнее по расписанию</dt><dd>${esc(lastSent)}</dd>
        <dt>Последнее полученное</dt><dd>${esc(received)}</dd>
        <dt>Браузер</dt><dd>${esc(support.yandex ? "Яндекс Браузер" : /Chrome/.test(navigator.userAgent) ? "Chrome" : "другой")}${support.standalone ? ", установлено как приложение" : ", вкладка браузера"}</dd>
      </dl>
      ${notifyTips(support)}
    </article>`;
}

async function refreshPushStatus(withServer = true) {
  const p = state.push;
  p.permission = permissionState();
  const registration = swRegistration || (await navigator.serviceWorker?.getRegistration?.().catch(() => null));
  const subscription = await currentSubscription(registration);
  p.subscribed = Boolean(subscription);
  p.received = await lastPushReceived();
  if (state.mode === "more") render();
  if (withServer && subscription && navigator.onLine) {
    p.server = await serverStatus(registration, API_BASE);
    p.checkedAt = Date.now();
    if (state.mode === "more") render();
  }
}

async function pushRegistration() {
  if (swRegistration) return swRegistration;
  if (!navigator.serviceWorker) return null;
  try {
    return await Promise.race([navigator.serviceWorker.ready, sleep(8000).then(() => null)]);
  } catch {
    return null;
  }
}

async function enablePush() {
  const p = state.push;
  const settings = pushSettings();
  if (!state.group) {
    p.note = "Сначала выберите группу.";
    render();
    return;
  }
  p.busy = true;
  p.note = "Включаем…";
  render();
  const registration = await pushRegistration();
  if (!settings.subgroup) settings.subgroup = state.subgroup || "all";
  const result = await subscribePush(registration, API_BASE, settings, state.group, state.subgroup);
  p.busy = false;
  if (result.ok) {
    settings.enabled = true;
    settings.syncedAt = new Date().toISOString();
    savePushSettings(settings);
    saveNotify(false);
    p.note = `Готово: напомним за ${settings.lead} мин до пары. Нажмите «Прислать тестовое», чтобы проверить.`;
    haptic(12);
  } else {
    settings.enabled = false;
    savePushSettings(settings);
    p.note = {
      denied: "Уведомления запрещены. Нажмите на значок слева от адреса → Уведомления → «Разрешить».",
      dismissed: "Разрешение не дали — окно закрыли. Нажмите ещё раз и выберите «Разрешить».",
      unsupported: "Этот браузер не умеет показывать уведомления.",
      "no-push": "Браузер не поддерживает push. Попробуйте Chrome.",
      "subscribe-failed": `Браузер не смог оформить подписку (${result.detail || "ошибка"}). ${pushSupport().yandex ? "В Яндекс Браузере это бывает — попробуйте Chrome." : "Проверьте, что на телефоне работают сервисы Google Play."}`,
      server: `Подписка есть, но сервер её не принял: ${result.detail || "нет связи"}. Попробуйте ещё раз.`,
    }[result.reason] || "Не получилось включить.";
  }
  render();
  refreshPushStatus();
  planNotification(state.record);
}

async function disablePush() {
  const p = state.push;
  const settings = pushSettings();
  p.busy = true;
  render();
  await unsubscribePush(await pushRegistration(), API_BASE);
  settings.enabled = false;
  savePushSettings(settings);
  saveNotify(false);
  p.busy = false;
  p.server = null;
  p.note = "Уведомления выключены.";
  clearTimeout(notifyTimer);
  render();
  refreshPushStatus(false);
}

let pushSyncTimer = 0;
function syncPushSettings() {
  const settings = pushSettings();
  savePushSettings(settings);
  render();
  planNotification(state.record);
  if (!settings.enabled) return;
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(async () => {
    const result = await subscribePush(await pushRegistration(), API_BASE, settings, state.group, state.subgroup);
    if (result.ok) {
      settings.syncedAt = new Date().toISOString();
      savePushSettings(settings);
    }
    state.push.note = result.ok ? "Настройки сохранены на сервере." : "Не удалось сохранить настройки на сервере — попробуем при следующем открытии.";
    if (state.mode === "more") render();
    refreshPushStatus();
  }, 600);
}

async function sendTestPush() {
  const p = state.push;
  p.busy = true;
  p.note = "Отправляем тестовое…";
  render();
  const result = await testPush(await pushRegistration(), API_BASE, pushSettings(), state.group, state.subgroup);
  p.busy = false;
  p.note = result.ok
    ? "Сервер отправил тестовое — оно должно появиться в шторке через пару секунд. Не пришло — смотрите советы ниже."
    : result.reason === "no-subscription"
      ? "Подписки нет — выключите и включите уведомления."
      : `Не отправилось: ${result.message || result.status}.`;
  render();
  setTimeout(() => refreshPushStatus(false), 4000);
}

// Подписка могла пропасть (сброс данных, новый браузер) или устареть — проверяем при запуске.
// Старые напоминания (v16 и раньше, «пока открыто») переводим на сервер, если разрешение уже дано.
async function verifyPushOnBoot() {
  const settings = pushSettings();
  const legacy = loadNotify() && permissionState() === "granted";
  if ((!settings.enabled && !legacy) || permissionState() !== "granted") return;
  const registration = await pushRegistration();
  const subscription = await currentSubscription(registration);
  const stale = !settings.syncedAt || Date.now() - Date.parse(settings.syncedAt) > 3 * 24 * 60 * 60 * 1000;
  if (subscription && !legacy && !stale) return;
  if (!navigator.onLine || !state.group) return;
  if (!settings.subgroup) settings.subgroup = state.subgroup || "all";
  const result = await subscribePush(registration, API_BASE, settings, state.group, state.subgroup);
  if (result.ok) {
    settings.enabled = true;
    settings.syncedAt = new Date().toISOString();
    savePushSettings(settings);
    saveNotify(false);
  }
}

// ===== Быстрые действия по долгому нажатию на пару =====

function lessonFromCard(card) {
  const iso = card.dataset.iso;
  const index = Number(card.dataset.idx);
  const source = card.dataset.press;
  const day = source === "teacher" ? teacherDay(iso) : dayByDate(iso);
  const lesson = day?.lessons?.[index];
  return lesson ? { iso, lesson, source } : null;
}

function pairOfLesson(lesson) {
  const found = PAIRS.find(([, start]) => start === lesson.start);
  return found ? found[0] : 1;
}

function lessonText(iso, lesson) {
  return [
    `${weekdayName(iso)}, ${formatDots(iso)}`,
    `${lesson.start}–${lesson.end} ${lesson.type ? `(${lesson.type}) ` : ""}${lesson.subject}`,
    [lesson.room, lesson.teacher, (lesson.groups || []).join(", ")].filter(Boolean).join(" · "),
  ].join("\n");
}

function actionsSheetHtml() {
  const { iso, lesson, source } = state.actions;
  const teacher = source === "group" && looksLikeTeacher(lesson.teacher) ? lesson.teacher : "";
  const building = lesson.room ? buildingOf(lesson.room) : "";
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="actions-title">
    <div class="sheet-card actions-card">
      <div class="grabber"></div>
      <p class="lead">${esc(weekdayName(iso))}, ${esc(formatDots(iso))} · ${esc(lesson.start)}–${esc(lesson.end)}</p>
      <h2 id="actions-title">${esc(lesson.subject)}</h2>
      <div class="action-list">
        <button type="button" data-action="act-share-day"><span aria-hidden="true">🖼</span> Картинка этого дня</button>
        <button type="button" data-action="act-copy"><span aria-hidden="true">📋</span> Скопировать пару</button>
        ${teacher ? `<button type="button" data-action="act-teacher"><span aria-hidden="true">👤</span> Расписание: ${esc(teacher)}</button>` : ""}
        ${building ? `<button type="button" data-action="act-room"><span aria-hidden="true">🚪</span> Аудитория ${esc(lesson.room)}: занятость за день</button>` : ""}
        ${lesson.room ? `<a href="https://kis.vgltu.ru/map/rasp?auditory=${encodeURIComponent(lesson.room)}" target="_blank" rel="noopener"><span aria-hidden="true">🗺</span> ${esc(lesson.room)} на карте ВГЛТУ</a>` : ""}
      </div>
      <button class="primary" type="button" data-action="act-close">Закрыть</button>
    </div>
  </div>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function openRoomFromLesson(iso, lesson) {
  const r = state.rooms;
  r.building = buildingOf(lesson.room);
  r.date = iso;
  r.pair = pairOfLesson(lesson);
  state.mode = "rooms";
  render();
  window.scrollTo?.(0, 0);
  loadBuildings().then(async () => {
    await loadRooms();
    state.rooms.open = lesson.room;
    if (state.mode === "rooms") render();
  });
}

// ===== Навигация: свайпы, быстрый выбор даты, «к сегодня», автопрокрутка =====

function setDay(iso) {
  const today = moscowIso();
  state.follow = iso === today ? "today" : "none";
  state.anchor = iso === today ? null : iso;
  if (state.mode !== "week") state.mode = iso === today ? "today" : "day";
  state.dateError = "";
  render();
  if (state.mode === "week") ensureWeek();
  else if (!dayByDate(iso)) refresh(iso, true);
}

function swipe(direction) {
  const delta = direction === "left" ? 1 : -1;
  if (state.share.open || state.pickerOpen || state.actions || state.rooms.open) return false;
  let moved = false;
  if (["today", "tomorrow", "day"].includes(state.mode) && state.group) {
    setDay(addDays(activeIso(), delta));
    moved = true;
  } else if (state.mode === "week" && state.group) {
    const monday = addDays(mondayOf(activeIso()), delta * 7);
    if (delta < 0 && monday < mondayOf(moscowIso())) return false;
    const today = moscowIso();
    state.follow = monday <= today ? "today" : "none";
    state.anchor = monday <= today ? null : monday;
    render();
    ensureWeek();
    moved = true;
  } else if (state.mode === "teachers" && state.teacher.name && !state.teacher.picking) {
    state.teacher.week = addDays(state.teacher.week, delta * 7);
    render();
    loadTeacherWeek(state.teacher.week);
    moved = true;
  } else if (state.mode === "rooms") {
    state.rooms.date = addDays(state.rooms.date, delta);
    loadRooms();
    moved = true;
  }
  if (moved) app.querySelector("main")?.classList.add(direction === "left" ? "slide-left" : "slide-right");
  return moved;
}

function pullRefresh() {
  if (state.mode === "teachers" && state.teacher.name) loadTeacherWeek(state.teacher.week, true);
  else if (state.mode === "rooms") loadRooms(true);
  else if (state.mode === "attendance") {
    if (state.attendance.session) refreshAttendance();
  } else if (state.mode === "more") {
    checkForUpdate(true);
    refreshPushStatus();
  } else if (state.group) {
    const days = visibleWeekDays(activeIso(), moscowIso());
    refresh(state.mode === "week" && days.length ? days[0] : activeIso(), true);
  }
}

function todayFab() {
  if (state.share.open || state.pickerOpen || state.actions) return "";
  const today = moscowIso();
  if (["day", "tomorrow"].includes(state.mode) && state.group && activeIso() !== today) {
    return `<button type="button" class="fab" data-action="go-today">↺ Сегодня</button>`;
  }
  if (state.mode === "week" && state.group && mondayOf(activeIso()) !== mondayOf(today)) {
    return `<button type="button" class="fab" data-action="week-now">↺ Эта неделя</button>`;
  }
  if (state.mode === "teachers" && state.teacher.name && !state.teacher.picking && state.teacher.week !== mondayOf(today)) {
    return `<button type="button" class="fab" data-action="teacher-week" data-delta="0">↺ Эта неделя</button>`;
  }
  if (state.mode === "rooms" && state.rooms.date && state.rooms.date !== today) {
    return `<button type="button" class="fab" data-action="rooms-today">↺ Сегодня</button>`;
  }
  return "";
}

// Один раз при открытии «Сегодня»/недели: прокрутить к текущей или следующей паре.
function autoScroll() {
  if (!["today", "week"].includes(state.mode) && !(state.mode === "teachers" && state.teacher.name)) return;
  const key = `${state.mode}|${moscowIso()}|${state.mode === "teachers" ? state.teacher.name : state.group}`;
  if (state.scrollKey === key) return;
  const target = app.querySelector(".card.now") || app.querySelector(".card.next");
  if (!target) return;
  state.scrollKey = key;
  const rect = target.getBoundingClientRect();
  if (rect.top > window.innerHeight * 0.62 || rect.top < 0) {
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.3), behavior: "smooth" });
  }
}

const LAST_MODE_KEY = "rasp.lastMode";
let modeRestored = false;
function rememberMode() {
  if (!modeRestored) return;
  try {
    const section = navSection();
    localStorage.setItem(LAST_MODE_KEY, ["attendance", "teachers", "more"].includes(section) ? section : "schedule");
  } catch {
    /* приватный режим */
  }
}

function render() {
  document.title = state.group ? `Пары · ${state.group}` : "Пары";
  const offline = navigator.onLine ? "" : `<p class="offline-flag">Нет сети</p>`;
  const main = state.mode === "attendance"
    ? attendanceView()
    : state.mode === "teachers"
      ? teacherView()
      : state.mode === "rooms"
        ? roomsView()
    : state.mode === "more"
      ? moreView()
      : !state.group
        ? `<section class="hero"><p class="kicker">Сначала группа</p><h1 class="hero-date hero-range">Выберите код</h1><p class="weekday">Например ${esc(DEFAULT_GROUP)}. Расписание останется на этом телефоне.</p></section>`
        : scheduleView();
  app.innerHTML = `<header class="top">
      <div class="top-row">
        <div>
          <p class="eyebrow">ВГЛТУ</p>
          <p class="brand">Пары</p>
        </div>
        <button class="group-btn" type="button" data-action="open-group"><span class="group-kicker">группа</span><span class="group-code">${esc(state.group || "Выбрать")}</span></button>
      </div>
      ${offline}
      ${state.loading ? `<div class="progress" aria-hidden="true"></div>` : ""}
    </header>
    <main>${main}</main>
    ${nav()}
    ${updateBanner()}
    ${state.pickerOpen ? pickerHtml() : ""}
    ${state.rooms.open && state.mode === "rooms" ? roomSheetHtml() : ""}
    ${state.share.open ? shareSheetHtml() : ""}
    ${state.actions ? actionsSheetHtml() : ""}
    ${todayFab()}`;
  rememberMode();
  requestAnimationFrame(autoScroll);
}

function ensure(iso) {
  if (!dayByDate(iso)) refresh(iso, true);
}

function ensureWeek() {
  const days = visibleWeekDays(activeIso(), moscowIso());
  if (days.some((iso) => !dayByDate(iso))) refresh(days[0], true);
}

function goToday() {
  state.follow = "today";
  state.mode = "today";
  state.anchor = null;
  state.dateError = "";
  state.seenToday = moscowIso();
  render();
  ensure(moscowIso());
}

function applyDateFromFields() {
  const day = Number(document.getElementById("day")?.value);
  const month = Number(document.getElementById("month")?.value);
  const year = Number(document.getElementById("year")?.value);
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIso(iso) || year < 2020 || year > 2036) {
    state.dateError = "Нет такой даты. Проверьте день, месяц и год.";
    render();
    return;
  }
  state.dateError = "";
  state.follow = "none";
  state.anchor = iso;
  if (state.mode === "today" || state.mode === "tomorrow") state.mode = "day";
  render();
  refresh(iso, true);
}

async function commitGroup(raw) {
  const name = resolveGroup(raw);
  if (!name) return;
  saveGroup(name);
  rememberRecent(name);
  state.group = name;
  state.query = name;
  state.liveIssue = "";
  state.pickerOpen = false;
  state.follow = "today";
  state.mode = "today";
  state.anchor = null;
  state.record = mergeRecords(loadRecord(name) || (await readCachedRecord(name)), bundledRecord(name));
  state.seenToday = moscowIso();
  render();
  refresh(moscowIso(), true);
  if (pushSettings().enabled) syncPushSettings();
}

function tick() {
  const today = moscowIso();
  const changed = today !== state.seenToday;
  state.seenToday = today;
  if (changed) {
    render();
    if (state.group) refresh(activeIso(), true);
  } else if (liveViewNeedsTick()) render();
  planNotification(state.record);
}

// «Сейчас», «через N мин» и полоса прогресса обновляются раз в 30 секунд, если не мешаем вводу.
function liveViewNeedsTick() {
  if (document.hidden || state.share.open || state.pickerOpen || state.actions || state.rooms.open) return false;
  const active = document.activeElement;
  if (active && app.contains(active) && active.matches("input, select, textarea")) return false;
  if (["today", "week"].includes(state.mode) && state.group) return true;
  if (state.mode === "day" && activeIso() === moscowIso()) return true;
  return state.mode === "teachers" && state.teacher.name && !state.teacher.picking && state.teacher.week === mondayOf(moscowIso());
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'theme') { changeTheme(button.dataset.theme); return; }
  if (action === "subgroup") {
    const next = saveSubgroup(button.dataset.subgroup);
    if (next === state.subgroup) return;
    state.subgroup = next;
    render();
    planNotification(state.record);
  } else if (action === "mode") {
    const mode = button.dataset.mode;
    state.dateError = "";
    if (mode === "today" || mode === "schedule") goToday();
    else if (mode === "tomorrow") {
      state.follow = "tomorrow";
      state.mode = "tomorrow";
      render();
      ensure(activeIso());
    } else if (mode === "week") {
      state.mode = "week";
      render();
      ensureWeek();
    } else if (mode === "rooms") {
      openRooms();
    } else if (mode === "teachers") {
      if (state.mode === "teachers" && state.teacher.name && !state.teacher.picking) {
        state.teacher.picking = true;
      }
      state.mode = "teachers";
      render();
      ensureTeacherList();
      if (state.teacher.name && !state.teacher.picking) loadTeacherWeek(state.teacher.week || mondayOf(moscowIso()));
      if (state.teacher.picking || !state.teacher.name) document.getElementById("teacher-query")?.focus();
    } else if (mode === "attendance") {
      state.mode = "attendance";
      render();
      if (state.attendance.session && navigator.onLine) refreshAttendance();
    } else {
      state.mode = "more";
      render();
      refreshPushStatus();
    }
  } else if (action === "pick-teacher" || action === "open-teacher") openTeacher(button.dataset.teacher);
  else if (action === "rooms-building") {
    state.rooms.building = button.dataset.building;
    localStorage.setItem(ROOMS_BUILDING_KEY, state.rooms.building);
    loadRooms();
  } else if (action === "rooms-pair") {
    state.rooms.pair = Number(button.dataset.pair);
    render();
  } else if (action === "rooms-day") {
    state.rooms.date = addDays(state.rooms.date, Number(button.dataset.delta));
    loadRooms();
  } else if (action === "rooms-refresh") loadRooms(true);
  else if (action === "room-open") {
    state.rooms.open = button.dataset.room;
    render();
  } else if (action === "room-close") {
    state.rooms.open = "";
    render();
  } else if (action === "share-open") openShare(button.dataset.source);
  else if (action === "share-range") {
    state.share.range = button.dataset.range;
    state.share.url = "";
    render();
    buildShare();
  } else if (action === "share-send") sendShare();
  else if (action === "share-download") downloadShare();
  else if (action === "share-close") {
    state.share.open = false;
    render();
  }
  else if (action === "teacher-fav") {
    if (state.teacher.name) toggleFavorite(state.teacher.name);
    render();
  } else if (action === "teacher-change") {
    state.teacher.picking = true;
    state.teacher.query = "";
    render();
    ensureTeacherList();
    document.getElementById("teacher-query")?.focus();
  } else if (action === "teacher-cancel") {
    state.teacher.picking = false;
    render();
  } else if (action === "teacher-week") {
    const delta = Number(button.dataset.delta);
    state.teacher.week = delta ? addDays(state.teacher.week, delta) : mondayOf(moscowIso());
    render();
    loadTeacherWeek(state.teacher.week);
  } else if (action === "teacher-refresh") loadTeacherWeek(state.teacher.week, true);
  else if (action === "go-today") goToday();
  else if (action === "shift-day") {
    const next = addDays(activeIso(), Number(button.dataset.delta));
    state.follow = "none";
    state.anchor = next;
    if (state.mode === "today" || state.mode === "tomorrow") state.mode = "day";
    state.dateError = "";
    render();
    if (state.mode === "week") ensureWeek();
    else if (!dayByDate(next)) refresh(next, true);
  } else if (action === "open-day") {
    state.follow = "none";
    state.anchor = button.dataset.date;
    state.mode = "day";
    render();
  } else if (action === "refresh") {
    prefetchRecent();
    const days = visibleWeekDays(activeIso(), moscowIso());
    refresh(state.mode === "week" && days.length ? days[0] : activeIso(), true);
  } else if (action === "att-scope") {
    state.attendance.scope = button.dataset.scope === "dates" ? "dates" : "semester";
    state.attendance.error = "";
    render();
    if (state.attendance.scope === "semester" && state.attendance.session) refreshAttendance();
  } else if (action === "att-apply") applyAttendanceDates();
  else if (action === "att-refresh") refreshAttendance();
  else if (action === "att-logout") signOutAttendance();
  else if (action === "open-group") {
    state.query = state.group || DEFAULT_GROUP;
    state.pickerOpen = true;
    state.pickerCanClose = Boolean(state.group);
    render();
    document.getElementById("group-query")?.focus();
  } else if (action === "close-picker") {
    state.pickerOpen = false;
    render();
  } else if (action === "pick-group") commitGroup(button.dataset.group);
  else if (action === "dismiss-tip") {
    dismissInstallTip();
    render();
  } else if (action === "install" && state.installEvent) {
    state.installEvent.prompt();
    state.installEvent.userChoice.finally(() => {
      state.installEvent = null;
      render();
    });
  } else if (action === "apply-update") applyUpdate();
  else if (action === "later-update") {
    state.update.dismissed = state.update.available?.version || APP_VERSION + 1;
    render();
  } else if (action === "seen-update") {
    state.update.justUpdated = false;
    render();
  } else if (action === "check-update") checkForUpdate(true);
  else if (action === "repair-app") repairApp();
  else if (action === "push-toggle") {
    if (pushSettings().enabled) disablePush();
    else enablePush();
  } else if (action === "push-lead") {
    pushSettings().lead = Number(button.dataset.value);
    syncPushSettings();
  } else if (action === "push-subgroup") {
    pushSettings().subgroup = button.dataset.value;
    syncPushSettings();
  } else if (action === "push-quiet") {
    pushSettings().quiet = button.dataset.value;
    syncPushSettings();
  } else if (action === "push-first") {
    pushSettings().firstOnly = !pushSettings().firstOnly;
    syncPushSettings();
  } else if (action === "push-test") sendTestPush();
  else if (action === "pick-date") {
    const input = document.getElementById("quick-date");
    try {
      if (input?.showPicker) input.showPicker();
      else throw new Error("no picker");
    } catch {
      document.querySelector("[data-date-form]")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("day")?.focus();
    }
  } else if (action === "week-now") {
    state.follow = "today";
    state.anchor = null;
    render();
    ensureWeek();
  } else if (action === "rooms-today") {
    state.rooms.date = moscowIso();
    loadRooms();
  } else if (action === "act-close") {
    state.actions = null;
    render();
  } else if (action === "act-copy") {
    const { iso, lesson } = state.actions;
    copyText(lessonText(iso, lesson)).then((ok) => {
      state.actions = null;
      render();
      if (!ok) window.prompt("Скопируйте:", lessonText(iso, lesson).replace(/\n/g, " · "));
    });
  } else if (action === "act-share-day") {
    const { iso, source } = state.actions;
    state.actions = null;
    openShare(source, iso);
  } else if (action === "act-teacher") {
    const { lesson } = state.actions;
    state.actions = null;
    openTeacher(lesson.teacher);
  } else if (action === "act-room") {
    const { iso, lesson } = state.actions;
    state.actions = null;
    openRoomFromLesson(iso, lesson);

    render();
  }
});

app.addEventListener("change", (event) => {
  if (!event.target.matches?.("[data-quick-date]")) return;
  const iso = event.target.value;
  if (!isValidIso(iso)) return;
  if (state.mode === "week") {
    state.follow = iso <= moscowIso() ? "today" : "none";
    state.anchor = iso <= moscowIso() ? null : iso;
    render();
    ensureWeek();
  } else setDay(iso);
});

app.addEventListener("input", (event) => {
  if (event.target.id === "teacher-query") {
    state.teacher.query = event.target.value;
    refreshTeacherSuggest();
    return;
  }
  if (event.target.id !== "group-query") return;
  state.query = event.target.value;
  const list = document.getElementById("suggest");
  if (list) list.innerHTML = suggestHtml(state.query);
});

app.addEventListener("submit", (event) => {
  if (event.target.matches("[data-date-form]")) {
    event.preventDefault();
    applyDateFromFields();
  } else if (event.target.matches("[data-group-form]")) {
    event.preventDefault();
    commitGroup(state.query);
  } else if (event.target.matches("[data-teacher-form]")) {
    event.preventDefault();
    const first = searchTeachers(state.teacher.list, state.teacher.query, 1)[0];
    if (first) openTeacher(first);
  } else if (event.target.matches("[data-attendance-form]")) {
    event.preventDefault();
    submitAttendance(event.target);
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  render();
});

window.addEventListener("online", () => {
  render();
  if (state.group) refresh(activeIso(), true);
  refreshGroups();
  setTimeout(prefetchRecent, 5000);
});

window.addEventListener("offline", () => render());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { tick(); prefetchRecent(); }
});

window.addEventListener("pageshow", () => tick());

// Обновления приложения. version.json лежит на сайте и не кэшируется; номер в нём сравнивается
// с APP_VERSION из кода. Новый service worker скачивает всю версию заранее и ждёт кнопку «Обновить».
const VERSION_KEY = "rasp.appVersion";
const RELOAD_KEY = "rasp.updateReload";
const UPDATE_CHECK_EVERY_MS = 30 * 60 * 1000;
const UPDATE_CHECK_GAP_MS = 60 * 1000;
const UPDATE_WAIT_MS = 30000;
let swRegistration = null;
let hadController = false;
let updateRequested = false;
let lastUpdateCheck = 0;

function noteFirstRunOfVersion() {
  let seen = 0;
  let used = false;
  try {
    seen = Number(localStorage.getItem(VERSION_KEY)) || 0;
    used = Boolean(localStorage.getItem("rasp.group"));
    localStorage.setItem(VERSION_KEY, String(APP_VERSION));
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    return;
  }
  // До версии 11 номер не запоминался: если группа уже была выбрана, это обновление, а не установка.
  if (seen ? seen < APP_VERSION : used) state.update.justUpdated = true;
}

async function fetchRemoteVersion() {
  const response = await fetchText(`./version.json?t=${Date.now()}`, { cache: "no-store" }, 4000);
  if (!response.ok) return null;
  return normalizeVersionInfo(JSON.parse(response.text));
}

// Без сети — описание новой версии из кэша, который уже скачал ждущий worker.
async function cachedNewerVersion() {
  try {
    const own = new URL("./version.json", location.href).href;
    for (const key of await caches.keys()) {
      const match = /^rasp-shell-v(\d+)$/.exec(key);
      if (!match || Number(match[1]) <= APP_VERSION) continue;
      const hit = await (await caches.open(key)).match(own);
      const info = hit ? normalizeVersionInfo(await hit.json()) : null;
      if (info) return info;
    }
  } catch {
    /* Нет доступа к кэшу — покажем баннер без списка изменений. */
  }
  return null;
}

// Полная перерисовка стёрла бы набираемый текст (выбор группы, вход, дата) —
// в таком случае обновляется только баннер.
function refreshUpdateUi() {
  const typing = document.activeElement?.matches?.("input, textarea, select");
  if (!state.pickerOpen && !typing) {
    render();
    return;
  }
  const html = updateBanner();
  const current = app.querySelector(".update-banner");
  if (current) current.outerHTML = html;
  else if (html) app.querySelector(".nav")?.insertAdjacentHTML("afterend", html);
}

function syncWaiting() {
  state.update.waiting = Boolean(hadController && swRegistration?.waiting);
}

async function checkForUpdate(manual = false) {
  const update = state.update;
  if (update.checking) return;
  lastUpdateCheck = Date.now();
  update.checking = true;
  if (manual) {
    update.note = "";
    render();
  }
  let remote = null;
  let reached = false;
  try {
    // A slow SW download must not block the independent version probe/UI.
    if (navigator.onLine) Promise.resolve(swRegistration?.update()).catch(() => {});
  } catch {
    /* sw.js недоступен — проверим по version.json. */
  }
  try {
    remote = await fetchRemoteVersion();
    reached = Boolean(remote);
  } catch {
    remote = null;
  }
  syncWaiting();
  if (!isNewer(remote) && (update.waiting || update.activated)) remote = (await cachedNewerVersion()) || remote;
  if (isNewer(remote)) update.available = remote;
  update.checking = false;
  if (manual) {
    if (isNewer(update.available) || update.waiting || update.activated) {
      update.dismissed = 0;
      update.note = "";
    } else {
      update.note = reached ? "У вас последняя версия." : "Не удалось проверить: нет связи с сайтом.";
    }
  }
  refreshUpdateUi();
}

async function repairApp() {
  const update = state.update;
  if (update.repairing) return;
  const controller = navigator.serviceWorker?.controller;
  if (!navigator.onLine || !controller) {
    update.note = "Для восстановления подключитесь к интернету и откройте приложение ещё раз. Сохранённые данные остаются на месте.";
    render(); return;
  }
  update.repairing = true;
  update.note = "Скачиваем и проверяем файлы приложения…";
  render();
  try {
    const ok = await new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = value => { clearTimeout(timer); channel.port1.close(); resolve(value); };
      const timer = setTimeout(() => finish(false), 20000);
      channel.port1.onmessage = event => finish(event.data?.ok === true);
      controller.postMessage({ type: "repair-shell" }, [channel.port2]);
    });
    if (!ok) throw new Error('Repair failed');
    location.reload();
  } catch {
    update.note = "Не удалось восстановить файлы. Рабочая копия и личные данные сохранены. Повторите при устойчивом интернете.";
  } finally {
    update.repairing = false;
    render();
  }
}

function reloadOnce(reason) {
  const target = String(state.update.available?.version || "next");
  let previous = null;
  try {
    previous = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || "null");
  } catch {
    previous = null;
  }
  if (!reloadAllowed(previous, target)) {
    state.update.applying = false;
    state.update.note = "Обновление не установилось. Проверьте интернет и нажмите «Обновить» ещё раз.";
    render();
    return false;
  }
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ version: target, at: Date.now(), reason }));
  } catch {
    /* Без sessionStorage защита держится на флаге ниже. */
  }
  if (reloadOnce.done) return false;
  reloadOnce.done = true;
  location.reload();
  return true;
}

function waitForWaiting(registration, ms) {
  return new Promise((resolve) => {
    if (registration.waiting) {
      resolve(registration.waiting);
      return;
    }
    const timer = setTimeout(() => finish(registration.waiting || null), ms);
    const watched = new Set();
    function finish(worker) {
      clearTimeout(timer);
      registration.removeEventListener("updatefound", watchInstalling);
      resolve(worker);
    }
    function watchInstalling() {
      const worker = registration.installing;
      if (!worker || watched.has(worker)) return;
      watched.add(worker);
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") finish(worker);
        else if (worker.state === "activated" || worker.state === "redundant") finish(registration.waiting || null);
      });
    }
    registration.addEventListener("updatefound", watchInstalling);
    watchInstalling();
  });
}

async function applyUpdate() {
  const update = state.update;
  if (update.applying) return;
  update.applying = true;
  update.note = "";
  render();
  updateRequested = true;
  if (update.activated || !("serviceWorker" in navigator)) {
    reloadOnce("activated");
    return;
  }
  let registration = swRegistration;
  try {
    registration = registration || (await navigator.serviceWorker.getRegistration());
  } catch {
    registration = null;
  }
  if (!registration) {
    reloadOnce("no-worker");
    return;
  }
  let worker = registration.waiting;
  if (!worker) {
    try {
      await registration.update();
    } catch {
      /* Нет сети — ниже подождём, вдруг скачивание уже идёт. */
    }
    worker = await waitForWaiting(registration, UPDATE_WAIT_MS);
  }
  if (worker) {
    // Дальше controllerchange → одна перезагрузка.
    worker.postMessage({ type: "skip-waiting" });
    setTimeout(() => {
      if (update.applying && !reloadOnce.done) reloadOnce("timeout");
    }, 10000);
    return;
  }
  // Ждущего worker нет: либо новая версия уже активна, либо её не удалось скачать.
  reloadOnce("no-waiting");
}

function watchWorker(worker) {
  if (!worker || !hadController) return;
  const notify = () => {
    if (worker.state !== "installed") return;
    syncWaiting();
    cachedNewerVersion().then((info) => {
      if (info && !isNewer(state.update.available)) state.update.available = info;
      refreshUpdateUi();
    });
  };
  notify();
  worker.addEventListener("statechange", notify);
}

function watchServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    if (updateRequested) {
      reloadOnce("controllerchange");
      return;
    }
    state.update.activated = true;
    // Новая версия включилась сама — перезагрузиться, если человек сейчас ничего не вводит.
    const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!typing && reloadOnce("auto-activate")) return;
    refreshUpdateUi();
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "rasp-push") {
      refreshPushStatus(false);
      return;
    }
    if (event.data?.type === "rasp-open-date") {
      openDateFromLink(event.data.date);
      return;
    }
    if (event.data?.type !== "rasp-shell" || !hadController) return;
    if (event.data.version === `rasp-shell-v${APP_VERSION}`) return;
    state.update.activated = true;
    if (!updateRequested) refreshUpdateUi();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((registration) => {
    swRegistration = registration;
    state.swReady = true;
    watchWorker(registration.installing);
    watchWorker(registration.waiting);
    registration.addEventListener("updatefound", () => watchWorker(registration.installing));
    syncWaiting();
    if (state.mode === "more" || state.update.waiting) refreshUpdateUi();
    checkForUpdate(false);
    verifyPushOnBoot().catch(() => {});
  }).catch(() => {});
}

noteFirstRunOfVersion();
watchServiceWorker();
setInterval(() => {
  if (document.visibilityState === "visible") checkForUpdate(false);
}, UPDATE_CHECK_EVERY_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastUpdateCheck > UPDATE_CHECK_GAP_MS) checkForUpdate(false);
});

let attendanceToken = 0;

function applyAttendanceDates() {
  const from = document.getElementById("att-from")?.value || "";
  const to = document.getElementById("att-to")?.value || "";
  if (!isValidIso(from) || !isValidIso(to) || from > to) {
    state.attendance.error = "Проверьте даты периода.";
    render();
    return;
  }
  state.attendance.from = from;
  state.attendance.to = to;
  state.attendance.scope = "dates";
  state.attendance.error = "";
  refreshAttendance();
}

async function submitAttendance(form) {
  if (state.attendance.loading) return;
  const requestId = ++attendanceToken;
  const login = form.login.value.trim();
  const password = form.password.value;
  form.password.value = "";
  const worker = configuredWorkerUrl();
  if (!worker) {
    state.attendance.error = "Посещаемость сейчас недоступна.";
    render();
    return;
  }
  state.attendance.loading = true;
  state.attendance.error = "";
  render();
  try {
    const result = await loginAttendance(worker, login, password);
    if (requestId !== attendanceToken) return;
    saveSession({ login: result.login, token: result.token, name: result.name, savedAt: new Date().toISOString() });
    state.attendance.session = loadSession();
    state.attendance.loading = false;
    await refreshAttendance();
  } catch (error) {
    if (requestId !== attendanceToken) return;
    state.attendance.loading = false;
    state.attendance.error = asAttendanceError(error).message || "Не удалось войти";
    if (state.mode === "attendance") render();
  }
}

function showAttendance() {
  return state.mode === "attendance";
}

async function refreshAttendance() {
  const token = ++attendanceToken;
  const session = state.attendance.session;
  const worker = configuredWorkerUrl();
  if (!session || !worker) {
    state.attendance.error = worker ? "Сначала войдите." : "Посещаемость сейчас недоступна.";
    if (showAttendance()) render();
    return;
  }
  if (!navigator.onLine) {
    state.attendance.error = "Нет сети. Показана последняя копия.";
    if (showAttendance()) render();
    return;
  }
  const range = attendanceRange();
  if (range.from > range.to) {
    state.attendance.error = "Дата «с» позже даты «по».";
    render();
    return;
  }
  state.attendance.loading = true;
  state.attendance.error = "";
  if (showAttendance()) render();
  try {
    const result = await fetchAttendance(worker, session.token, range.from, range.to, { needName: !session.name });
    if (token !== attendanceToken) return;
    const name = result.name || session.name || "";
    if (name && name !== session.name) {
      saveSession({ login: session.login, token: session.token, name, savedAt: session.savedAt });
      state.attendance.session = loadSession();
    }
    const snapshot = {
      login: session.login,
      name,
      fetchedAt: new Date().toISOString(),
      label: range.label,
      from: range.from,
      to: range.to,
      days: result.days,
      summary: summarizeAttendance(result.days),
    };
    saveSnapshot(snapshot);
    state.attendance.snapshot = snapshot;
  } catch (error) {
    if (token !== attendanceToken) return;
    const wrapped = asAttendanceError(error);
    if (wrapped.code === "unauthorized") {
      clearSession();
      state.attendance.session = null;
    }
    state.attendance.error = wrapped.message || "Не удалось обновить посещаемость";
    state.attendance.snapshot = loadSnapshot();
  }
  state.attendance.loading = false;
  if (showAttendance()) render();
}

async function signOutAttendance() {
  const session = state.attendance.session;
  const worker = configuredWorkerUrl();
  attendanceToken += 1;
  if (session && worker) logoutAttendance(worker, session.token);
  clearSession();
  state.attendance.session = null;
  state.attendance.loading = false;
  state.attendance.error = "";
  render();
}

// ?date=ГГГГ-ММ-ДД — из уведомления: открыть этот день расписания.
function openDateFromLink(iso) {
  if (!isValidIso(iso || "") || !state.group) return false;
  state.actions = null;
  state.share.open = false;
  state.mode = "today";
  setDay(iso);
  window.scrollTo?.(0, 0);
  return true;
}

function restoreLastMode() {
  let saved = "";
  try {
    saved = localStorage.getItem(LAST_MODE_KEY) || "";
  } catch {
    saved = "";
  }
  if (saved === "teachers") {
    state.mode = "teachers";
    render();
    ensureTeacherList();
    if (state.teacher.name) loadTeacherWeek(state.teacher.week || mondayOf(moscowIso()));
  } else if (saved === "attendance") {
    state.mode = "attendance";
    render();
    if (state.attendance.session && navigator.onLine) refreshAttendance();
  } else if (saved === "more") {
    state.mode = "more";
    render();
    refreshPushStatus();
  }
}

async function boot() {
  await initBundles();
  pruneGroupHistory();
  // Старые версии (до 23.09) хранили адрес Worker на workers.dev — он больше не нужен.
  try {
    localStorage.removeItem("rasp.workerUrl");
  } catch {
    /* приватный режим */
  }
  state.seenToday = moscowIso();
  state.subgroup = loadSubgroup();
  state.teacher.name = loadCurrentTeacher();
  state.teacher.record = state.teacher.name ? loadTeacherRecord(state.teacher.name) : null;
  state.teacher.week = mondayOf(state.seenToday);
  const savedTeachers = loadTeacherList();
  if (savedTeachers) {
    state.teacher.list = savedTeachers.teachers;
    state.teacher.listAt = savedTeachers.fetchedAt;
  }
  const semester = semesterRange(state.seenToday);
  state.attendance.from = semester.from;
  state.attendance.to = state.seenToday;
  state.attendance.session = loadSession();
  state.attendance.snapshot = loadSnapshot();
  state.groups = groupsFromStorage();
  state.group = loadGroup();
  if (state.group) rememberRecent(state.group);
  state.query = state.group || DEFAULT_GROUP;
  state.pickerOpen = !state.group;
  state.pickerCanClose = false;
  if (state.group) state.record = mergeRecords(loadRecord(state.group), bundledRecord(state.group));
  render();
  if (state.group && !state.record) {
    readCachedRecord(state.group).then((cached) => {
      if (!cached || state.record || state.group !== loadGroup()) return;
      state.record = cached;
      render();
    });
  }
  refreshGroups();
  if (state.group) refresh(moscowIso(), true);
  const params = new URLSearchParams(location.search);
  const linked = params.get("date");
  if (linked) {
    history.replaceState(null, "", location.pathname);
    if (!openDateFromLink(linked)) restoreLastMode();
  } else if (state.group) restoreLastMode();
  modeRestored = true;
  rememberMode();
  attachGestures(app, {
    onSwipe: swipe,
    onRefresh: pullRefresh,
    onLongPress: (card) => {
      const found = lessonFromCard(card);
      if (!found) return;
      state.actions = found;
      render();
    },
  });
  planNotification(state.record);
  setInterval(tick, 30000);
  setTimeout(prefetchRecent, 0);
}

boot();
