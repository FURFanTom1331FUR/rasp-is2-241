import { handlePush } from "../_push.js";

// /push/key · /push/subscribe · /push/unsubscribe · /push/status · /push/test
export function onRequest(context) {
  return handlePush(context, String(context.params.action || ""));
}
