import { preflight, withCors, json } from "./_kis.js";
import { handleRooms } from "./_rooms.js";

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(request, json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" }));
  }
  return withCors(request, await handleRooms(context));
}
