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
  readCachedRecord,
  rememberRecent,
  saveGroup,
  saveNotify,
  saveRecord,
  saveSubgroup,
} from "./store.js";

// Прокси (functions/schedule.js, functions/groups.js) ходит к kis.vgltu.ru.
// На pages.dev — тот же домен, с зеркала GitHub Pages — https://rasp-is2-241.pages.dev.
const API_BASE = apiBase();
const LIVE_SCHEDULE = `${API_BASE}schedule`;
const LIVE_GROUPS = `${API_BASE}groups`;
const LIVE_WINDOWS = 2;
const LIVE_TIMEOUT_MS = 12000;
const GROUPS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PREFETCH_EVERY_MS = 6 * 60 * 60 * 1000;
const PREFETCH_GAP_MS = 1500;
const DEFAULT_GROUP = "ИС2-241-ОБ";
const LEAD_MS = 10 * 60 * 1000;

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

function findNextLesson(record, now = new Date()) {
  if (!record?.days) return null;
  const today = moscowIso(now);
  const candidates = [];
  for (const iso of [today, addDays(today, 1)]) {
    const day = record.days.find((item) => item.date === iso);
    if (!day) continue;
    for (const lesson of day.lessons) {
      if (!lessonMatchesSubgroup(lesson, state.subgroup)) continue;
      const start = moscowInstant(iso, lesson.start);
      if (start.getTime() > now.getTime()) candidates.push({ iso, lesson, start });
    }
  }
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0] || null;
}

