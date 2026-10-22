"""Build the 2022 election-results layer for the govote2026 map.

Source: tools/data/2022_results_jerusalem.xlsx, the Knesset 25 results per ballot box for Jerusalem with
polling-station addresses (Central Elections Committee data, prepared by the user with claude.ai).

Only the polling stations inside the official בית הכרם boundary are used. They were located by matching
their addresses to the municipal address points (Herzl 137 has no point; the Ziv campus building next to
Herzl 139 is used). The file's own שכונה column is not used: it tags the Yefe Nof school as "יפה נוף",
which is part of the official neighbourhood.

Writes govote2026/results2022.json: one entry per building, with its ballot boxes.
"""
import json
from pathlib import Path

import pandas as pd

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / 'tools' / 'data' / '2022_results_jerusalem.xlsx'
OUT = REPO / 'govote2026' / 'results2022.json'

COALITION = ['מחל', 'שס', 'ג', 'ט']                         # Likud, Shas, UTJ, Religious Zionism
LIBERAL = ['פה', 'כן', 'אמת', 'מרצ', 'ל', 'ום', 'עם']     # Yesh Atid, National Unity, Labor, Meretz,
                                                           # Yisrael Beiteinu, Hadash-Ta'al, Ra'am

# polling-station address -> (map label, lat, lon)
SITES = {
    'החלוץ 47': ('בית ספר ויצ"ו בית הכרם', 31.77641, 35.19137),
    'שחר 19': ('ממ"ד דרור', 31.78063, 35.19424),
    'מעגל בית המדרש 8': ('בי"ס ממלכתי בית הכרם', 31.78188, 35.19131),
    'שד הרצל 137': ('קמפוס זיו (תיכון זיו-מרקס ומתנ"ס זיו)', 31.77690, 35.18621),
    'התומר 5': ('בי"ס יפה נוף', 31.77974, 35.18647),
}

# Ballot boxes in the neighbourhood's buildings whose voters plainly live elsewhere: Shas + UTJ took
# 71% and 74% here vs. under 4% in every other box in the neighbourhood, matching the Haredi boxes
# numbered next to them (265 Har Nof, 285 and 289 Bayit Vegan). Shown on the map but left out of the
# building's colour and totals.
EXCLUDED = {267: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה', 286: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה'}


def main():
    d = pd.read_excel(SOURCE)
    d = d[d['כתובת קלפי'].str.strip().isin(SITES)]
    sites = []
    for addr, (label, lat, lon) in SITES.items():
        rows = d[d['כתובת קלפי'].str.strip() == addr].sort_values('קלפי')
        boxes = []
        for _, r in rows.iterrows():
            kalpi = float(r['קלפי'])
            boxes.append({
                'kalpi': f'{kalpi:g}', 'venue': r['מקום קלפי'], 'valid': int(r['כשרים']), 'registered': int(r['בזב']),
                'coalition': int(r[COALITION].sum()), 'liberal': int(r[LIBERAL].sum()),
                'excluded': EXCLUDED.get(int(kalpi)),
            })
        kept = [b for b in boxes if not b['excluded']]
        valid = sum(b['valid'] for b in kept)
        sites.append({
            'label': label, 'address': addr.replace('שד ', "שד' "), 'lat': lat, 'lon': lon, 'boxes': boxes,
            'valid': valid, 'registered': sum(b['registered'] for b in kept),
            'liberal_share': round(sum(b['liberal'] for b in kept) / valid, 4),
            'coalition_share': round(sum(b['coalition'] for b in kept) / valid, 4),
        })
        print(f"{label}: {len(boxes)} boxes ({len(boxes) - len(kept)} excluded), {valid} valid votes, "
              f"liberal {sites[-1]['liberal_share']:.0%}, coalition {sites[-1]['coalition_share']:.0%}")
    json.dump({'election': 'הבחירות לכנסת ה-25 (1.11.2022)', 'sites': sites},
              open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    total = sum(s['valid'] for s in sites)
    lib = sum(b['liberal'] for s in sites for b in s['boxes'] if not b['excluded'])
    print(f'neighbourhood: {total} valid votes, liberal {lib / total:.1%}')


if __name__ == '__main__':
    main()
