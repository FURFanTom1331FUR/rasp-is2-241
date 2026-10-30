import assert from 'node:assert/strict';
import { addDays } from '../js/dates.js';
const RealDate = Date;
let now = '2026-10-30T06:00:00Z';
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return new RealDate(now).getTime(); }
};
globalThis.location = { href: 'https://example.test/app/' };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const entries = new Map();
const cache = {
  keys: async () => [...entries.keys()].map(url => ({ url })),
  match: async key => entries.get(key)?.clone(),
  put: async (key, r) => { entries.set(key, r.clone()); },
  delete: async key => entries.delete(typeof key === 'string' ? key : key.url),
};
globalThis.caches = { open: async () => cache };
const groups = ['previously unopened', 'another group'];
function pack(week) {
  return { schema: 1, week, complete: true, fetchedAt: now, groups,
    records: Object.fromEntries(groups.map(g => [g, Array.from({ length: 7 }, (_, i) => ({ date: addDays(week, i), lessons: [] }))])) };
}
let broken = false;
globalThis.fetch = async url => {
  if (String(url).endsWith('groups.json')) return Response.json({ groups });
  if (broken) return new Response('truncated', { status: 200 });
  return Response.json(pack(String(url).match(/(\d{4}-\d{2}-\d{2})\.json/)[1]));
};
const { initBundles, syncBundles, bundledRecord, validateBundle } = await import('../js/bundles.js');
await initBundles();
await syncBundles();
assert.equal(entries.size, 2);
assert.equal(bundledRecord(groups[0]).days.length, 14, 'unopened group available offline');
navigator.onLine = false;
assert.equal(bundledRecord(groups[1]).days[0].date, '2026-10-26');
const old = await Promise.all([...entries.values()].map(r => r.clone().text()));
now = '2026-10-30T08:00:00Z'; navigator.onLine = true; broken = true;
await syncBundles();
assert.deepEqual(await Promise.all([...entries.values()].map(r => r.clone().text())), old, 'failure keeps working copy');
const partial = pack('2026-10-26'); delete partial.records[groups[1]];
assert.throws(() => validateBundle(partial, partial.week, groups));
const missingDay = pack('2026-10-26'); missingDay.records[groups[0]].pop();
assert.throws(() => validateBundle(missingDay, missingDay.week, groups));
assert.throws(() => validateBundle(pack('2026-10-26'), '2026-10-26', [...groups, 'missing']));
now = '2026-11-01T21:01:00Z'; // Monday in Moscow, still Sunday in UTC.
await initBundles();
assert.equal(entries.size, 1, 'previous week removed at Moscow rollover');
assert.equal(bundledRecord(groups[0]).days[0].date, '2026-11-02', 'next promoted to current');
now = '2026-11-09T06:00:00Z';
await initBundles();
assert.equal(entries.size, 0);
assert.equal(bundledRecord(groups[0]), null, 'expired data never used as current');
console.log('bundle tests ok: coverage, offline, validation, failure, Moscow rollover, retention');
