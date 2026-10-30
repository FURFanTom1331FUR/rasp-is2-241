// Версия приложения. При выпуске поднять номер здесь, в version.json и SHELL в sw.js
// («rasp-shell-vN»), дату и список изменений — одинаково в этом файле и в version.json.
export const APP_VERSION = 20;
export const APP_DATE = "2026-10-30";
export const APP_CHANGES = [
  "Вход с зеркала выбирает доступный сервер посещаемости до отправки пароля; недоступный Pages больше не единственный маршрут.",
  "Быстрая проверка доступности, ограниченное ожидание ответа и точные ошибки без предположений о Wi-Fi или «белых списках». Сохранённая сессия не удаляется при сетевой ошибке.",
  "В «Ещё» добавлены светлая, тёмная и тема «Лес»: выбор сохраняется и применяется до отображения, без сетевых шрифтов."
];

// Ответ version.json → { version, date, changes } или null.
export function normalizeVersionInfo(data) {
  const version = Number(data?.version);
  if (!Number.isInteger(version) || version < 1) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(data?.date || "")) ? String(data.date) : "";
  const changes = Array.isArray(data?.changes) ? data.changes.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [];
  return { version, date, changes };
}

export function isNewer(info, current = APP_VERSION) {
  return Boolean(info) && Number(info.version) > current;
}

// Защита от цикла перезагрузок: для одной и той же версии — не чаще раза в 2 минуты.
export const RELOAD_GUARD_MS = 2 * 60 * 1000;

export function reloadAllowed(previous, version, now = Date.now()) {
  if (!previous || typeof previous !== "object") return true;
  if (String(previous.version) !== String(version)) return true;
  const at = Number(previous.at);
  return !Number.isFinite(at) || now - at < 0 || now - at >= RELOAD_GUARD_MS;
}
