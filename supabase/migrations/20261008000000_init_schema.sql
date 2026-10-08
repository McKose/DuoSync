-- =============================================================================
-- DuoSync — initial schema
-- Strict 1-to-1 isolation: every couple-scoped row is guarded by
-- public.is_couple_member(couple_id). All state transitions that carry
-- business rules (pairing, filing a case, defense, cooling-off cancel,
-- checklist merge, presence) go through SECURITY DEFINER RPCs; clients get
-- SELECT through RLS and only the narrow direct writes listed explicitly.
-- =============================================================================

-- gen_random_uuid() is core since PG13 — no uuid-ossp needed.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.case_status as enum ('AWAITING_DEFENSE', 'DELIBERATING', 'JUDGED', 'APPEALED');
create type public.message_status as enum ('PENDING', 'SENT', 'CANCELLED');
create type public.partner_status as enum ('NORMAL', 'BUSY', 'LOW_BATTERY', 'FRAGILE');

-- -----------------------------------------------------------------------------
-- 1. Profiles (extends auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
    id           uuid primary key references auth.users (id) on delete cascade,
    display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
    avatar_url   text check (avatar_url is null or char_length(avatar_url) <= 500),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- Push tokens live in their own table: a partner may read your profile,
-- but must never be able to read your device token (anyone holding an Expo
-- push token can push to that device).
create table public.push_tokens (
    user_id    uuid primary key references public.profiles (id) on delete cascade,
    token      text not null check (char_length(token) between 10 and 300),
    platform   text not null check (platform in ('ios', 'android')),
    updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. Couples (strict 1-to-1)
-- -----------------------------------------------------------------------------
create table public.couples (
    id                      uuid primary key default gen_random_uuid(),
    user_a_id               uuid not null references public.profiles (id) on delete cascade,
    -- CASCADE (not SET NULL): if either partner deletes their account the
    -- couple — and all shared data — is dissolved. SET NULL would leave an
    -- "active" couple with one member, which breaks the 1-to-1 invariant.
    user_b_id               uuid references public.profiles (id) on delete cascade,
    pairing_code            varchar(6) unique,
    pairing_code_expires_at timestamptz,
    is_active               boolean not null default false,
    user_a_battery          smallint check (user_a_battery between 0 and 100),
    user_b_battery          smallint check (user_b_battery between 0 and 100),
    user_a_status           public.partner_status not null default 'NORMAL',
    user_b_status           public.partner_status not null default 'NORMAL',
    user_a_seen_at          timestamptz,
    user_b_seen_at          timestamptz,
    created_at              timestamptz not null default now(),
    paired_at               timestamptz,
    constraint single_partner_constraint unique (user_a_id, user_b_id),
    constraint distinct_partners check (user_b_id is null or user_a_id <> user_b_id),
    constraint active_requires_partner check (not is_active or user_b_id is not null),
    constraint code_format check (pairing_code is null or pairing_code ~ '^[A-HJ-NP-Z2-9]{6}$')
);

-- A user may appear in at most one couple, in either column.
create unique index couples_user_a_uniq on public.couples (user_a_id);
create unique index couples_user_b_uniq on public.couples (user_b_id) where user_b_id is not null;

create or replace function public.tg_enforce_single_couple()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if exists (
        select 1 from public.couples c
        where c.id <> new.id
          and (c.user_a_id in (new.user_a_id, new.user_b_id)
               or c.user_b_id in (new.user_a_id, new.user_b_id))
    ) then
        raise exception 'ALREADY_PAIRED' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

create trigger couples_single_membership
    before insert or update of user_a_id, user_b_id on public.couples
    for each row execute function public.tg_enforce_single_couple();

-- Failed pairing attempts, for brute-force throttling.
create table public.pairing_attempts (
    id           bigint generated always as identity primary key,
    user_id      uuid not null references public.profiles (id) on delete cascade,
    attempted_at timestamptz not null default now()
);
create index pairing_attempts_user_time on public.pairing_attempts (user_id, attempted_at desc);

-- -----------------------------------------------------------------------------
-- 3. Court cases
-- -----------------------------------------------------------------------------
create table public.court_cases (
    id                      uuid primary key default gen_random_uuid(),
    couple_id               uuid not null references public.couples (id) on delete cascade,
    prosecutor_id           uuid not null references public.profiles (id) on delete cascade,
    defendant_id            uuid not null references public.profiles (id) on delete cascade,
    title                   varchar(120) not null check (char_length(btrim(title)) >= 3),
    category                text not null check (category in ('CHORES', 'PLANS', 'COMMUNICATION', 'MONEY', 'FAMILY', 'OTHER')),
    prosecutor_plea         text not null check (char_length(btrim(prosecutor_plea)) between 10 and 4000),
    defendant_plea          text check (defendant_plea is null or char_length(btrim(defendant_plea)) between 1 and 4000),
    defense_timed_out       boolean not null default false,
    status                  public.case_status not null default 'AWAITING_DEFENSE',
    verdict_judge           text,
    verdict_comedian        text,
    penalty                 text,
    fault_ratio_prosecutor  int check (fault_ratio_prosecutor between 0 and 100),
    fault_ratio_defendant   int check (fault_ratio_defendant between 0 and 100),
    defense_deadline        timestamptz not null default (now() + interval '24 hours'),
    defense_submitted_at    timestamptz,
    deliberation_started_at timestamptz,
    verdict_attempts        int not null default 0,
    last_error              text,
    created_at              timestamptz not null default now(),
    judged_at               timestamptz,
    constraint distinct_parties check (prosecutor_id <> defendant_id),
    constraint fault_sum_100 check (
        (fault_ratio_prosecutor is null and fault_ratio_defendant is null)
        or (fault_ratio_prosecutor + fault_ratio_defendant = 100)
    ),
    constraint judged_is_complete check (
        status <> 'JUDGED' or (
            verdict_judge is not null and verdict_comedian is not null and penalty is not null
            and fault_ratio_prosecutor is not null and judged_at is not null
            and defendant_plea is not null
        )
    )
);
create index court_cases_couple_created on public.court_cases (couple_id, created_at desc);
create index court_cases_claimable on public.court_cases (status, defense_deadline)
    where status in ('AWAITING_DEFENSE', 'DELIBERATING');

-- -----------------------------------------------------------------------------
-- 4. Delayed messages (cooling-off room)
-- -----------------------------------------------------------------------------
create table public.delayed_messages (
    id            uuid primary key default gen_random_uuid(),
    couple_id     uuid not null references public.couples (id) on delete cascade,
    sender_id     uuid not null references public.profiles (id) on delete cascade,
    recipient_id  uuid not null references public.profiles (id) on delete cascade,
    content       text not null check (char_length(btrim(content)) between 1 and 2000),
    delay_minutes smallint not null check (delay_minutes between 15 and 60),
    release_at    timestamptz not null,
    status        public.message_status not null default 'PENDING',
    sent_at       timestamptz,
    cancelled_at  timestamptz,
    created_at    timestamptz not null default now(),
    constraint distinct_ends check (sender_id <> recipient_id),
    constraint release_after_create check (release_at > created_at)
);
create index delayed_messages_due on public.delayed_messages (release_at) where status = 'PENDING';
create index delayed_messages_couple on public.delayed_messages (couple_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 5. Pending questions vault
-- -----------------------------------------------------------------------------
create table public.pending_questions (
    id            uuid primary key default gen_random_uuid(),
    couple_id     uuid not null references public.couples (id) on delete cascade,
    asker_id      uuid not null references public.profiles (id) on delete cascade,
    question_text text not null check (char_length(btrim(question_text)) between 1 and 1000),
    answer_text   text check (answer_text is null or char_length(btrim(answer_text)) between 1 and 2000),
    is_answered   boolean not null default false,
    answered_at   timestamptz,
    created_at    timestamptz not null default now(),
    constraint answered_consistency check (is_answered = (answer_text is not null))
);
create index pending_questions_couple on public.pending_questions (couple_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 6. Shared agenda & plans
-- checklist item shape:
--   {"id": uuid, "text": string, "done": bool, "updated_at": iso8601, "deleted": bool}
-- Merge is per-item last-write-wins on updated_at (see upsert_checklist_item).
-- -----------------------------------------------------------------------------
create table public.plans (
    id         uuid primary key default gen_random_uuid(),
    couple_id  uuid not null references public.couples (id) on delete cascade,
    created_by uuid references public.profiles (id) on delete set null,
    title      text not null check (char_length(btrim(title)) between 1 and 120),
    location   text check (location is null or char_length(location) <= 200),
    plan_date  timestamptz,
    checklist  jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index plans_couple_date on public.plans (couple_id, plan_date);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
    for each row execute function public.tg_touch_updated_at();
create trigger plans_touch before update on public.plans
    for each row execute function public.tg_touch_updated_at();

-- -----------------------------------------------------------------------------
-- Profile bootstrap on sign-up
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, display_name)
    values (
        new.id,
        left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                      split_part(coalesce(new.email, 'partner'), '@', 1)), 40)
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- =============================================================================
-- Membership helpers
-- SECURITY DEFINER so they can read couples without recursing into RLS.
-- search_path pinned to '' to prevent search_path hijacking.
-- =============================================================================
create or replace function public.is_couple_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.couples c
        where c.id = cid
          and c.is_active
          and (c.user_a_id = (select auth.uid()) or c.user_b_id = (select auth.uid()))
    );
$$;

create or replace function public.my_active_couple()
returns public.couples
language sql
stable
security definer
set search_path = ''
as $$
    select c.* from public.couples c
    where c.is_active
      and (c.user_a_id = (select auth.uid()) or c.user_b_id = (select auth.uid()))
    limit 1;
$$;

create or replace function public.is_my_partner(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.couples c
        where c.is_active
          and ((c.user_a_id = (select auth.uid()) and c.user_b_id = pid)
            or (c.user_b_id = (select auth.uid()) and c.user_a_id = pid))
    );
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.profiles          enable row level security;
alter table public.push_tokens       enable row level security;
alter table public.couples           enable row level security;
alter table public.pairing_attempts  enable row level security;
alter table public.court_cases       enable row level security;
alter table public.delayed_messages  enable row level security;
alter table public.pending_questions enable row level security;
alter table public.plans             enable row level security;

-- profiles: self + active partner can read; only self can update.
create policy "profiles_select_self_or_partner" on public.profiles
    for select to authenticated
    using (id = (select auth.uid()) or public.is_my_partner(id));
create policy "profiles_update_self" on public.profiles
    for update to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

-- push_tokens: strictly own row.
create policy "push_tokens_own" on public.push_tokens
    for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- couples: members (pending or active) can read their own row. No direct writes.
create policy "couples_select_member" on public.couples
    for select to authenticated
    using (user_a_id = (select auth.uid()) or user_b_id = (select auth.uid()));

-- pairing_attempts: no client access at all (RLS on, no policy).

-- court_cases: read-only for members. Writes via file_case / submit_defense RPCs;
-- verdict fields only via service_role (Edge Function).
create policy "Couple members can view cases" on public.court_cases
    for select to authenticated
    using (public.is_couple_member(couple_id));

-- delayed_messages: the sender sees all of their own messages; the recipient
-- sees ONLY released (SENT) messages. PENDING and CANCELLED rows are invisible
-- to the recipient — this is what makes cancellation silent, including over
-- Realtime (postgres_changes applies SELECT RLS per subscriber).
create policy "delayed_sender_reads_own" on public.delayed_messages
    for select to authenticated
    using (sender_id = (select auth.uid()) and public.is_couple_member(couple_id));
create policy "delayed_recipient_reads_sent" on public.delayed_messages
    for select to authenticated
    using (recipient_id = (select auth.uid()) and status = 'SENT' and public.is_couple_member(couple_id));

-- pending_questions: members read; asker may delete own unanswered question.
create policy "questions_select_member" on public.pending_questions
    for select to authenticated
    using (public.is_couple_member(couple_id));
create policy "questions_delete_own_unanswered" on public.pending_questions
    for delete to authenticated
    using (asker_id = (select auth.uid()) and not is_answered and public.is_couple_member(couple_id));

-- plans: both partners have equal rights.
create policy "plans_select_member" on public.plans
    for select to authenticated
    using (public.is_couple_member(couple_id));
create policy "plans_insert_member" on public.plans
    for insert to authenticated
    with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "plans_update_member" on public.plans
    for update to authenticated
    using (public.is_couple_member(couple_id))
    with check (public.is_couple_member(couple_id));
create policy "plans_delete_member" on public.plans
    for delete to authenticated
    using (public.is_couple_member(couple_id));

-- =============================================================================
-- Table privileges (defense in depth on top of RLS)
-- Supabase grants ALL to anon/authenticated by default; narrow it.
-- =============================================================================
revoke all on all tables in schema public from anon;

revoke insert, update, delete on public.couples           from authenticated;
revoke insert, update, delete on public.court_cases       from authenticated;
revoke insert, update, delete on public.delayed_messages  from authenticated;
revoke insert, update         on public.pending_questions from authenticated;
revoke all                    on public.pairing_attempts  from authenticated;
revoke insert, delete         on public.profiles          from authenticated;
revoke update                 on public.profiles          from authenticated;
grant  update (display_name, avatar_url) on public.profiles to authenticated;
-- plans: checklist is only mutable through upsert_checklist_item (atomic merge).
revoke update on public.plans from authenticated;
grant  update (title, location, plan_date) on public.plans to authenticated;

-- =============================================================================
-- RPC: pairing
-- =============================================================================
create or replace function public.generate_pairing_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
    -- 32 symbols, no 0/O/1/I. 256 % 32 = 0, so byte % 32 is unbiased.
    alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    raw bytea := uuid_send(gen_random_uuid());
    code text := '';
    i int;
begin
    for i in 0..5 loop
        code := code || substr(alphabet, (get_byte(raw, i) % 32) + 1, 1);
    end loop;
    return code;
end;
$$;

create or replace function public.create_pairing_code()
returns public.couples
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_row public.couples;
    v_try int := 0;
begin
    if v_uid is null then
        raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

    if exists (select 1 from public.couples c
               where c.is_active and (c.user_a_id = v_uid or c.user_b_id = v_uid)) then
        raise exception 'ALREADY_PAIRED' using errcode = 'P0001';
    end if;

    loop
        v_try := v_try + 1;
        begin
            -- Explicit UPDATE-then-INSERT rather than ON CONFLICT: the BEFORE
            -- INSERT single-membership trigger fires on the proposed row even
            -- when the conflict path is taken, and would reject the refresh.
            update public.couples c
            set pairing_code = public.generate_pairing_code(),
                pairing_code_expires_at = now() + interval '24 hours'
            where c.user_a_id = v_uid and not c.is_active
            returning * into v_row;

            if not found then
                -- A user who is still listed as someone's pending user_b
                -- cannot exist (user_b is only set on activation), so the
                -- membership trigger only guards true double-pairing here.
                insert into public.couples (user_a_id, pairing_code, pairing_code_expires_at)
                values (v_uid, public.generate_pairing_code(), now() + interval '24 hours')
                returning * into v_row;
            end if;
            return v_row;
        exception when unique_violation then
            -- pairing_code collision (p ≈ n / 32^6); retry with a fresh code.
            if v_try >= 5 then
                raise exception 'CODE_GENERATION_FAILED' using errcode = 'P0001';
            end if;
        end;
    end loop;
end;
$$;

create or replace function public.pair_with_code(p_code text)
returns setof public.couples
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_code text := upper(btrim(coalesce(p_code, '')));
    v_row public.couples;
    v_failures int;
begin
    if v_uid is null then
        raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

    select count(*) into v_failures
    from public.pairing_attempts a
    where a.user_id = v_uid and a.attempted_at > now() - interval '1 hour';
    if v_failures >= 10 then
        raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;

    if exists (select 1 from public.couples c
               where c.is_active and (c.user_a_id = v_uid or c.user_b_id = v_uid)) then
        raise exception 'ALREADY_PAIRED' using errcode = 'P0001';
    end if;

    select * into v_row
    from public.couples c
    where c.pairing_code = v_code
      and not c.is_active
      and c.pairing_code_expires_at > now()
      and c.user_a_id <> v_uid
    for update;

    if not found then
        -- A failed attempt must persist even though we raise: the exception
        -- would roll it back, so return a sentinel instead of raising here.
        insert into public.pairing_attempts (user_id) values (v_uid);
        return; -- empty set => INVALID_CODE on the client
    end if;

    -- Lock the inviter too, so they can't pair elsewhere concurrently.
    perform pg_advisory_xact_lock(hashtextextended(v_row.user_a_id::text, 0));

    -- Joining someone else's code discards my own pending invite, if any.
    delete from public.couples c where c.user_a_id = v_uid and not c.is_active;

    update public.couples c
    set user_b_id = v_uid,
        is_active = true,
        pairing_code = null,
        pairing_code_expires_at = null,
        paired_at = now()
    where c.id = v_row.id
    returning * into v_row;

    return next v_row;
end;
$$;

-- =============================================================================
-- RPC: presence / battery (passive sync)
-- =============================================================================
create or replace function public.update_my_presence(
    p_battery smallint default null,
    p_status public.partner_status default null
)
returns public.couples
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_row public.couples;
    v_is_a boolean;
    v_current public.partner_status;
    v_next public.partner_status;
    v_battery smallint := case when p_battery between 0 and 100 then p_battery else null end;
begin
    select * into v_row from public.couples c
    where c.is_active and (c.user_a_id = v_uid or c.user_b_id = v_uid)
    for update;
    if not found then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;

    v_is_a := (v_row.user_a_id = v_uid);
    v_current := case when v_is_a then v_row.user_a_status else v_row.user_b_status end;
    v_next := coalesce(p_status, v_current);

    -- Automatic LOW_BATTERY only overrides NORMAL; never a manual BUSY/FRAGILE.
    if p_status is null then
        if v_battery is not null and v_battery <= 15 and v_next = 'NORMAL' then
            v_next := 'LOW_BATTERY';
        elsif (v_battery is null or v_battery > 15) and v_next = 'LOW_BATTERY' then
            v_next := 'NORMAL';
        end if;
    end if;

    if v_is_a then
        update public.couples c
        set user_a_battery = coalesce(v_battery, c.user_a_battery),
            user_a_status  = v_next,
            user_a_seen_at = now()
        where c.id = v_row.id
        returning * into v_row;
    else
        update public.couples c
        set user_b_battery = coalesce(v_battery, c.user_b_battery),
            user_b_status  = v_next,
            user_b_seen_at = now()
        where c.id = v_row.id
        returning * into v_row;
    end if;
    return v_row;
end;
$$;

-- =============================================================================
-- RPC: court
-- =============================================================================
create or replace function public.file_case(p_title text, p_category text, p_plea text)
returns public.court_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_couple public.couples;
    v_row public.court_cases;
    v_today int;
begin
    select * into v_couple from public.couples c
    where c.is_active and (c.user_a_id = v_uid or c.user_b_id = v_uid);
    if not found or not public.is_couple_member(v_couple.id) then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;

    -- Cost / abuse cap: each filing costs one LLM call.
    select count(*) into v_today from public.court_cases cc
    where cc.prosecutor_id = v_uid and cc.created_at > now() - interval '24 hours';
    if v_today >= 5 then
        raise exception 'DAILY_CASE_LIMIT' using errcode = 'P0001';
    end if;

    insert into public.court_cases (couple_id, prosecutor_id, defendant_id, title, category, prosecutor_plea)
    values (
        v_couple.id,
        v_uid,
        case when v_couple.user_a_id = v_uid then v_couple.user_b_id else v_couple.user_a_id end,
        btrim(p_title),
        p_category,
        btrim(p_plea)
    )
    returning * into v_row;
    return v_row;
end;
$$;

create or replace function public.submit_defense(p_case_id uuid, p_plea text)
returns public.court_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_row public.court_cases;
begin
    select * into v_row from public.court_cases cc where cc.id = p_case_id for update;
    if not found or not public.is_couple_member(v_row.couple_id) then
        raise exception 'CASE_NOT_FOUND' using errcode = 'P0001';
    end if;
    if v_row.defendant_id <> v_uid then
        raise exception 'NOT_DEFENDANT' using errcode = 'P0001';
    end if;
    if v_row.status <> 'AWAITING_DEFENSE' or v_row.defendant_plea is not null then
        raise exception 'DEFENSE_CLOSED' using errcode = 'P0001';
    end if;
    if now() >= v_row.defense_deadline then
        raise exception 'DEFENSE_DEADLINE_PASSED' using errcode = 'P0001';
    end if;

    update public.court_cases cc
    set defendant_plea = btrim(p_plea),
        defense_submitted_at = now()
    where cc.id = p_case_id
    returning * into v_row;
    return v_row;
end;
$$;

-- ---- service_role only (Edge Function) ----

-- Atomically claims a case for LLM judgement. Returns NULL when the defense
-- lock is still engaged or another worker already holds the case. This is the
-- single gate that enforces "never call the LLM before defense or 24h timeout".
create or replace function public.claim_case_for_verdict(p_case_id uuid)
returns setof public.court_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.court_cases;
begin
    select * into v_row from public.court_cases cc where cc.id = p_case_id for update;
    if not found or v_row.verdict_attempts >= 5 then
        return;
    end if;

    if v_row.status = 'AWAITING_DEFENSE' then
        if v_row.defendant_plea is null then
            if now() < v_row.defense_deadline then
                return; -- defense lock engaged
            end if;
            v_row.defendant_plea := 'Davalı süre aşımı sebebiyle savunma yapmaktan imtina etmiştir.';
            v_row.defense_timed_out := true;
        end if;
    elsif v_row.status = 'DELIBERATING' then
        -- Reclaim only if the previous worker died (stale > 5 min).
        if v_row.deliberation_started_at > now() - interval '5 minutes' then
            return;
        end if;
    else
        return;
    end if;

    update public.court_cases cc
    set status = 'DELIBERATING',
        defendant_plea = v_row.defendant_plea,
        defense_timed_out = v_row.defense_timed_out,
        deliberation_started_at = now(),
        verdict_attempts = cc.verdict_attempts + 1,
        last_error = null
    where cc.id = p_case_id
    returning * into v_row;
    return next v_row;
end;
$$;

create or replace function public.complete_verdict(
    p_case_id uuid,
    p_verdict_judge text,
    p_verdict_comedian text,
    p_fault_prosecutor int,
    p_fault_defendant int,
    p_penalty text
)
returns setof public.court_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.court_cases;
begin
    update public.court_cases cc
    set verdict_judge = p_verdict_judge,
        verdict_comedian = p_verdict_comedian,
        fault_ratio_prosecutor = p_fault_prosecutor,
        fault_ratio_defendant = p_fault_defendant,
        penalty = p_penalty,
        status = 'JUDGED',
        judged_at = now(),
        last_error = null
    where cc.id = p_case_id and cc.status = 'DELIBERATING'
    returning * into v_row;
    if found then
        return next v_row;
    end if; -- empty set if someone else finished first
end;
$$;

create or replace function public.fail_verdict(p_case_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Back to AWAITING_DEFENSE with the plea kept, so the sweep retries.
    update public.court_cases cc
    set status = 'AWAITING_DEFENSE',
        deliberation_started_at = null,
        last_error = left(p_error, 500)
    where cc.id = p_case_id and cc.status = 'DELIBERATING';
end;
$$;

create or replace function public.list_claimable_cases(p_limit int default 20)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
    select cc.id from public.court_cases cc
    where cc.verdict_attempts < 5
      and (
        (cc.status = 'AWAITING_DEFENSE' and (cc.defendant_plea is not null or cc.defense_deadline <= now()))
        or (cc.status = 'DELIBERATING' and cc.deliberation_started_at <= now() - interval '5 minutes')
      )
    order by cc.created_at
    limit greatest(1, least(p_limit, 100));
$$;

-- =============================================================================
-- RPC: cooling-off room
-- =============================================================================
create or replace function public.schedule_delayed_message(p_content text, p_delay_minutes int)
returns public.delayed_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_couple public.couples;
    v_row public.delayed_messages;
begin
    select * into v_couple from public.couples c
    where c.is_active and (c.user_a_id = v_uid or c.user_b_id = v_uid);
    if not found then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    if p_delay_minutes is null or p_delay_minutes not between 15 and 60 then
        raise exception 'INVALID_DELAY' using errcode = 'P0001';
    end if;

    insert into public.delayed_messages (couple_id, sender_id, recipient_id, content, delay_minutes, release_at)
    values (
        v_couple.id, v_uid,
        case when v_couple.user_a_id = v_uid then v_couple.user_b_id else v_couple.user_a_id end,
        btrim(p_content), p_delay_minutes,
        now() + make_interval(mins => p_delay_minutes)
    )
    returning * into v_row;
    return v_row;
end;
$$;

-- Silent cancellation: status -> CANCELLED. The recipient never had SELECT
-- access to this row (PENDING), and still doesn't (CANCELLED), so neither a
-- query nor a Realtime event can reveal it. No push trigger fires on CANCELLED.
create or replace function public.cancel_delayed_message(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_count int;
begin
    update public.delayed_messages m
    set status = 'CANCELLED', cancelled_at = now()
    where m.id = p_message_id
      and m.sender_id = auth.uid()
      and m.status = 'PENDING'
      and m.release_at > now()
      and public.is_couple_member(m.couple_id);
    get diagnostics v_count = row_count;
    return v_count = 1; -- false: already released / not yours / not found
end;
$$;

-- Called every minute by pg_cron (service context).
create or replace function public.release_due_messages()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_count int;
begin
    update public.delayed_messages m
    set status = 'SENT', sent_at = now()
    where m.status = 'PENDING' and m.release_at <= now();
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- =============================================================================
-- RPC: questions vault
-- =============================================================================
create or replace function public.ask_question(p_text text)
returns public.pending_questions
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_couple public.couples := public.my_active_couple();
    v_row public.pending_questions;
begin
    if v_couple.id is null then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    insert into public.pending_questions (couple_id, asker_id, question_text)
    values (v_couple.id, auth.uid(), btrim(p_text))
    returning * into v_row;
    return v_row;
end;
$$;

create or replace function public.answer_question(p_question_id uuid, p_answer text)
returns public.pending_questions
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.pending_questions;
begin
    select * into v_row from public.pending_questions q where q.id = p_question_id for update;
    if not found or not public.is_couple_member(v_row.couple_id) then
        raise exception 'QUESTION_NOT_FOUND' using errcode = 'P0001';
    end if;
    if v_row.asker_id = auth.uid() then
        raise exception 'CANNOT_ANSWER_OWN' using errcode = 'P0001';
    end if;
    if v_row.is_answered then
        raise exception 'ALREADY_ANSWERED' using errcode = 'P0001';
    end if;
    update public.pending_questions q
    set answer_text = btrim(p_answer), is_answered = true, answered_at = now()
    where q.id = p_question_id
    returning * into v_row;
    return v_row;
end;
$$;

-- =============================================================================
-- RPC: checklist per-item last-write-wins merge
-- =============================================================================
create or replace function public.upsert_checklist_item(p_plan_id uuid, p_item jsonb)
returns public.plans
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_plan public.plans;
    v_id text := p_item ->> 'id';
    v_text text := btrim(coalesce(p_item ->> 'text', ''));
    v_done boolean := coalesce((p_item ->> 'done')::boolean, false);
    v_deleted boolean := coalesce((p_item ->> 'deleted')::boolean, false);
    v_ts timestamptz;
    v_existing jsonb;
    v_item jsonb;
    v_list jsonb;
begin
    if v_id is null or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'INVALID_ITEM_ID' using errcode = 'P0001';
    end if;
    if char_length(v_text) not between 1 and 200 then
        raise exception 'INVALID_ITEM_TEXT' using errcode = 'P0001';
    end if;
    begin
        v_ts := (p_item ->> 'updated_at')::timestamptz;
    exception when others then
        raise exception 'INVALID_ITEM_TIMESTAMP' using errcode = 'P0001';
    end;
    -- Clock-skew guard: a device with a clock in the future would otherwise
    -- win every subsequent conflict.
    v_ts := least(coalesce(v_ts, now()), now() + interval '1 minute');

    select * into v_plan from public.plans p where p.id = p_plan_id for update;
    if not found or not public.is_couple_member(v_plan.couple_id) then
        raise exception 'PLAN_NOT_FOUND' using errcode = 'P0001';
    end if;

    select e into v_existing
    from jsonb_array_elements(v_plan.checklist) e
    where e ->> 'id' = v_id
    limit 1;

    if v_existing is not null and (v_existing ->> 'updated_at')::timestamptz > v_ts then
        return v_plan; -- stale write loses
    end if;

    v_item := jsonb_build_object(
        'id', lower(v_id), 'text', v_text, 'done', v_done,
        'deleted', v_deleted, 'updated_at', to_jsonb(v_ts)
    );

    select coalesce(jsonb_agg(
               case when e ->> 'id' = v_id then v_item else e end
               order by ord), '[]'::jsonb)
    into v_list
    from jsonb_array_elements(v_plan.checklist) with ordinality as t(e, ord)
    -- prune tombstones older than 30 days
    where not (coalesce((e ->> 'deleted')::boolean, false)
               and (e ->> 'updated_at')::timestamptz < now() - interval '30 days'
               and e ->> 'id' <> v_id);

    if v_existing is null then
        if (select count(*) from jsonb_array_elements(v_list) e
            where not coalesce((e ->> 'deleted')::boolean, false)) >= 100 then
            raise exception 'CHECKLIST_FULL' using errcode = 'P0001';
        end if;
        v_list := v_list || jsonb_build_array(v_item);
    end if;

    update public.plans p set checklist = v_list where p.id = p_plan_id
    returning * into v_plan;
    return v_plan;
end;
$$;

-- =============================================================================
-- Function privileges
-- Postgres grants EXECUTE to PUBLIC by default; Supabase additionally grants
-- to anon/authenticated. Lock everything down, then open what clients need.
-- =============================================================================
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_couple_member(uuid)                         to authenticated;
grant execute on function public.my_active_couple()                             to authenticated;
grant execute on function public.is_my_partner(uuid)                            to authenticated;
grant execute on function public.create_pairing_code()                          to authenticated;
grant execute on function public.pair_with_code(text)                           to authenticated;
grant execute on function public.update_my_presence(smallint, public.partner_status) to authenticated;
grant execute on function public.file_case(text, text, text)                    to authenticated;
grant execute on function public.submit_defense(uuid, text)                     to authenticated;
grant execute on function public.schedule_delayed_message(text, int)            to authenticated;
grant execute on function public.cancel_delayed_message(uuid)                   to authenticated;
grant execute on function public.ask_question(text)                             to authenticated;
grant execute on function public.answer_question(uuid, text)                    to authenticated;
grant execute on function public.upsert_checklist_item(uuid, jsonb)             to authenticated;

grant execute on function public.claim_case_for_verdict(uuid)                    to service_role;
grant execute on function public.complete_verdict(uuid, text, text, int, int, text) to service_role;
grant execute on function public.fail_verdict(uuid, text)                        to service_role;
grant execute on function public.list_claimable_cases(int)                       to service_role;
grant execute on function public.release_due_messages()                          to service_role;

-- Trigger functions must stay executable by the trigger owner only; they are
-- invoked by the executor, not by callers, so no grant is needed.

-- =============================================================================
-- Realtime
-- =============================================================================
alter publication supabase_realtime add table
    public.couples, public.court_cases, public.delayed_messages,
    public.pending_questions, public.plans;
