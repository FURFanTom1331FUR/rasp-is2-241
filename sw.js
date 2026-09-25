// Версия: при выпуске поднять здесь, в js/version.js и version.json (см. README).
const SHELL = "rasp-shell-v11";
const SW_VERSION = Number(SHELL.slice("rasp-shell-v".length));
// С этой версии новый worker ждёт кнопку «Обновить». Старые (до 11) страницы о ней не знают —
// для них worker включается сразу, как раньше.
const UPDATER_SINCE = 11;
const DATA_CACHE = "rasp-data-v1";
const DATA_TIMEOUT_MS = 4000;
const PROXY_TIMEOUT_MS = 10000;
const UPDATE_TIMEOUT_MS = 15000;

const FILES = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/dates.js",
  "./js/parse.js",
  "./js/store.js",
  "./js/config.js",
  "./js/attendance.js",
  "./js/net.js",
  "./js/version.js",
  "./js/app.js",
  "./version.json",
  "./manifest.webmanifest",
  "./data/groups.json",
  "./data/schedules/ИС2-241-ОБ.json",
  "./data/schedules/ИС2-242-ОБ.json",
  "./data/schedules/ИС2-243-ОБ.json",
  "./data/schedules/ИС2-244-ОБ.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

const REQUIRED = [
  "./css/app.css",
  "./js/app.js",
  "./js/net.js",
  "./js/attendance.js",
  "./js/store.js",
  "./js/dates.js",
  "./js/parse.js",
  "./js/config.js",
  "./js/version.js",
];

const API_PATHS = new Set(["/login", "/attendance", "/logout"]);
// Прокси расписания (functions/groups.js, functions/schedule.js): сеть с таймаутом, потом копия.
const PROXY_PATHS = new Set(["./groups", "./schedule"].map((path) => new URL(path, self.location.href).pathname));
// Зеркало на GitHub Pages берёт те же данные с Cloudflare Pages — их тоже держим офлайн.
const PAGES_ORIGIN = "https://rasp-is2-241.pages.dev";
const PAGES_PROXY_PATHS = new Set(["/groups", "/schedule"]);
const VERSION_PATH = new URL("./version.json", self.location.href).pathname;

// Phones still on the network-first worker have HTML that waits on the network
// before painting. Until the atomic shell update replaces that HTML, answer
// navigations with a cached copy that paints localStorage and aborts hung fetches.
const LEGACY_BOOT = `<script data-rasp-legacy>(function(){
  var orig = window.fetch;
  window.fetch = function(input, init){
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 5000);
    var next = Object.assign({}, init || {}, { signal: controller.signal });
    return orig.call(this, input, next).then(function(response){
      var finish = function(){ clearTimeout(timer); };
      var text = response.text.bind(response);
      var json = response.json.bind(response);
      response.text = function(){ return text().finally(finish); };
      response.json = function(){ return json().finally(finish); };
      return response;
    }, function(error){ clearTimeout(timer); throw error; });
  };
  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"]/g, function(ch){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch];
    });
  }
  try {
    var app = document.getElementById("app");
    if (!app) return;
    var group = localStorage.getItem("rasp.group") || "";
    var raw = group ? localStorage.getItem("rasp.schedule:" + group) : "";
    var record = raw ? JSON.parse(raw) : null;
    var iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    var day = record && Array.isArray(record.days) ? record.days.find(function(item){ return item.date === iso; }) : null;
    var lessons = day && Array.isArray(day.lessons) ? day.lessons : [];
    var body = lessons.length ? lessons.map(function(lesson){
      return '<article class="card"><p class="time">' + esc(lesson.start) + "–" + esc(lesson.end) + '</p><h2 class="subject">' + esc(lesson.subject) + "</h2></article>";
    }).join("") : '<p class="boot">Загрузка расписания…</p>';
    app.innerHTML = '<header class="top"><div class="top-row"><div><p class="eyebrow">ВГЛТУ</p><p class="brand">Пары</p></div></div></header><main><div class="lessons">' + body + "</div></main>";
  } catch (e) {}
})();</script>`;

