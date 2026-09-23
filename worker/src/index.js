// Прокси только для входа в личный кабинет ВГЛТУ и журнала посещаемости.
// Пароль не пишется в логи и никуда не уходит, кроме POST https://vgltu.ru/lc/login.

const LOGIN_PAGE = "https://vgltu.ru/lc/login";
const ATTENDANCE = "https://vgltu.ru/lc/site/ajax-attendance-by-date";
const LOGOUT_PAGE = "https://vgltu.ru/lc/logout";
const UA = "rasp-is2-241 attendance-proxy";

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin && origin !== "null" ? origin : "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Vgltu-Session",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function json(request, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

export function collectCookies(response) {
  const lines = [];
  if (typeof response.headers.getSetCookie === "function") lines.push(...response.headers.getSetCookie());
  else {
    const single = response.headers.get("set-cookie");
    if (single) lines.push(...single.split(/,(?=\s*[^;,]+=)/));
  }
  const jar = new Map();
  for (const line of lines) {
    const pair = String(line).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function mergeCookies(base, extra) {
  const next = new Map(base);
  for (const [name, value] of extra) next.set(name, value);
  return next;
}

export function dateAttempts(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return [];
  return [`${match[3]}.${match[2]}.${match[1]}`, iso];
}

function loginMessage(html) {
  const blocks = [...String(html).matchAll(/help-block-error[^>]*>([^<]*)</g)].map((item) => item[1].trim()).filter(Boolean);
  if (blocks.length) return blocks[0];
  if (String(html).includes("Неверный")) return "Неверный ID или пароль!";
  return "Не удалось войти";
}

function looksLikeLogin(html) {
  const text = String(html);
  return text.includes('id="login-form"') || text.includes("Неверный ID") || text.includes("loginform-login");
}

export function studentNameFromHtml(html) {
  const match = String(html).match(/<([a-z0-9]+)\b[^>]*class="(?:[^"]*\s)?user-info__fio(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/\1>/i);
  if (!match) return "";
  const text = match[2]
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 160 || !/[A-Za-zА-Яа-яЁё]/.test(text)) return "";
  return text;
}

function safeLcUrl(location) {
  try {
    const url = new URL(location, "https://vgltu.ru");
    if (url.protocol !== "https:" || url.hostname !== "vgltu.ru" || !url.pathname.startsWith("/lc")) return "";
    return url.origin + url.pathname + url.search;
  } catch {
    return "";
  }
}

async function fetchStudentName(token, fetchImpl) {
  const pages = ["https://vgltu.ru/lc/", "https://vgltu.ru/lc/attendance"];
  for (const page of pages) {
    const response = await fetchImpl(page, {
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: `PHPFRONTSESSID=${token}`,
        "User-Agent": UA,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = safeLcUrl(response.headers.get("Location") || "");
      if (!next || next.includes("/login")) continue;
      const followed = await fetchImpl(next, {
        redirect: "manual",
        headers: {
          Accept: "text/html",
          Cookie: `PHPFRONTSESSID=${token}`,
          "User-Agent": UA,
        },
      });
      const name = studentNameFromHtml(await followed.text());
      if (name) return name;
      continue;
    }
    const name = studentNameFromHtml(await response.text());
    if (name) return name;
  }
  return "";
}

export async function performLogin(login, password, fetchImpl = fetch) {
  const page = await fetchImpl(LOGIN_PAGE, {
    redirect: "manual",
    headers: { Accept: "text/html", "User-Agent": UA },
  });
  const html = await page.text();
  let jar = collectCookies(page);
  const token = html.match(/name="_frontendCSRF" value="([^"]+)"/)?.[1];
  if (!token) {
    return { ok: false, status: 502, error: "Страница входа ВГЛТУ не отдала проверочный код." };
  }
  const body = new URLSearchParams();
  body.set("_frontendCSRF", token);
  body.set("LoginForm[login]", login);
  body.set("LoginForm[password]", password);
  body.set("login-button", "");
  const posted = await fetchImpl(LOGIN_PAGE, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Origin: "https://vgltu.ru",
      Referer: LOGIN_PAGE,
      "User-Agent": UA,
    },
    body,
  });
  jar = mergeCookies(jar, collectCookies(posted));
  const location = posted.headers.get("Location") || "";
  const failedRedirect = /\/login\/?$/.test(location) || location.includes("/lc/login");
  if (posted.status >= 300 && posted.status < 400 && location && !failedRedirect) {
    const session = jar.get("PHPFRONTSESSID") || "";
    if (!/^[A-Za-z0-9]{8,128}$/.test(session)) {
      return { ok: false, status: 502, error: "Кабинет не выдал сессию." };
    }
    let name = "";
    try {
      const landed = safeLcUrl(location);
      if (landed) name = studentNameFromHtml(await (await fetchImpl(landed, {
        redirect: "manual",
        headers: { Accept: "text/html", Cookie: cookieHeader(jar), "User-Agent": UA },
      })).text());
      if (!name) name = await fetchStudentName(session, fetchImpl);
    } catch {
      name = "";
    }
    return { ok: true, status: 200, login, token: session, name };
  }
  const failureHtml = await posted.text();
  return { ok: false, status: 401, error: loginMessage(failureHtml) };
}

