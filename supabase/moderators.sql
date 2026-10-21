-- Moderator access: one shared password, checked server-side. Run after schema.sql.
-- Set or change the password (bcrypt hash only, never the plain text) with:
--   insert into public.moderator_auth (id, password_hash) values (1, '<bcrypt hash>')
--   on conflict (id) do update set password_hash = excluded.password_hash;
-- (generate the hash locally, e.g. python -c "import bcrypt; print(bcrypt.hashpw(b'...', bcrypt.gensalt(10)).decode().replace('$2b$', '$2a$', 1))")

create table if not exists public.moderator_auth (
    id            int primary key default 1 check (id = 1),
    password_hash text not null
);

create table if not exists public.moderator_attempts (
    at timestamptz not null default now(),
    ip text,
    ok boolean not null
);

alter table public.moderator_auth     enable row level security;
alter table public.moderator_attempts enable row level security;
revoke all on public.moderator_auth, public.moderator_attempts from anon, authenticated;

-- Returns {"ok": true, "rows": [...]} with every block, its claim and the volunteer's phone,
-- or {"ok": false, "error": "bad_password" | "locked"}. Failed attempts are rate-limited per IP.
create or replace function public.moderator_claims(p_password text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_ip text := split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1);
begin
    if (select count(*) from public.moderator_attempts
        where not ok and ip is not distinct from v_ip and at > now() - interval '15 minutes') >= 10 then
        return jsonb_build_object('ok', false, 'error', 'locked');
    end if;
    if not exists (select 1 from public.moderator_auth
                   where id = 1 and password_hash = extensions.crypt(coalesce(p_password, ''), password_hash)) then
        insert into public.moderator_attempts (ip, ok) values (v_ip, false);
        return jsonb_build_object('ok', false, 'error', 'bad_password');
    end if;
    delete from public.moderator_attempts where at < now() - interval '1 day';
    return jsonb_build_object('ok', true, 'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                   'block_id', b.id, 'label', b.label, 'apartments', b.apartments,
                   'status', coalesce(c.status, 'free'), 'names', c.names, 'phone', s.phone, 'slots', c.slots,
                   'claimed_at', c.claimed_at, 'started_at', c.started_at, 'done_at', c.done_at)
               order by b.id)
        from public.blocks b
        left join public.claims c on c.block_id = b.id
        left join public.claim_secrets s on s.block_id = b.id), '[]'::jsonb));
end $$;

revoke all on function public.moderator_claims(text) from public;
grant execute on function public.moderator_claims(text) to anon, authenticated;
