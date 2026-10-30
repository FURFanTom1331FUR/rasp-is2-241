import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBundle } from '../js/bundles.js';
import { mondayOf, moscowIso, addDays } from '../js/dates.js';
const expected = JSON.parse(readFileSync(new URL('../version.json', import.meta.url))).version;
const base = process.env.RELEASE_URL || 'https://rasp-is2-241.pages.dev/';
async function get(path) {
  const response = await fetch(new URL(path, base), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, path);
  return response;
}
let lastError;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const [version, worker, groupList] = await Promise.all([
      get(`version.json?t=${Date.now()}`).then(r => r.json()), get('sw.js').then(r => r.text()), get('data/groups.json').then(r => r.json()),
    ]);
    assert.equal(version.version, expected);
    assert.ok(worker.includes(`rasp-shell-v${expected}`));
    const monday = mondayOf(moscowIso());
    for (const week of [monday, addDays(monday, 7)]) {
      const b = await (await get(`data/bundles/${week}.json`)).json();
      validateBundle(b, week, groupList.groups);
      console.log(`Production ${week}: ${b.groups.length}/${groupList.groups.length} groups verified`);
    }
    console.log(`Production v${expected} verified`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
throw lastError;
