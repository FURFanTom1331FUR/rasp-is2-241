// Optional real-browser regression: PLAYWRIGHT_MODULE may point to index.mjs;
// BROWSER_CHANNEL=msedge uses an installed Edge. Otherwise install Chromium via Playwright.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const version = JSON.parse(fs.readFileSync(new URL('version.json', root))).version;
let published = false, advertiseNext = false;
const oldFiles = new Map();
const types = { html: 'text/html', js: 'application/javascript', json: 'application/json', css: 'text/css', png: 'image/png', webmanifest: 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const name = decodeURIComponent(url.pathname).slice(1) || 'index.html';
  if (name.includes('..')) { res.writeHead(400); res.end(); return; }
  // Simulate stalled optional snapshots after the release. Installation must not wait.
  if (published && name.startsWith('data/schedules/')) {
    setTimeout(() => { if (!res.destroyed) { res.writeHead(503); res.end(); } }, 700);
    return;
  }
  let body;
  try {
    if (!published) {
      if (!oldFiles.has(name)) oldFiles.set(name, execFileSync('git', ['show', `a35dc95:${name}`], { stdio: ['ignore', 'pipe', 'ignore'] }));
      body = oldFiles.get(name);
    } else body = fs.readFileSync(new URL(name, root));
    if (advertiseNext && name === 'version.json') body = Buffer.from(JSON.stringify({ version: version + 1, date: '2026-10-30', changes: ['test'] }));
  } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[name.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
try {
  const context = await browser.newContext();
  // Standalone PWA uses the same registration/storage; exercise its media branch
  // and closing/reopening the window, without clearing the browser context.
  await context.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => query === '(display-mode: standalone)' ? { ...original(query), matches: true } : original(query);
  });
  let page = await context.newPage();
  page.on('pageerror', error => console.log('Browser error:', error.message));
  await page.goto(origin);
  await page.waitForFunction(() => navigator.serviceWorker.controller && localStorage.getItem('rasp.appVersion') === '17');
  await page.evaluate(async () => {
    localStorage.setItem('rasp.attendance.snapshot', JSON.stringify({ marker: 'preserve', rows: [] }));
    localStorage.setItem('rasp.subgroup', '2');
    localStorage.setItem('rasp.group', 'ИС2-241-ОБ');
  });
  published = true;
  await page.reload();
  try {
    await page.waitForFunction(v => localStorage.getItem('rasp.appVersion') === String(v), version, { timeout: 20000 });
  } catch (error) {
    console.log(await page.evaluate(async () => ({ version: localStorage.getItem('rasp.appVersion'), keys: await caches.keys(), text: document.body.innerText.slice(-500), registrations: (await navigator.serviceWorker.getRegistrations()).map(r => ({ active: r.active?.state, installing: r.installing?.state, waiting: r.waiting?.state })) })));
    throw error;
  }
  await page.waitForFunction(async () => (await caches.keys()).includes('rasp-bundles-v1'));
  await page.waitForFunction(async () => (await (await caches.open('rasp-bundles-v1')).keys()).length === 2, { timeout: 10000 });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rasp.attendance.snapshot')).marker), 'preserve');
  assert.equal(await page.evaluate(() => localStorage.getItem('rasp.subgroup')), '2');
  await context.setOffline(true);
  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(v => localStorage.getItem('rasp.appVersion') === String(v) && document.querySelector('.top'), version);
  assert.equal(await page.evaluate(() => localStorage.getItem('rasp.group')), 'ИС2-241-ОБ');
  await context.setOffline(false);
  await page.evaluate(() => { ServiceWorkerRegistration.prototype.update = () => new Promise(() => {}); });
  advertiseNext = true;
  if (await page.locator('[data-action="seen-update"]').count()) await page.locator('[data-action="seen-update"]').click();
  await page.locator('[data-action="mode"][data-mode="more"]').click();
  await page.locator('[data-action="check-update"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="apply-update"]'), null, { timeout: 5000 });
  assert.match(await page.locator('.update-banner').innerText(), new RegExp(String(version + 1)));
  advertiseNext = false;
  // Failed/offline recovery keeps storage and the working shell.
  await context.setOffline(true);
  await page.locator('[data-action="repair-app"]').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rasp.attendance.snapshot')).marker), 'preserve');
  await context.setOffline(false);
  await page.locator('[data-action="repair-app"]').click();
  await page.waitForEvent('load', { timeout: 20000 });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rasp.attendance.snapshot')).marker), 'preserve');
  console.log(`Browser update ok: v17 -> v${version}, stalled optional files, standalone reopen offline, hung SW probe, safe recovery`);
  await context.close();
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
