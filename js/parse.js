const MONTHS = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

const TYPE_RE = /^(лек|лаб|пр)\.\s*(.+)$/i;
const SUBGROUP_RE = /^(\d+)\s*п\.г\.?$/i;
const DATE_RE = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i;
const TIME_RE = /(\d{2}:\d{2})-(\d{2}:\d{2})/;

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function linesOf(cellHtml) {
  const text = decodeHtml(cellHtml.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\u00a0/g, " ");
  return text
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseRuDate(label) {
  const match = DATE_RE.exec(label.replace(/\s+/g, " "));
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (!month) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseCell(cellHtml, slot) {
  const lines = linesOf(cellHtml);
  if (!lines.length || !slot) return null;
  if (lines.length === 1 && lines[0].toLowerCase().startsWith("нет пар")) return null;

  let subject = lines[0];
  let lessonType = null;
  const typeMatch = TYPE_RE.exec(subject);
  if (typeMatch) {
    lessonType = typeMatch[1].toLowerCase();
    subject = typeMatch[2].trim();
  }

  let rest = lines.slice(1);
  let subgroup = null;
  const subgroupMatch = rest.length ? SUBGROUP_RE.exec(rest[0]) : null;
  if (subgroupMatch) {
    subgroup = `${subgroupMatch[1]} п.г.`;
    rest = rest.slice(1);
  }

  const teacher = rest.length ? rest[rest.length - 1] : "";
  const room = rest.length >= 2 ? rest[rest.length - 2] : "";
  const groups = rest.length >= 2 ? rest.slice(0, -2) : [];
  const [start, end] = slot.split("-");
  return {
    time: slot,
    start,
    end,
    type: lessonType,
    subject,
    subgroup,
    room,
    teacher,
    groups,
  };
}

export function parseScheduleHtml(rawHtml) {
  const text = decodeHtml(rawHtml);
  const parts = text.split(/<div>\s*<strong>/i).slice(1);
  const days = [];
  for (const part of parts) {
    const labelMatch = /^(.*?)<\/strong>/is.exec(part);
    if (!labelMatch) continue;
    const iso = parseRuDate(labelMatch[1].replace(/\s+/g, " "));
    if (!iso) continue;
    const tableMatch = /<table[^>]*>(.*?)<\/table>/is.exec(part);
    const lessons = [];
    let currentTime = null;
    if (tableMatch) {
      const rows = tableMatch[1].match(/<tr\b[^>]*>.*?<\/tr>/gis) || [];
      for (const row of rows) {
        const cells = row.match(/<td\b[^>]*>.*?<\/td>/gis) || [];
        if (!cells.length) continue;
        const inner = cells.map((cell) => cell.replace(/^<td\b[^>]*>/i, "").replace(/<\/td>$/i, ""));
        const content = inner[inner.length - 1];
        if (inner.length >= 2) {
          const timeMatch = TIME_RE.exec(decodeHtml(inner[0].replace(/<[^>]+>/g, "")));
          if (timeMatch) currentTime = `${timeMatch[1]}-${timeMatch[2]}`;
        }
        const lesson = parseCell(content, currentTime);
        if (lesson) lessons.push(lesson);
      }
    }
    lessons.sort((a, b) => a.start.localeCompare(b.start) || (a.subgroup || "").localeCompare(b.subgroup || "") || a.subject.localeCompare(b.subject, "ru"));
    days.push({ date: iso, lessons });
  }
  return days;
}
