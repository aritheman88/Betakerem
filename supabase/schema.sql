-- govote2026 schema. Run once in the Supabase SQL editor, then run seed_blocks.sql.
-- The browser only uses the publishable (anon) key: it can read settings/blocks/claims,
-- and changes anything only through the security-definer functions below.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------

create table if not exists public.settings (
    id         int primary key default 1 check (id = 1),
    live_from  timestamptz not null default '2026-10-27 00:00:00+02',  -- election day, Israel time
    live_until timestamptz not null default '2026-10-28 00:00:00+02'
);
insert into public.settings default values on conflict (id) do nothing;

create table if not exists public.blocks (
    id         text primary key,
    label      text not null,
    apartments int  not null,
    entrances  int  not null default 0
);
alter table public.blocks add column if not exists entrances int not null default 0;

create table if not exists public.claims (
    block_id   text primary key references public.blocks (id) on delete cascade,
    names      text not null,
    slots      text[] not null,
    status     text not null default 'claimed' check (status in ('claimed', 'in_progress', 'done')),
    claimed_at timestamptz not null default now(),
    started_at timestamptz,
    done_at    timestamptz
);

-- addresses (house ids like 'K001-3', see blocks.geojson) marked done; cleared when the block is released
create table if not exists public.house_done (
    house_id text primary key,
    block_id text not null references public.claims (block_id) on delete cascade,
    done_at  timestamptz not null default now()
);
create index if not exists house_done_block on public.house_done (block_id);

-- private: never readable with the publishable key
create table if not exists public.claim_secrets (
    block_id   text primary key references public.claims (block_id) on delete cascade,
    phone      text not null,
    token_hash text not null
);
create index if not exists claim_secrets_phone on public.claim_secrets (phone);

-- "request to join" a claimed block; a moderator connects the requester with the block's volunteers
create table if not exists public.join_requests (
    id          bigserial primary key,
    block_id    text not null references public.blocks (id) on delete cascade,
    names       text not null,
    phone       text not null,
    note        text,
    created_at  timestamptz not null default now(),
    notified_at timestamptz,  -- set when the hourly email job has reported it
    handled_at  timestamptz   -- set by a moderator from the moderators page
);

-- private: the API key derived from the site password (see gate.js). Not in the repo; set it with
--   insert into public.site_key (id, key) values (1, '<key>') on conflict (id) do update set key = excluded.key;
create table if not exists public.site_key (
    id  int primary key default 1 check (id = 1),
    key text not null
);

create table if not exists public.claim_log (
    id       bigserial primary key,
    block_id text not null,
    action   text not null,
    names    text,
    phone    text,
    at       timestamptz not null default now()
);

alter table public.settings      enable row level security;
alter table public.blocks        enable row level security;
alter table public.claims        enable row level security;
alter table public.claim_secrets enable row level security;
alter table public.claim_log     enable row level security;
alter table public.house_done    enable row level security;
alter table public.join_requests enable row level security;
alter table public.site_key      enable row level security;

drop policy if exists "public read" on public.settings;
drop policy if exists "public read" on public.blocks;
drop policy if exists "public read" on public.claims;
create policy "public read" on public.settings for select to anon, authenticated using (true);
create policy "public read" on public.blocks   for select to anon, authenticated using (true);
create policy "public read" on public.claims   for select to anon, authenticated using (true);
drop policy if exists "public read" on public.house_done;
create policy "public read" on public.house_done for select to anon, authenticated using (true);
-- claim_secrets, claim_log and join_requests have no policies, so anon/authenticated can't touch them.

revoke insert, update, delete, truncate on public.settings, public.blocks, public.claims, public.house_done from anon, authenticated;
revoke all on public.claim_secrets, public.claim_log, public.join_requests, public.site_key from anon, authenticated;
revoke all on sequence public.claim_log_id_seq, public.join_requests_id_seq from anon, authenticated;

-- live updates for the map
do $$ begin
    alter publication supabase_realtime add table public.claims;
exception when duplicate_object then null;
end $$;
do $$ begin
    alter publication supabase_realtime add table public.house_done;
exception when duplicate_object then null;
end $$;

-- ---------- helpers ----------

