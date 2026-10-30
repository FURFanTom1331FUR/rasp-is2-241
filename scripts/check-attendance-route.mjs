import assert from 'node:assert/strict';
import { ATTENDANCE_ORIGINS, PAGES_ORIGIN } from '../js/config.js';
import { attendanceRoute, forgetAttendanceRoute } from '../js/attendance-route.js';
import { loginAttendance, fetchAttendance, AttendanceError, ATTENDANCE_TIMEOUT_MS } from '../js/attendance.js';
const [workerA, workerB] = ATTENDANCE_ORIGINS;
const calls = [];
let actualMode = 'success', reachable = new Set([workerA]);
const oldFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input), origin = url.origin;
  calls.push({ origin, path: url.pathname, body: init.body, token: init.headers?.['X-Vgltu-Session'] });
  if (!reachable.has(origin)) return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail, { once: true });
  });
  if (init.body === '{}') return Response.json({ ok: false, error: 'Введите ID студента и пароль.' }, { status: 400 });
  if (actualMode === 'network') throw new TypeError('Failed to fetch');
  if (url.pathname === '/login') {
    if (actualMode === 'denied') return Response.json({ ok: false, error: 'Неверный ID или пароль!' }, { status: 401 });
    return Response.json({ ok: true, login: 'fixture', token: 'ABCDEF123456', name: '' });
  }
  if (actualMode === 'expired') return Response.json({ ok: false, error: 'Сессия истекла. Войдите снова.' }, { status: 401 });
  return Response.json({ ok: true, data: [{ date: '30.10.2026', subjects: [{ name: 'Math', go: '1' }] }] });
};
try {
  const start = Date.now();
  const session = await loginAttendance(PAGES_ORIGIN, 'fixture', 'private-test-password');
  assert.equal(session.token, 'ABCDEF123456');
  assert.ok(Date.now() - start < 1000, 'blocked Pages cannot hold up reachable Worker');
  assert.equal(calls.filter(c => c.body?.includes('private-test-password')).length, 1);
  assert.equal(calls.find(c => c.body?.includes('private-test-password')).origin, workerA);
  assert.ok(calls.filter(c => c.body === '{}').every(c => !c.token));
  const before = calls.length;
  const journal = await fetchAttendance(PAGES_ORIGIN, session.token, '2026-10-26', '2026-11-01');
  assert.equal(journal.days[0].subjects[0].mark, 'present');
  assert.equal(calls.length, before + 1, 'session reused without login/probe');
  actualMode = 'denied';
  await assert.rejects(loginAttendance(PAGES_ORIGIN, 'fixture', 'wrong'), e => e instanceof AttendanceError && e.code === 'denied');
  assert.equal(calls.filter(c => c.body?.includes('wrong')).length, 1, 'no automatic password retry');
  actualMode = 'expired';
  await assert.rejects(fetchAttendance(PAGES_ORIGIN, session.token, '2026-10-26', '2026-11-01'), e => e.code === 'unauthorized');
  actualMode = 'network';
  await assert.rejects(fetchAttendance(PAGES_ORIGIN, session.token, '2026-10-26', '2026-11-01'), e => e.code === 'network' && !/Wi|белыми/.test(e.message));
  assert.ok(!calls.some(c => c.path === '/version.json'), 'no extra post-failure probe');
  reachable = new Set([workerB]); actualMode = 'success';
  assert.equal(await attendanceRoute(PAGES_ORIGIN), workerB);
  forgetAttendanceRoute(workerB); reachable = new Set();
  const failedAt = Date.now();
  await assert.rejects(loginAttendance(PAGES_ORIGIN, 'fixture', 'not-sent'), e => e.code === 'unreachable');
  assert.ok(Date.now() - failedAt < 3000);
  assert.ok(!calls.some(c => c.body?.includes('not-sent')));
  await assert.rejects(attendanceRoute('https://untrusted.example'), /Untrusted/);
  assert.equal(ATTENDANCE_TIMEOUT_MS, 18000);
  console.log('Attendance routing ok: Pages blocked, Worker fallback, no credential fan-out, session reuse, denied/expired/network, bounded all-unreachable');
} finally { globalThis.fetch = oldFetch; }
