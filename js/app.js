import {
  addDays,
  formatDots,
  formatStamp,
  isValidIso,
  mondayOf,
  monthNames,
  moscowInstant,
  moscowIso,
  splitIso,
  weekdayName,
} from "./dates.js";
import { parseScheduleHtml } from "./parse.js";
import {
  dismissInstallTip,
  loadGroup,
  loadInstallDismissed,
  loadNotify,
  loadRecord,
  mergeRecords,
  readCachedRecord,
  saveGroup,
  saveNotify,
  saveRecord,
} from "./store.js";

const LIVE_SCHEDULE = "https://kis.vgltu.ru/schedule";
const LIVE_GROUPS = "https://kis.vgltu.ru/list?type=Group";
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
  loading: false,
  liveBlocked: false,
  swReady: false,
  installEvent: null,
  notifyNote: "",
  seenToday: "",
  lastRefresh: 0,
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
    try {
      new Notification("Скоро пара", {
        body: `${formatDots(next.iso)} ${next.lesson.time} · ${next.lesson.subject}${room}`,
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

async function loadGroups() {
  try {
    const response = await fetch(LIVE_GROUPS);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length) {
        localStorage.setItem("rasp.groups", JSON.stringify(data));
        return data.map(String);
      }
    }
  } catch {
    /* Список групп тоже без CORS. */
  }
  try {
    const response = await fetch("./data/groups.json", { cache: "no-cache" });
    if (response.ok) {
      const data = await response.json();
      const groups = data.groups || data;
      if (Array.isArray(groups) && groups.length) {
        localStorage.setItem("rasp.groups", JSON.stringify(groups));
        return groups.map(String);
      }
    }
  } catch {
    /* Офлайн без кэша списка. */
  }
  try {
    const cached = JSON.parse(localStorage.getItem("rasp.groups") || "null");
    if (Array.isArray(cached) && cached.length) return cached.map(String);
  } catch {
    /* Повреждённый кэш игнорируем. */
  }
  return [DEFAULT_GROUP, "ИС2-242-ОБ", "ИС2-243-ОБ", "ИС2-244-ОБ"];
}

async function fetchLive(group, iso) {
  const url = `${LIVE_SCHEDULE}?date=${iso}&group=${encodeURIComponent(group)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const days = parseScheduleHtml(await response.text());
  if (!days.length) throw new Error("empty");
  return {
    group,
    fetchedAt: new Date().toISOString(),
    source: LIVE_SCHEDULE,
    origin: "live",
    days,
  };
}

async function fetchSnapshot(group) {
  const response = await fetch(`./data/schedules/${encodeURIComponent(group)}.json`, { cache: "no-cache" });
  if (!response.ok) return null;
  const data = await response.json();
  data.group = data.group || group;
  data.origin = data.origin || "snapshot";
  return data;
}

async function refresh(iso, force) {
  if (!state.group || !navigator.onLine) return;
  if (!force && Date.now() - state.lastRefresh < 10 * 60 * 1000 && dayByDate(iso)) return;
  const token = ++refreshToken;
  state.loading = true;
  state.lastRefresh = Date.now();
  render();
  let record = state.record;
  let liveBlocked = false;
  try {
    record = mergeRecords(record, await fetchLive(state.group, iso));
    record = await saveRecord(state.group, record);
  } catch {
    liveBlocked = true;
    try {
      const file = await fetchSnapshot(state.group);
      if (file) {
        record = mergeRecords(record, file);
        record = await saveRecord(state.group, record);
      }
    } catch {
      /* Остаётся то, что уже лежит в памяти телефона. */
    }
  }
  if (token !== refreshToken) return;
  state.record = record;
  state.liveBlocked = liveBlocked;
  state.loading = false;
  render();
  planNotification(record);
}

function statusText() {
  if (state.loading) return "Обновляем расписание…";
  const offline = navigator.onLine ? "" : " Нет сети: показано сохранённое расписание.";
  if (!state.record?.fetchedAt) {
    const missing = state.liveBlocked
      ? "Для этой группы нет сохранённой копии. Сайт ВГЛТУ не отдаёт расписание прямо в браузер (CORS)."
      : "Расписание ещё не загружено.";
    return missing + offline;
  }
  const stamp = formatStamp(state.record.fetchedAt);
  if (state.record.origin === "live") return `Обновлено с сайта ВГЛТУ ${stamp}.${offline}`;
  return `Копия от ${stamp}.${offline}`;
}

function dateHero(iso) {
  const today = moscowIso();
  const dots = formatDots(iso);
  const todayDots = formatDots(today);
  const week = state.mode === "week";
  let kicker = `<p class="kicker">${week ? "Неделя" : "Сегодня"}</p>`;
  let back = "";
  if (iso !== today) {
    const kind = week ? "Неделя" : iso === addDays(today, 1) ? "Завтра" : "Выбранная дата";
    kicker = `<p class="kicker warn">${kind} · сегодня ${esc(todayDots)}</p>`;
    back = `<button type="button" class="text-btn" data-action="go-today">К сегодня</button>`;
  }
  const title = week
    ? `<h1 class="hero-date hero-range">${esc(formatDots(mondayOf(iso)))} – ${esc(formatDots(addDays(mondayOf(iso), 6)))}</h1>`
    : `<h1 class="hero-date">${esc(dots)}</h1>`;
  const sub = week ? `<p class="weekday">${esc(weekdayName(mondayOf(iso)))} – ${esc(weekdayName(addDays(mondayOf(iso), 6)))}</p>` : `<p class="weekday">${esc(weekdayName(iso))}</p>`;
  return `<div class="hero">${kicker}${title}${sub}${back}</div>`;
}

function lessonCard(iso, lesson) {
  const phase = phaseOf(iso, lesson);
  const typeClass = lesson.type || "none";
  const chips = [
    lesson.type ? `<span class="chip ${esc(lesson.type)}">${esc(lesson.type)}</span>` : "",
    lesson.subgroup ? `<span class="chip">${esc(lesson.subgroup)}</span>` : "",
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
    return `<div class="empty"><p class="empty-title">Нет копии на ${esc(formatDots(iso))}</p><p>Нажмите «Обновить» или добавьте эту дату скриптом.</p></div>`;
  }
  if (!day.lessons.length) return `<div class="empty"><p class="empty-title">Нет пар</p><p>В этот день занятий нет.</p></div>`;
  return day.lessons.map((lesson) => lessonCard(iso, lesson)).join("");
}

function dateControls(iso) {
  const parts = splitIso(iso);
  const months = monthNames()
    .map((name, index) => `<option value="${index + 1}" ${index + 1 === parts.month ? "selected" : ""}>${esc(name)}</option>`)
    .join("");
  return `<form class="date-card" data-date-form>
    <div class="date-card-head"><p>Другая дата</p><strong>${esc(formatDots(iso))}</strong></div>
    <div class="date-nav">
      <button class="shift" type="button" data-action="shift-day" data-delta="-1" aria-label="Предыдущий день">‹</button>
      <div class="date-grid">
        <label class="field">День<input id="day" name="day" inputmode="numeric" min="1" max="31" value="${parts.day}" required /></label>
        <label class="field">Месяц<select id="month" name="month">${months}</select></label>
        <label class="field">Год<input id="year" name="year" inputmode="numeric" min="2020" max="2036" value="${parts.year}" required /></label>
      </div>
      <button class="shift" type="button" data-action="shift-day" data-delta="1" aria-label="Следующий день">›</button>
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
    const start = mondayOf(iso);
    const days = [];
    for (let index = 0; index < 7; index += 1) {
      const dayIso = addDays(start, index);
      const todayMark = dayIso === moscowIso() ? ` <span class="chip">сегодня</span>` : "";
      days.push(`<section>
        <h2><button type="button" class="day-jump" data-action="open-day" data-date="${esc(dayIso)}">${esc(weekdayName(dayIso))}, ${esc(formatDots(dayIso))}</button>${todayMark}</h2>
        ${dayBody(dayIso)}
      </section>`);
    }
    body = `<div class="week">${days.join("")}</div>`;
  } else {
    body = `<div class="lessons">${dayBody(iso)}</div>`;
  }
  return `${dateHero(iso)}
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

function moreView() {
  const notifyOn = loadNotify() && (typeof Notification === "undefined" || Notification.permission === "granted");
  return `<section class="more">
    <h1>Ещё</h1>
    <article class="block">
      <h2>Напоминание</h2>
      <p>За 10 минут до следующей пары, пока приложение открыто. Отдельный сервер уведомлений не нужен. На iPhone напоминание ограничено системой.</p>
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
      <h2>Посещаемость</h2>
      <p class="soon">Скоро</p>
      <p>Отметку сюда ещё не подключали. Пароль от личного кабинета приложение не спрашивает и не хранит.</p>
      <p><a href="https://vgltu.ru/lc/attendance" target="_blank" rel="noopener">Открыть посещаемость на vgltu.ru</a></p>
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
    more: `<circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/>`,
  };
  return `<svg ${common}>${paths[name]}</svg>`;
}

