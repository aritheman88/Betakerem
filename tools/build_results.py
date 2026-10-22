"""Build the 2022 election-results layer for the govote2026 map: every polling building in Jerusalem.

Sources:
    tools/data/2022_results_jerusalem.xlsx    Knesset 25 results per ballot box for Jerusalem, with polling-station
                                              addresses (Central Elections Committee data, prepared by the user with
                                              claude.ai; its שכונה column is an approximate assignment)
    tools/data/k25_jerusalem_geocodes.json    ballot box -> address -> lat/lon (YardenMorad2003/election-dashboard),
                                              typically within ~100 m

Positions are overridden in POSITIONS: the בית הכרם buildings use the municipal address points (more exact;
the geocode put Herzl 137 ~450 m off), and three addresses the geocoder got wrong or missed come from OSM.

Writes govote2026/results2022.json: one entry per building, with its ballot boxes.
"""
import json
from pathlib import Path

import pandas as pd

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / 'tools' / 'data' / '2022_results_jerusalem.xlsx'
GEOCODES = REPO / 'tools' / 'data' / 'k25_jerusalem_geocodes.json'
OUT = REPO / 'govote2026' / 'results2022.json'

COALITION = ['מחל', 'שס', 'ג', 'ט']                         # Likud, Shas, UTJ, Religious Zionism
LIBERAL = ['פה', 'כן', 'אמת', 'מרצ', 'ל']                # Yesh Atid, National Unity, Labor, Meretz, Yisrael Beiteinu
ARAB = ['ום', 'עם']                                        # Hadash-Ta'al, Ra'am

# polling-station address (as in the results file) -> (lat, lon)
POSITIONS = {
    # בית הכרם, from the municipal address layer
    'החלוץ 47': (31.77641, 35.19137),
    'שחר 19': (31.78063, 35.19424),
    'מעגל בית המדרש 8': (31.78188, 35.19131),
    'שד הרצל 137': (31.77690, 35.18621),  # Ziv campus building, next to the Herzl 139 address point
    'התומר 5': (31.77974, 35.18647),
    # the geocode file put these outside Jerusalem or has no position; from OSM (Nominatim / Overpass)
    'שד שרת משה 1': (31.75700, 35.18500),        # start of Moshe Sharett Blvd, Ramat Sharett
    'שד דיין משה 135': (31.82402, 35.23824),     # מינהל קהילתי פסגת זאב
    'דרך בר-לב': (31.79724, 35.22959),           # תיכון עבדאללה אבן חוסיין
    'אלוף שאלתיאל 1': (31.78486, 35.20686),      # בית החייל
    'וולטה העלית 12': (31.75762, 35.17812),      # בי"ס תל"י בית וגן
    'גרינולד 8': (31.76320, 35.19054),           # אולפנא נווה עציון
    'שד דב יוסף 2': (31.75320, 35.19865),        # אורט ספניאן
    'ככר ארן זלמן 7': (31.76411, 35.19603),      # בי"ס אלונים
    'ככר ארן זלמן 11': (31.76435, 35.19640),     # יד המורה, same square as Alonim
    'גנרל קניג פייר 16': (31.75561, 35.21441),
    'גריק פטריאכט 26': (31.77838, 35.22849),
    'הרב והרבנית קאפח 20': (31.77999, 35.20993),
    'הרפוב הדומיניקנית 3': (31.75469, 35.16867),
    'זנגויל 25': (31.76729, 35.17833),
    'זנגויל 29': (31.76259, 35.17742),           # בי"ס אגרון
    "כט' בנובמבר 13": (31.76645, 35.21641),      # בי"ס אדם
    'מחנה פליטים קלנדיה': (31.86292, 35.22730),  # מעבר קלנדיה
    'חיל האויר 60': (31.82870, 35.23954),         # ישיבת נתיבות חיים, street only
    'מעלות כיסופים 5': (31.81895, 35.19465),
    'רקנטי אברהם 6': (31.81488, 35.19434),       # מרכז קהילתי בית אברהם
    'ש פת 3': (31.75246, 35.20062),
    'המשורינים 4': (31.76421, 35.20770),         # street only
    'פישל אהרן 29': (31.79350, 35.21970),        # street only
    'אלמדינה מונורה 142': (31.73791, 35.23143),  # צור באהר, neighbourhood centre
    'בית צפפה': (31.74415, 35.20625),            # בית צפאפה, neighbourhood centre
    'מוצא תחתית 1א': (31.79279, 35.16851),       # מוצא, village centre
}
# positions known only to the street or neighbourhood; the popup says so
APPROXIMATE = {'שד שרת משה 1', 'זנגויל 25', 'המשורינים 4', 'פישל אהרן 29', 'אלמדינה מונורה 142', 'בית צפפה',
               'מוצא תחתית 1א', 'ככר ארן זלמן 11', 'גריק פטריאכט 26', 'הרפוב הדומיניקנית 3', 'חיל האויר 60',
               'מעלות כיסופים 5', 'ש פת 3'}
