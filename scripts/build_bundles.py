"""Publish only complete two-week coverage. Resume successful groups on same-day retries."""
import hashlib
import gzip
import json
import os
import re
import sys
import time
from datetime import timedelta
from urllib.parse import urlencode
from update_schedule import ROOT, DATA, fetch, update_groups, parse_schedule_html, moscow_today, now_msk_iso, SCHEDULE_URL


def build():
    today = moscow_today()
    monday = today - timedelta(days=today.weekday())
    groups = update_groups()
    staging = ROOT / 'work' / 'bundle-resume' / str(today)
    staging.mkdir(parents=True, exist_ok=True)
    records, failed = {}, []
    expected = {str(monday + timedelta(days=i)) for i in range(14)}
    for group in groups:
        path = staging / (hashlib.sha256(group.encode()).hexdigest() + '.json')
        try:
            if path.exists():
                days = json.loads(path.read_text(encoding='utf-8'))
            else:
                raw = fetch(SCHEDULE_URL + '?' + urlencode({'date': str(monday), 'group': group}))
                if len(re.findall(r'</table\s*>', raw, re.I)) != 14:
                    raise ValueError('Incomplete HTML tables')
                days = parse_schedule_html(raw)
                time.sleep(1)
            if {d['date'] for d in days} != expected or len(days) != 14:
                raise ValueError('Incomplete 14-day calendar')
            path.write_text(json.dumps(days, ensure_ascii=False), encoding='utf-8')
            records[group] = days
        except Exception as error:
            print(f'{group}: {error}', file=sys.stderr)
            failed.append(group)
    print(f'Verified {len(records)}/{len(groups)} groups; failed: {failed}')
    if failed:
        return 1
    output = DATA / 'bundles'
    output.mkdir(exist_ok=True)
    keep = set()
    for offset in (0, 7):
        week = str(monday + timedelta(days=offset))
        end = str(monday + timedelta(days=offset + 6))
        keep.add(week)
        payload = dict(schema=1, week=week, fetchedAt=now_msk_iso(), complete=True, groups=groups,
                       records={g: sorted([d for d in records[g] if week <= d['date'] <= end], key=lambda d: d['date']) for g in groups})
        text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        temp = output / (week + '.tmp')
        temp.write_text(text, encoding='utf-8')
        os.replace(temp, output / (week + '.json'))
        print(f'{week}: {len(text.encode())} bytes; gzip estimate {len(gzip.compress(text.encode()))} bytes')
    for path in output.glob('*.json'):
        if path.stem not in keep:
            path.unlink()
    return 0


if __name__ == '__main__':
    sys.exit(build())
