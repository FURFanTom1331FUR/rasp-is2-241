// Пустая строка — тот же адрес, с которого открыт сайт (корень Cloudflare Pages).
// Пароль студента сюда не кладётся.
export const WORKER_URL = "";

// Прокси расписания живёт на Cloudflare Pages (functions/).
// Посещаемость выбирает доступный сервер из отдельного списка ниже.
export const PAGES_ORIGIN = "https://rasp-is2-241.pages.dev";

// Existing university-session proxies owned by this project (repository history).
// Credentials may only go to these fixed HTTPS origins, never a discovered URL.
export const ATTENDANCE_ORIGINS = [
  "https://rasp-attendance.integrall1331.workers.dev",
  "https://rasp-attendance.harsh-raft.workers.dev",
  PAGES_ORIGIN,
];

export function isProxyHost(hostname = globalThis.location?.hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  return host === "rasp-is2-241.pages.dev" || host.endsWith(".rasp-is2-241.pages.dev");
}

// Основа адресов /schedule и /groups: «./» на своём домене, иначе pages.dev.
export function apiBase(hostname = globalThis.location?.hostname) {
  return isProxyHost(hostname) ? "./" : `${PAGES_ORIGIN}/`;
}

// Публичный VAPID-ключ для Web Push (приватный — секрет на Cloudflare).
export const VAPID_PUBLIC = "BIPvIGO8-hPCdJ6ncfAigWTzdTPlKWVWTVUYpf0QnQ_rAHPYz7PcfdO2r7m32GfS7tuzgrfRBJWndg-Y0Haq9Vk";
