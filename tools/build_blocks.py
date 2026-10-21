"""Build canvassing blocks for the govote2026 map.

A block is a group of residential addresses on one street (or a few small neighbouring
streets) holding roughly BLOCK_TARGET apartments, drawn as an area around its buildings.

Sources:
    Jerusalem municipality GIS (BaseLayers MapServer): neighbourhood boundary (layer 40),
        address points with apartment counts (layer 10), building footprints (layer 30)
    OSM (Overpass): street centre-lines, used only to order addresses along each street

Writes:
    govote2026/boundary.geojson
    govote2026/blocks.geojson       one polygon per block, with its address list
    govote2026/buildings.geojson    building footprints tagged with their block id
    supabase/seed_blocks.sql        rows for the blocks table
"""
import gzip
import json
import math
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiPoint, Point, Polygon, mapping
from shapely.ops import linemerge, unary_union

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / 'govote2026'
SQL_OUT = REPO / 'supabase' / 'seed_blocks.sql'
CACHE_DIR = REPO / 'tools' / 'cache'
REFRESH = False  # True to re-download everything instead of using tools/cache

MUNI_MAPSERVER = 'https://gisviewer.jerusalem.muni.il/arcgis/rest/services/BaseLayers/MapServer'
NEIGHBOURHOODS_LAYER = 40
ADDRESSES_LAYER = 10   # רוזטות, מספרי בתים (has apartment counts)
BUILDINGS_LAYER = 30   # מבנים (footprints)
NEIGHBOURHOOD_CODE = 56  # בית הכרם (official, incl. רמת בית הכרם and יפה נוף)

OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
HIGHWAY_TYPES = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
                 'pedestrian', 'footway', 'path', 'steps', 'service']

BLOCK_TARGET = 65      # apartments per block the splitter aims for
SMALL_BLOCK = 35       # blocks below this are merged into a neighbouring block...
MERGED_MAX = 95        # ...as long as the result stays at or below this
MERGE_DISTANCE_M = 90  # and the two blocks are this close
MIN_BLOCK = 5          # blocks still this small after merging are dropped (isolated houses on main roads)
NAME_MATCH_MIN = 0.6
CELL_REACH_M = 22      # how far a block's area extends beyond its buildings
USER_AGENT = 'betakerem-govote2026/1.0'

_to_m = Transformer.from_crs(4326, 2039, always_xy=True)  # Israeli TM grid, metres
_to_deg = Transformer.from_crs(2039, 4326, always_xy=True)


def to_m(geom):
    return shapely.transform(geom, lambda xy: np.column_stack(_to_m.transform(xy[:, 0], xy[:, 1])))


def to_deg(geom):
    return shapely.transform(geom, lambda xy: np.column_stack(_to_deg.transform(xy[:, 0], xy[:, 1])))


def http_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': USER_AGENT})
    raw = urllib.request.urlopen(req, timeout=180).read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return json.loads(raw)


def cached(name, fetch):
    path = CACHE_DIR / name
    if path.exists() and not REFRESH:
        return json.load(open(path, encoding='utf-8'))
    data = fetch()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    return data


def muni_query(layer, **params):
    params.update(f='json', inSR=4326, outSR=4326)
    return http_json(f'{MUNI_MAPSERVER}/{layer}/query', urllib.parse.urlencode(params).encode())


def muni_features_in(layer, bounds):
    minx, miny, maxx, maxy = bounds
    env = json.dumps({'xmin': minx, 'ymin': miny, 'xmax': maxx, 'ymax': maxy, 'spatialReference': {'wkid': 4326}})
    oids = sorted(muni_query(layer, geometry=env, geometryType='esriGeometryEnvelope', returnIdsOnly='true')['objectIds'])
    feats = []
    for i in range(0, len(oids), 300):  # server caps responses at 1000 records
        feats += muni_query(layer, objectIds=','.join(map(str, oids[i:i + 300])), outFields='*', returnGeometry='true')['features']
    return feats


def fetch_boundary():
    d = muni_query(NEIGHBOURHOODS_LAYER, where=f'CODE={NEIGHBOURHOOD_CODE}', outFields='SCHN_NAME', returnGeometry='true')
    rings = d['features'][0]['geometry']['rings']
    return Polygon(rings[0], rings[1:])


