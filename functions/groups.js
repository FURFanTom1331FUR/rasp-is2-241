import { GROUPS_FRESH_S, cachedJson, json, loadGroups, preflight, withCors } from "./_kis.js";

// GET /groups — список групп ВГЛТУ в том же виде, что data/groups.json.
export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(request, json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" }));
  }
  const url = new URL(request.url);
  return withCors(request, await cachedJson(context, `${url.origin}/__edge/groups`, GROUPS_FRESH_S, () => loadGroups()));
}
