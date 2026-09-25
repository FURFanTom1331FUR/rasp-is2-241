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
const DATE_RE = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i;
const TIME_RE = /(\d{2}:\d{2})-(\d{2}:\d{2})/;
const SUBGROUP_BODY = String.raw`(\d)\s*п\s*[./]?\s*г\.?|(\d)\s*[-–]?\s*(?:я|ая|й)?\s*подгруппа|подгруппа\s+(\d)`;
const SUBGROUP_MARK = new RegExp(`(?:^|[\\s(«"'])(?:${SUBGROUP_BODY})(?=$|[\\s).,;:»"'])`, "i");
const SUBGROUP_LINE = new RegExp(`^(?:\\(\\s*)?(?:${SUBGROUP_BODY})\\s*\\)?\\.?$`, "i");
const SUBGROUP_STRIP = new RegExp(String.raw`(?:^|\s)\(?\s*(?:\d\s*п\s*[./]?\s*г\.?|\d\s*[-–]?\s*(?:я|ая|й)?\s*подгруппа|подгруппа\s+\d)\s*\)?(?=$|[\s.,;:])`, "gi");

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

function subgroupFromMatch(match) {
  if (!match) return null;
  const number = Number(match[1] || match[2] || match[3]);
  return number >= 1 && number <= 9 ? number : null;
}

export function subgroupNumberIn(value) {
  const text = String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return subgroupFromMatch(SUBGROUP_LINE.exec(text)) || subgroupFromMatch(SUBGROUP_MARK.exec(text));
}

export function stripSubgroupMark(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(SUBGROUP_STRIP, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function plainSubject(value) {
  return stripSubgroupMark(value)
    .replace(/^(лек|лаб|пр)\.?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

export function normalizeSubgroupChoice(value) {
  return value === "1" || value === "2" ? value : "all";
}

export function lessonSubgroup(lesson) {
  if (!lesson || typeof lesson !== "object") return subgroupNumberIn(lesson);
  const fromField = subgroupNumberIn(lesson.subgroup);
  if (fromField) return fromField;
  const fields = [lesson.subject, lesson.room, lesson.teacher, ...(Array.isArray(lesson.groups) ? lesson.groups : [])];
  for (const field of fields) {
    const number = subgroupNumberIn(field);
    if (number) return number;
  }
  return null;
}

export function subgroupBadgeLabel(number) {
  return number ? `${number} пг` : "";
}

export function lessonMatchesSubgroup(lesson, choice) {
  const selected = normalizeSubgroupChoice(choice);
  if (selected === "all") return true;
  const number = lessonSubgroup(lesson);
  if (!number) return true;
  return String(number) === selected;
}

export function subjectSubgroup(subject, sameDayLessons = []) {
  const direct = subgroupNumberIn(`${subject?.name || ""} ${subject?.type || ""}`);
  if (direct) return direct;
  const name = plainSubject(subject?.name);
  if (!name) return null;
  const matches = sameDayLessons.filter((lesson) => plainSubject(lesson.subject) === name);
  const ids = [...new Set(matches.map((lesson) => lessonSubgroup(lesson) || 0))];
  if (ids.length !== 1) return null;
  return ids[0] || null;
}

export function subjectMatchesSubgroup(subject, choice, sameDayLessons = []) {
  const selected = normalizeSubgroupChoice(choice);
  if (selected === "all") return true;
  const number = subjectSubgroup(subject, sameDayLessons);
  if (!number) return true;
  return String(number) === selected;
}

function cleanLine(line, subgroup) {
  const number = subgroupNumberIn(line);
  if (!number) return { line, subgroup };
  const stripped = stripSubgroupMark(line);
  return { line: stripped, subgroup: subgroup || number };
}

function parseCell(cellHtml, slot) {
  const lines = linesOf(cellHtml);
  if (!lines.length || !slot) return null;
  if (lines.length === 1 && lines[0].toLowerCase().startsWith("нет пар")) return null;

  let subgroup = null;
  const kept = [];
  for (const line of lines) {
    const dedicated = subgroupFromMatch(SUBGROUP_LINE.exec(line.replace(/\s+/g, " ").trim()));
    if (dedicated) {
      if (!subgroup) subgroup = dedicated;
      continue;
    }
    kept.push(line);
  }
  if (!kept.length) return null;

  let subject = kept[0];
  let lessonType = null;
  const typeMatch = TYPE_RE.exec(subject);
  if (typeMatch) {
    lessonType = typeMatch[1].toLowerCase();
    subject = typeMatch[2].trim();
  }
  const subjectLine = cleanLine(subject, subgroup);
  subject = subjectLine.line;
  subgroup = subjectLine.subgroup;
  if (!subject) return null;

  const rest = [];
  for (const line of kept.slice(1)) {
    const cleaned = cleanLine(line, subgroup);
    subgroup = cleaned.subgroup;
    if (cleaned.line) rest.push(cleaned.line);
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
    subgroup: subgroup ? `${subgroup} п.г.` : null,
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
