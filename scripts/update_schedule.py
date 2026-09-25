#!/usr/bin/env python3
"""Скачать расписание групп ВГЛТУ и сохранить JSON для офлайн-приложения.

Сайт kis.vgltu.ru не отдаёт заголовок CORS, поэтому страница на GitHub Pages
не может прочитать ответ из браузера. Этот скрипт запускает сопровождающий
и кладёт файлы в data/, откуда приложение читает их с того же домена.

Примеры:
  python3 scripts/update_schedule.py
  python3 scripts/update_schedule.py ИС2-242-ОБ
  python3 scripts/update_schedule.py --from 2026-09-21 --weeks 2 ИС2-241-ОБ ИС2-243-ОБ
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SCHEDULES = DATA / "schedules"
LIST_URL = "https://kis.vgltu.ru/list?type=Group"
SCHEDULE_URL = "https://kis.vgltu.ru/schedule"
MSK = timezone(timedelta(hours=3))
USER_AGENT = "rasp-is2-241/1.0 (+https://github.com/FURFanTom1331FUR/rasp-is2-241)"

MONTHS = {
    "января": 1,
    "февраля": 2,
    "марта": 3,
    "апреля": 4,
    "мая": 5,
    "июня": 6,
    "июля": 7,
    "августа": 8,
    "сентября": 9,
    "октября": 10,
    "ноября": 11,
    "декабря": 12,
}

TYPE_RE = re.compile(r"^(лек|лаб|пр)\.\s*(.+)$", re.IGNORECASE)
DATE_RE = re.compile(r"(\d{1,2})\s+([а-яё]+)\s+(\d{4})", re.IGNORECASE)
TIME_RE = re.compile(r"(\d{2}:\d{2})-(\d{2}:\d{2})")
SUBGROUP_BODY = r"(\d)\s*п\s*[./]?\s*г\.?|(\d)\s*[-–]?\s*(?:я|ая|й)?\s*подгруппа|подгруппа\s+(\d)"
SUBGROUP_MARK = re.compile(rf"(?:^|[\s(«\"'])(?:{SUBGROUP_BODY})(?=$|[\s).,;:»\"'])", re.IGNORECASE)
SUBGROUP_LINE = re.compile(rf"^(?:\(\s*)?(?:{SUBGROUP_BODY})\s*\)?\.?$", re.IGNORECASE)
SUBGROUP_STRIP = re.compile(
    r"(?:^|\s)\(?\s*(?:\d\s*п\s*[./]?\s*г\.?|\d\s*[-–]?\s*(?:я|ая|й)?\s*подгруппа|подгруппа\s+\d)\s*\)?(?=$|[\s.,;:])",
    re.IGNORECASE,
)


def now_msk_iso() -> str:
    return datetime.now(MSK).isoformat(timespec="seconds")


def moscow_today() -> date:
    return datetime.now(MSK).date()


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read().decode("utf-8", "replace")


def lines_of(cell_html: str) -> list[str]:
    text = re.sub(r"<br\s*/?>", "\n", cell_html, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text).replace("\xa0", " ")
    lines = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return lines


def parse_ru_date(label: str) -> str | None:
    match = DATE_RE.search(label.replace("\xa0", " "))
    if not match:
        return None
    day = int(match.group(1))
    month = MONTHS.get(match.group(2).lower())
    year = int(match.group(3))
    if not month:
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _subgroup_from_match(match: re.Match[str] | None) -> int | None:
    if not match:
        return None
    raw = next((group for group in match.groups() if group), None)
    if not raw:
        return None
    number = int(raw)
    return number if 1 <= number <= 9 else None


def subgroup_number_in(value: str) -> int | None:
    text = re.sub(r"\s+", " ", (value or "").replace("\xa0", " ")).strip()
    if not text:
        return None
    return _subgroup_from_match(SUBGROUP_LINE.match(text)) or _subgroup_from_match(SUBGROUP_MARK.search(text))


def strip_subgroup_mark(value: str) -> str:
    text = SUBGROUP_STRIP.sub(" ", (value or "").replace("\xa0", " "))
    text = re.sub(r"\s+([.,;:])", r"\1", text)
    text = re.sub(r"\(\s*\)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_cell(cell_html: str, slot: str | None) -> dict | None:
    lines = lines_of(cell_html)
    if not lines or not slot:
        return None
    if len(lines) == 1 and lines[0].lower().startswith("нет пар"):
        return None

    subgroup = None
    kept: list[str] = []
    for line in lines:
        dedicated = _subgroup_from_match(SUBGROUP_LINE.match(re.sub(r"\s+", " ", line).strip()))
        if dedicated:
            subgroup = subgroup or dedicated
            continue
        kept.append(line)
    if not kept:
        return None

    subject = kept[0]
    lesson_type = None
    type_match = TYPE_RE.match(subject)
    if type_match:
        lesson_type = type_match.group(1).lower()
        subject = type_match.group(2).strip()
    found = subgroup_number_in(subject)
    if found:
        subgroup = subgroup or found
        subject = strip_subgroup_mark(subject)
    if not subject:
        return None

    rest: list[str] = []
    for line in kept[1:]:
        found = subgroup_number_in(line)
        if found:
            subgroup = subgroup or found
            line = strip_subgroup_mark(line)
        if line:
            rest.append(line)

    teacher = rest[-1] if rest else ""
    room = rest[-2] if len(rest) >= 2 else ""
    groups = rest[:-2] if len(rest) >= 2 else []
    start, end = slot.split("-")
    return {
        "time": slot,
        "start": start,
        "end": end,
        "type": lesson_type,
        "subject": subject,
        "subgroup": f"{subgroup} п.г." if subgroup else None,
        "room": room,
        "teacher": teacher,
        "groups": groups,
    }


def parse_schedule_html(raw_html: str) -> list[dict]:
    text = unescape(raw_html)
    days = []
    parts = re.split(r"<div>\s*<strong>", text, flags=re.IGNORECASE)
    for part in parts[1:]:
        label_match = re.match(r"(.*?)</strong>", part, flags=re.DOTALL | re.IGNORECASE)
        if not label_match:
            continue
        iso = parse_ru_date(re.sub(r"\s+", " ", label_match.group(1)))
        if not iso:
            continue
        table_match = re.search(r"<table[^>]*>(.*?)</table>", part, flags=re.DOTALL | re.IGNORECASE)
        lessons = []
        current_time = None
        if table_match:
            rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table_match.group(1), flags=re.DOTALL | re.IGNORECASE)
            for row in rows:
                cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row, flags=re.DOTALL | re.IGNORECASE)
                if not cells:
                    continue
                content = cells[-1]
                if len(cells) >= 2:
                    time_match = TIME_RE.search(unescape(re.sub(r"<[^>]+>", "", cells[0])))
                    if time_match:
                        current_time = f"{time_match.group(1)}-{time_match.group(2)}"
                lesson = parse_cell(content, current_time)
                if lesson:
                    lessons.append(lesson)
        lessons.sort(key=lambda item: (item["start"], item["subgroup"] or "", item["subject"]))
        days.append({"date": iso, "lessons": lessons})
    return days


def load_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def update_groups() -> list[str]:
    raw = fetch(LIST_URL)
    groups = json.loads(raw)
    if not isinstance(groups, list) or not groups:
        raise RuntimeError("Список групп пустой или неожиданного формата")
    names = [str(item).strip() for item in groups if str(item).strip()]
    write_json(
        DATA / "groups.json",
        {
            "fetchedAt": now_msk_iso(),
            "source": LIST_URL,
            "groups": names,
        },
    )
    print(f"Групп в списке: {len(names)}")
    return names


def update_group(group: str, start: date, weeks: int) -> None:
    by_date: dict[str, dict] = {}
    path = SCHEDULES / f"{group}.json"
    previous = load_json(path)
    if previous:
        for day in previous.get("days", []):
            by_date[day["date"]] = day

    for index in range(weeks):
        window = start + timedelta(days=14 * index)
        query = urllib.parse.urlencode({"date": window.isoformat(), "group": group})
        url = f"{SCHEDULE_URL}?{query}"
        print(f"  {group}: {window.isoformat()}")
        raw = fetch(url)
        parsed = parse_schedule_html(raw)
        if not parsed:
            raise RuntimeError(f"Пустой ответ для {group} на {window.isoformat()}")
        for day in parsed:
            by_date[day["date"]] = day
        if index + 1 < weeks:
            time.sleep(0.25)

    days = [by_date[key] for key in sorted(by_date)]
    write_json(
        path,
        {
            "group": group,
            "fetchedAt": now_msk_iso(),
            "source": SCHEDULE_URL,
            "origin": "snapshot",
            "range": {"from": days[0]["date"], "to": days[-1]["date"]},
            "days": days,
        },
    )
    lesson_count = sum(len(day["lessons"]) for day in days)
    print(f"  сохранено {path.relative_to(ROOT)}: {len(days)} дн., {lesson_count} пар")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Обновить JSON расписания ВГЛТУ для Пары")
    parser.add_argument("groups", nargs="*", help="Коды групп. По умолчанию ИС2-241-ОБ")
    parser.add_argument("--from", dest="start", help="Первый день окна, ГГГГ-ММ-ДД. По умолчанию понедельник текущей недели по Москве")
    parser.add_argument("--weeks", type=int, default=2, help="Сколько окон по 14 дней запросить (по умолчанию 2)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.weeks < 1:
        print("Нужно хотя бы одно окно --weeks", file=sys.stderr)
        return 2
    if args.start:
        try:
            start = date.fromisoformat(args.start)
        except ValueError:
            print("Дата --from должна быть в формате ГГГГ-ММ-ДД", file=sys.stderr)
            return 2
    else:
        today = moscow_today()
        start = today - timedelta(days=today.weekday())

    groups = args.groups or ["ИС2-241-ОБ"]
    try:
        known = update_groups()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
        print(f"Не удалось обновить список групп: {error}", file=sys.stderr)
        return 1

    known_fold = {name.casefold(): name for name in known}
    failed = False
    for group in groups:
        canonical = known_fold.get(group.casefold(), group)
        if canonical != group:
            print(f"{group} → {canonical}")
        try:
            update_group(canonical, start, args.weeks)
        except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as error:
            print(f"Ошибка для {canonical}: {error}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
