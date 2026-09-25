const SHELL = "rasp-shell-v8";
const DATA_TIMEOUT_MS = 4000;
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
  "./js/app.js",
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
];

const API_PATHS = new Set(["/login", "/attendance", "/logout"]);

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

async function store(cache, key, response) {
  if (!response || response.status !== 200 || response.type === "opaque" || response.type === "opaqueredirect") return false;
  try {
    const clean = await materialize(response);
    if (!clean || clean.status !== 200) return false;
    await cache.put(key, clean);
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffered(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response) return null;
    return await materialize(response);
  } finally {
    clearTimeout(timer);
  }
}

async function copyPreviousShell(cache) {
  const keys = await caches.keys();
  const previous = keys.filter((key) => key.startsWith("rasp-shell-") && key !== SHELL);
  for (const key of previous) {
    const old = await caches.open(key);
    const requests = await old.keys();
    await Promise.all(
      requests.map(async (request) => {
        const response = await old.match(request);
        if (!response) return;
        const path = new URL(request.url).pathname;
        const targets = [request];
        if (path.endsWith("/index.html")) targets.push(indexUrl());
        if (path.endsWith("/") || path.endsWith("/index.html")) targets.push(rootUrl());
        for (const target of targets) {
          try {
            await cache.put(target, response.clone());
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

async function precache(cache) {
  const fresh = new Map();
  const pending = new Map(FILES.map((path) => [path, loadFresh(fresh, path)]));
  await Promise.all(["./", "./index.html", ...REQUIRED].map((path) => pending.get(path)));
  const codeReady = (fresh.has("./") || fresh.has("./index.html")) && REQUIRED.every((path) => fresh.has(path));
  if (codeReady) {
    const shellPaths = FILES.filter((path) => !path.startsWith("./data/") && !path.startsWith("./icons/"));
    const ordered = shellPaths.filter((path) => path !== "./").concat("./");
    for (const path of ordered) await storeFresh(cache, path, fresh.get(path));
  }
  await Promise.all([...pending.values()]);
  const extras = FILES.filter((path) => path.startsWith("./data/") || path.startsWith("./icons/") || path.endsWith(".webmanifest"));
  for (const path of extras) await storeFresh(cache, path, fresh.get(path));
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await copyPreviousShell(cache);
      if (!(await hasDocument(cache))) {
        await precache(cache);
        if (!(await hasDocument(cache))) throw new Error("shell not cached");
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // Не ждать сеть: пока activate не завершится, Chrome не отдаёт fetch,
  // и зависший precache снова заморозил бы открытие.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith("rasp-shell-") && key !== SHELL).map((key) => caches.delete(key)),
      );
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

function isDataRequest(url) {
  return url.pathname.includes("/data/");
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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (API_PATHS.has(path)) return;
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
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
