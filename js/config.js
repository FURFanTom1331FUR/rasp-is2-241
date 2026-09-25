// Пустая строка — тот же адрес, с которого открыт сайт (корень Cloudflare Pages).
// Пароль студента сюда не кладётся.
export const WORKER_URL = "";

// Прокси расписания и входа живёт только на Cloudflare Pages (functions/).
// Зеркало на GitHub Pages и любые другие адреса ходят туда напрямую (CORS).
export const PAGES_ORIGIN = "https://rasp-is2-241.pages.dev";

export function isProxyHost(hostname = globalThis.location?.hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  return host === "rasp-is2-241.pages.dev" || host.endsWith(".rasp-is2-241.pages.dev");
}

// Основа адресов /schedule и /groups: «./» на своём домене, иначе pages.dev.
export function apiBase(hostname = globalThis.location?.hostname) {
  return isProxyHost(hostname) ? "./" : `${PAGES_ORIGIN}/`;
}
