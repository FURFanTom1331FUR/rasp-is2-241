// Уведомления о парах через Web Push.
// Подписки лежат в Workers KV одним ключом "subs" (бесплатный тариф: 1000 записей и 1000 list в сутки —
// поэтому не ключ на подписку, а один документ; пишем только при подписке/отписке и после рассылки).
// Рассылку раз в минуту делает отдельный Worker rasp-push (cron), см. push-worker/.
import { lessonMatchesSubgroup, lessonSubgroup, subgroupBadgeLabel } from "../js/parse.js";
import { allowedOrigin, isGroupCode, json } from "./_kis.js";
import { sendPush } from "./_webpush.js";

export const PAGES_ORIGIN = "https://rasp-is2-241.pages.dev";
export const SUBS_KEY = "subs";
export const PAIR_STARTS = ["08:30", "10:10", "11:50", "13:40", "15:20", "17:00", "18:40", "20:20"];
export const LEADS = [5, 10, 15, 30, 60];
const MAX_SUBS = 500;
const MAX_SENDS_PER_RUN = 40;
const QUIET_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const APP_URLS = new Set(["https://rasp-is2-241.pages.dev/", "https://furfantom1331fur.github.io/rasp-is2-241/"]);

export function vapidFromEnv(env) {
  if (!env?.VAPID_PUBLIC || !env?.VAPID_PRIVATE) return null;
  return { publicKey: env.VAPID_PUBLIC, privateJwk: env.VAPID_PRIVATE, subject: env.VAPID_SUBJECT };
}

export async function subId(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || url.hostname === "localhost") return false;
  return typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string" && sub.keys.p256dh.length >= 80 && sub.keys.auth.length >= 16 && String(sub.endpoint).length < 1000;
}

export function cleanSettings(raw = {}) {
  const lead = LEADS.includes(Number(raw.lead)) ? Number(raw.lead) : 10;
  const subgroup = raw.subgroup === "1" || raw.subgroup === "2" ? raw.subgroup : "all";
  const quiet = QUIET_RE.test(String(raw.quiet || "")) ? raw.quiet : "";
  const group = String(raw.group || "").trim();
  const appUrl = APP_URLS.has(raw.appUrl) || /^https:\/\/[a-z0-9-]+\.rasp-is2-241\.pages\.dev\/$/.test(String(raw.appUrl || "")) ? raw.appUrl : `${PAGES_ORIGIN}/`;
  return { group: isGroupCode(group) ? group : "", subgroup, lead, quiet, firstOnly: Boolean(raw.firstOnly), appUrl };
}

export async function readSubs(kv) {
  const data = await kv.get(SUBS_KEY, "json");
  return data && typeof data.subs === "object" ? data : { v: 1, subs: {} };
}

export async function writeSubs(kv, data) {
  await kv.put(SUBS_KEY, JSON.stringify(data));
}

// ===== Время по Москве (UTC+3 круглый год) =====
export function moscowParts(ms) {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

function minutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function inQuiet(quiet, hhmm) {
  if (!quiet) return false;
  const [from, to] = quiet.split("-").map(minutes);
  const now = minutes(hhmm);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// Какие начала пар «наступают» в эту минуту для данного запаса времени.
export function slotsDue(lead, hhmm) {
  const now = minutes(hhmm);
  return PAIR_STARTS.filter((start) => minutes(start) - lead === now);
}

export function lessonsForSlot(day, start, settings) {
  if (!day?.lessons?.length) return [];
  const matching = day.lessons.filter((lesson) => lessonMatchesSubgroup(lesson, settings.subgroup));
  const at = matching.filter((lesson) => lesson.start === start);
  if (!at.length) return [];
  if (settings.firstOnly) {
    const first = matching.map((lesson) => lesson.start).sort()[0];
    if (first !== start) return [];
  }
  return at;
}

export function buildPayload(lessons, date, settings) {
  const first = lessons[0];
  const subjects = [...new Set(lessons.map((lesson) => lesson.subject))];
  const title = `Через ${settings.lead} мин: ${subjects.join(" / ")}`;
  const lines = lessons.map((lesson) => {
    const badge = subgroupBadgeLabel(lessonSubgroup(lesson));
    return [`${lesson.start}–${lesson.end}`, lesson.type, badge, lesson.room, lesson.teacher].filter(Boolean).join(" · ");
  });
  return {
    kind: "pair",
    title,
    body: lines.join("\n"),
    tag: `pair-${date}-${first.start}`,
    date,
    url: `${settings.appUrl}?date=${date}`,
    group: settings.group,
    sentAt: new Date().toISOString(),
  };
}

export async function fetchDay(group, date, fetchImpl = fetch) {
  const url = `${PAGES_ORIGIN}/schedule?date=${date}&group=${encodeURIComponent(group)}&windows=1`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "rasp-push-cron" } });
  if (!response.ok) throw new Error(`schedule ${response.status}`);
  const data = await response.json();
  return data.days?.find((day) => day.date === date) || { date, lessons: [] };
}

