import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fetchText } from "../js/net.js";
import { apiBase, isProxyHost, PAGES_ORIGIN } from "../js/config.js";
import { ATTENDANCE_NETWORK_MESSAGE, asAttendanceError, AttendanceError, configuredWorkerUrl, markOf, normalizeAttendance, normalizeWorkerUrl, summarizeAttendance } from "../js/attendance.js";
import { onRequest as onLogin } from "../functions/login.js";
import { onRequest as onAttendance } from "../functions/attendance.js";
import { onRequest as onLogout } from "../functions/logout.js";
import { onRequest as onSchedule } from "../functions/schedule.js";
import { onRequest as onGroups } from "../functions/groups.js";
import { allowedOrigin, cachedJson, fetchUpstream, isGroupCode, isIsoDate, loadGroups, loadSchedule, shiftIso, UpstreamError, windowCount } from "../functions/_kis.js";
import { addDays, formatDots, isValidIso, mondayOf, moscowInstant, moscowIso, semesterRange, visibleWeekDays, weekdayName } from "../js/dates.js";
import { dateAttempts, studentNameFromHtml } from "../worker/src/index.js";
import { lessonMatchesSubgroup, lessonSubgroup, parseScheduleHtml, subgroupNumberIn, subjectMatchesSubgroup, subjectSubgroup } from "../js/parse.js";

