// Свободные аудитории: пары, занятость, подписи корпусов, офлайн-копии ответов.

export const PAIRS = [
  [1, "08:30", "10:00"],
  [2, "10:10", "11:40"],
  [3, "11:50", "13:20"],
  [4, "13:40", "15:10"],
  [5, "15:20", "16:50"],
  [6, "17:00", "18:30"],
  [7, "18:40", "20:10"],
  [8, "20:20", "21:50"],
];

const LABELS = {
  Гл: "Главный корпус",
  АПП: "АПП",
  БЖД: "БЖД",
  НИИ: "НИИ",
  ПРЭМ: "ПРЭМ",
  АГор: "АГор",
  ОБД: "ОБД",
};

export function buildingLabel(key) {
  if (LABELS[key]) return LABELS[key];
  const match = /^(\d+)к$/i.exec(key);
  return match ? `Корпус ${match[1]}` : key;
}

export function sortBuildings(keys) {
  const rank = (key) => (key === "Гл" ? -1 : /^\d+к$/i.test(key) ? Number.parseInt(key, 10) : 100);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "ru"));
}

// Пара, которая идёт сейчас, иначе ближайшая следующая; после последней — null.
export function pairAt(hhmm) {
  for (const pair of PAIRS) if (hhmm < pair[2]) return pair[0];
  return null;
}

export function pairById(id) {
  return PAIRS.find((pair) => pair[0] === Number(id)) || PAIRS[0];
}

function overlaps(lesson, start, end) {
  return lesson.start < end && lesson.end > start;
}

// { busy: занятие в это время | null, until: "13:40" — до какого времени свободна/занята, или "" — до конца дня }
export function occupancy(lessons, start, end) {
  const sorted = [...(lessons || [])].sort((a, b) => a.start.localeCompare(b.start));
  const busy = sorted.find((lesson) => overlaps(lesson, start, end)) || null;
  if (busy) {
    // Подряд идущие пары без перерыва больше 20 минут считаем одной занятостью.
    let until = busy.end;
    for (const lesson of sorted) {
      if (lesson.start >= busy.start && lesson.start <= addMinutes(until, 20) && lesson.end > until) until = lesson.end;
    }
    return { busy, until };
  }
  const next = sorted.find((lesson) => lesson.start >= end);
  return { busy: null, until: next ? next.start : "" };
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function splitRooms(entries, start, end) {
  const free = [];
  const busy = [];
  const unknown = [];
  for (const entry of entries) {
    if (!entry.ok) {
      unknown.push({ room: entry.room });
      continue;
    }
    const state = occupancy(entry.lessons, start, end);
    if (state.busy) busy.push({ room: entry.room, ...state });
    else free.push({ room: entry.room, ...state });
  }
  const byRoom = (a, b) => a.room.localeCompare(b.room, "ru", { numeric: true });
  // Сначала аудитории, свободные дольше всего.
  free.sort((a, b) => (a.until ? 0 : -1) - (b.until ? 0 : -1) || (b.until || "").localeCompare(a.until || "") || byRoom(a, b));
  busy.sort((a, b) => a.until.localeCompare(b.until) || byRoom(a, b));
  unknown.sort(byRoom);
  return { free, busy, unknown };
}

const CACHE_PREFIX = "rasp.rooms:";
const CACHE_INDEX = "rasp.roomsIndex";
const CACHE_LIMIT = 6;

export function loadRoomsCache(building, date) {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${building}:${date}`);
    const data = raw ? JSON.parse(raw) : null;
    return data && Array.isArray(data.rooms) ? data : null;
  } catch {
    return null;
  }
}

export function saveRoomsCache(building, date, data) {
  const key = `${CACHE_PREFIX}${building}:${date}`;
  try {
    const index = JSON.parse(localStorage.getItem(CACHE_INDEX) || "[]").filter((item) => item !== key);
    index.unshift(key);
    for (const old of index.slice(CACHE_LIMIT)) localStorage.removeItem(old);
    localStorage.setItem(CACHE_INDEX, JSON.stringify(index.slice(0, CACHE_LIMIT)));
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* память заполнена — копия не обязательна */
  }
}