// Один запуск cron. scheduledTime — момент запуска (мс). Возвращает отчёт для логов.
export async function runCron(env, scheduledTime, { fetchImpl = fetch, send = sendPush } = {}) {
  const vapid = vapidFromEnv(env);
  if (!vapid || !env.PUSH_KV) return { skipped: "no config" };
  const { date, hhmm } = moscowParts(Math.round(scheduledTime / 60000) * 60000);
  const leadsNow = LEADS.filter((lead) => slotsDue(lead, hhmm).length);
  if (!leadsNow.length) return { date, hhmm, idle: true };
  const data = await readSubs(env.PUSH_KV);
  const due = [];
  for (const [id, record] of Object.entries(data.subs)) {
    const settings = record.settings;
    if (!settings?.group || !leadsNow.includes(settings.lead) || inQuiet(settings.quiet, hhmm)) continue;
    for (const start of slotsDue(settings.lead, hhmm)) due.push({ id, record, start });
  }
  if (!due.length) return { date, hhmm, due: 0 };
  const days = new Map();
  for (const group of new Set(due.map((item) => item.record.settings.group))) {
    try {
      days.set(group, await fetchDay(group, date, fetchImpl));
    } catch (error) {
      days.set(group, null);
    }
  }
  const sends = [];
  for (const item of due.slice(0, MAX_SENDS_PER_RUN)) {
    const settings = item.record.settings;
    const lessons = lessonsForSlot(days.get(settings.group), item.start, settings);
    if (!lessons.length) continue;
    sends.push({ ...item, payload: buildPayload(lessons, date, settings) });
  }
  const results = await Promise.all(sends.map((item) => send(item.record.subscription, item.payload, vapid)));
  let changed = false;
  results.forEach((result, index) => {
    const { id } = sends[index];
    if (result.gone) {
      delete data.subs[id];
    } else if (data.subs[id]) {
      data.subs[id].last = { at: new Date(scheduledTime).toISOString(), status: result.status, title: sends[index].payload.title };
    }
    changed = true;
  });
  if (changed) await writeSubs(env.PUSH_KV, data);
  return { date, hhmm, due: due.length, sent: results.filter((r) => r.ok).length, gone: results.filter((r) => r.gone).length, statuses: results.map((r) => r.status) };
}

// ===== HTTP: /push/key, /push/subscribe, /push/unsubscribe, /push/status, /push/test =====

function cors(request, response) {
  const origin = allowedOrigin(request.headers.get("Origin"));
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
    headers.set("Access-Control-Max-Age", "86400");
  }
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

async function body(request) {
  try {
    const text = await request.text();
    return text.length > 8000 ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function testPayload(settings) {
  const { date, hhmm } = moscowParts(Date.now());
  return {
    kind: "test",
    title: "Пары: проверка уведомлений",
    body: `Работает! Отправлено сервером в ${hhmm} МСК. Напоминания о парах придут за ${settings.lead} мин.`,
    tag: "rasp-test",
    date,
    url: `${settings.appUrl}?date=${date}`,
    sentAt: new Date().toISOString(),
  };
}

export async function handlePush(context, path) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return cors(request, new Response(null, { status: 204 }));
  const vapid = vapidFromEnv(env);
  if (path === "key") {
    return cors(request, json(vapid ? 200 : 503, vapid ? { ok: true, publicKey: vapid.publicKey } : { ok: false, error: "not_configured" }));
  }
  if (request.method !== "POST") return cors(request, json(405, { ok: false, error: "method_not_allowed" }));
  if (!vapid || !env.PUSH_KV) return cors(request, json(503, { ok: false, error: "not_configured", message: "Сервер уведомлений не настроен." }));
  const input = await body(request);
  if (!input) return cors(request, json(400, { ok: false, error: "bad_json" }));
  const endpoint = input.subscription?.endpoint || input.endpoint || "";
  if (path === "test") {
    if (!validSubscription(input.subscription)) return cors(request, json(400, { ok: false, error: "bad_subscription", message: "Подписка повреждена — выключите и включите уведомления." }));
    const settings = cleanSettings(input.settings);
    const result = await sendPush(input.subscription, testPayload(settings), vapid, { ttl: 300 });
    return cors(request, json(result.ok ? 200 : 502, { ok: result.ok, status: result.status, gone: result.gone, message: result.ok ? "Отправлено" : `Сервис уведомлений ответил ${result.status || "ошибкой сети"}` }));
  }
  if (path === "subscribe") {
    if (!validSubscription(input.subscription)) return cors(request, json(400, { ok: false, error: "bad_subscription" }));
    const settings = cleanSettings(input.settings);
    if (!settings.group) return cors(request, json(400, { ok: false, error: "bad_group", message: "Сначала выберите группу." }));
    const data = await readSubs(env.PUSH_KV);
    const id = await subId(input.subscription.endpoint);
    if (input.oldEndpoint) delete data.subs[await subId(input.oldEndpoint)];
    if (!data.subs[id] && Object.keys(data.subs).length >= MAX_SUBS) return cors(request, json(507, { ok: false, error: "full" }));
    const now = new Date().toISOString();
    data.subs[id] = {
      subscription: { endpoint: input.subscription.endpoint, keys: { p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth } },
      settings,
      createdAt: data.subs[id]?.createdAt || now,
      updatedAt: now,
      last: data.subs[id]?.last || null,
    };
    await writeSubs(env.PUSH_KV, data);
    return cors(request, json(200, { ok: true, id, settings, savedAt: now }));
  }
  if (path === "unsubscribe") {
    if (!endpoint) return cors(request, json(400, { ok: false, error: "no_endpoint" }));
    const data = await readSubs(env.PUSH_KV);
    const id = await subId(endpoint);
    if (data.subs[id]) {
      delete data.subs[id];
      await writeSubs(env.PUSH_KV, data);
    }
    return cors(request, json(200, { ok: true }));
  }
  if (path === "status") {
    if (!endpoint) return cors(request, json(400, { ok: false, error: "no_endpoint" }));
    const data = await readSubs(env.PUSH_KV);
    const record = data.subs[await subId(endpoint)];
    return cors(request, json(200, { ok: true, subscribed: Boolean(record), settings: record?.settings || null, last: record?.last || null, updatedAt: record?.updatedAt || null }));
  }
  return cors(request, json(404, { ok: false, error: "not_found" }));
}