assert.equal(moscowIso(new Date("2026-09-22T21:00:00.000Z")), "2026-09-23");
assert.equal(moscowIso(new Date("2026-09-22T20:59:00.000Z")), "2026-09-22");
assert.equal(formatDots("2026-09-23"), "23.09.2026");
assert.equal(addDays("2026-09-30", 1), "2026-10-01");
assert.equal(addDays("2026-12-31", 1), "2027-01-01");
assert.equal(mondayOf("2026-09-23"), "2026-09-21");
assert.equal(mondayOf("2026-09-27"), "2026-09-21");
assert.equal(isValidIso("2026-09-23"), true);
assert.equal(isValidIso("2026-02-29"), false);
assert.equal(isValidIso("2028-02-29"), true);
assert.equal(isValidIso("2026-04-31"), false);
assert.equal(weekdayName("2026-09-23"), "среда");
assert.deepEqual(visibleWeekDays("2026-09-23", "2026-09-23"), [
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
]);
assert.deepEqual(visibleWeekDays("2026-09-21", "2026-09-23"), [
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
]);
assert.equal(weekdayName("2026-09-27"), "воскресенье");
assert.deepEqual(visibleWeekDays("2026-09-27", "2026-09-27"), ["2026-09-27"]);
assert.deepEqual(visibleWeekDays("2026-09-30", "2026-09-23"), [
  "2026-09-28",
  "2026-09-29",
  "2026-09-30",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
]);
assert.deepEqual(visibleWeekDays("2026-09-14", "2026-09-23"), []);
assert.deepEqual(semesterRange("2026-09-23"), {
  from: "2026-09-01",
  to: "2027-01-31",
  label: "Осенний семестр",
});
assert.equal(semesterRange("2026-03-02").label, "Весенний семестр");
assert.equal(markOf("0"), "absent");
assert.equal(markOf(null), "none");
assert.equal(markOf("1"), "present");
assert.equal(normalizeAttendance({
  gotData: true,
  data: [{ date: "23.09.2026", subjects: [{ name: "Экономика", type: "лек", go: "0" }] }],
})[0].subjects[0].mark, "absent");
assert.deepEqual(summarizeAttendance([
  { subjects: [{ mark: "present" }, { mark: "absent" }, { mark: "none" }] },
  { subjects: [{ mark: "present" }] },
]), {
  total: 4,
  absent: 1,
  present: 2,
  unmarked: 1,
  attended: 3,
  percent: 75,
});
assert.equal(summarizeAttendance([]).percent, null);
assert.equal(normalizeWorkerUrl("https://rasp-attendance.example.workers.dev"), "https://rasp-attendance.example.workers.dev");
assert.equal(normalizeWorkerUrl("https://evil.example/login"), null);
assert.equal(configuredWorkerUrl(), "");
globalThis.location = { origin: "https://rasp-is2-241.pages.dev/", hostname: "rasp-is2-241.pages.dev" };
assert.equal(configuredWorkerUrl(), "https://rasp-is2-241.pages.dev");
globalThis.location = { origin: "https://abc123.rasp-is2-241.pages.dev", hostname: "abc123.rasp-is2-241.pages.dev" };
assert.equal(configuredWorkerUrl(), "https://abc123.rasp-is2-241.pages.dev");
globalThis.location = { origin: "http://localhost:8788", hostname: "localhost" };
assert.equal(configuredWorkerUrl(), "http://localhost:8788");
// Зеркало GitHub Pages без functions/ — вход через Cloudflare Pages.
globalThis.location = { origin: "https://furfantom1331fur.github.io", hostname: "furfantom1331fur.github.io" };
assert.equal(configuredWorkerUrl(), "https://rasp-is2-241.pages.dev");
delete globalThis.location;
const network = asAttendanceError(new TypeError("Failed to fetch"));
assert.equal(network.message, ATTENDANCE_NETWORK_MESSAGE);
assert.equal(asAttendanceError(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })).code, "network");
assert.equal(asAttendanceError(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })).message, ATTENDANCE_NETWORK_MESSAGE);
assert.equal(network.message.includes("Failed to fetch"), false);
assert.equal(asAttendanceError(Object.assign(new Error("Load failed"), { name: "TypeError" })).message, ATTENDANCE_NETWORK_MESSAGE);
assert.equal(asAttendanceError(Object.assign(new Error("NetworkError when attempting to fetch resource."), { name: "NetworkError" })).message, ATTENDANCE_NETWORK_MESSAGE);
const denied = new AttendanceError("Неверный ID или пароль!", "denied");
assert.equal(asAttendanceError(denied), denied);
const loginDenied = await onLogin({
  request: new Request("https://rasp.pages.dev/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }),
});
assert.equal(loginDenied.status, 400);
assert.deepEqual(await loginDenied.json(), { ok: false, error: "Введите ID студента и пароль." });
const loginOptions = await onLogin({
  request: new Request("https://rasp.pages.dev/login", { method: "OPTIONS" }),
});
assert.equal(loginOptions.status, 204);
const journal = await onAttendance({
  request: new Request("https://rasp.pages.dev/attendance?from=2026-09-01&to=2026-09-07"),
});
assert.equal(journal.status, 401);
const signedOut = await onLogout({
  request: new Request("https://rasp.pages.dev/logout", { method: "POST" }),
});
assert.equal(signedOut.status, 200);
assert.deepEqual(await signedOut.json(), { ok: true });
assert.deepEqual(dateAttempts("2026-09-23"), ["23.09.2026", "2026-09-23"]);
assert.equal(studentNameFromHtml(`<div class="user-info__fio-wrap"><div class="user-info__fio">Иванов<br> Иван  Иванович</div><span class="user-info__userid">ID</span></div>`), "Иванов Иван Иванович");
assert.equal(studentNameFromHtml(`<div class="user-info__fio-wrap">нет</div>`), "");
assert.equal(moscowInstant("2026-09-23", "13:40").toISOString(), "2026-09-23T10:40:00.000Z");

const fixture = `
<div class="table">
  <div style="margin-bottom: 25px;">
    <div><strong>23 сентября 2026</strong></div>
    <div>среда</div>
    <table>
      <tr>
        <td rowspan="2">17:00-18:30</td>
        <td>лаб. Тестирование программного обеспечения<br/>2 п.г.<br />ИС2-241-ОБ<br/><a href="https://kis.vgltu.ru/map/rasp?auditory=215&#x41A;&#x43E;&#x43C;&#x43F;/&#x413;&#x43B;">215&#x41A;&#x43E;&#x43C;&#x43F;/&#x413;&#x43B;</a><br />Занин И.Н.<br /></td>
      </tr>
      <tr>
        <td>лек. Экономика<br/><br />ИС2-241-ОБ<br />ИС2-242-ОБ<br/><a>119Л/7к</a><br />Серебрякова Н.А.<br /></td>
      </tr>
      <tr>
        <td>08:30-10:00</td>
        <td>Физическая культура<br/><br />ИС2-241-ОБ<br/><a>сз /Гл</a><br />ВакансияФиз-ра3<br /></td>
      </tr>
    </table>
  </div>
  <div>
    <div><strong>27 сентября 2026</strong></div>
    <div>воскресенье</div>
    <table><tr><td>Нет пар.</td></tr></table>
  </div>
  <div>
    <div><strong>24 сентября 2026</strong></div>
    <div>четверг</div>
    <table>
      <tr>
        <td>10:10-11:40</td>
        <td>пр. Web-разработка (1 п/г)<br/>ИС2-241-ОБ<br/><a>215Комп/Гл</a><br/>Иванов И.И.</td>
      </tr>
      <tr>
        <td rowspan="2">11:50-13:20</td>
        <td>лаб. Предмет<br/>(2пг)<br/>ИС2-241-ОБ<br/><a>97Комп/Гл</a><br/>Петров П.П.</td>
      </tr>
      <tr>
        <td>лек. Общая<br/>1 пг<br/>ИС2-241-ОБ<br/><a>сз /Гл</a><br/>Сидоров С.С.</td>
      </tr>
      <tr>
        <td>13:40-15:10</td>
        <td>пр. Подгруппы в названии<br/>подгруппа 2<br/>ИС2-241-ОБ<br/><a>119Л/7к</a><br/>Орлова О.О.</td>
      </tr>
    </table>
  </div>
</div>`;

const days = parseScheduleHtml(fixture);
assert.equal(days.length, 3);
assert.equal(days[0].date, "2026-09-23");
assert.equal(days[1].date, "2026-09-27");
assert.equal(days[1].lessons.length, 0);
assert.equal(days[0].lessons.length, 3);
assert.deepEqual(days[0].lessons[0], {
  time: "08:30-10:00",
  start: "08:30",
  end: "10:00",
  type: null,
  subject: "Физическая культура",
  subgroup: null,
  room: "сз /Гл",
  teacher: "ВакансияФиз-ра3",
  groups: ["ИС2-241-ОБ"],
});
const lab = days[0].lessons.find((lesson) => lesson.subject.startsWith("Тестирование"));
assert.equal(lab.type, "лаб");
assert.equal(lab.subgroup, "2 п.г.");
assert.equal(lab.room, "215Комп/Гл");
assert.equal(lab.teacher, "Занин И.Н.");
assert.equal(lab.time, "17:00-18:30");
const lecture = days[0].lessons.find((lesson) => lesson.subject === "Экономика");
assert.equal(lecture.type, "лек");
assert.deepEqual(lecture.groups, ["ИС2-241-ОБ", "ИС2-242-ОБ"]);

const variants = days.find((day) => day.date === "2026-09-24").lessons;
const web = variants.find((lesson) => lesson.subject === "Web-разработка");
assert.equal(web.subgroup, "1 п.г.");
assert.equal(web.room, "215Комп/Гл");
assert.equal(lessonSubgroup(web), 1);
const subjectOnly = variants.find((lesson) => lesson.subject === "Предмет");
assert.equal(subjectOnly.subgroup, "2 п.г.");
assert.equal(subjectOnly.room, "97Комп/Гл");
const shortMark = variants.find((lesson) => lesson.subject === "Общая");
assert.equal(shortMark.subgroup, "1 п.г.");
assert.equal(shortMark.room, "сз /Гл");
const worded = variants.find((lesson) => lesson.subject === "Подгруппы в названии");
assert.equal(worded.subgroup, "2 п.г.");
assert.equal(worded.room, "119Л/7к");
assert.equal(subgroupNumberIn("215Комп/Гл"), null);
assert.equal(subgroupNumberIn("97Комп/Гл"), null);
assert.equal(subgroupNumberIn("(1пг)"), 1);
assert.equal(subgroupNumberIn("2-я подгруппа"), 2);
assert.equal(subgroupNumberIn("1 п.г."), 1);

const sample = [
  { subject: "Общая лекция", subgroup: null },
  { subject: "Лабораторная", subgroup: "1 п.г." },
  { subject: "Другая лабораторная", subgroup: "2 п.г." },
];
assert.deepEqual(sample.filter((lesson) => lessonMatchesSubgroup(lesson, "all")).map((lesson) => lesson.subject), [
  "Общая лекция",
  "Лабораторная",
  "Другая лабораторная",
]);
assert.deepEqual(sample.filter((lesson) => lessonMatchesSubgroup(lesson, "1")).map((lesson) => lesson.subject), [
  "Общая лекция",
  "Лабораторная",
]);
assert.deepEqual(sample.filter((lesson) => lessonMatchesSubgroup(lesson, "2")).map((lesson) => lesson.subject), [
  "Общая лекция",
  "Другая лабораторная",
]);
assert.equal(lessonMatchesSubgroup({ subject: "Комп", room: "215Комп/Гл", subgroup: null }, "1"), true);
assert.equal(subjectSubgroup({ name: "Лабораторная (2 пг)", type: "лаб" }, []), 2);
assert.equal(subjectMatchesSubgroup({ name: "Лабораторная (2 пг)", type: "лаб" }, "1"), false);
assert.equal(subjectMatchesSubgroup({ name: "Лабораторная", type: "лаб" }, "1", sample), true);
assert.equal(subjectMatchesSubgroup({ name: "Лабораторная", type: "лаб" }, "2", sample), false);
assert.equal(subjectMatchesSubgroup({ name: "Экономика", type: "лек" }, "2", sample), true);
assert.equal(subjectSubgroup({ name: "Лабораторная", type: "" }, [
  { subject: "Лабораторная", subgroup: "1 п.г." },
  { subject: "Лабораторная", subgroup: "2 п.г." },
]), null);

const hung = await new Promise((resolve, reject) => {
  const server = http.createServer(() => {});
  server.listen(0, "127.0.0.1", async () => {
    const { port } = server.address();
    const started = Date.now();
    try {
      await fetchText(`http://127.0.0.1:${port}/hang`, {}, 300);
      reject(new Error("hung fetch should abort"));
    } catch (error) {
      const elapsed = Date.now() - started;
      try {
        assert.equal(error.name, "AbortError");
        assert.ok(elapsed < 1500, `timeout took ${elapsed}ms`);
      } catch (check) {
        server.close(() => reject(check));
        return;
      }
    }
    server.close(() => resolve());
  });
});
assert.equal(hung, undefined);

const quick = await new Promise((resolve, reject) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1", async () => {
    const { port } = server.address();
    try {
      const response = await fetchText(`http://127.0.0.1:${port}/ok`, {}, 1000);
      assert.equal(response.ok, true);
      assert.equal(response.text, '{"ok":true}');
    } catch (error) {
      server.close(() => reject(error));
      return;
    }
    server.close(() => resolve());
  });
});
assert.equal(quick, undefined);

