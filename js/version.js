// Версия приложения. При выпуске поднять номер здесь, в version.json и SHELL в sw.js
// («rasp-shell-vN»), дату и список изменений — одинаково в этом файле и в version.json.
export const APP_VERSION = 12;
export const APP_DATE = "2026-10-11";
export const APP_CHANGES = [
  "Посещаемость: приложение ждёт ответа кабинета ВГЛТУ до 30 секунд вместо 5 — больше нет ложной ошибки «Нет связи с сервером посещаемости».",
  "Журнал и ФИО загружаются одновременно, поэтому посещаемость открывается быстрее.",
  "Если vgltu.ru долго не отвечает, приложение так и пишет, а не «нет связи»."
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
