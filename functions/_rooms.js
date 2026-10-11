// Свободные аудитории: расписание аудиторий с kis.vgltu.ru (schedule?auditory=…).
// Корпус делится на части по ROOM_PART комнат — у Pages Functions лимит подзапросов на вызов.
// Каждая часть (14 дней с понедельника) хранится на краю Cloudflare ROOMS_FRESH_S секунд,
// так что сайт ВГЛТУ получает не больше одного запроса на аудиторию раз в несколько часов.
import { parseScheduleHtml } from "../js/parse.js";
import { KIS_SCHEDULE, UpstreamError, fetchUpstream, isIsoDate, json } from "./_kis.js";

export const KIS_ROOMS = "https://kis.vgltu.ru/list?type=Auditory";
export const ROOM_PART = 16;
export const ROOMS_FRESH_S = 6 * 60 * 60;
export const ROOM_LIST_FRESH_S = 24 * 60 * 60;
const KEEP_S = 3 * 24 * 60 * 60;
const CONCURRENCY = 4;
const ROOM_TIMEOUT_MS = 8000;

// «207Пр/АПП» → «АПП», «113Ин.яз./9к» → «9к», «10информ/10к» → «10к», «110Л/11к комп» → «11к».
export function buildingOf(room) {
  const text = String(room || "");
  const slash = text.lastIndexOf("/");
  if (slash < 0) return "";
  let key = text.slice(slash + 1).trim().split(/\s+/)[0] || "";
  if (/^\d+кор$/i.test(key)) key = key.replace(/кор$/i, "к");
  return key;
}

export function groupRooms(rooms, minRooms = 3) {
  const map = new Map();
  for (const room of rooms) {
    const key = buildingOf(room);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(room);
  }
  const out = {};
  for (const [key, list] of map) {
    if (list.length >= minRooms) out[key] = [...new Set(list)].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  }
  return out;
}

export function mondayIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return date.toISOString().slice(0, 10);
}

function edgeCache() {
  try {
    return globalThis.caches?.default || null;
  } catch {
    return null;
  }
}

