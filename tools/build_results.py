"""Build the 2022 election-results layer for the govote2026 map: every polling building in Israel.

Sources:
    tools/data/2022_results_jerusalem.xlsx    Knesset 25 results per ballot box for Jerusalem, with polling-station
                                              addresses (Central Elections Committee data, prepared by the user with
                                              claude.ai; its שכונה column is an approximate assignment)
    tools/data/k25_jerusalem_geocodes.json    ballot box -> address -> lat/lon (YardenMorad2003/election-dashboard),
                                              typically within ~100 m
    tools/data/2022_results_israel.xlsx       the same for all of Israel (sheet כל הקלפיות; Jerusalem is taken from
                                              the file above, which has the neighbourhoods)
    tools/data/k25_israel_venue_positions.json  "<locality code>|<venue>" -> lat/lon for the rest of Israel
                                              (election-dashboard venue coordinates; "approximate" = locality centre)

External envelopes (soldiers, diplomats etc., locality 9999) have no place and are left out, as are the few
buildings with no known position (listed when the script runs).

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
ISRAEL = REPO / 'tools' / 'data' / '2022_results_israel.xlsx'
VENUE_POSITIONS = REPO / 'tools' / 'data' / 'k25_israel_venue_positions.json'
JERUSALEM, ENVELOPES = 3000, 9999  # locality codes
OUT = REPO / 'govote2026' / 'results2022.json'

COALITION = ['מחל', 'שס', 'ג', 'ט']                         # Likud, Shas, UTJ, Religious Zionism
LIBERAL = ['פה', 'כן', 'אמת', 'מרצ', 'ל']                # Yesh Atid, National Unity, Labor, Meretz, Yisrael Beiteinu
ARAB = ['ום', 'עם', 'ד']                                   # Hadash-Ta'al, Ra'am, Balad

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


def ballot_boxes(rows, excluded=None):
    return [{
        'kalpi': f'{float(r["קלפי"]):g}', 'valid': int(r['כשרים']), 'registered': int(r['בזב']), 'voted': int(r['מצביעים']),
        'coalition': int(r[COALITION].sum()), 'liberal': int(r[LIBERAL].sum()), 'arab': int(r[ARAB].sum()),
        'excluded': (excluded or {}).get(int(float(r['קלפי']))),
    } for _, r in rows.iterrows()]


def site_entry(label, address, neighbourhood, locality, pos, boxes, beit_hakerem=False, approx=False):
    kept = [b for b in boxes if not b['excluded']]
    valid = sum(b['valid'] for b in kept)
    registered = sum(b['registered'] for b in kept)
    return {
        'label': label, 'address': address, 'neighbourhood': neighbourhood, 'locality': locality,
        'beit_hakerem': beit_hakerem, 'approx': approx, 'lat': round(pos[0], 5), 'lon': round(pos[1], 5), 'boxes': boxes,
        'valid': valid, 'registered': registered,
        'turnout': round(sum(b['voted'] for b in kept) / registered, 4) if registered else None,
        'liberal_share': round(sum(b['liberal'] for b in kept) / valid, 4) if valid else None,
        'arab_share': round(sum(b['arab'] for b in kept) / valid, 4) if valid else None,
        'coalition_share': round(sum(b['coalition'] for b in kept) / valid, 4) if valid else None,
    }


def israel_sites():
    """Every polling building outside Jerusalem, one entry per locality + venue."""
    d = pd.read_excel(ISRAEL, sheet_name='כל הקלפיות')
    d = d[~d['סמל ישוב'].isin([JERUSALEM, ENVELOPES])].copy()
    d['venue'] = d['מקום קלפי'].astype(str).str.strip()
    positions = json.load(open(VENUE_POSITIONS, encoding='utf-8'))
    sites, missing = [], []
    for (semel, venue), rows in d.sort_values('קלפי').groupby(['סמל ישוב', 'venue'], sort=False):
        key = f'{semel}|{venue}'
        pos = positions['venues'].get(key) or positions['approximate'].get(key)
        locality = str(rows['ישוב'].iloc[0]).strip()
        if pos is None:
            missing.append((locality, venue, int(rows['כשרים'].sum())))
            continue
        address = ' / '.join(a for a in dict.fromkeys(rows['כתובת קלפי'].fillna('').astype(str).str.strip()) if a)
        sites.append(site_entry(venue, address, None, locality, pos, ballot_boxes(rows),
                                approx=key not in positions['venues']))
    return sites, missing


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
        boxes = ballot_boxes(rows, EXCLUDED if addr in BEIT_HAKEREM else None)
        sites.append(site_entry(' / '.join(dict.fromkeys(rows['מקום קלפי'])), addr.replace('שד ', "שד' "),
                                rows['שכונה'].iloc[0], 'ירושלים', pos, boxes, addr in BEIT_HAKEREM, addr in APPROXIMATE))
    if missing:
        raise SystemExit(f'no position for: {missing}')
    jerusalem = list(sites)
    others, unplaced = israel_sites()
    sites += others
    json.dump({'election': 'הבחירות לכנסת ה-25 (1.11.2022)', 'sites': sites},
              open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    def share(ss, bloc):
        kept = [b for s in ss for b in s['boxes'] if not b['excluded']]
        return sum(b[bloc] for b in kept) / sum(b['valid'] for b in kept)
    bhk = [s for s in sites if s['beit_hakerem']]
    print(f'left out, no position: {len(unplaced)} buildings, {sum(v for *_, v in unplaced)} valid votes: {unplaced}')
    print(f'{len(sites)} buildings, {sum(len(s["boxes"]) for s in sites)} ballot boxes, '
          f'{sum(s["valid"] for s in sites)} valid votes')
    for bloc in ('liberal', 'arab', 'coalition'):
        print(f'{bloc} share: Israel {share(sites, bloc):.1%}, Jerusalem {share(jerusalem, bloc):.1%}, '
              f'בית הכרם {share(bhk, bloc):.1%}')
    kept = [b for s in sites for b in s['boxes'] if not b['excluded']]
    jer = [b for s in jerusalem for b in s['boxes'] if not b['excluded']]
    print(f'turnout: Israel {sum(b["voted"] for b in kept) / sum(b["registered"] for b in kept):.1%}, Jerusalem '
          f'{sum(b["voted"] for b in jer) / sum(b["registered"] for b in jer):.1%}, בית הכרם '
          f'{sum(b["voted"] for s in bhk for b in s["boxes"] if not b["excluded"]) / sum(s["registered"] for s in bhk):.1%}')
    print(f'{sum(1 for s in sites if s["valid"] and s["arab_share"] > s["liberal_share"])} buildings where the Arab bloc '
          f'outpolls the liberal one')


if __name__ == '__main__':
    main()
