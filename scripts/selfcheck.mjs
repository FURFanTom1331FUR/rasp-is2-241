import assert from "node:assert/strict";
import { markOf, normalizeAttendance, normalizeWorkerUrl, summarizeAttendance } from "../js/attendance.js";
import { addDays, formatDots, isValidIso, mondayOf, moscowInstant, moscowIso, semesterRange, visibleWeekDays, weekdayName } from "../js/dates.js";
import { dateAttempts, studentNameFromHtml } from "../worker/src/index.js";
import { parseScheduleHtml } from "../js/parse.js";

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
</div>`;

const days = parseScheduleHtml(fixture);
assert.equal(days.length, 2);
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

console.log("selfcheck ok");