export async function performAttendance(token, from, to, fetchImpl = fetch, options = {}) {
  if (!/^[A-Za-z0-9]{8,128}$/.test(token || "")) {
    return { ok: false, status: 401, error: "Нет сессии. Войдите снова." };
  }
  const attempts = dateAttempts(from).map((begin, index) => [begin, dateAttempts(to)[index]]);
  let empty = null;
  for (const [beginDate, endDate] of attempts) {
    if (!beginDate || !endDate) continue;
    const url = new URL(ATTENDANCE);
    url.searchParams.set("beginDate", beginDate);
    url.searchParams.set("endDate", endDate);
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: `PHPFRONTSESSID=${token}`,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://vgltu.ru/lc/attendance",
        "User-Agent": UA,
      },
    });
    const text = await response.text();
    if (looksLikeLogin(text) || text.includes('property "login" on null') || text.includes("property &quot;login&quot; on null")) {
      return { ok: false, status: 401, error: "Сессия истекла. Войдите снова." };
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!payload) continue;
    const data = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
    if (!data) continue;
    if (payload.gotData === false || data.length === 0) {
      empty = { ok: true, status: 200, format: beginDate.includes(".") ? "d.m.Y" : "Y-m-d", data };
      continue;
    }
    return { ok: true, status: 200, format: beginDate.includes(".") ? "d.m.Y" : "Y-m-d", data, name: options.name || "" };
  }
  if (empty) return { ...empty, name: options.name || "" };
  return { ok: false, status: 502, error: "Кабинет не отдал журнал посещаемости." };
}

export async function performLogout(token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9]{8,128}$/.test(token || "")) return;
  await fetchImpl(LOGOUT_PAGE, {
    redirect: "manual",
    headers: { Cookie: `PHPFRONTSESSID=${token}`, "User-Agent": UA },
  });
}

function routeOf(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  return { url, path };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const { url, path } = routeOf(request);
    try {
      if (request.method === "POST" && path === "/login") {
        const payload = await request.json().catch(() => null);
        const login = String(payload?.login || "").trim();
        const password = String(payload?.password || "");
        if (!login || !password || login.length > 64 || password.length > 200) {
          return json(request, 400, { ok: false, error: "Введите ID студента и пароль." });
        }
        const result = await performLogin(login, password);
        return json(request, result.status, result.ok
          ? { ok: true, login: result.login, token: result.token, name: result.name || "" }
          : { ok: false, error: result.error });
      }
      if (request.method === "GET" && path === "/attendance") {
        const sessionToken = request.headers.get("X-Vgltu-Session") || "";
        let name = "";
        if (url.searchParams.get("needName") !== "0") {
          try {
            name = await fetchStudentName(sessionToken, fetch);
          } catch {
            name = "";
          }
        }
        const result = await performAttendance(sessionToken, url.searchParams.get("from"), url.searchParams.get("to"), fetch, { name });
        return json(request, result.status, result.ok
          ? { ok: true, format: result.format, data: result.data, name: result.name || "" }
          : { ok: false, error: result.error });
      }
      if (request.method === "POST" && path === "/logout") {
        await performLogout(request.headers.get("X-Vgltu-Session") || "");
        return json(request, 200, { ok: true });
      }
      return json(request, 404, { ok: false, error: "Неизвестный запрос." });
    } catch {
      return json(request, 502, { ok: false, error: "Нет связи с vgltu.ru." });
    }
  },
};
