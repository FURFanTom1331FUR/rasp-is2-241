const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

function partsInZone(date, timeZone) {
  const list = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const bag = {};
  for (const part of list) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  let day = Number(bag.day);
  let month = Number(bag.month);
  let year = Number(bag.year);
  if (hour === 24) hour = 0;
  return { year, month, day, hour, minute: Number(bag.minute), second: Number(bag.second) };
}

export function moscowOffsetMinutes(instant) {
  const moscow = partsInZone(instant, "Europe/Moscow");
  const utc = partsInZone(instant, "UTC");
  const moscowMs = Date.UTC(moscow.year, moscow.month - 1, moscow.day, moscow.hour, moscow.minute, moscow.second);
  const utcMs = Date.UTC(utc.year, utc.month - 1, utc.day, utc.hour, utc.minute, utc.second);
  return Math.round((moscowMs - utcMs) / 60000);
}

export function moscowIso(instant = new Date()) {
  const parts = partsInZone(instant, "Europe/Moscow");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function formatDots(iso) {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

export function monthName(monthNumber) {
  return MONTHS[monthNumber - 1] || "";
}

export function monthNames() {
  return MONTHS.slice();
}

export function isValidIso(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || year < 1000) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function addDays(iso, amount) {
  const [year, month, day] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day + amount));
  const y = probe.getUTCFullYear();
  const m = String(probe.getUTCMonth() + 1).padStart(2, "0");
  const d = String(probe.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function mondayOf(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addDays(iso, delta);
}

// Неделя в приложении заканчивается в воскресенье: в HTML расписания ВГЛТУ
// воскресенье есть отдельным днём (часто «Нет пар.»), поэтому суббота не взята за конец.
export function visibleWeekDays(anchorIso, todayIso) {
  const end = addDays(mondayOf(anchorIso), 6);
  let cursor = mondayOf(anchorIso);
  if (cursor < todayIso) cursor = todayIso;
  const days = [];
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function semesterRange(iso) {
  const { year, month } = splitIso(iso);
  if (month >= 9) {
    return { from: `${year}-09-01`, to: `${year + 1}-01-31`, label: "Осенний семестр" };
  }
  if (month === 1) {
    return { from: `${year - 1}-09-01`, to: `${year}-01-31`, label: "Осенний семестр" };
  }
  return { from: `${year}-02-01`, to: `${year}-08-31`, label: "Весенний семестр" };
}

export function weekdayName(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 9, 0, 0));
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "long",
  }).format(noon);
}

export function moscowInstant(iso, hhmm) {
  const [year, month, day] = iso.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const wallAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = moscowOffsetMinutes(wallAsUtc);
  return new Date(wallAsUtc.getTime() - offset * 60000);
}

export function formatStamp(isoString) {
  const instant = new Date(isoString);
  if (Number.isNaN(instant.getTime())) return "";
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(instant);
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${date}, ${time} МСК`;
}

export function splitIso(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}