function planNotification(record) {
  clearTimeout(notifyTimer);
  if (!loadNotify() || !("Notification" in window) || Notification.permission !== "granted" || !record) return;
  const next = findNextLesson(record);
  if (!next) return;
  const key = `${next.iso}|${next.lesson.time}|${next.lesson.subject}|${next.lesson.subgroup || ""}`;
  if (sessionStorage.getItem("rasp.notified") === key) return;
  const show = () => {
    sessionStorage.setItem("rasp.notified", key);
    const room = next.lesson.room ? ` · ${next.lesson.room}` : "";
    const badge = subgroupBadgeLabel(lessonSubgroup(next.lesson));
    const subgroup = badge ? ` · ${badge}` : "";
    try {
      new Notification("Скоро пара", {
        body: `${formatDots(next.iso)} ${next.lesson.time} · ${next.lesson.subject}${subgroup}${room}`,
        lang: "ru",
        tag: "rasp-next",
        icon: "./icons/icon-192.png",
      });
    } catch {
      /* iOS и встроенные браузеры могут молча отказать. */
    }
  };
  const delay = next.start.getTime() - LEAD_MS - Date.now();
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
  const snapPromise = fetchSnapshot(group);
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
  if (live.record) state.record = await saveRecord(group, mergeRecords(state.record, live.record));
  state.liveIssue = live.issue || "";
  state.loading = false;
  render();
  planNotification(state.record);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// В фоне и по одной: недавние группы получают текущую и три следующие недели для офлайна.
let prefetching = false;

async function prefetchRecent() {
  if (prefetching || !navigator.onLine) return;
  const last = Number(localStorage.getItem("rasp.prefetchAt") || 0);
  if (Date.now() - last < PREFETCH_EVERY_MS) return;
  prefetching = true;
  try {
    localStorage.setItem("rasp.prefetchAt", String(Date.now()));
    for (const group of loadRecent()) {
      if (group === state.group) continue;
      const saved = loadRecord(group);
      const savedAt = Date.parse(saved?.fetchedAt || "");
      if (saved?.origin === "live" && Date.now() - savedAt < PREFETCH_EVERY_MS) continue;
      await sleep(PREFETCH_GAP_MS);
      if (!navigator.onLine) return;
      try {
        const live = await fetchLive(group, moscowIso());
        if (!live.issue && group !== state.group) await saveRecord(group, mergeRecords(loadRecord(group), live.record));
      } catch (error) {
        if (error?.kind === "offline") return;
      }
    }
  } catch {
    /* Предзагрузка необязательна. */
  } finally {
    prefetching = false;
  }
}

function offlineNow() {
  return !navigator.onLine || state.liveIssue === "offline";
}

function statusText() {
  if (state.loading) return "Обновляем расписание…";
  if (!state.record?.fetchedAt) {
    if (offlineNow()) {
      return "Для этой группы ещё нет сохранённой копии. Откройте её, когда будет интернет — после этого она будет доступна офлайн.";
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
  let title = `<h1 class="hero-date">${esc(dots)}</h1>`;
  let sub = `<p class="weekday">${esc(weekdayName(iso))}</p>`;
  if (week && days.length > 1) {
    title = `<h1 class="hero-date hero-range">${esc(formatDots(days[0]))} – ${esc(formatDots(days[days.length - 1]))}</h1>`;
    sub = `<p class="weekday">${esc(weekdayName(days[0]))} – ${esc(weekdayName(days[days.length - 1]))}</p>`;
  } else if (week && days.length === 1) {
    title = `<h1 class="hero-date">${esc(formatDots(days[0]))}</h1>`;
    sub = `<p class="weekday">${esc(weekdayName(days[0]))}</p>`;
  } else if (week) {
    title = `<h1 class="hero-date hero-range">Неделя прошла</h1>`;
    sub = `<p class="weekday">Дни до сегодняшнего по Москве не показываем</p>`;
  }
  return `<div class="hero">${kicker}${title}${sub}${back}</div>`;
}

function lessonCard(iso, lesson) {
  const phase = phaseOf(iso, lesson);
  const typeClass = lesson.type || "none";
  const badge = state.subgroup === "all" ? subgroupBadgeLabel(lessonSubgroup(lesson)) : "";
  const chips = [
    lesson.type ? `<span class="chip ${esc(lesson.type)}">${esc(lesson.type)}</span>` : "",
    badge ? `<span class="chip subgroup">${esc(badge)}</span>` : "",
    phase === "now" ? `<span class="chip now">сейчас</span>` : "",
  ].join("");
  const bits = [];
  if (lesson.teacher) bits.push(`<span>${esc(lesson.teacher)}</span>`);
  if (lesson.room) {
    if (bits.length) bits.push(`<span class="dot">·</span>`);
    bits.push(`<a href="https://kis.vgltu.ru/map/rasp?auditory=${encodeURIComponent(lesson.room)}" target="_blank" rel="noopener">${esc(lesson.room)}</a>`);
  }
  return `<article class="card ${esc(typeClass)} ${phase}">
    <div class="card-top">
      <p class="time">${esc(lesson.start)}<span class="time-sep">–</span>${esc(lesson.end)}</p>
      <div class="chips">${chips}</div>
    </div>
    <h2 class="subject">${esc(lesson.subject)}</h2>
    ${bits.length ? `<p class="meta-line">${bits.join("")}</p>` : ""}
  </article>`;
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
  return lessons.map((lesson) => lessonCard(iso, lesson)).join("");
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
        <button class="primary" type="submit">${state.attendance.loading ? "Входим…" : "Войти"}</button>
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
  const notifyOn = loadNotify() && (typeof Notification === "undefined" || Notification.permission === "granted");
  return `<section class="more">
    <h1>Ещё</h1>
    ${versionBlock()}
    <article class="block">
      <h2>Напоминание</h2>
      <p>За 10 минут до следующей пары, пока приложение открыто. Если выбрана подгруппа, напоминание приходит только по общим парам и парам этой подгруппы. Отдельный сервер уведомлений не нужен. На iPhone напоминание ограничено системой.</p>
      <p>${esc(state.notifyNote || (notifyOn ? "Напоминания включены." : "Сейчас выключены."))}</p>
      <button class="primary" type="button" data-action="notify-on">Включить за 10 минут</button>
      <button class="ghost" type="button" data-action="notify-off">Выключить</button>
    </article>
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
    more: `<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/>`,
  };
  return `<svg ${common}>${paths[name]}</svg>`;
}

function navSection() {
  if (state.mode === "more") return "more";
  if (state.mode === "attendance") return "attendance";
  return "schedule";
}

function nav() {
  const current = navSection();
  const items = [
    ["schedule", "Расписание"],
    ["attendance", "Посещаемость"],
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
      ${newer ? `<button class="primary" type="button" data-action="apply-update">Обновить до версии ${update.available.version}</button>` : ""}
      ${note ? `<p class="status" role="status">${esc(note)}</p>` : ""}
    </article>`;
}

function render() {
  document.title = state.group ? `Пары · ${state.group}` : "Пары";
  const offline = navigator.onLine ? "" : `<p class="offline-flag">Нет сети</p>`;
  const main = state.mode === "attendance"
    ? attendanceView()
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
    ${state.pickerOpen ? pickerHtml() : ""}`;
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
  state.record = loadRecord(name) || (await readCachedRecord(name));
  state.seenToday = moscowIso();
  render();
  refresh(moscowIso(), true);
}

async function enableNotify() {
  if (!("Notification" in window)) {
    state.notifyNote = "Этот браузер не умеет показывать уведомления.";
    render();
    return;
  }
  let permission = Notification.permission;
  if (permission !== "granted") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    saveNotify(false);
    state.notifyNote = "Разрешение не дали. Напоминания выключены, расписание работает как обычно.";
    render();
    return;
  }
  saveNotify(true);
  state.notifyNote = "Напомним за 10 минут до пары, пока приложение открыто.";
  planNotification(state.record);
  render();
}

function tick() {
  const today = moscowIso();
  const changed = today !== state.seenToday;
  state.seenToday = today;
  if (changed) {
    render();
    if (state.group) refresh(activeIso(), true);
  }
  planNotification(state.record);
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
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
    } else if (mode === "attendance") {
      state.mode = "attendance";
      render();
      if (state.attendance.session && navigator.onLine) refreshAttendance();
    } else {
      state.mode = "more";
      render();
    }
  } else if (action === "go-today") goToday();
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
  else if (action === "notify-on") enableNotify();
  else if (action === "notify-off") {
    saveNotify(false);
    clearTimeout(notifyTimer);
    state.notifyNote = "Напоминания выключены.";
    render();
  }
});

app.addEventListener("input", (event) => {
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
  if (document.visibilityState === "visible") tick();
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
  const response = await fetchText(`./version.json?t=${Date.now()}`, { cache: "no-store" }, 8000);
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
  update.checking = manual;
  if (manual) {
    update.note = "";
    render();
  }
  let remote = null;
  let reached = false;
  try {
    await swRegistration?.update();
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
    refreshUpdateUi();
  });
  navigator.serviceWorker.addEventListener("message", (event) => {
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
    saveSession({ login: result.login, token: result.token, name: result.name, savedAt: new Date().toISOString() });
    state.attendance.session = loadSession();
    state.attendance.loading = false;
    await refreshAttendance();
  } catch (error) {
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

function boot() {
  state.seenToday = moscowIso();
  state.subgroup = loadSubgroup();
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
  if (state.group) state.record = loadRecord(state.group);
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
  planNotification(state.record);
  setInterval(tick, 30000);
  setTimeout(prefetchRecent, 8000);
}

boot();