function rootUrl() {
  return new URL("./", self.location.href).href;
}

function indexUrl() {
  return new URL("./index.html", self.location.href).href;
}

function safeHeaders(response) {
  const headers = new Headers();
  const type = response.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  return headers;
}

async function materialize(response) {
  const body = await response.blob();
  const status = response.status >= 200 && response.status <= 599 ? response.status : 200;
  return new Response(body, {
    status: response.redirected && status >= 300 ? 200 : status,
    statusText: response.statusText || "",
    headers: safeHeaders(response),
  });
}

function isProxyRequest(url) {
  if (url.origin === self.location.origin) return PROXY_PATHS.has(url.pathname);
  return url.origin === PAGES_ORIGIN && PAGES_PROXY_PATHS.has(url.pathname);
}

function isDataRequest(url) {
  return url.pathname.includes("/data/");
}

function wantsJson(key) {
  const url = new URL(typeof key === "string" ? key : key.url, self.location.href);
  return isDataRequest(url) || isProxyRequest(url);
}

function isJson(response) {
  return /\bjson\b/i.test(response?.headers?.get("Content-Type") || "");
}

async function store(cache, key, response) {
  if (!response || response.status !== 200 || response.type === "opaque" || response.type === "opaqueredirect") return false;
  // Без 404.html Pages отвечал index.html с кодом 200 — такой ответ не должен лечь под ключ JSON.
  if (wantsJson(key) && !isJson(response)) return false;
  try {
    const clean = await materialize(response);
    if (!clean || clean.status !== 200) return false;
    await cache.put(key, clean);
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffered(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!response) return null;
    return await materialize(response);
  } finally {
    clearTimeout(timer);
  }
}