def fetch_streets(bounds):
    minx, miny, maxx, maxy = bounds
    query = f'''[out:json][timeout:120];
way["highway"~"^({'|'.join(HIGHWAY_TYPES)})$"]["name"]({miny},{minx},{maxy},{maxx});
out geom;'''
    for attempt in range(3):
        for url in OVERPASS_URLS:
            try:
                return http_json(url, urllib.parse.urlencode({'data': query}).encode())
            except Exception as e:
                print('Overpass failed:', url, e)
                time.sleep(10)
    raise RuntimeError('all Overpass servers failed')


# ---- street names ----

def norm_name(name):
    """Normalise a street name for OSM-vs-municipality comparison: drop prefixes, punctuation, initials."""
    name = re.sub(r'[^\w\s]', ' ', name or '')
    tokens = [t for t in name.split() if t not in ('שדרות', 'דרך', 'רחוב', 'מעלות', 'מעלה', 'סמטת') and len(t) > 2]
    return ' '.join(sorted(tokens))


def name_similarity(a, b):
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return 0
    if a in b or b in a:
        return 1
    return SequenceMatcher(None, a, b).ratio()


def clean_street(name):
    """Municipal names sometimes have doubled spaces or a trailing initial ('כרמון מ.')."""
    return re.sub(r'\s+', ' ', name or '').strip()


def house_key(num, letter):
    """BldNum is usually a number but sometimes text like "37 א'"; the letter may sit in either field."""
    m = re.match(r'\s*(\d*)\s*(.*)', str(num or ''))
    in_num, in_letter = re.sub(r'[^\w]', '', m.group(2)), re.sub(r'[^\w]', '', letter or '')
    extra = in_num if in_num == in_letter else in_num + in_letter
    return int(m.group(1) or 0), extra


def house_label(num, letter):
    n, extra = house_key(num, letter)
    return f'{n}{extra}'


# ---- addresses ----

def load_addresses(boundary_m):
    """Residential address points inside the boundary, de-duplicated, in metres."""
    raw = cached('muni_addresses.json', lambda: muni_features_in(ADDRESSES_LAYER, to_deg(boundary_m).buffer(0.001).bounds))
    seen = {}
    for f in raw:
        a = f['attributes']
        apts = a['NUM_APTS_C'] or 0
        street = clean_street(a['StreetName1'])
        if apts <= 0 or not street:
            continue
        pt = to_m(Point(f['geometry']['x'], f['geometry']['y']))
        if not boundary_m.buffer(5).contains(pt):
            continue
        key = (street, house_key(a['BldNum'], a['BLDG_LETTE']))
        if key in seen:  # the layer has a few duplicate rosettes for the same address
            continue
        seen[key] = {'street': street, 'num': house_key(a['BldNum'], a['BLDG_LETTE']),
                     'label': house_label(a['BldNum'], a['BLDG_LETTE']), 'apts': apts, 'pt': pt}
    return list(seen.values())


def street_paths(osm, streets):
    """For each municipal street name, one LineString (metres) along the matching OSM ways, or None."""
    ways = [(w['tags']['name'], to_m(LineString([(p['lon'], p['lat']) for p in w['geometry']])))
            for w in osm['elements'] if w['type'] == 'way' and len(w.get('geometry', [])) > 1]
    paths = {}
    for street in streets:
        lines = [g for n, g in ways if name_similarity(n, street) >= NAME_MATCH_MIN]
        if not lines:
            paths[street] = None
            continue
        merged = linemerge(lines)
        parts = list(merged.geoms) if merged.geom_type == 'MultiLineString' else [merged]
        paths[street] = chain_parts(parts)
    return paths


def chain_parts(parts):
    """Join line parts into one path, greedily walking to the nearest free endpoint."""
    parts = sorted(parts, key=lambda g: -g.length)
    coords = list(parts.pop(0).coords)
    while parts:
        end = Point(coords[-1])
        best, flip = min(((p, Point(p.coords[-1]).distance(end) < Point(p.coords[0]).distance(end)) for p in parts),
                         key=lambda pf: min(Point(pf[0].coords[0]).distance(end), Point(pf[0].coords[-1]).distance(end)))
        parts.remove(best)
        coords += list(best.coords)[::-1] if flip else list(best.coords)
    return LineString(coords)