function nav() {
  const items = [
    ["today", "Сегодня"],
    ["tomorrow", "Завтра"],
    ["week", "Неделя"],
    ["more", "Ещё"],
  ];
  return `<nav class="nav">${items
    .map(([mode, label]) => `<button type="button" data-action="mode" data-mode="${mode}" ${state.mode === mode ? 'aria-current="page"' : ""}>${navIcon(mode)}${label}</button>`)
    .join("")}</nav>`;
}

function render() {
  document.title = state.group ? `Пары · ${state.group}` : "Пары";
  const offline = navigator.onLine ? "" : `<p class="offline-flag">Нет сети</p>`;
  const main = !state.group
    ? `<section class="hero"><p class="kicker">Сначала группа</p><h1 class="hero-date hero-range">Выберите код</h1><p class="weekday">Например ${esc(DEFAULT_GROUP)}. Расписание останется на этом телефоне.</p></section>`
    : state.mode === "more"
      ? moreView()
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
    ${state.pickerOpen ? pickerHtml() : ""}`;
}

function ensure(iso) {
  if (!dayByDate(iso)) refresh(iso, true);
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
  state.group = name;
  state.query = name;
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
  if (action === "mode") {
    const mode = button.dataset.mode;
    state.dateError = "";
    if (mode === "today") goToday();
    else if (mode === "tomorrow") {
      state.follow = "tomorrow";
      state.mode = "tomorrow";
      render();
      ensure(activeIso());
    } else if (mode === "week") {
      state.mode = "week";
      render();
      const start = mondayOf(activeIso());
      for (let index = 0; index < 7; index += 1) {
        if (!dayByDate(addDays(start, index))) {
          refresh(start, true);
          break;
        }
      }
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
    if (state.mode === "week") {
      const start = mondayOf(next);
      const missing = [0, 1, 2, 3, 4, 5, 6].some((index) => !dayByDate(addDays(start, index)));
      if (missing) refresh(start, true);
    } else if (!dayByDate(next)) refresh(next, true);
  } else if (action === "open-day") {
    state.follow = "none";
    state.anchor = button.dataset.date;
    state.mode = "day";
    render();
  } else if (action === "refresh") refresh(state.mode === "week" ? mondayOf(activeIso()) : activeIso(), true);
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
  } else if (action === "notify-on") enableNotify();
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
});

window.addEventListener("offline", () => render());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick();
});

window.addEventListener("pageshow", () => tick());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(() => {
      state.swReady = true;
      if (state.mode === "more") render();
    }).catch(() => {});
  });
}

async function boot() {
  state.seenToday = moscowIso();
  state.groups = await loadGroups();
  state.group = loadGroup();
  state.query = state.group || DEFAULT_GROUP;
  state.pickerOpen = !state.group;
  state.pickerCanClose = false;
  if (state.group) state.record = loadRecord(state.group) || (await readCachedRecord(state.group));
  render();
  if (state.group) refresh(moscowIso(), true);
  planNotification(state.record);
  setInterval(tick, 30000);
}

boot();
