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
    apartments int  not null
);

create table if not exists public.claims (
    block_id   text primary key references public.blocks (id) on delete cascade,
    names      text not null,
    slots      text[] not null,
    status     text not null default 'claimed' check (status in ('claimed', 'in_progress', 'done')),
    claimed_at timestamptz not null default now(),
    started_at timestamptz,
    done_at    timestamptz
);

-- private: never readable with the publishable key
create table if not exists public.claim_secrets (
    block_id   text primary key references public.claims (block_id) on delete cascade,
    phone      text not null,
    token_hash text not null
);
create index if not exists claim_secrets_phone on public.claim_secrets (phone);

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

drop policy if exists "public read" on public.settings;
drop policy if exists "public read" on public.blocks;
drop policy if exists "public read" on public.claims;
create policy "public read" on public.settings for select to anon, authenticated using (true);
create policy "public read" on public.blocks   for select to anon, authenticated using (true);
create policy "public read" on public.claims   for select to anon, authenticated using (true);
-- claim_secrets and claim_log have no policies, so anon/authenticated can't touch them.

revoke insert, update, delete, truncate on public.settings, public.blocks, public.claims from anon, authenticated;
revoke all on public.claim_secrets, public.claim_log from anon, authenticated;
revoke all on sequence public.claim_log_id_seq from anon, authenticated;

-- live updates for the map
do $$ begin
    alter publication supabase_realtime add table public.claims;
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
       or not (p_slots <@ array['09-11', '11-13', '13-15', '15-17']) then
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
    if not public._is_live() then raise exception 'not_live'; end if;
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    update public.claims set status = 'done', done_at = now(), started_at = coalesce(started_at, now())
    where block_id = p_block_id and status in ('claimed', 'in_progress');
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'done');
end $$;

-- undo an accidental "done"
create or replace function public.reopen_round(p_block_id text, p_token text default null, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
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
    if not public._can_edit(p_block_id, p_token, p_phone) then raise exception 'not_allowed'; end if;
    delete from public.claims where block_id = p_block_id and status <> 'done';
    if not found then raise exception 'bad_status'; end if;
    insert into public.claim_log (block_id, action) values (p_block_id, 'release');
end $$;

-- blocks claimed with this phone (to manage them from another device)
create or replace function public.my_blocks(p_phone text)
returns setof text
language sql stable security definer set search_path = '' as $$
    select block_id from public.claim_secrets
    where phone = public._norm_phone(p_phone) and public._norm_phone(p_phone) <> ''
$$;

revoke all on function public._norm_phone(text), public._hash(text), public._can_edit(text, text, text), public._is_live()
    from public, anon, authenticated;
revoke all on function public.claim_block(text, text, text, text[]), public.start_round(text, text, text),
    public.mark_done(text, text, text), public.reopen_round(text, text, text), public.release_block(text, text, text),
    public.my_blocks(text) from public;
grant execute on function public.claim_block(text, text, text, text[]), public.start_round(text, text, text),
    public.mark_done(text, text, text), public.reopen_round(text, text, text), public.release_block(text, text, text),
    public.my_blocks(text) to anon, authenticated;