def order_along(addrs, path):
    if path is not None and path.length > 0:
        return sorted(addrs, key=lambda a: (path.project(a['pt']), a['num']))
    # no OSM line: order along the points' main axis
    xy = np.array([[a['pt'].x, a['pt'].y] for a in addrs])
    if len(xy) < 2:
        return addrs
    axis = np.linalg.svd(xy - xy.mean(axis=0))[2][0]
    return [addrs[i] for i in np.argsort((xy - xy.mean(axis=0)) @ axis)]


def split_balanced(addrs):
    """Cut an ordered address list into k contiguous chunks of roughly equal apartments."""
    total = sum(a['apts'] for a in addrs)
    k = max(1, round(total / BLOCK_TARGET))
    if k == 1:
        return [addrs]
    chunks, cur, acc, cut = [], [], 0, 1
    for a in addrs:
        target = total * cut / k
        # close the chunk before this address if that lands closer to the target
        if cur and cut < k and abs(acc - target) <= abs(acc + a['apts'] - target):
            chunks.append(cur)
            cur, cut = [], cut + 1
        cur.append(a)
        acc += a['apts']
    chunks.append(cur)
    return chunks


def merge_small(blocks):
    """Merge blocks under SMALL_BLOCK apartments into the nearest neighbour that stays under MERGED_MAX."""
    def apts(b):
        return sum(a['apts'] for a in b)

    def hull(b):
        return MultiPoint([a['pt'] for a in b]).convex_hull

    while True:
        blocks.sort(key=apts)
        for small in blocks:
            if apts(small) >= SMALL_BLOCK:
                return blocks
            h = hull(small)
            options = [(b, hull(b).distance(h)) for b in blocks if b is not small and apts(b) + apts(small) <= MERGED_MAX]
            options = [(b, d) for b, d in options if d <= MERGE_DISTANCE_M]
            if options:
                # prefer a block on the same street, then the closest one
                same = [(b, d) for b, d in options if b[0]['street'] == small[0]['street']]
                target = min(same or options, key=lambda bd: (bd[1], apts(bd[0])))[0]
                target.extend(small)
                blocks.remove(small)
                break
        else:
            return blocks


def block_label(addrs):
    by_street = defaultdict(list)
    for a in addrs:
        by_street[a['street']].append(a)
    main = max(by_street, key=lambda s: sum(a['apts'] for a in by_street[s]))
    nums = sorted(a['num'][0] for a in by_street[main])
    label = f'{main} {nums[0]}' if nums[0] == nums[-1] else f'{main} {nums[0]}–{nums[-1]}'
    if len(by_street) > 1:
        label += ' ועוד'
    return label


def address_list(addrs):
    by_street = defaultdict(list)
    for a in addrs:
        by_street[a['street']].append(a)
    out = []
    for street in sorted(by_street, key=lambda s: -sum(a['apts'] for a in by_street[s])):
        houses = sorted(by_street[street], key=lambda a: a['num'])
        out.append({'street': street, 'houses': [[a['label'], a['apts']] for a in houses]})
    return out


# ---- geometry ----

def block_areas(blocks, footprints, boundary_m):
    """Partition the area around the buildings between blocks: Voronoi cells of the address points."""
    pts = [(a['pt'], i) for i, b in enumerate(blocks) for a in b]
    cells = shapely.voronoi_polygons(MultiPoint([p for p, _ in pts]), extend_to=boundary_m.buffer(500))
    reach = unary_union([g.buffer(CELL_REACH_M) for g in footprints] + [p.buffer(CELL_REACH_M) for p, _ in pts])
    reach = reach.intersection(boundary_m.buffer(CELL_REACH_M))
    tree = shapely.STRtree([p for p, _ in pts])
    parts = defaultdict(list)
    for cell in cells.geoms:
        idx = tree.query(cell, predicate='contains')
        for j in idx:
            parts[pts[j][1]].append(cell)
    areas = {}
    for i, cs in parts.items():
        g = unary_union(cs).intersection(reach)
        areas[i] = g.buffer(1).buffer(-1).simplify(1.5)
    return areas


def round_coords(geom_mapping, nd=6):
    return json.loads(json.dumps(geom_mapping), parse_float=lambda x: round(float(x), nd))


