// Версия приложения. При выпуске поднять номер здесь, в version.json и SHELL в sw.js
// («rasp-shell-vN»), дату и список изменений — одинаково в этом файле и в version.json.
export const APP_VERSION = 17;
export const APP_DATE = "2026-10-12";
export const APP_CHANGES = [
  "Уведомления о парах теперь приходят с сервера, даже когда приложение закрыто: выберите за сколько минут, подгруппу и «не беспокоить» в «Ещё», проверьте кнопкой «Прислать тестовое».",
  "Свайп влево/вправо листает дни и недели (и у преподавателей), потяните вниз — обновить, нажмите на дату — календарь, кнопка «Сегодня», если ушли с сегодняшнего дня.",
  "Сегодня: линия «сейчас», «через N мин» у следующей пары и полоса прогресса текущей; долгое нажатие на пару — быстрые действия; приложение открывается на последней вкладке."
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
