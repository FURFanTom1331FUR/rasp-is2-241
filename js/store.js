const GROUP_KEY = "rasp.group";
const DATA_CACHE = "rasp-data-v1";
const RECENT_KEY = "rasp.recent";
const RECORD_PREFIX = "rasp.schedule:";
export const RECENT_LIMIT = 10;

export function loadGroup() {
  return localStorage.getItem(GROUP_KEY) || "";
}

export function saveGroup(group) {
  localStorage.setItem(GROUP_KEY, group);
}

export function loadNotify() {
  return localStorage.getItem("rasp.notify") === "1";
}

export function saveNotify(enabled) {
  localStorage.setItem("rasp.notify", enabled ? "1" : "0");
}

export function loadInstallDismissed() {
  return localStorage.getItem("rasp.installTip") === "0";
}

export function dismissInstallTip() {
  localStorage.setItem("rasp.installTip", "0");
}

export function loadSubgroup() {
  const value = localStorage.getItem("rasp.subgroup");
  return value === "1" || value === "2" ? value : "all";
}

export function saveSubgroup(value) {
  const next = value === "1" || value === "2" ? value : "all";
  localStorage.setItem("rasp.subgroup", next);
  return next;
}

function recordKey(group) {
  return `${RECORD_PREFIX}${group}`;
}

function recordUrl(group) {
  return new URL(`./data/schedules/${encodeURIComponent(group)}.json`, location.href);
}

function storedRecordGroups() {
  const groups = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && key.startsWith(RECORD_PREFIX)) groups.push(key.slice(RECORD_PREFIX.length));
  }
  return groups;
}

// Последние открытые группы: их расписание храним офлайн, остальное удаляем.
export function loadRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || "null");
    if (Array.isArray(saved)) return saved.map(String).filter(Boolean).slice(0, RECENT_LIMIT);
  } catch {
    /* Повреждённый список собираем заново. */
  }
  const current = loadGroup();
  const known = storedRecordGroups()
    .map((group) => ({ group, time: fetchedTime(loadRecord(group)) }))
    .sort((a, b) => b.time - a.time)
    .map((item) => item.group);
  return [...new Set([current, ...known].filter(Boolean))].slice(0, RECENT_LIMIT);
}

function forgetRecord(group) {
  localStorage.removeItem(recordKey(group));
  try {
    caches
      .open(DATA_CACHE)
      .then((cache) => cache.delete(recordUrl(group)))
      .catch(() => {});
  } catch {
    /* Cache API может быть недоступен. */
  }
}

function pruneRecords(keep) {
  const allowed = new Set(keep);
  for (const group of storedRecordGroups()) {
    if (!allowed.has(group)) forgetRecord(group);
  }
}

export function rememberRecent(group) {
  if (!group) return loadRecent();
  const list = [group, ...loadRecent().filter((item) => item !== group)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* Память может быть заполнена — ниже освободим место. */
  }
  pruneRecords([...list, loadGroup()]);
  return list;
}

export function loadRecord(group) {
  try {
    const raw = localStorage.getItem(recordKey(group));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fetchedTime(record) {
  const value = Date.parse(record?.fetchedAt || "");
  return Number.isNaN(value) ? 0 : value;
}

export function mergeRecords(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;
  const incomingNewer = fetchedTime(incoming) >= fetchedTime(base);
  const primary = incomingNewer ? incoming : base;
  const secondary = incomingNewer ? base : incoming;
  const byDate = new Map();
  for (const day of secondary.days || []) byDate.set(day.date, day);
  for (const day of primary.days || []) byDate.set(day.date, day);
  return {
    group: primary.group || secondary.group,
    fetchedAt: primary.fetchedAt,
    source: primary.source,
    origin: primary.origin || secondary.origin || "cache",
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function writeRecord(group, text) {
  try {
    localStorage.setItem(recordKey(group), text);
    return;
  } catch {
    /* Не влезло: освобождаем место от самых старых групп и пробуем ещё раз. */
  }
  const keep = [loadGroup(), group];
  const recent = loadRecent().filter((item) => !keep.includes(item));
  while (recent.length) {
    forgetRecord(recent.pop());
    try {
      localStorage.setItem(recordKey(group), text);
      return;
    } catch {
      /* Дальше удаляем следующую. */
    }
  }
  try {
    localStorage.setItem(recordKey(group), text);
  } catch {
    /* Остаётся копия в Cache API ниже. */
  }
}

export async function saveRecord(group, record) {
  const payload = { ...record, group };
  writeRecord(group, JSON.stringify(payload));
  try {
    const cache = await caches.open(DATA_CACHE);
    const url = recordUrl(group);
    await cache.put(
      url,
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );
  } catch {
    /* Cache API может быть недоступен. localStorage уже записан. */
  }
  return payload;
}

export async function readCachedRecord(group) {
  try {
    const cache = await caches.open(DATA_CACHE);
    const response = await cache.match(recordUrl(group));
    if (!response) return null;
    const record = await response.json();
    return Array.isArray(record?.days) ? record : null;
  } catch {
    return null;
  }
}
