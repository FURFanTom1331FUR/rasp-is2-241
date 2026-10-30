import { addDays, mondayOf, moscowIso } from './dates.js';
const CACHE = 'rasp-bundles-v1';
let loaded = new Map(), running, lastSuccess = 0;
export let bundleStatus = '';
const weeks = () => { const w = mondayOf(moscowIso()); return [w, addDays(w, 7)]; };
const url = w => new URL(`./data/bundles/${w}.json`, location.href).href;
export function validateBundle(b, week, expected) {
  if (b?.schema !== 1 || b.week !== week || b.complete !== true || !Number.isFinite(Date.parse(b.fetchedAt)) ||
      !Array.isArray(b.groups) || !b.groups.length || new Set(b.groups).size !== b.groups.length || !b.records) throw Error('Invalid bundle');
  if (expected && (b.groups.length !== expected.length || expected.some(g => !b.groups.includes(g)))) throw Error('Incomplete groups');
  if (Object.keys(b.records).length !== b.groups.length) throw Error('Invalid records');
  for (const g of b.groups) {
    const days = b.records[g];
    if (!Array.isArray(days) || days.length !== 7) throw Error('Incomplete week');
    days.forEach((d, i) => {
      if (d.date !== addDays(week, i) || !Array.isArray(d.lessons) || d.lessons.some(l => typeof l.subject !== 'string' ||
          !/^\d{2}:\d{2}$/.test(l.start) || !/^\d{2}:\d{2}$/.test(l.end))) throw Error('Invalid day');
    });
  }
  return b;
}
async function prune(cache) {
  const allowed = weeks();
  loaded = new Map([...loaded].filter(([w]) => allowed.includes(w)));
  for (const r of await cache.keys()) if (!allowed.some(w => r.url === url(w))) await cache.delete(r);
}
export async function initBundles() {
  try {
    const cache = await caches.open(CACHE);
    await prune(cache);
    for (const w of weeks()) {
      try { const r = await cache.match(url(w)); if (r) loaded.set(w, validateBundle(await r.json(), w)); } catch { /* other week remains */ }
    }
    bundleStatus = loaded.size === 2 ? 'Все группы сохранены: текущая и следующая недели.' :
      loaded.size ? 'Сохранена одна неделя всех групп; вторая ещё не загружена.' : '';
  } catch { bundleStatus = 'Общее офлайн-хранилище недоступно.'; }
}
export function bundledRecord(group) {
  const packs = weeks().map(w => loaded.get(w)).filter(b => b?.records[group]);
  if (!packs.length) return null;
  return { group, origin: 'bundle', fetchedAt: packs.map(b => b.fetchedAt).sort()[0], days: packs.flatMap(b => b.records[group]) };
}
export function syncBundles(onChange = () => {}) {
  if (running) return running;
  if (!navigator.onLine || Date.now() - lastSuccess < 3600000) return Promise.resolve();
  running = (async () => {
    bundleStatus = 'Скачиваем все группы для офлайна…'; onChange();
    try {
      const cache = await caches.open(CACHE);
      await prune(cache);
      const r = await fetch(new URL('./data/groups.json', location.href), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('Groups unavailable');
      const expected = (await r.json()).groups;
      if (!Array.isArray(expected) || !expected.length) throw Error('Invalid groups');
      for (const w of weeks()) {
        const response = await fetch(url(w), { cache: 'no-store', signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw Error('Bundle unavailable');
        const text = await response.text();
        if (text.length > 25000000) throw Error('Bundle too large');
        const b = validateBundle(JSON.parse(text), w, expected);
        if (!weeks().includes(w)) continue;
        if (Date.parse(loaded.get(w)?.fetchedAt) > Date.parse(b.fetchedAt)) continue;
        await cache.put(url(w), new Response(text, { headers: { 'Content-Type': 'application/json' } }));
        loaded.set(w, b); onChange();
      }
      lastSuccess = Date.now();
      await prune(cache);
      bundleStatus = 'Все группы сохранены: текущая и следующая недели.';
    } catch { bundleStatus = 'Все группы обновить не удалось. Сохранённые недели доступны; для отсутствующих нужен интернет.'; }
    finally { running = null; onChange(); }
  })();
  return running;
}
