import { ATTENDANCE_ORIGINS } from './config.js';
import { fetchText } from './net.js';

export const PROBE_TIMEOUT_MS = 2500;
let selected = '', selectedAt = 0, pending;
const failedUntil = new Map();
export function forgetAttendanceRoute(origin) {
  failedUntil.set(origin, Date.now() + 30000);
  if (selected === origin) { selected = ''; selectedAt = 0; }
}
function origins(primary) {
  const url = new URL(primary);
  // Preserve explicit local dev endpoints. Production fallback uses only the
  // hardcoded project services; never consult localStorage for credential URLs.
  if (['localhost', '127.0.0.1'].includes(url.hostname)) return [primary];
  if (!ATTENDANCE_ORIGINS.includes(primary) && !url.hostname.endsWith('.rasp-is2-241.pages.dev')) throw Error('Untrusted attendance server');
  return [...new Set([primary, ...ATTENDANCE_ORIGINS])];
}
export async function attendanceRoute(primary) {
  const allowed = origins(primary);
  if (allowed.includes(selected) && Date.now() - selectedAt < 60000) return selected;
  if (pending?.primary === primary) return pending.promise;
  const candidates = allowed.filter(origin => (failedUntil.get(origin) || 0) <= Date.now());
  const controllers = [];
  const task = Promise.any((candidates.length ? candidates : allowed).map(async origin => {
    const controller = new AbortController(); controllers.push(controller);
    // Empty login is rejected locally by the proxy, without contacting vgltu.ru
    // or sending a student ID/password/token. It also exercises CORS preflight.
    const response = await fetchText(`${origin}/login`, {
      method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
    }, PROBE_TIMEOUT_MS);
    const data = JSON.parse(response.text);
    if (response.status !== 400 || data?.ok !== false || data.error !== 'Введите ID студента и пароль.') throw Error('Not an attendance proxy');
    return origin;
  })).then(origin => {
    selected = origin; selectedAt = Date.now(); return origin;
  }).finally(() => {
    controllers.forEach(controller => controller.abort());
    pending = null;
  });
  pending = { primary, promise: task };
  return task;
}
