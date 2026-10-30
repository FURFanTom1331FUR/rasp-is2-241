import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const current = readFileSync(new URL('sw.js', root), 'utf8');
const release = JSON.parse(readFileSync(new URL('version.json', root), 'utf8'));
const old = execFileSync('git', ['show', 'e20c04d:sw.js'], { encoding: 'utf8' });

async function run(source, { failWrite = false, mismatch = false } = {}) {
  const version = Number(source.match(/rasp-shell-v(\d+)/)[1]);
  const entries = new Map();
  const oldKey = 'rasp-shell-v17';
  entries.set(oldKey, new Map([['https://test.local/js/version.js', new Response('export const APP_VERSION = 17;')]]));
  entries.set('rasp-bundles-v1', new Map([['https://test.local/sentinel', Response.json({ keep: true })]]));
  const requests = [], listeners = {};
  let failed = false, activated = false;
  const caches = {
    keys: async () => [...entries.keys()],
    has: async key => entries.has(key),
    delete: async key => entries.delete(key),
    open: async name => {
      if (!entries.has(name)) entries.set(name, new Map());
      const data = entries.get(name);
      const key = r => typeof r === 'string' ? r : r.url;
      return {
        keys: async () => [...data.keys()].map(url => ({ url })),
        match: async r => data.get(key(r))?.clone(),
        delete: async r => data.delete(key(r)),
        put: async (r, response) => {
          if (failWrite && name !== oldKey && key(r).endsWith('/js/version.js') && !failed) {
            failed = true; throw new Error('QuotaExceededError');
          }
          data.set(key(r), response.clone());
        },
      };
    },
  };
  const self = { location: new URL('https://test.local/sw.js'), registration: { active: {} },
    addEventListener: (name, handler) => { listeners[name] = handler; },
    skipWaiting: async () => { activated = true; },
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  const fetch = async input => {
    const url = new URL(input); requests.push(url.pathname);
    if (url.pathname === '/version.json') return Response.json({ ...release, version: mismatch ? version - 1 : version });
    const name = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    let body;
    try { body = readFileSync(new URL(name, root)); } catch { return new Response('', { status: 404 }); }
    return new Response(body, { headers: { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'text/plain' } });
  };
  const context = vm.createContext({ self, caches, fetch, URL, Response, Headers, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(source, context);
  let installing;
  listeners.install({ waitUntil: p => { installing = p; } });
  let error;
  try { await installing; } catch (e) { error = e; }
  return { entries, requests, activated, error, version, listeners };
}

// Reproduce the released worker accepting an old module after a failed write.
const broken = await run(old, { failWrite: true });
assert.equal(broken.activated, true);
assert.match(await broken.entries.get('rasp-shell-v18').get('https://test.local/js/version.js').text(), /VERSION = 17/);

const safe = await run(current, { failWrite: true });
assert.ok(safe.error, 'cache failure rejects installation');
assert.equal(safe.activated, false, 'old worker remains active');
assert.ok(safe.entries.has('rasp-shell-v17'));
assert.ok(safe.entries.has('rasp-bundles-v1'));
const mismatch = await run(current, { mismatch: true });
assert.ok(mismatch.error, 'mixed CDN release cannot activate');
const good = await run(current);
assert.equal(good.activated, true);
assert.equal(good.error, undefined);
assert.ok(!good.requests.some(p => p.startsWith('/data/')), 'optional snapshots do not delay installation');
let activation;
good.listeners.activate({ waitUntil: p => { activation = p; } });
await activation;
assert.ok(good.entries.has('rasp-bundles-v1'), 'activation preserves offline bundles');
assert.ok(!good.entries.has('rasp-shell-v17'), 'only obsolete shell removed');
console.log('SW update tests ok: reproduced v18 mixed shell, rejected write failure/mismatch, preserved data, bounded core install');

// A hanging native update() used to prevent even a fast version probe.
async function probe(source) {
  const start = source.indexOf('async function checkForUpdate(');
  const end = source.indexOf('\nfunction reloadOnce(', start);
  const body = source.slice(start, end).split('\nasync function repairApp(')[0];
  const state = { update: {} };
  const context = vm.createContext({ state, navigator: { onLine: true }, Date,
    swRegistration: { update: () => new Promise(() => {}) },
    fetchRemoteVersion: async () => ({ version: 999 }),
    syncWaiting: () => {}, isNewer: info => info?.version > release.version,
    cachedNewerVersion: async () => null, render: () => {}, refreshUpdateUi: () => {},
  });
  const task = vm.runInContext(body + '\ncheckForUpdate(true)', context);
  return Promise.race([task.then(() => state.update), new Promise(resolve => setTimeout(() => resolve(null), 100))]);
}
const oldClient = execFileSync('git', ['show', 'e20c04d:js/app.js'], { encoding: 'utf8' });
assert.equal(await probe(oldClient), null, 'released client blocks behind hanging update');
assert.equal((await probe(readFileSync(new URL('js/app.js', root), 'utf8'))).available.version, 999);

const repair = await run(current);
const beforeData = await repair.entries.get('rasp-bundles-v1').get('https://test.local/sentinel').clone().text();
let done, reply;
repair.listeners.message({ data: { type: 'repair-shell' }, ports: [{ postMessage: value => { reply = value; } }], waitUntil: p => { done = p; } });
await done;
assert.equal(reply.ok, true);
assert.equal(await repair.entries.get('rasp-bundles-v1').get('https://test.local/sentinel').clone().text(), beforeData);
assert.ok(!repair.entries.has(`rasp-repair-v${repair.version}`));
console.log('Client probe and safe shell repair tests ok');