function shellVersion(name) {
  const match = /^rasp-shell-v(\d+)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

async function previousShells() {
  const keys = await caches.keys();
  return keys.filter((key) => key.startsWith("rasp-shell-") && key !== SHELL);
}

// Перенести из старых кэшей то, чего нет в новом: копии расписания, данные, иконки.
// Код оболочки новый worker уже скачал сам. Ответы прокси при activate берём из старого кэша:
// пока новый worker ждал, старый мог сохранить более свежее расписание.
async function copyPreviousEntries(cache, overwriteProxy = false) {
  for (const key of await previousShells()) {
    const old = await caches.open(key);
    const requests = await old.keys();
    await Promise.all(
      requests.map(async (request) => {
        const url = new URL(request.url);
        const path = url.pathname;
        const targets = [request];
        if (path.endsWith("/index.html")) targets.push(indexUrl());
        if (path.endsWith("/") || path.endsWith("/index.html")) targets.push(rootUrl());
        for (const target of targets) {
          try {
            const present = await cache.match(target);
            if (present && !(overwriteProxy && isProxyRequest(url))) continue;
            const response = await old.match(request);
            if (response) await cache.put(target, response.clone());
          } catch {
            /* Редирект из старого кэша нельзя положить повторно. */
          }
        }
      }),
    );
  }
}

async function hasDocument(cache) {
  const direct = (await cache.match(rootUrl())) || (await cache.match(indexUrl()));
  if (direct) return direct;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (!path.endsWith("/") && !path.endsWith("/index.html")) continue;
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  return null;
}

function loadFresh(fresh, path) {
  const url = new URL(path, self.location.href).href;
  return fetchBuffered(url, UPDATE_TIMEOUT_MS)
    .then((response) => {
      if (response && response.status === 200) fresh.set(path, response);
    })
    .catch(() => {});
}

async function storeFresh(cache, path, response) {
  if (!response) return;
  const url = new URL(path, self.location.href).href;
  await store(cache, url, response.clone());
  if (path === "./" || path === "./index.html") await store(cache, rootUrl(), response.clone());
}

async function freshVersion(fresh) {
  try {
    const data = await fresh.get("./version.json")?.clone().json();
    return Number(data?.version) || 0;
  } catch {
    return 0;
  }
}

// Код кладётся в кэш только целиком и только своей версии: если на сайте уже другая версия
// (или CDN отдал старые файлы), этот worker её не подхватит — для неё будет свой worker.
async function precache(cache) {
  const fresh = new Map();
  const pending = new Map(FILES.map((path) => [path, loadFresh(fresh, path)]));
  await Promise.all(["./", "./index.html", "./version.json", ...REQUIRED].map((path) => pending.get(path)));
  const codeReady =
    (fresh.has("./") || fresh.has("./index.html")) &&
    REQUIRED.every((path) => fresh.has(path)) &&
    (await freshVersion(fresh)) === SW_VERSION;
  if (codeReady) {
    const shellPaths = FILES.filter((path) => !path.startsWith("./data/") && !path.startsWith("./icons/"));
    const ordered = shellPaths.filter((path) => path !== "./").concat("./");
    for (const path of ordered) await storeFresh(cache, path, fresh.get(path));
  }
  await Promise.all([...pending.values()]);
  const extras = FILES.filter((path) => path.startsWith("./data/") || path.startsWith("./icons/") || path.endsWith(".webmanifest"));
  for (const path of extras) await storeFresh(cache, path, fresh.get(path));
  return codeReady;
}

let shellRefresh = null;

function refreshShell() {
  if (!shellRefresh) {
    shellRefresh = (async () => {
      try {
        const cache = await caches.open(SHELL);
        await precache(cache);
      } catch {
        /* Фоновое обновление оболочки необязательно для текущего экрана. */
      } finally {
        shellRefresh = null;
      }
    })();
  }
  return shellRefresh;
}

// Убрать из кэша HTML и ошибки, сохранённые под адресами данных старыми версиями.
async function purgeBadData(cacheName) {
  try {
    if (!(await caches.has(cacheName))) return;
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (!wantsJson(request)) continue;
      const response = await cache.match(request);
      if (!response || response.status !== 200 || !isJson(response)) await cache.delete(request);
    }
  } catch {
    /* Чистка необязательна. */
  }
}

// Для /schedule держим одну копию на группу: новое окно заменяет старое.
async function dropOlderSchedules(cache, url) {
  if (!url.pathname.endsWith("/schedule")) return;
  const group = url.searchParams.get("group");
  try {
    for (const request of await cache.keys()) {
      const other = new URL(request.url);
      if (
        other.origin === url.origin &&
        other.pathname === url.pathname &&
        other.searchParams.get("group") === group &&
        other.href !== url.href
      ) {
        await cache.delete(request);
      }
    }
  } catch {
    /* Лишняя копия не мешает. */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const previous = await previousShells();
      const updating = Boolean(self.registration.active);
      const legacy = previous.length > 0 && Math.max(...previous.map(shellVersion)) < UPDATER_SINCE;
      const cache = await caches.open(SHELL);
      await purgeBadData(SHELL);
      await purgeBadData(DATA_CACHE);
      const ready = await precache(cache);
      // Обновление без полного свежего кода не ставим: старая версия работает дальше,
      // браузер попробует снова при следующей проверке.
      if (!ready && (updating || !(await hasDocument(cache)))) throw new Error("fresh shell not cached");
      await copyPreviousEntries(cache);
      if (!updating || legacy) await self.skipWaiting();
    })(),
  );
});

// Кнопка «Обновить» в приложении.
self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "skip-waiting") event.waitUntil(self.skipWaiting());
  else if (type === "version") event.source?.postMessage({ type: "rasp-version", version: SW_VERSION });
});

self.addEventListener("activate", (event) => {
  // Не ждать сеть: пока activate не завершится, Chrome не отдаёт fetch,
  // и зависший precache снова заморозил бы открытие. Здесь только локальные кэши.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await copyPreviousEntries(cache, true);
      const keys = await previousShells();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) client.postMessage({ type: "rasp-shell", version: SHELL });
    })(),
  );
});

