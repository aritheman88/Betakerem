"""Build the 2026 election-results layer for the govote2026 map, in the same format as results2022.json.

Sources:
    tools/data/2026_results_final.csv     Knesset 26 final results per ballot box (Central Elections Committee export
                                          "expb"); when present it is used alone
    tools/data/2026_results_<HHMM>.csv    otherwise: partial counts (only the ballot boxes counted so far), one file per
                                          download; all are merged, the latest file winning for a box in several
    tools/cache/kalpi_data.json           the committee's turnout map: "<locality code>|<ballot box>" -> neighbourhood id
                                          (downloaded when missing; delete it to refresh)
    govote2026/neighbourhoods2026.json    neighbourhood shapes (tools/build_neighbourhoods.py)
    govote2026/results2022.json           2022 polling buildings with positions (tools/build_results.py)

The 2026 file has no addresses, so each ballot box is placed at the 2022 polling building with the same locality
and polling-station number (the part before the dot), when that building lies inside the box's 2026
neighbourhood. Many cities renumbered their stations, so the other boxes are grouped per neighbourhood and
drawn at the neighbourhood's centre, marked approximate. External envelopes (locality 9999) are left out.

Writes govote2026/results2026.json: one entry per building (or neighbourhood), with its ballot boxes; each entry
matched to a 2022 building also carries that building's 2022 result as y22 = [liberal, Arab, coalition, turnout].
"""
import json
import sys
import urllib.request
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_neighbourhoods import inside, ring_of  # noqa: E402

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
FINAL = REPO / 'tools' / 'data' / '2026_results_final.csv'
SOURCES = [FINAL] if FINAL.exists() else sorted((REPO / 'tools' / 'data').glob('2026_results_[0-9][0-9][0-9][0-9].csv'))
KALPI_URL = 'https://mapvotes.bechirot.gov.il/data/votes/latest/kalpi_data.json'
KALPI_CACHE = REPO / 'tools' / 'cache' / 'kalpi_data.json'
SHAPES = REPO / 'govote2026' / 'neighbourhoods2026.json'
RESULTS_2022 = REPO / 'govote2026' / 'results2022.json'
OUT = REPO / 'govote2026' / 'results2026.json'
ENVELOPES = 9999
BEIT_HAKEREM_NBR = 1105
# as in 2022 (build_results.py): Haredi polling stations at the Ziv campus, left out of the colour
EXCLUDED = {267: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה', 286: 'קלפי חרדית – מצביעיה כנראה גרים מחוץ לשכונה'}

# Likud, Shas, UTJ, Religious Zionism, Otzma Yehudit, Noam, Amcha Yisrael (Ofer Winter), Black Flag
COALITION = ['מחל', 'שס', 'ג', 'ט', 'ב', 'ני', 'ך', 'נר']
LIBERAL = ['רק', 'דרך', 'אמת', 'ל']              # Together (Bennett), Yashar (Eisenkot), the Democrats, Yisrael Beiteinu
ARAB = ['ודם', 'עם']                              # the Joint List, Ra'am
UNALIGNED = ['די']                                # the Reservists (Zelicha)


def polygons_of(shape, arcs):
    polygons = [shape['arcs']] if shape['type'] == 'Polygon' else shape['arcs']
    return [[ring_of(arcs, r) for r in p] for p in polygons]


def contains(polygons, lat, lon):
    return any(inside(lat, lon, p[0]) and not any(inside(lat, lon, h) for h in p[1:]) for p in polygons)


def centre(polygons):
    """The area centroid of the largest ring, or the inside grid point closest to it."""
    ring = max((p[0] for p in polygons), key=len)
    a = cy = cx = 0
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        f = x1 * y2 - x2 * y1
        a, cy, cx = a + f, cy + (y1 + y2) * f, cx + (x1 + x2) * f
    if a:
        lat, lon = cy / (3 * a), cx / (3 * a)
        if contains(polygons, lat, lon):
            return lat, lon
    lats, lons = [p[0] for p in ring], [p[1] for p in ring]
    mid = sum(lats) / len(lats), sum(lons) / len(lons)
    grid = [(min(lats) + (max(lats) - min(lats)) * i / 20, min(lons) + (max(lons) - min(lons)) * j / 20)
            for i in range(1, 20) for j in range(1, 20)]
    grid = [g for g in grid if contains(polygons, *g)] or [ring[0]]
    return min(grid, key=lambda g: (g[0] - mid[0]) ** 2 + (g[1] - mid[1]) ** 2)


def entry(label, address, neighbourhood, locality, pos, boxes, beit_hakerem=False, approx=False, y22=None):
    if beit_hakerem:
        for b in boxes:
            b['excluded'] = EXCLUDED.get(int(float(b['kalpi'])))
    kept = [b for b in boxes if not b['excluded']]
    valid = sum(b['valid'] for b in kept)
    registered = sum(b['registered'] for b in kept)
    share = lambda k: round(sum(b[k] for b in kept) / valid, 4) if valid else None
    return {
        'label': label, 'address': address, 'neighbourhood': neighbourhood, 'locality': locality,
        'beit_hakerem': beit_hakerem, 'approx': approx, 'lat': round(pos[0], 5), 'lon': round(pos[1], 5),
        'boxes': sorted(boxes, key=lambda b: float(b['kalpi'])), 'valid': valid, 'registered': registered,
        'turnout': round(sum(b['voted'] for b in kept) / registered, 4) if registered else None,
        'liberal_share': share('liberal'), 'arab_share': share('arab'), 'coalition_share': share('coalition'),
        'unaligned_share': share('unaligned'),
        'y22': y22,
    }


def main():
    d = pd.concat([pd.read_csv(f, encoding='utf-8-sig') for f in SOURCES])
    d = d.loc[:, ~d.columns.str.startswith('Unnamed')]
    d = d.drop_duplicates(['סמל ישוב', 'קלפי'], keep='last')
    d = d[d['סמל ישוב'] != ENVELOPES]
    if not KALPI_CACHE.exists():
        KALPI_CACHE.parent.mkdir(exist_ok=True)
        req = urllib.request.Request(KALPI_URL, headers={'User-Agent': 'Mozilla/5.0 (betakerem.org/govote2026 results map)'})
        KALPI_CACHE.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    nbr_of = {k: f['nbr'] for k, f in json.load(open(KALPI_CACHE, encoding='utf-8'))['features'].items()}
    topo = json.load(open(SHAPES, encoding='utf-8'))
    shapes = {s['id']: (s, polygons_of(s, topo['arcs'])) for s in topo['shapes']}

    # 2022 buildings by (locality, polling-station number)
    old, towns = {}, {}
    for site in json.load(open(RESULTS_2022, encoding='utf-8'))['sites']:
        towns.setdefault(site['locality'], []).append((site['lat'], site['lon']))
        for b in site['boxes']:
            old.setdefault((site['locality'], int(float(b['kalpi']))), site)

    buildings, areas, in_town, unplaced = {}, {}, {}, []
    for _, r in d.iterrows():
        kalpi = f'{float(r["קלפי"]):g}'
        locality = str(r['שם ישוב']).strip()
        box = {'kalpi': kalpi, 'valid': int(r['כשרים']), 'registered': int(r['בזב']), 'voted': int(r['מצביעים']),
               'coalition': int(r[COALITION].sum()), 'liberal': int(r[LIBERAL].sum()), 'arab': int(r[ARAB].sum()),
               'unaligned': int(r[UNALIGNED].sum()), 'excluded': None}
        nbr = nbr_of.get(f'{r["סמל ישוב"]}|{kalpi}')
        shape = shapes.get(nbr)
        site = old.get((locality, int(float(kalpi))))
        if site and (shape is None or contains(shape[1], site['lat'], site['lon'])):
            buildings.setdefault(id(site), (site, []))[1].append(box)
        elif shape:
            areas.setdefault(nbr, (shape, locality, []))[2].append(box)
        elif locality in towns:  # no neighbourhood in the committee's data: the middle of the town's 2022 buildings
            in_town.setdefault(locality, []).append(box)
        else:
            unplaced.append((locality, kalpi, box['valid']))

    sites = []
    for site, boxes in buildings.values():
        y22 = [site['liberal_share'], site['arab_share'], site['coalition_share'], site['turnout']]
        sites.append(entry(site['label'], site['address'], site['neighbourhood'], site['locality'],
                           (site['lat'], site['lon']), boxes, site['beit_hakerem'], site['approx'], y22))
    for nbr, ((shape, polygons), locality, boxes) in areas.items():
        sites.append(entry(f'קלפיות בשכונה {shape["name"]}' if shape['name'] else f'קלפיות ב{locality}', None,
                           shape['name'], locality, centre(polygons), boxes,
                           nbr == BEIT_HAKEREM_NBR, True))
    for locality, boxes in in_town.items():
        points = towns[locality]
        pos = sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
        sites.append(entry(f'קלפיות ב{locality}', None, None, locality, pos, boxes, approx=True))
    sites = [s for s in sites if s['valid']]

    counted, total = len(d), len(nbr_of) - sum(k.startswith(f'{ENVELOPES}|') for k in nbr_of)
    final = SOURCES == [FINAL]
    time = None if final else f'{SOURCES[-1].stem[-4:-2]}:{SOURCES[-1].stem[-2:]}'
    OUT.write_text(json.dumps({'final': final, 'counted': counted, 'total': total, 'time': time, 'sites': sites},
                              ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    boxes = [b for s in sites for b in s['boxes'] if not b['excluded']]
    valid = sum(b['valid'] for b in boxes)
    print(f'{counted} of {total} ballot boxes counted; left out, no neighbourhood: {unplaced}')
    print(f'{len(buildings)} 2022 buildings ({sum(len(b) for _, b in buildings.values())} boxes), '
          f'{len(areas)} neighbourhood groups ({sum(len(a[2]) for a in areas.values())} boxes)')
    for bloc in ['liberal', 'arab', 'coalition', 'unaligned']:
        print(f'{bloc} share: {sum(b[bloc] for b in boxes) / valid:.1%}')
    print(f'turnout: {sum(b["voted"] for b in boxes) / sum(b["registered"] for b in boxes):.1%}')
    bhk = [s for s in sites if s['beit_hakerem']]
    print('בית הכרם:', [(s['label'], [b['kalpi'] for b in s['boxes']], s['liberal_share']) for s in bhk])
    for bloc in ['liberal', 'arab', 'coalition', 'unaligned']:
        print(f'  {bloc}: {sum(s[bloc + "_share"] * s["valid"] for s in bhk) / sum(s["valid"] for s in bhk):.1%}')
    print(f'-> {OUT.name} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
