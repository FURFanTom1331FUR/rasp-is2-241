import handler from "../worker/src/index.js";

export function onRequest(context) {
  return handler.fetch(context.request);
}
