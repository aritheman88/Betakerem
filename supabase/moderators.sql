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

-- null when the password is right, else 'bad_password' | 'locked'. Failed attempts are rate-limited per IP.
create or replace function public._moderator_error(p_password text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_ip text := split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1);
begin
    if (select count(*) from public.moderator_attempts
        where not ok and ip is not distinct from v_ip and at > now() - interval '15 minutes') >= 10 then
        return 'locked';
    end if;
    if not exists (select 1 from public.moderator_auth
                   where id = 1 and password_hash = extensions.crypt(coalesce(p_password, ''), password_hash)) then
        insert into public.moderator_attempts (ip, ok) values (v_ip, false);
        return 'bad_password';
    end if;
    delete from public.moderator_attempts where at < now() - interval '1 day';
    return null;
end $$;

-- join requests with the requester's and the block volunteers' details
create or replace function public._join_request_rows(p_where text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    v jsonb;
begin
    execute format($q$
        select coalesce(jsonb_agg(jsonb_build_object(
                   'id', r.id, 'block_id', r.block_id, 'label', b.label,
                   'names', r.names, 'phone', r.phone, 'note', r.note,
                   'owner_names', c.names, 'owner_phone', s.phone, 'owner_slots', c.slots,
                   'created_at', r.created_at, 'notified_at', r.notified_at, 'handled_at', r.handled_at)
               order by r.created_at), '[]'::jsonb)
        from public.join_requests r
        join public.blocks b on b.id = r.block_id
        left join public.claims c on c.block_id = r.block_id
        left join public.claim_secrets s on s.block_id = r.block_id
        where %s $q$, p_where) into v;
    return v;
end $$;

-- Returns {"ok": true, "rows": [...], "requests": [...]}: every block with its claim and the volunteer's phone,
-- plus all join requests; or {"ok": false, "error": "bad_password" | "locked"}.
create or replace function public.moderator_claims(p_password text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err text := public._moderator_error(p_password);
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    return jsonb_build_object('ok', true, 'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                   'block_id', b.id, 'label', b.label, 'apartments', b.apartments, 'entrances', b.entrances,
                   'houses_done', (select count(*) from public.house_done h where h.block_id = b.id),
                   'status', coalesce(c.status, 'free'), 'names', c.names, 'phone', s.phone, 'slots', c.slots,
                   'claimed_at', c.claimed_at, 'started_at', c.started_at, 'done_at', c.done_at)
               order by b.id)
        from public.blocks b
        left join public.claims c on c.block_id = b.id
        left join public.claim_secrets s on s.block_id = b.id), '[]'::jsonb),
        'requests', public._join_request_rows('true'));
end $$;

-- mark a join request handled (p_handled) or back to open
create or replace function public.moderator_handle_request(p_password text, p_id bigint, p_handled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err text := public._moderator_error(p_password);
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    update public.join_requests set handled_at = case when p_handled then now() end where id = p_id;
    return jsonb_build_object('ok', found);
end $$;

-- for the hourly email job: open requests not reported yet, which are marked reported on the way out
create or replace function public.moderator_new_requests(p_password text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err text := public._moderator_error(p_password);
    v_rows jsonb;
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    v_rows := public._join_request_rows('r.notified_at is null and r.handled_at is null');
    update public.join_requests set notified_at = now() where notified_at is null and handled_at is null
        and id in (select (x ->> 'id')::bigint from jsonb_array_elements(v_rows) x);
    return jsonb_build_object('ok', true, 'requests', v_rows,
        'open', (select count(*) from public.join_requests where handled_at is null));
end $$;

-- put reported requests back in the queue, e.g. when the email failed to send
create or replace function public.moderator_unnotify_requests(p_password text, p_ids bigint[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err text := public._moderator_error(p_password);
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    update public.join_requests set notified_at = null where id = any (p_ids);
    return jsonb_build_object('ok', true);
end $$;

-- free a block whatever its state (undo vandalism, or a volunteer who dropped out)
create or replace function public.moderator_release(p_password text, p_block_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err text := public._moderator_error(p_password);
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    delete from public.claims where block_id = p_block_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'moderator_release');
    return jsonb_build_object('ok', true);
end $$;

-- fix a claim: names, phone, shifts and status. Setting it back to 'claimed' clears its marked addresses.
create or replace function public.moderator_update_claim(p_password text, p_block_id text, p_names text, p_phone text,
                                                         p_slots text[], p_status text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_err   text := public._moderator_error(p_password);
    v_names text := btrim(regexp_replace(coalesce(p_names, ''), '\s+', ' ', 'g'));
    v_phone text := public._norm_phone(p_phone);
begin
    if v_err is not null then
        return jsonb_build_object('ok', false, 'error', v_err);
    end if;
    if char_length(v_names) < 2 or char_length(v_names) > 80 then
        return jsonb_build_object('ok', false, 'error', 'bad_names');
    end if;
    if v_phone !~ '^0(5\d{8}|[2-9]\d{7})$' then
        return jsonb_build_object('ok', false, 'error', 'bad_phone');
    end if;
    if p_slots is null or cardinality(p_slots) = 0
       or not (p_slots <@ array['10-12', '12-14', '14-16', '16-18']) then
        return jsonb_build_object('ok', false, 'error', 'bad_slots');
    end if;
    if p_status is null or p_status not in ('claimed', 'in_progress', 'done') then
        return jsonb_build_object('ok', false, 'error', 'bad_status');
    end if;
    update public.claims set
        names = v_names,
        slots = (select array_agg(s order by s) from unnest(p_slots) s),
        started_at = case when p_status = 'claimed' then null else coalesce(started_at, now()) end,
        done_at = case when p_status = 'done' then coalesce(done_at, now()) end,
        status = p_status
    where block_id = p_block_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_claimed');
    end if;
    update public.claim_secrets set phone = v_phone where block_id = p_block_id;
    if p_status = 'claimed' then
        delete from public.house_done where block_id = p_block_id;
    end if;
    insert into public.claim_log (block_id, action, names, phone) values (p_block_id, 'moderator_edit', v_names, v_phone);
    return jsonb_build_object('ok', true);
end $$;

revoke all on function public._moderator_error(text), public._join_request_rows(text) from public, anon, authenticated;
revoke all on function public.moderator_claims(text), public.moderator_handle_request(text, bigint, boolean),
    public.moderator_new_requests(text), public.moderator_unnotify_requests(text, bigint[]),
    public.moderator_release(text, text), public.moderator_update_claim(text, text, text, text, text[], text) from public;
grant execute on function public.moderator_claims(text), public.moderator_handle_request(text, bigint, boolean),
    public.moderator_new_requests(text), public.moderator_unnotify_requests(text, bigint[]),
    public.moderator_release(text, text), public.moderator_update_claim(text, text, text, text, text[], text)
    to anon, authenticated;