// Прокси расписания: проверка параметров, разбор, ошибки ВГЛТУ.
assert.equal(isIsoDate("2026-09-25"), true);
assert.equal(isIsoDate("2026-02-30"), false);
assert.equal(isIsoDate("25.09.2026"), false);
assert.equal(isGroupCode("ИС2-241-ОБ"), true);
assert.equal(isGroupCode("<script>"), false);
assert.equal(isGroupCode(""), false);
assert.equal(shiftIso("2026-09-21", 14), "2026-10-05");
assert.equal(windowCount("9"), 3);
assert.equal(windowCount("x"), 1);
assert.equal((await onSchedule({ request: new Request("https://x.test/schedule?date=2026-13-01&group=ИС2-241-ОБ") })).status, 400);
assert.equal((await onSchedule({ request: new Request("https://x.test/schedule?date=2026-09-21&group=%3Cb%3E") })).status, 400);
assert.equal((await onSchedule({ request: new Request("https://x.test/schedule", { method: "POST" }) })).status, 405);
assert.equal((await onGroups({ request: new Request("https://x.test/groups", { method: "POST" }) })).status, 405);
{
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, encoding: init.headers["Accept-Encoding"] });
    return new Response(fixture, { status: 200, headers: { "Content-Type": "text/html" } });
  };
  const record = await loadSchedule("ИС2-241-ОБ", "2026-09-21", 2, fakeFetch);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((item) => item.encoding === "gzip"));
  assert.ok(seen[1].url.includes("date=2026-10-05"));
  assert.equal(record.origin, "live");
  assert.equal(record.days.length, 3);
  const groups = await loadGroups(async () => new Response(JSON.stringify(["ИС2-241-ОБ", " ", "ИС2-251-ОБ"])));
  assert.deepEqual(groups.groups, ["ИС2-241-ОБ", "ИС2-251-ОБ"]);
  await assert.rejects(loadSchedule("ИС2-241-ОБ", "2026-09-21", 1, async () => new Response("<p>пусто</p>")), UpstreamError);
  await assert.rejects(fetchUpstream("https://x.test/", async () => new Response("", { status: 503 })), (error) => error.code === "status");
  await assert.rejects(
    fetchUpstream("https://x.test/", (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), 50),
    (error) => error.code === "timeout",
  );
  const failed = await cachedJson({}, "https://x.test/__edge/k", 60, async () => {
    throw new UpstreamError("timeout", "slow");
  });
  assert.equal(failed.status, 504);
  assert.equal((await failed.json()).error, "upstream_timeout");
  const broken = await cachedJson({}, "https://x.test/__edge/k", 60, async () => {
    throw new UpstreamError("status", "HTTP 500");
  });
  assert.equal(broken.status, 502);
  const good = await cachedJson({}, "https://x.test/__edge/k", 60, async () => ({ ok: true, fetchedAt: new Date().toISOString(), days: [] }));
  assert.equal(good.status, 200);
  assert.match(good.headers.get("Content-Type"), /json/);
}