def main():
    OUT_DIR.mkdir(exist_ok=True)
    SQL_OUT.parent.mkdir(exist_ok=True)
    boundary = Polygon(*cached('boundary.json', lambda: [mapping(fetch_boundary())['coordinates'][0], []]))
    boundary_m = to_m(boundary)
    json.dump({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'name': 'בית הכרם'}, 'geometry': round_coords(mapping(boundary))}]},
        open(OUT_DIR / 'boundary.geojson', 'w', encoding='utf-8'), ensure_ascii=False)

    addrs = load_addresses(boundary_m)
    osm = cached('osm_streets_geom.json', lambda: fetch_streets(boundary.buffer(0.003).bounds))
    by_street = defaultdict(list)
    for a in addrs:
        by_street[a['street']].append(a)
    paths = street_paths(osm, by_street)
    no_path = sorted(s for s, p in paths.items() if p is None)
    if no_path:
        print('streets without an OSM line (ordered by point axis):', no_path)

    blocks = []
    for street, sa in by_street.items():
        blocks += split_balanced(order_along(sa, paths[street]))
    blocks = merge_small(blocks)
    dropped = [b for b in blocks if sum(a['apts'] for a in b) < MIN_BLOCK]
    if dropped:
        print('dropping tiny isolated blocks:', [block_label(b) for b in dropped])
        blocks = [b for b in blocks if b not in dropped]

    raw_fp = cached('muni_buildings.json', lambda: muni_features_in(BUILDINGS_LAYER, boundary.buffer(0.001).bounds))
    footprints = []
    for f in raw_fp:
        g = to_m(Polygon(f['geometry']['rings'][0], f['geometry']['rings'][1:]))
        if g.is_valid and boundary_m.buffer(5).contains(g.centroid):
            footprints.append(g)

    # order blocks north-west to south-east so ids read naturally on the map
    blocks.sort(key=lambda b: (-round(np.mean([a['pt'].y for a in b]), -2), np.mean([a['pt'].x for a in b])))
    areas = block_areas(blocks, footprints, boundary_m)

    pt_tree = shapely.STRtree([a['pt'] for b in blocks for a in b])
    pt_block = [i for i, b in enumerate(blocks) for _ in b]
    block_feats, building_feats = [], []
    for i, b in enumerate(blocks):
        bid = f'B{i + 1:03d}'
        block_feats.append({'type': 'Feature', 'id': bid, 'geometry': round_coords(mapping(to_deg(areas[i]))), 'properties': {
            'id': bid, 'label': block_label(b), 'apartments': sum(a['apts'] for a in b),
            'entrances': len(b), 'addresses': address_list(b)}})
    for g in footprints:
        near = pt_tree.query(g, predicate='intersects')
        if len(near) == 0:
            j = pt_tree.nearest(g)
            if pt_tree.geometries[j].distance(g) > 15:
                continue  # not a residential building we know of
            near = [j]
        votes = defaultdict(int)
        for j in near:
            votes[pt_block[j]] += 1
        i = max(votes, key=votes.get)
        building_feats.append({'type': 'Feature', 'geometry': round_coords(mapping(to_deg(g.simplify(0.5)))),
                               'properties': {'b': f'B{i + 1:03d}'}})

    json.dump({'type': 'FeatureCollection', 'features': block_feats},
              open(OUT_DIR / 'blocks.geojson', 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump({'type': 'FeatureCollection', 'features': building_feats},
              open(OUT_DIR / 'buildings.geojson', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    with open(SQL_OUT, 'w', encoding='utf-8') as f:
        f.write('-- generated by tools/build_blocks.py\n')
        f.write('insert into public.blocks (id, label, apartments) values\n')
        f.write(',\n'.join(f"  ('{p['id']}', '{p['label'].replace(chr(39), chr(39) * 2)}', {p['apartments']})"
                           for p in (bf['properties'] for bf in block_feats)))
        f.write('\non conflict (id) do update set label = excluded.label, apartments = excluded.apartments;\n')

    sizes = sorted(bf['properties']['apartments'] for bf in block_feats)
    print(f'{len(block_feats)} blocks, {sum(sizes)} apartments in {sum(len(b) for b in blocks)} entrances, '
          f'{len(building_feats)} buildings drawn')
    print('apartments per block: min', sizes[0], 'median', sizes[len(sizes) // 2], 'max', sizes[-1],
          '| <35:', sum(s < 35 for s in sizes), '| 35-95:', sum(35 <= s <= 95 for s in sizes), '| >95:', sum(s > 95 for s in sizes))
    print('largest:', [(bf['properties']['label'], bf['properties']['apartments']) for bf in
                       sorted(block_feats, key=lambda x: -x['properties']['apartments'])[:6]])


if __name__ == '__main__':
    main()
