// Уведомления о парах: подписка Web Push, настройки, диагностика.
import { VAPID_PUBLIC } from "./config.js";

const SETTINGS_KEY = "rasp.push";
const META_CACHE = "rasp-meta";

export const LEAD_OPTIONS = [5, 10, 15, 30, 60];
export const QUIET_OPTIONS = [
  ["", "Нет"],
  ["00:00-09:00", "До 9:00"],
  ["19:00-23:59", "После 19:00"],
];

export function pushSupport(nav = navigator, win = window) {
  const ua = String(nav.userAgent || "");
  return {
    sw: "serviceWorker" in nav,
    push: "PushManager" in win,
    notification: "Notification" in win,
    yandex: /YaBrowser|YaApp|YaSearchBrowser/i.test(ua),
    android: /Android/i.test(ua),
    ios: /iPhone|iPad|iPod/i.test(ua),
    honor: /HONOR|HUAWEI|LGN-/i.test(ua),
    standalone: Boolean(win.matchMedia?.("(display-mode: standalone)").matches || nav.standalone),
  };
}

export function permissionState() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function loadPushSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (data && typeof data === "object") return { enabled: false, lead: 10, subgroup: "", quiet: "", firstOnly: false, ...data };
  } catch {
    /* повреждено */
  }
  return { enabled: false, lead: 10, subgroup: "", quiet: "", firstOnly: false };
}

export function savePushSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function keyBytes(base64) {
  const text = base64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(text + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (char) => char.charCodeAt(0));
}

export function appUrl() {
  return new URL("./", location.href).href;
}

async function post(api, path, payload, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(`${api}push/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok && data?.ok !== false, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

// Копия настроек для service worker (pushsubscriptionchange) — у него нет localStorage.
async function rememberForWorker(api, serverSettings) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put("/__rasp/push-settings", new Response(JSON.stringify({ settings: serverSettings, publicKey: VAPID_PUBLIC, api: new URL(api, location.href).href })));
  } catch {
    /* не критично */
  }
}

export function serverSettings(settings, group, subgroup) {
  return {
    group,
    subgroup: settings.subgroup || subgroup || "all",
    lead: settings.lead,
    quiet: settings.quiet,
    firstOnly: settings.firstOnly,
    appUrl: appUrl(),
  };
}

export async function currentSubscription(registration) {
  try {
    return (await registration?.pushManager?.getSubscription()) || null;
  } catch {
    return null;
  }
}

// Включить: разрешение → подписка в браузере → регистрация на сервере.
export async function subscribePush(registration, api, settings, group, subgroup) {
  if (typeof Notification === "undefined") return { ok: false, reason: "unsupported" };
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" };
  if (!registration?.pushManager) return { ok: false, reason: "no-push" };
  let subscription = await currentSubscription(registration);
  try {
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
  } catch (error) {
    return { ok: false, reason: "subscribe-failed", detail: String(error?.message || error) };
  }
  const payload = serverSettings(settings, group, subgroup);
  const result = await post(api, "subscribe", { subscription: subscription.toJSON(), settings: payload });
  if (!result.ok) return { ok: false, reason: "server", detail: result.data?.message || result.error || `HTTP ${result.status}` };
  await rememberForWorker(api, payload);
  return { ok: true, savedAt: result.data.savedAt, subscription };
}

export async function unsubscribePush(registration, api) {
  const subscription = await currentSubscription(registration);
  if (!subscription) return { ok: true };
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    /* всё равно сообщим серверу */
  }
  const result = await post(api, "unsubscribe", { endpoint });
  return { ok: result.ok };
}

export async function testPush(registration, api, settings, group, subgroup) {
  const subscription = await currentSubscription(registration);
  if (!subscription) return { ok: false, reason: "no-subscription" };
  const result = await post(api, "test", { subscription: subscription.toJSON(), settings: serverSettings(settings, group, subgroup) });
  return { ok: result.ok, status: result.data?.status || result.status, message: result.data?.message || result.error || "" };
}

export async function serverStatus(registration, api) {
  const subscription = await currentSubscription(registration);
  if (!subscription) return { ok: true, subscribed: false, local: false };
  const result = await post(api, "status", { endpoint: subscription.endpoint }, 12000);
  if (!result.ok) return { ok: false, local: true, error: result.error || `HTTP ${result.status}` };
  return { ok: true, local: true, ...result.data };
}

export async function lastPushReceived() {
  try {
    const cache = await caches.open(META_CACHE);
    const hit = await cache.match("/__rasp/push-log");
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}
