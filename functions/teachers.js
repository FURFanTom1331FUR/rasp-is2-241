import { TEACHERS_FRESH_S, cachedJson, json, loadTeachers, preflight, withCors } from "./_kis.js";

// GET /teachers — список преподавателей ВГЛТУ: { ok, fetchedAt, teachers: ["Фамилия И.О.", …] }.
export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(request, json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" }));
  }
  const url = new URL(request.url);
  return withCors(request, await cachedJson(context, `${url.origin}/__edge/teachers`, TEACHERS_FRESH_S, () => loadTeachers()));
}