BEIT_HAKEREM = {'החלוץ 47', 'שחר 19', 'מעגל בית המדרש 8', 'שד הרצל 137', 'התומר 5'}  # inside the official boundary

# Ballot boxes in בית הכרם buildings whose voters plainly live elsewhere: Shas + UTJ took 71% and 74% here vs.
# under 4% in every other box in the neighbourhood, like the Haredi boxes numbered next to them (265 Har Nof,
# 285 and 289 Bayit Vegan). Shown in the popup but left out of the building's colour and totals.
EXCLUDED = {267: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה', 286: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה'}


def main():
    d = pd.read_excel(SOURCE)
    d['addr'] = d['כתובת קלפי'].str.strip()
    geo = json.load(open(GEOCODES, encoding='utf-8'))
    kalpi_addr, geocodes = geo['kalpi_addresses'], geo['geocodes']
    sites, missing = [], []
    for addr, rows in d.sort_values('קלפי').groupby('addr', sort=False):
        pos = POSITIONS.get(addr) or geocodes.get(kalpi_addr.get(f"{float(rows['קלפי'].iloc[0]):g}", ''))
        if pos is None:
            missing.append(addr)
            continue
        boxes = []
        for _, r in rows.iterrows():
            kalpi = float(r['קלפי'])
            boxes.append({
                'kalpi': f'{kalpi:g}', 'venue': r['מקום קלפי'], 'valid': int(r['כשרים']), 'registered': int(r['בזב']),
                'coalition': int(r[COALITION].sum()), 'liberal': int(r[LIBERAL].sum()),
                'arab': int(r[ARAB].sum()),
                'excluded': EXCLUDED.get(int(kalpi)) if addr in BEIT_HAKEREM else None,
            })
        kept = [b for b in boxes if not b['excluded']]
        valid = sum(b['valid'] for b in kept)
        venues = list(dict.fromkeys(rows['מקום קלפי']))
        sites.append({
            'label': ' / '.join(venues), 'address': addr.replace('שד ', "שד' "), 'neighbourhood': rows['שכונה'].iloc[0],
            'beit_hakerem': addr in BEIT_HAKEREM, 'approx': addr in APPROXIMATE, 'lat': round(pos[0], 5), 'lon': round(pos[1], 5), 'boxes': boxes,
            'valid': valid, 'registered': sum(b['registered'] for b in kept),
            'liberal_share': round(sum(b['liberal'] for b in kept) / valid, 4) if valid else None,
            'arab_share': round(sum(b['arab'] for b in kept) / valid, 4) if valid else None,
            'coalition_share': round(sum(b['coalition'] for b in kept) / valid, 4) if valid else None,
        })
    if missing:
        raise SystemExit(f'no position for: {missing}')
    json.dump({'election': 'הבחירות לכנסת ה-25 (1.11.2022)', 'sites': sites},
              open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    def share(ss, bloc):
        kept = [b for s in ss for b in s['boxes'] if not b['excluded']]
        return sum(b[bloc] for b in kept) / sum(b['valid'] for b in kept)
    bhk = [s for s in sites if s['beit_hakerem']]
    print(f'{len(sites)} buildings, {sum(len(s["boxes"]) for s in sites)} ballot boxes, '
          f'{sum(s["valid"] for s in sites)} valid votes')
    for bloc in ('liberal', 'arab', 'coalition'):
        print(f'{bloc} share: Jerusalem {share(sites, bloc):.1%}, בית הכרם {share(bhk, bloc):.1%}')
    print(f'{sum(1 for s in sites if s["valid"] and s["arab_share"] > s["liberal_share"])} buildings where the Arab bloc '
          f'outpolls the liberal one')


if __name__ == '__main__':
    main()
