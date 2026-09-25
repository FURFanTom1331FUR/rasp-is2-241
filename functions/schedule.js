import { SCHEDULE_FRESH_S, cachedJson, isGroupCode, isIsoDate, json, loadSchedule, windowCount } from "./_kis.js";

// GET /schedule?date=ГГГГ-ММ-ДД&group=КОД[&windows=1..3]
// Одно окно — 14 дней начиная с date, как на kis.vgltu.ru. Ответ — уже разобранные дни.
export async function onRequest(context) {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
  }
  const url = new URL(context.request.url);
  const date = url.searchParams.get("date") || "";
  const group = (url.searchParams.get("group") || "").trim();
  const windows = windowCount(url.searchParams.get("windows"));
  if (!isIsoDate(date)) return json(400, { ok: false, error: "bad_date", message: "Дата должна быть в формате ГГГГ-ММ-ДД." });
  if (!isGroupCode(group)) return json(400, { ok: false, error: "bad_group", message: "Неверный код группы." });
  const key = `${url.origin}/__edge/schedule?date=${date}&group=${encodeURIComponent(group)}&windows=${windows}`;
  return cachedJson(context, key, SCHEDULE_FRESH_S, () => loadSchedule(group, date, windows));
}