// Основа адресов прокси: свой домен на pages.dev/localhost, иначе pages.dev по CORS.
assert.equal(PAGES_ORIGIN, "https://rasp-is2-241.pages.dev");
assert.equal(apiBase("rasp-is2-241.pages.dev"), "./");
assert.equal(apiBase("feature-x.rasp-is2-241.pages.dev"), "./");
assert.equal(apiBase("localhost"), "./");
assert.equal(apiBase("127.0.0.1"), "./");
assert.equal(apiBase("furfantom1331fur.github.io"), "https://rasp-is2-241.pages.dev/");
assert.equal(apiBase("evil-rasp-is2-241.pages.dev"), "https://rasp-is2-241.pages.dev/");
assert.equal(isProxyHost("rasp-is2-241.pages.dev.evil.com"), false);

// CORS прокси: белый список, Vary: Origin, заголовок на каждый ответ (в том числе из копии на краю).
{
  const MIRROR = "https://furfantom1331fur.github.io";
  assert.equal(allowedOrigin(MIRROR), MIRROR);
  assert.equal(allowedOrigin("https://rasp-is2-241.pages.dev"), "https://rasp-is2-241.pages.dev");
  assert.equal(allowedOrigin("https://0a1b2c.rasp-is2-241.pages.dev"), "https://0a1b2c.rasp-is2-241.pages.dev");
  assert.equal(allowedOrigin("https://evil.example"), "");
  assert.equal(allowedOrigin("https://rasp-is2-241.pages.dev.evil.example"), "");
  assert.equal(allowedOrigin("http://furfantom1331fur.github.io"), "");
  assert.equal(allowedOrigin("null"), "");
  const at = (path, init = {}) => new Request(`https://rasp-is2-241.pages.dev${path}`, init);
  for (const handler of [onSchedule, onGroups]) {
    const path = handler === onSchedule ? "/schedule?date=2026-09-21&group=ИС2-241-ОБ" : "/groups";
    const ok = await handler({ request: at(path, { method: "OPTIONS", headers: { Origin: MIRROR, "Access-Control-Request-Method": "GET" } }) });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), MIRROR);
    assert.equal(ok.headers.get("Access-Control-Allow-Methods"), "GET");
    assert.match(ok.headers.get("Vary"), /Origin/);
    const bad = await handler({ request: at(path, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }) });
    assert.equal(bad.status, 204);
    assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
    assert.match(bad.headers.get("Vary"), /Origin/);
    const post = await handler({ request: at(path, { method: "POST", headers: { Origin: MIRROR } }) });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Access-Control-Allow-Origin"), MIRROR);
  }
  const badDate = await onSchedule({ request: at("/schedule?date=x&group=ИС2-241-ОБ", { headers: { Origin: MIRROR } }) });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.headers.get("Access-Control-Allow-Origin"), MIRROR);

  // Копия на краю не хранит CORS: один и тот же кэш отдаётся разным Origin с разными заголовками.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const store = new Map();
  const fakeCache = {
    async match(request) {
      const hit = store.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null, "edge copy must not carry ACAO");
      store.set(request.url, response.clone());
    },
  };
  Object.defineProperty(globalThis, "caches", { value: { default: fakeCache }, configurable: true, writable: true });
  try {
    store.set("https://rasp-is2-241.pages.dev/__edge/groups", new Response(JSON.stringify({ ok: true, fetchedAt: new Date().toISOString(), groups: ["ИС2-241-ОБ"] }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
    const fromMirror = await onGroups({ request: at("/groups", { headers: { Origin: MIRROR } }) });
    assert.equal(fromMirror.headers.get("X-Rasp-Edge"), "hit");
    assert.equal(fromMirror.headers.get("Access-Control-Allow-Origin"), MIRROR);
    assert.deepEqual((await fromMirror.json()).groups, ["ИС2-241-ОБ"]);
    const fromEvil = await onGroups({ request: at("/groups", { headers: { Origin: "https://evil.example" } }) });
    assert.equal(fromEvil.headers.get("X-Rasp-Edge"), "hit");
    assert.equal(fromEvil.headers.get("Access-Control-Allow-Origin"), null);
    const sameOrigin = await onGroups({ request: at("/groups") });
    assert.equal(sameOrigin.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(sameOrigin.status, 200);
  } finally {
    if (saved) Object.defineProperty(globalThis, "caches", saved);
    else delete globalThis.caches;
  }
}

// Версия оболочки совпадает в sw.js и js/app.js; 404.html без ссылок от корня домена.
{
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const version = sw.match(/const SHELL = "(rasp-shell-v\d+)"/)[1];
  assert.ok(app.includes(`"${version}"`), `js/app.js should expect ${version}`);
  assert.ok(sw.includes('"https://rasp-is2-241.pages.dev"'), "sw.js should cache cross-origin proxy data");
  const notFound = readFileSync(new URL("../404.html", import.meta.url), "utf8");
  assert.equal(/(href|src)="\//.test(notFound), false, "404.html links must be relative");
}

console.log("selfcheck ok");
