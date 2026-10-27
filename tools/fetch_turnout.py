"""Copy the Central Elections Committee's live turnout (election day 2026) into govote2026/turnout2026.json.

The committee's map (mapvotes.bechirot.gov.il, also embedded by ynet) reads per-neighbourhood and per-ballot-box
turnout from static JSON files that it updates through the day. Browsers on other sites can't read them (no CORS),
so the Windows Task Scheduler task "govote2026_turnout" runs this script with --push every 10 minutes on election day:
it commits and pushes the file when it changed, and GitHub Pages serves it with the map.

Writes a slim file: national total, per-neighbourhood figures, and each neighbourhood's ballot boxes.
Exits without writing when the committee's source file hasn't changed.
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

# ---- settings ----
BASE = 'https://mapvotes.bechirot.gov.il/data/votes/latest/'
REPO = Path(__file__).resolve().parent.parent
OUT = REPO / 'govote2026' / 'turnout2026.json'


def get(name):
    req = urllib.request.Request(BASE + name, headers={'User-Agent': 'Mozilla/5.0 (betakerem.org/govote2026 turnout map)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    nbr = get('neighborhood_data.json')
    old = json.load(open(OUT, encoding='utf-8')) if OUT.exists() else {}
    if old.get('source') == nbr['source']:
        print(f'unchanged: {nbr["source"]} ({nbr["time"]})')
        return False
    kalpi = get('kalpi_data.json')
    boxes = {}
    for k in kalpi['features'].values():
        boxes.setdefault(str(k['nbr']), []).append([k['kalpi'], k['בזב'], k['מצביעים'], k['percent'], k['updated']])
    out = {
        'source': nbr['source'], 'time': nbr['time'], 'previous_time': (nbr.get('previous') or {}).get('time'),
        'total': nbr['total'],
        # neighbourhood id -> [ballot boxes, eligible, voted, percent, updated, percent at the previous update]
        'nbr': {i: [f['kalpis'], f['בזב'], f['מצביעים'], f['percent'], f['updated'], f.get('prev_percent')]
                for i, f in nbr['features'].items()},
        # neighbourhood id -> [[ballot box, eligible, voted, percent, updated], ...]
        'kalpi': {i: sorted(b, key=lambda x: float(x[0])) for i, b in boxes.items()},
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {nbr["source"]} ({nbr["time"]}): national {nbr["total"]["percent"]}%, '
          f'{len(out["nbr"])} neighbourhoods, {len(kalpi["features"])} ballot boxes')
    return True


def push():
    # commit only this file, so work in progress in the repo is left alone
    git = lambda *a: subprocess.run(['git', *a], cwd=REPO, check=True)
    git('add', str(OUT))
    git('commit', '-q', '-m', f'Turnout update {json.load(open(OUT, encoding="utf-8"))["time"]}', '--', str(OUT))
    git('pull', '--rebase', '--autostash', '-q')
    git('push', '-q')


if __name__ == '__main__':
    if main() and '--push' in sys.argv:
        push()