create or replace function public._norm_phone(p text) returns text
language sql immutable set search_path = '' as $$
    select case
        when d ~ '^972' then '0' || substr(d, 4)
        else d
    end
    from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create or replace function public._hash(p text) returns text
language sql immutable set search_path = '' as $$
    select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

-- true when the caller holds the block's edit token or knows the phone it was claimed with
create or replace function public._can_edit(p_block_id text, p_token text, p_phone text) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.claim_secrets s
        where s.block_id = p_block_id
          and ((p_token is not null and s.token_hash = public._hash(p_token))
               or (nullif(public._norm_phone(p_phone), '') is not null and s.phone = public._norm_phone(p_phone)))
    )
$$;

-- true when the request carries the site key (header x-site-key, sent by the map after the password gate)
create or replace function public._site_key_ok() returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.site_key
                   where id = 1 and key = current_setting('request.headers', true)::json ->> 'x-site-key')
$$;

create or replace function public._is_live() returns boolean
language sql stable set search_path = '' as $$
    select now() >= live_from and now() < live_until from public.settings where id = 1
$$;

-- ---------- API (called from the browser via supabase.rpc) ----------

create or replace function public.claim_block(p_block_id text, p_names text, p_phone text, p_slots text[])
returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_names text := btrim(regexp_replace(coalesce(p_names, ''), '\s+', ' ', 'g'));
    v_phone text := public._norm_phone(p_phone);
    v_token text;
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not exists (select 1 from public.blocks where id = p_block_id) then
        raise exception 'no_such_block';
    end if;
    if char_length(v_names) < 2 or char_length(v_names) > 80 then
        raise exception 'bad_names';
    end if;
    if v_phone !~ '^0(5\d{8}|[2-9]\d{7})$' then
        raise exception 'bad_phone';
    end if;
    if p_slots is null or cardinality(p_slots) = 0
       or not (p_slots <@ array['10-12', '12-14', '14-16', '16-18']) then
        raise exception 'bad_slots';
    end if;
    -- light rate limits
    if (select count(*) from public.claim_secrets where phone = v_phone) >= 5 then
        raise exception 'too_many_for_phone';
    end if;
    if (select count(*) from public.claim_log where action = 'claim' and at > now() - interval '1 minute') >= 30 then
        raise exception 'busy';
    end if;

    insert into public.claims (block_id, names, slots)
    values (p_block_id, v_names, (select array_agg(s order by s) from unnest(p_slots) s))
    on conflict (block_id) do nothing;
    if not found then
        raise exception 'already_claimed';
    end if;

    v_token := encode(extensions.gen_random_bytes(18), 'hex');
    insert into public.claim_secrets (block_id, phone, token_hash) values (p_block_id, v_phone, public._hash(v_token));
    insert into public.claim_log (block_id, action, names, phone) values (p_block_id, 'claim', v_names, v_phone);
    return v_token;
end $$;

create or replace function public.start_round(p_block_id text, p_token text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not public._is_live() then raise exception 'not_live'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    update public.claims set status = 'in_progress', started_at = now()
    where block_id = p_block_id and status = 'claimed';
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'start');
end $$;

create or replace function public.mark_done(p_block_id text, p_token text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not public._is_live() then raise exception 'not_live'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    update public.claims set status = 'done', done_at = now(), started_at = coalesce(started_at, now())
    where block_id = p_block_id and status in ('claimed', 'in_progress');
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'done');
end $$;

