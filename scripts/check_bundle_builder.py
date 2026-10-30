"""Exercise publication/resume without sending requests to the university."""
import json
import tempfile
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
import build_bundles as b


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    data = root / 'data'
    data.mkdir()
    groups = ['unopened', 'second']
    start = date(2026, 10, 26)
    days = [{'date': str(start + timedelta(days=i)), 'lessons': []} for i in range(14)]
    calls = []
    fail = [True]

    def fetch(url):
        calls.append(url)
        if 'second' in url and fail[0]:
            raise RuntimeError('upstream unavailable')
        return '</table>' * 14

    with patch.multiple(b, ROOT=root, DATA=data, update_groups=lambda: groups,
                        moscow_today=lambda: date(2026, 10, 30), fetch=fetch,
                        parse_schedule_html=lambda raw: days), patch.object(b.time, 'sleep'):
        assert b.build() == 1
        assert not (data / 'bundles').exists(), 'partial run must not publish'
        fail[0] = False
        assert b.build() == 0
        assert len(calls) == 3, 'retry must reuse successful group'
        output = data / 'bundles'
        assert len(list(output.glob('*.json'))) == 2
        payload = json.loads((output / '2026-10-26.json').read_text(encoding='utf-8'))
        assert payload['groups'] == groups and payload['complete'] is True
        assert all(len(days) == 7 for days in payload['records'].values())
        before = {p.name: p.read_bytes() for p in output.glob('*.json')}
        # A newly listed group fails: keep the previous complete publication.
        groups.append('third')
        with patch.object(b, 'fetch', return_value='truncated HTML'):
            assert b.build() == 1
        assert before == {p.name: p.read_bytes() for p in output.glob('*.json')}
print('builder tests ok: completeness, resume, atomic failure, two-week publication')