async function matchCached(cache, request) {
  if (request.mode === "navigate") {
    return (await cache.match(request, { ignoreSearch: true })) || (await hasDocument(cache)) || undefined;
  }
  return (await cache.match(request)) || undefined;
}

async function upgradeNavigation(response) {
  const html = await response.text();
  const headers = { "Content-Type": "text/html; charset=utf-8" };
  if (!html || html.includes("data-rasp-boot") || html.includes("data-rasp-legacy")) {
    return new Response(html, { status: 200, headers });
  }
  const next = html.replace(
    /<script\s+type=(["'])module\1\s+src=(["'])\.\/js\/app\.js\2\s*><\/script>/i,
    `${LEGACY_BOOT}$&`,
  );
  return new Response(next === html ? html : next, { status: 200, headers });
}

async function present(request, response) {
  if (!response) return response;
  if (request.mode !== "navigate" && request.destination !== "document") return response;
  return upgradeNavigation(response);
}

function offlineResponse() {
  return new Response("Нет сохранённой копии", {
    status: 504,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetchBuffered(request.url, UPDATE_TIMEOUT_MS);
    if (fresh && fresh.status === 200) {
      await store(cache, request.url, fresh.clone());
      return fresh;
    }
  } catch {
    /* Нет сети и нет копии. */
  }
  return offlineResponse();
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL);
  const cached = await matchCached(cache, request);
  event.waitUntil(refreshShell());
  if (cached) return present(request, cached);
  await refreshShell();
  const updated = await matchCached(cache, request);
  if (updated) return present(request, updated);
  return offlineResponse();
}

async function networkThenCache(request) {
  const cache = await caches.open(SHELL);
  const url = request.url;
  try {
    const fresh = await fetchBuffered(url, DATA_TIMEOUT_MS);
    if (fresh && fresh.status === 200) {
      await store(cache, url, fresh.clone());
      return fresh;
    }
  } catch {
    /* Сеть зависла — ниже отдаём копию. */
  }
  const cached = await cache.match(request) || await cache.match(url);
  if (cached) return cached;
  return offlineResponse();
}

function withFallback(response, reason) {
  const headers = safeHeaders(response);
  headers.set("X-Rasp-Fallback", reason);
  return new Response(response.body, { status: 200, headers });
}

// В кэш идёт только настоящий ответ прокси: 200, JSON и не { ok: false }.
async function isOkJson(response) {
  if (!response || response.status !== 200 || !isJson(response)) return false;
  try {
    const data = await response.clone().json();
    return Boolean(data) && typeof data === "object" && data.ok !== false;
  } catch {
    return false;
  }
}

async function proxyThenCache(request) {
  const cache = await caches.open(SHELL);
  const url = new URL(request.url);
  const init = url.origin === self.location.origin ? {} : { mode: "cors", credentials: "omit" };
  let fresh = null;
  try {
    fresh = await fetchBuffered(url.href, PROXY_TIMEOUT_MS, init);
  } catch {
    fresh = null;
  }
  if (await isOkJson(fresh)) {
    if (await store(cache, url.href, fresh.clone())) await dropOlderSchedules(cache, url);
    return fresh;
  }
  const cached = await cache.match(url.href);
  // «upstream» — сервер ответил ошибкой (ВГЛТУ молчит), «offline» — до сервера не дошли.
  if (cached) return withFallback(cached, fresh ? "upstream" : "offline");
  return fresh || offlineResponse();
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (API_PATHS.has(path)) return;
  if (event.request.method !== "GET") return;
  if (isProxyRequest(url)) {
    event.respondWith(proxyThenCache(event.request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // version.json — только сеть: по нему приложение узнаёт о новой версии.
  if (url.pathname === VERSION_PATH) return;
  if (isDataRequest(url)) {
    event.respondWith(networkThenCache(event.request));
    return;
  }
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(staleWhileRevalidate(event, event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
