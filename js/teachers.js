// Расписание преподавателей: список ФИО, поиск, избранное, офлайн-копии.
// Источник тот же, что у групп: kis.vgltu.ru через прокси (functions/teachers.js, /schedule?teacher=).

const LIST_KEY = "rasp.teachers";
const CURRENT_KEY = "rasp.teacher";
const FAVORITES_KEY = "rasp.teacherFavorites";
const RECENT_KEY = "rasp.teacherRecent";
const RECORD_PREFIX = "rasp.tschedule:";
export const TEACHER_RECENT_LIMIT = 8;
export const TEACHER_SEARCH_LIMIT = 40;

const LOOKALIKE = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у" };

export function foldName(value) {
  return String(value ?? "")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[a-z]/g, (char) => LOOKALIKE[char] || char)
    .replace(/[.\s]+/g, " ")
    .trim();
}

// «гон», «Гонца», «гонца а» → совпадение по началу фамилии; затем — по любой части ФИО.
export function searchTeachers(list, query, limit = TEACHER_SEARCH_LIMIT) {
  const needle = foldName(query);
  if (!needle) return [];
  const starts = [];
  const contains = [];
  for (const name of list || []) {
    const folded = foldName(name);
    if (folded.startsWith(needle)) starts.push(name);
    else if (folded.includes(needle)) contains.push(name);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadTeacherList() {
  const data = readJson(LIST_KEY, null);
  if (!data || !Array.isArray(data.teachers)) return null;
  return { fetchedAt: String(data.fetchedAt || ""), teachers: data.teachers.map(String) };
}

export function saveTeacherList(teachers, fetchedAt) {
  writeJson(LIST_KEY, { fetchedAt, teachers });
}

export function normalizeTeacherList(payload) {
  const source = Array.isArray(payload?.teachers) ? payload.teachers : Array.isArray(payload) ? payload : [];
  return [...new Set(source.map((name) => String(name).replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function loadCurrentTeacher() {
  return localStorage.getItem(CURRENT_KEY) || "";
}

export function saveCurrentTeacher(name) {
  if (name) localStorage.setItem(CURRENT_KEY, name);
  else localStorage.removeItem(CURRENT_KEY);
}

export function loadFavorites() {
  const list = readJson(FAVORITES_KEY, []);
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

export function toggleFavorite(name) {
  const list = loadFavorites();
  const next = list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
  writeJson(FAVORITES_KEY, next);
  pruneTeacherRecords();
  return next;
}

export function loadTeacherRecent() {
  const list = readJson(RECENT_KEY, []);
  return Array.isArray(list) ? list.map(String).filter(Boolean).slice(0, TEACHER_RECENT_LIMIT) : [];
}

export function rememberTeacher(name) {
  const list = [name, ...loadTeacherRecent().filter((item) => item !== name)].slice(0, TEACHER_RECENT_LIMIT);
  writeJson(RECENT_KEY, list);
  pruneTeacherRecords();
  return list;
}

// Офлайн храним расписание только избранных и последних открытых преподавателей.
function pruneTeacherRecords() {
  const keep = new Set([...loadFavorites(), ...loadTeacherRecent(), loadCurrentTeacher()]);
  const drop = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && key.startsWith(RECORD_PREFIX) && !keep.has(key.slice(RECORD_PREFIX.length))) drop.push(key);
  }
  for (const key of drop) localStorage.removeItem(key);
}

export function loadTeacherRecord(name) {
  const record = readJson(`${RECORD_PREFIX}${name}`, null);
  return record && Array.isArray(record.days) ? record : null;
}

export function saveTeacherRecord(name, record) {
  if (writeJson(`${RECORD_PREFIX}${name}`, record)) return;
  // Память заполнена: оставляем только текущего и пробуем ещё раз.
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key && key.startsWith(RECORD_PREFIX) && key !== `${RECORD_PREFIX}${name}`) localStorage.removeItem(key);
  }
  writeJson(`${RECORD_PREFIX}${name}`, record);
}

// Новые дни заменяют старые с той же датой; держим не больше 10 недель вокруг.
export function mergeTeacherDays(base, incoming, keepFrom = "") {
  const byDate = new Map();
  for (const day of base?.days || []) byDate.set(day.date, day);
  for (const day of incoming || []) byDate.set(day.date, day);
  return [...byDate.values()]
    .filter((day) => !keepFrom || day.date >= keepFrom)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-70);
}