async function readEdge(cache, key) {
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

function writeEdge(context, cache, key, payload) {
  if (!cache) return;
  const put = cache
    .put(key, new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${KEEP_S}` } }))
    .catch(() => {});
  if (typeof context?.waitUntil === "function") context.waitUntil(put);
}

function ageOf(payload) {
  const at = Date.parse(payload?.fetchedAt || "");
  return Number.isNaN(at) ? Infinity : (Date.now() - at) / 1000;
}

export async function loadRoomList(fetchImpl = fetch) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = JSON.parse(await fetchUpstream(KIS_ROOMS, fetchImpl));
      const rooms = Array.isArray(data) ? [...new Set(data.map((r) => String(r).replace(/\s+/g, " ").trim()).filter(Boolean))] : [];
      if (rooms.length < 50) throw new UpstreamError("format", "Короткий список аудиторий");
      return { ok: true, fetchedAt: new Date().toISOString(), source: KIS_ROOMS, rooms, buildings: groupRooms(rooms) };
    } catch (error) {
      last = error;
    }
  }
  throw last || new UpstreamError("network", "Список аудиторий недоступен");
}

async function roomList(context, origin, fetchImpl) {
  const cache = edgeCache();
  const key = new Request(`${origin}/__edge/rooms-list`);
  const cached = await readEdge(cache, key);
  if (cached && ageOf(cached) < ROOM_LIST_FRESH_S) return cached;
  try {
    const fresh = await loadRoomList(fetchImpl);
    writeEdge(context, cache, key, fresh);
    return fresh;
  } catch (error) {
    if (cached) return { ...cached, stale: true };
    // Запасная копия из репозитория (data/rooms.json), если kis.vgltu.ru молчит.
    try {
      const asset = await context?.env?.ASSETS?.fetch(new Request(`${origin}/data/rooms.json`));
      if (asset?.ok) {
        const data = await asset.json();
        return { ok: true, fetchedAt: data.fetchedAt, source: KIS_ROOMS, rooms: data.rooms, buildings: groupRooms(data.rooms), stale: true };
      }
    } catch {
      /* нет копии */
    }
    throw error;
  }
}

function compactLesson(lesson) {
  return {
    start: lesson.start,
    end: lesson.end,
    type: lesson.type || null,
    subject: lesson.subject,
    groups: lesson.groups || [],
    teacher: lesson.teacher || "",
    subgroup: lesson.subgroup || null,
  };
}

export async function loadRoomWindow(room, monday, fetchImpl = fetch) {
  const url = `${KIS_SCHEDULE}?date=${monday}&auditory=${encodeURIComponent(room)}`;
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const days = parseScheduleHtml(await fetchUpstream(url, fetchImpl, ROOM_TIMEOUT_MS));
      if (!days.length) throw new UpstreamError("format", "Пустая страница");
      return { room, ok: true, days: days.map((day) => ({ date: day.date, lessons: day.lessons.map(compactLesson) })) };
    } catch (error) {
      last = error;
    }
  }
  return { room, ok: false, error: String(last?.code || "error") };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function loadRoomPart(rooms, monday, fetchImpl = fetch) {
  const results = await pool(rooms, CONCURRENCY, (room) => loadRoomWindow(room, monday, fetchImpl));
  const failed = results.filter((item) => !item.ok).length;
  // Часть комнат не скачалась — копия считается свежей только ~20 минут, потом попробуем снова.
  const at = failed ? Date.now() - (ROOMS_FRESH_S - 20 * 60) * 1000 : Date.now();
  return { ok: true, monday, fetchedAt: new Date(at).toISOString(), failed, rooms: results };
}

export function sliceDay(part, date) {
  return part.rooms.map((item) => {
    if (!item.ok) return { room: item.room, ok: false, lessons: [] };
    const day = item.days.find((d) => d.date === date);
    return { room: item.room, ok: Boolean(day), lessons: day ? day.lessons : [] };
  });
}

// GET /rooms → список аудиторий по корпусам.
// GET /rooms?building=Гл&date=ГГГГ-ММ-ДД&part=0 → занятость одной части корпуса на этот день.
export async function handleRooms(context, fetchImpl = fetch) {
  const url = new URL(context.request.url);
  const building = (url.searchParams.get("building") || "").trim();
  let list;
  try {
    list = await roomList(context, url.origin, fetchImpl);
  } catch {
    return json(502, { ok: false, error: "upstream_error", message: "Сайт ВГЛТУ не отдал список аудиторий." });
  }
  if (!building) {
    return json(200, { ok: true, fetchedAt: list.fetchedAt, buildings: list.buildings, part: ROOM_PART, stale: Boolean(list.stale) });
  }
  const rooms = list.buildings?.[building];
  if (!rooms) return json(404, { ok: false, error: "bad_building", message: "Нет такого корпуса." });
  const date = url.searchParams.get("date") || "";
  if (!isIsoDate(date)) return json(400, { ok: false, error: "bad_date", message: "Дата должна быть в формате ГГГГ-ММ-ДД." });
  const parts = Math.ceil(rooms.length / ROOM_PART);
  const part = Number(url.searchParams.get("part") || 0);
  if (!Number.isInteger(part) || part < 0 || part >= parts) return json(400, { ok: false, error: "bad_part", message: "Неверная часть." });
  const chunk = rooms.slice(part * ROOM_PART, (part + 1) * ROOM_PART);
  const monday = mondayIso(date);
  const cache = edgeCache();
  const key = new Request(`${url.origin}/__edge/rooms?b=${encodeURIComponent(building)}&m=${monday}&p=${part}&n=${encodeURIComponent(chunk.join("|")).slice(0, 200)}`);
  let payload = await readEdge(cache, key);
  let edge = "hit";
  if (!payload || ageOf(payload) >= ROOMS_FRESH_S) {
    const fresh = await loadRoomPart(chunk, monday, fetchImpl);
    if (fresh.failed < chunk.length) {
      writeEdge(context, cache, key, fresh);
      payload = fresh;
      edge = "miss";
    } else if (payload) {
      edge = "stale";
    } else {
      return json(504, { ok: false, error: "upstream_timeout", message: "Сайт ВГЛТУ не отдал расписание аудиторий." });
    }
  }
  return json(200, {
    ok: true,
    building,
    date,
    part,
    parts,
    total: rooms.length,
    fetchedAt: payload.fetchedAt,
    rooms: sliceDay(payload, date),
  }, { "X-Rasp-Edge": edge });
}
