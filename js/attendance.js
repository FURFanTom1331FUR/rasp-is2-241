import { PAGES_ORIGIN, WORKER_URL, isProxyHost } from "./config.js";
import { fetchText } from "./net.js";

const SESSION_KEY = "rasp.attendance.session";
const SNAPSHOT_KEY = "rasp.attendance.snapshot";
const WORKER_KEY = "rasp.workerUrl";

export class AttendanceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AttendanceError";
    this.code = code || "failed";
  }
}

export const ATTENDANCE_NETWORK_MESSAGE =
  "Нет связи с сервером посещаемости. Обновите страницу или удалите сайт с экрана и откройте снова. Если не поможет — Worker недоступен из сети.";

export function asAttendanceError(error) {
  if (error instanceof AttendanceError) return error;
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  if (
    name === "TypeError" ||
    name === "NetworkError" ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    /Failed to fetch|NetworkError|Load failed|aborted|timed out|timeout/i.test(message)
  ) {
    return new AttendanceError(ATTENDANCE_NETWORK_MESSAGE, "network");
  }
  if (error instanceof Error) return error;
  return new AttendanceError("Не удалось войти", "failed");
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function bakedWorkerUrl() {
  return String(WORKER_URL || "").trim().replace(/\/$/, "");
}

export function normalizeWorkerUrl(value, baked = bakedWorkerUrl()) {
  const clean = String(value || "").trim().replace(/\/$/, "");
  if (!clean) return "";
  let url;
  try {
    url = new URL(clean);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  let bakedHost = "";
  if (baked) {
    try {
      bakedHost = new URL(baked).hostname;
    } catch {
      bakedHost = "";
    }
  }
  const allowed = local || url.hostname.endsWith(".workers.dev") || (bakedHost && url.hostname === bakedHost);
  if (!allowed) return null;
  const path = url.pathname.replace(/\/$/, "");
  return url.origin + path;
}

export function configuredWorkerUrl() {
  const baked = normalizeWorkerUrl(bakedWorkerUrl());
  if (baked) return baked;
  const origin = globalThis.location?.origin;
  if (!origin || origin === "null") return "";
  // Зеркало (GitHub Pages) без functions/ — вход идёт через Cloudflare Pages.
  if (!isProxyHost(globalThis.location?.hostname)) return PAGES_ORIGIN;
  return String(origin).replace(/\/$/, "");
}

export function saveWorkerUrl(value) {
  const next = normalizeWorkerUrl(value);
  if (next == null) return null;
  if (next) localStorage.setItem(WORKER_KEY, next);
  else localStorage.removeItem(WORKER_KEY);
  return next;
}

export function loadSession() {
  const session = readJson(SESSION_KEY);
  if (!session?.token || !session.login) return null;
  if (!/^[A-Za-z0-9]{8,128}$/.test(session.token)) return null;
  return {
    login: String(session.login),
    token: session.token,
    savedAt: session.savedAt || "",
    name: cleanStudentName(session.name),
  };
}

export function saveSession(session) {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      login: session.login,
      token: session.token,
      savedAt: session.savedAt,
      name: cleanStudentName(session.name),
    }),
  );
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function loadSnapshot() {
  const snapshot = readJson(SNAPSHOT_KEY);
  if (!snapshot || !Array.isArray(snapshot.days)) return null;
  return snapshot;
}

export function saveSnapshot(snapshot) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function summarizeAttendance(days) {
  let total = 0;
  let absent = 0;
  let present = 0;
  let unmarked = 0;
  for (const day of days || []) {
    for (const subject of day.subjects || []) {
      total += 1;
      if (subject.mark === "absent") absent += 1;
      else if (subject.mark === "present") present += 1;
      else unmarked += 1;
    }
  }
  const attended = total - absent;
  const percent = total ? Math.round((attended / total) * 1000) / 10 : null;
  return { total, absent, present, unmarked, attended, percent };
}

export function cleanStudentName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 160 || !/[A-Za-zА-Яа-яЁё]/.test(text)) return "";
  return text;
}

export function markOf(go) {
  if (go === "0" || go === 0) return "absent";
  if (go == null || go === "" || go === " ") return "none";
  return "present";
}

export function normalizeAttendance(payload) {
  const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return source.map((day) => ({
    date: String(day?.date || ""),
    subjects: (Array.isArray(day?.subjects) ? day.subjects : []).map((subject) => ({
      name: String(subject?.name || ""),
      type: String(subject?.type || ""),
      mark: markOf(subject?.go),
    })),
  }));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function loginAttendance(workerUrl, login, password) {
  try {
    const response = await fetchText(`${workerUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ login, password }),
    });
    const json = parseJson(response.text);
    if (!response.ok || !json?.ok || !json.token) {
      throw new AttendanceError(json?.error || "Не удалось войти", response.status === 401 ? "denied" : "failed");
    }
    return { login: String(json.login || login), token: String(json.token), name: cleanStudentName(json.name) };
  } catch (error) {
    throw asAttendanceError(error);
  }
}

export async function fetchAttendance(workerUrl, token, from, to, options = {}) {
  try {
    const url = new URL(`${workerUrl}/attendance`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    if (options.needName === false) url.searchParams.set("needName", "0");
    const response = await fetchText(url, {
      headers: { Accept: "application/json", "X-Vgltu-Session": token },
    });
    const json = parseJson(response.text);
    if (response.status === 401) {
      throw new AttendanceError(json?.error || "Сессия истекла. Войдите снова.", "unauthorized");
    }
    if (!response.ok || !json?.ok) {
      throw new AttendanceError(json?.error || "Кабинет не отдал посещаемость", "failed");
    }
    return {
      days: normalizeAttendance(json),
      format: json.format || "",
      name: cleanStudentName(json.name),
    };
  } catch (error) {
    throw asAttendanceError(error);
  }
}

export async function logoutAttendance(workerUrl, token) {
  try {
    await fetchText(`${workerUrl}/logout`, {
      method: "POST",
      headers: { Accept: "application/json", "X-Vgltu-Session": token },
    });
  } catch {
    /* Локальная сессия всё равно стирается. */
  }
}
