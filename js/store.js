const GROUP_KEY = "rasp.group";
const DATA_CACHE = "rasp-data-v1";

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

function recordKey(group) {
  return `rasp.schedule:${group}`;
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

export async function saveRecord(group, record) {
  const payload = { ...record, group };
  localStorage.setItem(recordKey(group), JSON.stringify(payload));
  try {
    const cache = await caches.open(DATA_CACHE);
    const url = new URL(`./data/schedules/${encodeURIComponent(group)}.json`, location.href);
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
    const url = new URL(`./data/schedules/${encodeURIComponent(group)}.json`, location.href);
    const response = await cache.match(url);
    if (!response) return null;
    return await response.json();
  } catch {
    return null;
  }
}
