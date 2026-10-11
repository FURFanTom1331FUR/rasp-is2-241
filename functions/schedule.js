import { SCHEDULE_FRESH_S, cachedJson, isGroupCode, isIsoDate, isTeacherName, json, loadSchedule, preflight, windowCount, withCors } from "./_kis.js";

// GET /schedule?date=ГГГГ-ММ-ДД&group=КОД[&windows=1..3]
// GET /schedule?date=ГГГГ-ММ-ДД&teacher=Фамилия И.О.[&windows=1..3] — расписание преподавателя
// Одно окно — 14 дней начиная с date, как на kis.vgltu.ru. Ответ — уже разобранные дни.
export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight(request);
  return withCors(request, await handle(context));
}

async function handle(context) {
  const { request } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "";
  const group = (url.searchParams.get("group") || "").trim();
  const teacher = (url.searchParams.get("teacher") || "").replace(/\s+/g, " ").trim();
  const windows = windowCount(url.searchParams.get("windows"));
  if (!isIsoDate(date)) return json(400, { ok: false, error: "bad_date", message: "Дата должна быть в формате ГГГГ-ММ-ДД." });
  if (teacher && !group) {
    if (!isTeacherName(teacher)) return json(400, { ok: false, error: "bad_teacher", message: "Неверное ФИО преподавателя." });
    const tkey = `${url.origin}/__edge/schedule?date=${date}&teacher=${encodeURIComponent(teacher)}&windows=${windows}`;
    return cachedJson(context, tkey, SCHEDULE_FRESH_S, () => loadSchedule(teacher, date, windows, fetch, "teacher"));
  }
  if (!isGroupCode(group)) return json(400, { ok: false, error: "bad_group", message: "Неверный код группы." });
  const key = `${url.origin}/__edge/schedule?date=${date}&group=${encodeURIComponent(group)}&windows=${windows}`;
  return cachedJson(context, key, SCHEDULE_FRESH_S, () => loadSchedule(group, date, windows));
}
