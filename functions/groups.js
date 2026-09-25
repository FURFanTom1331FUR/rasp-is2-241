import { GROUPS_FRESH_S, cachedJson, json, loadGroups } from "./_kis.js";

// GET /groups — список групп ВГЛТУ в том же виде, что data/groups.json.
export async function onRequest(context) {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
  }
  const url = new URL(context.request.url);
  return cachedJson(context, `${url.origin}/__edge/groups`, GROUPS_FRESH_S, () => loadGroups());
}
