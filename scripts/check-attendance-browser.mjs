import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const base = 'https://furfantom1331fur.github.io/rasp-is2-241/';
const worker = 'https://rasp-attendance.integrall1331.workers.dev';
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route(`${base}**`, async route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname).slice('/rasp-is2-241/'.length) || 'index.html';
    try {
      const body = readFileSync(new URL(name, root));
      const types = { js: 'application/javascript', html: 'text/html', json: 'application/json', css: 'text/css' };
      await route.fulfill({ status: 200, contentType: types[name.split('.').pop()] || 'application/octet-stream', body });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await context.route('https://rasp-is2-241.pages.dev/**', route => route.abort('timedout'));
  await context.route('https://rasp-attendance.harsh-raft.workers.dev/**', route => route.abort('timedout'));
  const passwords = [];
  let journalRequests = 0, unavailable = false;
  await context.route(`${worker}/**`, async route => {
    const request = route.request();
    if (unavailable) return route.abort('timedout');
    const cors = { 'Access-Control-Allow-Origin': 'https://furfantom1331fur.github.io', 'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Vgltu-Session', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const respond = (status, json) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(json) });
    if (new URL(request.url()).pathname === '/login') {
      const body = JSON.parse(request.postData() || '{}');
      if (!body.login) return respond(400, { ok: false, error: 'Введите ID студента и пароль.' });
      passwords.push(body.password);
      return respond(200, { ok: true, login: body.login, token: 'FIXTURE1234567890', name: '' });
    }
    journalRequests++;
    assert.equal(await request.headerValue('x-vgltu-session'), 'FIXTURE1234567890');
    return respond(200, { ok: true, data: [{ date: '30.10.2026', subjects: [{ name: 'Тестовый предмет', type: 'лек', go: '1' }] }] });
  });
  const page = await context.newPage();
  await page.goto(base);
  if (await page.locator('[data-action="seen-update"]').count()) await page.locator('[data-action="seen-update"]').click();
  // Close first-run group picker using a valid group without touching real auth.
  await page.evaluate(() => { localStorage.setItem('rasp.group', 'ИС2-241-ОБ'); });
  await page.reload();
  if (await page.locator('[data-action="seen-update"]').count()) await page.locator('[data-action="seen-update"]').click();
  await page.locator('[data-action="mode"][data-mode="attendance"]').click();
  await page.locator('input[name="login"]').fill('fixture');
  await page.locator('input[name="password"]').fill('fixture-password');
  await page.locator('form[data-attendance-form] button[type="submit"]').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('rasp.attendance.snapshot') || 'null')?.days?.length === 1, null, { timeout: 5000 });
  assert.deepEqual(passwords, ['fixture-password']);
  assert.ok(journalRequests >= 1);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('Тестовый предмет'));
  assert.equal(passwords.length, 1, 'valid session survives reload without password submission');
  unavailable = true;
  await page.locator('[data-action="att-refresh"]').click();
  await page.waitForFunction(() => document.body.innerText.includes('Не удалось подключиться'), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rasp.attendance.session')).token), 'FIXTURE1234567890');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rasp.attendance.snapshot')).days.length), 1);
  assert.ok(!(await page.locator('body').innerText()).includes('подключитесь к Wi'));
  await context.close();
  console.log('Attendance browser ok: mirror + blocked Pages, login/journal fixture, session reuse, network failure preserves snapshot/session');
} finally { await browser.close(); }
