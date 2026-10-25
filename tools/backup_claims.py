"""Hourly backup of the govote2026 claims, so vandalism or a mistake can be undone (the free Supabase plan has no
backups of its own).

Run hourly by the Windows Task Scheduler task "govote2026_backup" until election night.
Each run saves, in tools/backups/ (gitignored: it holds phone numbers):
    claims_<YYYY-MM-DD_HHMM>.json   every block with its claim (names, phone, slots, status) and done addresses
    restore_latest.sql              SQL that puts the claims of the newest backup back; run it in the Supabase SQL
                                    editor. It also has a commented-out part that releases blocks claimed since.
A run whose claims are identical to the previous backup's saves nothing new.

Uses the moderator password from Betakerem/.env (GOVOTE_MODERATOR_PASSWORD), like check_join_requests.py.
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# ---- settings ----
REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / 'tools' / 'backups'
SUPABASE_URL = 'https://plsyyconetnlpkpspaje.supabase.co'
SUPABASE_KEY = 'sb_publishable_DG7VvWfcdCT1v8XUpyDBUQ_J4XkriA4'  # publishable key, same as govote2026/config.js
TZ = ZoneInfo('Asia/Jerusalem')

load_dotenv(REPO / '.env')


def get(path, **params):
    r = requests.get(f'{SUPABASE_URL}/rest/v1/{path}', params=params, timeout=60,
                     headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'})
    r.raise_for_status()
    return r.json()


def fetch_claims(password):
    r = requests.post(f'{SUPABASE_URL}/rest/v1/rpc/moderator_claims', json={'p_password': password}, timeout=60,
                      headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'})
    r.raise_for_status()
    data = r.json()
    if not data.get('ok'):
        raise RuntimeError(f'moderator_claims: {data.get("error")}')
    claims = {row['block_id']: row for row in data['rows'] if row['status'] != 'free'}
    for h in get('house_done', select='house_id,block_id,done_at', order='house_id'):
        claims[h['block_id']].setdefault('houses', []).append({'house_id': h['house_id'], 'done_at': h['done_at']})
    return claims


def sql_str(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"


def restore_sql(claims, taken_at):
    ids = ', '.join(sql_str(b) for b in claims) or "''"
    lines = [f'-- Puts back the claims from the backup of {taken_at} ({len(claims)} claimed blocks).',
             '-- Claims and phones of these blocks are set to what they were then; volunteers can edit again with their phone.',
             'begin;']
    for b, c in claims.items():
        slots = 'array[' + ', '.join(sql_str(s) for s in c['slots']) + ']::text[]'
        lines.append(
            f"insert into public.claims (block_id, names, slots, status, claimed_at, started_at, done_at) values "
            f"({sql_str(b)}, {sql_str(c['names'])}, {slots}, {sql_str(c['status'])}, {sql_str(c['claimed_at'])}, "
            f"{sql_str(c['started_at'])}, {sql_str(c['done_at'])}) on conflict (block_id) do update set "
            f"names = excluded.names, slots = excluded.slots, status = excluded.status, claimed_at = excluded.claimed_at, "
            f"started_at = excluded.started_at, done_at = excluded.done_at;")
        lines.append(
            f"insert into public.claim_secrets (block_id, phone, token_hash) values ({sql_str(b)}, {sql_str(c['phone'])}, "
            f"encode(extensions.gen_random_bytes(32), 'hex')) on conflict (block_id) do update set phone = excluded.phone;")
        for h in c.get('houses', []):
            lines.append(f"insert into public.house_done (house_id, block_id, done_at) values ({sql_str(h['house_id'])}, "
                         f"{sql_str(b)}, {sql_str(h['done_at'])}) on conflict (house_id) do nothing;")
    lines += ['commit;', '',
              '-- Optional: also release every block claimed AFTER this backup (e.g. someone grabbed many blocks).',
              '-- Check the moderators page first; remove the "--" from the next line to run it.',
              f'-- delete from public.claims where block_id not in ({ids});', '']
    return '\n'.join(lines)


def main():
    password = os.getenv('GOVOTE_MODERATOR_PASSWORD')
    if not password:
        sys.exit(f'GOVOTE_MODERATOR_PASSWORD must be set in {REPO / ".env"}')
    OUT_DIR.mkdir(exist_ok=True)
    now = datetime.now(TZ)
    claims = fetch_claims(password)
    previous = sorted(OUT_DIR.glob('claims_*.json'))
    if previous and json.load(open(previous[-1], encoding='utf-8'))['claims'] == claims:
        print(f'{now:%Y-%m-%d %H:%M} {len(claims)} claimed blocks, unchanged since {previous[-1].name}')
        return
    path = OUT_DIR / f'claims_{now:%Y-%m-%d_%H%M}.json'
    json.dump({'taken_at': now.isoformat(timespec='seconds'), 'claims': claims},
              open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    (OUT_DIR / 'restore_latest.sql').write_text(restore_sql(claims, f'{now:%d/%m %H:%M}'), encoding='utf-8')
    print(f'{now:%Y-%m-%d %H:%M} {len(claims)} claimed blocks saved to {path.name}')


if __name__ == '__main__':
    main()
