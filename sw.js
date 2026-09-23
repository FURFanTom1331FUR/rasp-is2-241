const SHELL = "rasp-shell-v4";

const FILES = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/dates.js",
  "./js/parse.js",
  "./js/store.js",
  "./js/config.js",
  "./js/attendance.js",
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("rasp-shell-") && key !== SHELL)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const home = await cache.match("./index.html");
      if (home) return home;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});
