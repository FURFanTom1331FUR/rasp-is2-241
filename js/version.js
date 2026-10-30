// Версия приложения. При выпуске поднять номер здесь, в version.json и SHELL в sw.js
// («rasp-shell-vN»), дату и список изменений — одинаково в этом файле и в version.json.
export const APP_VERSION = 19;
export const APP_DATE = "2026-10-30";
export const APP_CHANGES = [
  "Исправлены баги версии 18: проверка обновлений не ждёт зависшую загрузку service worker.",
  "Новая оболочка устанавливается только целиком; старый код не подмешивается, необязательные снимки не задерживают установку.",
  "Кнопка «Восстановить файлы приложения» повторно скачивает оболочку, сохраняя расписания, посещаемость и настройки."
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
