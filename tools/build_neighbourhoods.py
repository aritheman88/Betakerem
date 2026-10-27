"""Neighbourhood shapes for the election-day turnout layer: govote2026/neighbourhoods2026.json.

Source: the Central Elections Committee's turnout map (mapvotes.bechirot.gov.il), neighborhood_geometry.topojson,
in Web Mercator (EPSG:3857). Its "id" is the key of the turnout figures that tools/fetch_turnout.py copies.

Output keeps the TopoJSON idea (shared borders stored once) but in plain lat/lon, so the map needs no library:
    arcs:  [[[lat, lon], ...], ...]                      (4 decimals, about 10 m)
    shapes: [{id, name, city, type: Polygon|MultiPolygon, arcs, y22}]   arc index i, or ~i for the arc reversed
y22 = the 2022 result of the polling buildings inside the neighbourhood (govote2026/results2022.json; run
build_results.py first): [valid votes, liberal share, Arab share, coalition share, final turnout]. Polling buildings
mostly serve their own neighbourhood, so this is a fair but not exact picture of who lives there.
"""
import json
import math
import urllib.request
from pathlib import Path

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
URL = 'https://mapvotes.bechirot.gov.il/data/votes/latest/neighborhood_geometry.topojson'
CACHE = REPO / 'tools' / 'cache' / 'neighborhood_geometry.topojson'
OUT = REPO / 'govote2026' / 'neighbourhoods2026.json'
RESULTS = REPO / 'govote2026' / 'results2022.json'


def unproject(x, y):
    r = 6378137.0
    return round(math.degrees(2 * math.atan(math.exp(y / r)) - math.pi / 2), 4), round(math.degrees(x / r), 4)


def ring_of(arcs, indexes):
    pts = []
    for i in indexes:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts += a[1:] if pts else a
    return pts


def inside(lat, lon, ring):
    hit = False
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def results_2022(arcs, shapes):
    """Attach to each shape the summed 2022 result of the polling buildings inside it."""
    sites = [s for s in json.load(open(RESULTS, encoding='utf-8'))['sites'] if s['valid']]
    for shape in shapes:
        polygons = [shape['arcs']] if shape['type'] == 'Polygon' else shape['arcs']
        polygons = [[ring_of(arcs, r) for r in p] for p in polygons]
        lats = [pt[0] for p in polygons for pt in p[0]]
        lons = [pt[1] for p in polygons for pt in p[0]]
        box = min(lats), max(lats), min(lons), max(lons)
        mine = [s for s in sites if box[0] <= s['lat'] <= box[1] and box[2] <= s['lon'] <= box[3]
                and any(inside(s['lat'], s['lon'], p[0]) and not any(inside(s['lat'], s['lon'], h) for h in p[1:])
                        for p in polygons)]
        valid = sum(s['valid'] for s in mine)
        if valid:
            share = lambda k: round(sum(s[k] * s['valid'] for s in mine) / valid, 3)
            turnout = round(sum(s['turnout'] * s['registered'] for s in mine) / sum(s['registered'] for s in mine), 3)
            shape['y22'] = [valid, share('liberal_share'), share('arab_share'), share('coalition_share'), turnout]
    return sum('y22' in s for s in shapes)


def main():
    if not CACHE.exists():
        CACHE.parent.mkdir(exist_ok=True)
        req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
        CACHE.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    topo = json.load(open(CACHE, encoding='utf-8'))
    (sx, sy), (tx, ty) = topo['transform']['scale'], topo['transform']['translate']
    arcs = []
    for arc in topo['arcs']:
        x = y = 0
        points = []
        for dx, dy in arc:
            x, y = x + dx, y + dy
            p = unproject(x * sx + tx, y * sy + ty)
            if not points or p != points[-1]:
                points.append(p)
        arcs.append(points)
    shapes = [{'id': g['properties']['id'], 'name': g['properties'].get('neighborhood_name'),
               'city': g['properties'].get('שם ישוב'), 'type': g['type'], 'arcs': g['arcs']}
              for g in topo['objects']['neighborhood']['geometries']
              if g['type'] in ('Polygon', 'MultiPolygon') and g['properties']['id'] >= 0]
    with_2022 = results_2022(arcs, shapes)
    OUT.write_text(json.dumps({'arcs': arcs, 'shapes': shapes}, ensure_ascii=False, separators=(',', ':')),
                   encoding='utf-8')
    print(f'{len(shapes)} neighbourhoods ({with_2022} with 2022 polling buildings), {sum(map(len, arcs))} points -> {OUT.name} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
