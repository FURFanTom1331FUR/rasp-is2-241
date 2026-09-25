export const FETCH_TIMEOUT_MS = 5000;

export async function fetchText(input, init = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const parent = init.signal;
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onAbort);
  }
}
