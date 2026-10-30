import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { moscowIso } from '../js/dates.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
mkdirSync(new URL('work/themes/', root), { recursive: true });
const types = { js: 'application/javascript', html: 'text/html', css: 'text/css', json: 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/login') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Введите ID студента и пароль.' })); return; }
  if (url.pathname === '/attendance') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: [{ date: '30.10.2026', subjects: [{ name: 'Тестовая дисциплина', go: '1' }] }] })); return; }
  const name = decodeURIComponent(url.pathname).slice(1) || 'index.html';
  if (name.includes('..')) { res.writeHead(400); res.end(); return; }
  try { const body = readFileSync(new URL(name, root)); res.writeHead(200, { 'Content-Type': types[name.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
function luminance(rgb) { return rgb.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((s, x, i) => s + x * [.2126, .7152, .0722][i], 0); }
function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((a,b) => b-a); return (x + .05) / (y + .05); }
try {
  for (const theme of ['light', 'dark', 'forest']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: theme === 'light' ? 'dark' : 'light' });
    await context.addInitScript(({ theme, today }) => {
      if (!localStorage.getItem('theme-test-seeded')) {
        localStorage.setItem('rasp.theme', theme); localStorage.setItem('rasp.group', 'ИС2-241-ОБ');
        localStorage.setItem('rasp.schedule:ИС2-241-ОБ', JSON.stringify({ group: 'ИС2-241-ОБ', fetchedAt: new Date().toISOString(), days: [{ date: today, lessons: [{ start: '08:30', end: '10:00', time: '08:30-10:00', type: 'лек', subject: 'Тестирование программного обеспечения', teacher: 'Иванов И.И.', room: '215Комп/Гл', groups: [] }] }] }));
        localStorage.setItem('rasp.appVersion', '20'); localStorage.setItem('theme-test-seeded', '1');
      }
      document.addEventListener('DOMContentLoaded', () => { window.themeAtDOMContentLoaded = document.documentElement.dataset.theme; });
    }, { theme, today: moscowIso() });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForSelector('.top');
    assert.equal(await page.evaluate(() => window.themeAtDOMContentLoaded), theme);
    const check = async screen => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme} ${screen}: no horizontal overflow`);
      const colors = await page.evaluate(() => { const rgb = v => getComputedStyle(document.body).getPropertyValue(v).trim(); const el = document.createElement('span'); document.body.append(el); const resolve = value => { el.style.color = value; return getComputedStyle(el).color.match(/[\d.]+/g).slice(0,3).map(Number); }; const ink = resolve(rgb('--ink')), card = resolve(rgb('--card')), muted = resolve(rgb('--muted')), accent = resolve(rgb('--accent')), onAccent = resolve(rgb('--on-accent')); el.remove(); return { ink, card, muted, accent, onAccent }; });
      assert.ok(contrast(colors.ink, colors.card) >= 4.5, `${theme}: main text contrast`);
      assert.ok(contrast(colors.muted, colors.card) >= 4.5, `${theme}: muted text contrast`);
      assert.ok(contrast(colors.onAccent, colors.accent) >= 4.5, `${theme}: selected buttons contrast`);
      await page.screenshot({ path: fileURLToPath(new URL(`work/themes/${theme}-${screen}.png`, root)), fullPage: false });
    };
    await check('schedule');
    await page.locator('[data-action="mode"][data-mode="more"]').click(); await check('more');
    await page.locator(`[data-action="theme"][data-theme="${theme}"]`).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('rasp.theme')), theme);
    await page.locator('[data-action="mode"][data-mode="attendance"]').click(); await check('login');
    await page.evaluate(() => localStorage.setItem('rasp.attendance.session', JSON.stringify({ login: 'fixture', token: 'FIXTURE1234567890' })));
    await page.reload();
    await page.waitForFunction(() => document.body.innerText.includes('Тестовая дисциплина'));
    await check('attendance');
    await page.locator('[data-action="mode"][data-mode="schedule"]').click();
    await page.locator('[data-action="open-group"]').click(); await check('dialog');
    await page.keyboard.press('Escape');
    await context.setOffline(true); await page.reload(); await page.waitForSelector('.top');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    await context.close();
  }
  console.log('Theme browser ok: three mobile themes, prepaint persistence/offline, schedule/more/login/attendance/dialog, contrast and overflow');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