-- mark one address of the block done (p_done) or not done. Starts the round if needed, and completes
-- the block once every address is done. Returns the block's status afterwards.
create or replace function public.mark_house(p_block_id text, p_house_id text, p_done boolean,
                                             p_token text default null, p_phone text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_status text;
    v_entrances int;
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not public._is_live() then raise exception 'not_live'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    select entrances into v_entrances from public.blocks where id = p_block_id;
    if coalesce(p_house_id, '') !~ ('^' || p_block_id || '-[0-9]{1,3}$') then
        raise exception 'no_such_house';
    end if;
    if split_part(p_house_id, '-', 2)::int not between 1 and v_entrances then
        raise exception 'no_such_house';
    end if;
    select status into v_status from public.claims where block_id = p_block_id for update;
    if v_status is distinct from 'claimed' and v_status is distinct from 'in_progress' then
        raise exception 'bad_status';
    end if;
    if p_done then
        insert into public.house_done (house_id, block_id) values (p_house_id, p_block_id) on conflict do nothing;
    else
        delete from public.house_done where house_id = p_house_id;
    end if;
    insert into public.claim_log (block_id, action)
    values (p_block_id, case when p_done then 'house ' else 'unhouse ' end || p_house_id);
    if (select count(*) from public.house_done where block_id = p_block_id) >= v_entrances then
        update public.claims set status = 'done', done_at = now(), started_at = coalesce(started_at, now())
        where block_id = p_block_id;
        insert into public.claim_log (block_id, action) values (p_block_id, 'done');
        return 'done';
    end if;
    if v_status = 'claimed' then
        update public.claims set status = 'in_progress', started_at = now() where block_id = p_block_id;
        insert into public.claim_log (block_id, action) values (p_block_id, 'start');
    end if;
    return 'in_progress';
end $$;

-- undo an accidental "done"
create or replace function public.reopen_round(p_block_id text, p_token text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    update public.claims set status = 'in_progress', done_at = null
    where block_id = p_block_id and status = 'done';
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'reopen');
end $$;

create or replace function public.release_block(p_block_id text, p_token text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    delete from public.claims where block_id = p_block_id and status <> 'done';
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'release');
end $$;

-- ask to join a block someone already claimed; only moderators see the request
create or replace function public.request_join(p_block_id text, p_names text, p_phone text, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_names text := btrim(regexp_replace(coalesce(p_names, ''), '\s+', ' ', 'g'));
    v_phone text := public._norm_phone(p_phone);
    v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
    if not public._site_key_ok() then raise exception 'bad_site_key'; end if;
    if not exists (select 1 from public.claims where block_id = p_block_id) then
        raise exception 'not_claimed';
    end if;
    if char_length(v_names) < 2 or char_length(v_names) > 80 then
        raise exception 'bad_names';
    end if;
    if v_phone !~ '^0(5\d{8}|[2-9]\d{7})$' then
        raise exception 'bad_phone';
    end if;
    if char_length(v_note) > 300 then
        raise exception 'bad_note';
    end if;
    if exists (select 1 from public.claim_secrets where block_id = p_block_id and phone = v_phone) then
        raise exception 'own_block';
    end if;
    if exists (select 1 from public.join_requests where block_id = p_block_id and phone = v_phone and handled_at is null) then
        raise exception 'already_requested';
    end if;
    if (select count(*) from public.join_requests where phone = v_phone and handled_at is null) >= 5
       or (select count(*) from public.join_requests where created_at > now() - interval '1 minute') >= 30 then
        raise exception 'busy';
    end if;
    insert into public.join_requests (block_id, names, phone, note) values (p_block_id, v_names, v_phone, v_note);
    insert into public.claim_log (block_id, action, names, phone) values (p_block_id, 'join_request', v_names, v_phone);
end $$;

-- blocks claimed with this phone (to manage them from another device)
create or replace function public.my_blocks(p_phone text)
returns setof text
language sql stable security definer set search_path = '' as $$
    select block_id from public.claim_secrets
    where phone = public._norm_phone(p_phone) and public._norm_phone(p_phone) <> ''
      and public._site_key_ok()
$$;

revoke all on function public._norm_phone(text), public._hash(text), public._can_edit(text, text, text), public._is_live(),
    public._site_key_ok()
    from public, anon, authenticated;
revoke all on function public.claim_block(text, text, text, text[]), public.start_round(text, text, text),
    public.mark_done(text, text, text), public.mark_house(text, text, boolean, text, text),
    public.reopen_round(text, text, text), public.release_block(text, text, text),
    public.request_join(text, text, text, text), public.my_blocks(text) from public;
grant execute on function public.claim_block(text, text, text, text[]), public.start_round(text, text, text),
    public.mark_done(text, text, text), public.mark_house(text, text, boolean, text, text),
    public.reopen_round(text, text, text), public.release_block(text, text, text),
    public.request_join(text, text, text, text), public.my_blocks(text) to anon, authenticated;
