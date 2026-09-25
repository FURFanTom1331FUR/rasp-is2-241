// Прокси расписания kis.vgltu.ru на том же домене, что и приложение.
// У kis.vgltu.ru нет CORS, поэтому браузер ходит сюда, а функция — к ВГЛТУ.
// Без Accept-Encoding: gzip ответ ВГЛТУ зависает после ~16 КБ, поэтому gzip обязателен.
import { parseScheduleHtml } from "../js/parse.js";

export const KIS_LIST = "https://kis.vgltu.ru/list?type=Group";
export const KIS_SCHEDULE = "https://kis.vgltu.ru/schedule";
const UA = "rasp-is2-241 schedule-proxy (+https://github.com/FURFanTom1331FUR/rasp-is2-241)";
const UPSTREAM_TIMEOUT_MS = 8000;
const WINDOW_DAYS = 14;
const MAX_WINDOWS = 3;
const GROUP_RE = /^[0-9A-Za-zА-Яа-яЁё_\-.()/ ]{2,40}$/;

// Сколько копия считается свежей и сколько её держим на случай, если ВГЛТУ не ответит.
export const SCHEDULE_FRESH_S = 45 * 60;
export const GROUPS_FRESH_S = 24 * 60 * 60;
const KEEP_S = 7 * 24 * 60 * 60;

export class UpstreamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function json(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

export function upstreamFailure(error) {
  const timeout = error?.code === "timeout";
  return json(timeout ? 504 : 502, {
    ok: false,
    error: timeout ? "upstream_timeout" : "upstream_error",
    message: timeout ? "Сайт ВГЛТУ не ответил вовремя." : "Сайт ВГЛТУ не отдал расписание.",
  });
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day && year >= 2020 && year <= 2036;
}

export function isGroupCode(value) {
  return GROUP_RE.test(value || "") && value.trim() === value;
}

export function shiftIso(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function windowCount(raw) {
  const value = Number(raw || 1);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_WINDOWS);
}

export async function fetchUpstream(url, fetchImpl = fetch, ms = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "Accept-Encoding": "gzip", Accept: "*/*", "User-Agent": UA },
      });
    } catch (error) {
      throw new UpstreamError(controller.signal.aborted ? "timeout" : "network", String(error?.message || error));
    }
    if (!response.ok) throw new UpstreamError("status", `HTTP ${response.status}`);
    try {
      return await response.text();
    } catch (error) {
      throw new UpstreamError(controller.signal.aborted ? "timeout" : "network", String(error?.message || error));
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function loadGroups(fetchImpl = fetch) {
  const text = await fetchUpstream(KIS_LIST, fetchImpl);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpstreamError("format", "Список групп не JSON");
  }
  const groups = Array.isArray(data) ? data.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!groups.length) throw new UpstreamError("format", "Пустой список групп");
  return { ok: true, fetchedAt: new Date().toISOString(), source: KIS_LIST, groups };
}

export async function loadSchedule(group, from, windows, fetchImpl = fetch) {
  const starts = Array.from({ length: windows }, (_, index) => shiftIso(from, index * WINDOW_DAYS));
  const pages = await Promise.all(
    starts.map((start) => fetchUpstream(`${KIS_SCHEDULE}?date=${start}&group=${encodeURIComponent(group)}`, fetchImpl)),
  );
  const byDate = new Map();
  for (const html of pages) {
    const days = parseScheduleHtml(html);
    if (!days.length) throw new UpstreamError("format", "ВГЛТУ вернул пустую страницу");
    for (const day of days) byDate.set(day.date, day);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    ok: true,
    group,
    fetchedAt: new Date().toISOString(),
    source: KIS_SCHEDULE,
    origin: "live",
    range: { from: days[0].date, to: days[days.length - 1].date },
    days,
  };
}

function edgeCache() {
  try {
    return globalThis.caches?.default || null;
  } catch {
    return null;
  }
}

// Копия на краю Cloudflare: свежая отдаётся сразу, устаревшая — только если ВГЛТУ не ответил.
export async function cachedJson(context, keyUrl, freshSeconds, load) {
  const cache = edgeCache();
  const key = new Request(keyUrl, { method: "GET" });
  let cached = null;
  if (cache) {
    try {
      cached = await cache.match(key);
    } catch {
      cached = null;
    }
  }
  let payload = null;
  if (cached) {
    try {
      payload = await cached.json();
    } catch {
      payload = null;
    }
  }
  const age = payload ? (Date.now() - Date.parse(payload.fetchedAt || "")) / 1000 : Infinity;
  if (payload && age >= 0 && age < freshSeconds) return json(200, payload, { "X-Rasp-Edge": "hit" });
  try {
    const fresh = await load();
    if (cache) {
      const stored = new Response(JSON.stringify(fresh), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${KEEP_S}` },
      });
      const put = cache.put(key, stored).catch(() => {});
      if (typeof context?.waitUntil === "function") context.waitUntil(put);
      else await put;
    }
    return json(200, fresh, { "X-Rasp-Edge": "miss" });
  } catch (error) {
    if (payload) return json(200, { ...payload, stale: true }, { "X-Rasp-Edge": "stale" });
    return upstreamFailure(error);
  }
}
