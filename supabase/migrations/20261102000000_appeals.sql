-- =============================================================================
-- DuoSync — appeals / istinaf (ROADMAP C3)
--
-- Rules (user, 2026-10-31/11-02):
--   * Either party may appeal a JUDGED case within 12 h of its latest verdict.
--   * At most 2 appeals per case (first instance + 2 appeal rounds).
--   * The other party may reply within 12 h; after that the panel decides
--     without a reply (same lock as the 24 h defense window).
--   * History is kept: court_cases keeps the first-instance verdict, every
--     round keeps its own; the latest judged round is the one that counts.
--
-- The LLM is reachable for an appeal only through claim_appeal_for_verdict(),
-- which returns an empty set until the respondent has replied or the reply
-- window has passed — the appeal twin of claim_case_for_verdict().
-- =============================================================================

create type public.appeal_status as enum ('AWAITING_REPLY', 'DELIBERATING', 'JUDGED');

-- Lets court_appeals reference (case, couple) together, so an appeal can never
-- point at a case of another couple.
alter table public.court_cases add constraint court_cases_id_couple_uniq unique (id, couple_id);

create table public.court_appeals (
    id                      uuid primary key default gen_random_uuid(),
    case_id                 uuid not null,
    couple_id               uuid not null references public.couples (id) on delete cascade,
    round                   smallint not null check (round between 1 and 2),
    appellant_id            uuid not null references public.profiles (id) on delete cascade,
    respondent_id           uuid not null references public.profiles (id) on delete cascade,
    appellant_reason        text not null check (char_length(btrim(appellant_reason)) between 10 and 2000),
    respondent_reply        text check (respondent_reply is null or char_length(btrim(respondent_reply)) between 1 and 2000),
    reply_timed_out         boolean not null default false,
    reply_deadline          timestamptz not null,
    replied_at              timestamptz,
    status                  public.appeal_status not null default 'AWAITING_REPLY',
    verdict_judge           text,
    verdict_comedian        text,
    penalty                 text,
    -- Same roles as the case (prosecutor/defendant), not appellant/respondent,
    -- so every round of one case reads on the same scale.
    fault_ratio_prosecutor  int check (fault_ratio_prosecutor between 0 and 100),
    fault_ratio_defendant   int check (fault_ratio_defendant between 0 and 100),
    deliberation_started_at timestamptz,
    verdict_attempts        int not null default 0,
    last_error              text,
    created_at              timestamptz not null default now(),
    judged_at               timestamptz,
    foreign key (case_id, couple_id) references public.court_cases (id, couple_id) on delete cascade,
    constraint appeal_round_uniq unique (case_id, round),
    constraint appeal_distinct_parties check (appellant_id <> respondent_id),
    constraint appeal_fault_sum_100 check (
        (fault_ratio_prosecutor is null and fault_ratio_defendant is null)
        or (fault_ratio_prosecutor + fault_ratio_defendant = 100)
    ),
    constraint appeal_judged_is_complete check (
        status <> 'JUDGED' or (
            verdict_judge is not null and verdict_comedian is not null and penalty is not null
            and fault_ratio_prosecutor is not null and judged_at is not null
            and respondent_reply is not null
        )
    )
);
create index court_appeals_couple_created on public.court_appeals (couple_id, created_at);
create index court_appeals_claimable on public.court_appeals (status, reply_deadline)
    where status in ('AWAITING_REPLY', 'DELIBERATING');

alter table public.court_appeals enable row level security;
create policy "court_appeals_select_member" on public.court_appeals
    for select to authenticated
    using (public.is_couple_member(couple_id));

revoke all on public.court_appeals from anon, authenticated;
grant select on public.court_appeals to authenticated;

-- -----------------------------------------------------------------------------
-- Client RPCs
-- -----------------------------------------------------------------------------
create or replace function public.file_appeal(p_case_id uuid, p_reason text)
returns public.court_appeals
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_case public.court_cases;
    v_rounds int;
    v_last_verdict timestamptz;
    v_row public.court_appeals;
begin
    -- Locking the case serialises two appeals filed at the same moment.
    select * into v_case from public.court_cases cc where cc.id = p_case_id for update;
    if not found or not public.is_couple_member(v_case.couple_id) then
        raise exception 'CASE_NOT_FOUND' using errcode = 'P0001';
    end if;
    if v_case.status = 'APPEALED' then
        raise exception 'APPEAL_PENDING' using errcode = 'P0001';
    end if;
    if v_case.status <> 'JUDGED' then
        raise exception 'APPEAL_NOT_ALLOWED' using errcode = 'P0001';
    end if;

    select count(*), max(a.judged_at) into v_rounds, v_last_verdict
    from public.court_appeals a where a.case_id = p_case_id;
    if v_rounds >= 2 then
        raise exception 'APPEAL_LIMIT_REACHED' using errcode = 'P0001';
    end if;
    if now() > coalesce(v_last_verdict, v_case.judged_at) + interval '12 hours' then
        raise exception 'APPEAL_WINDOW_CLOSED' using errcode = 'P0001';
    end if;

    insert into public.court_appeals (
        case_id, couple_id, round, appellant_id, respondent_id, appellant_reason, reply_deadline
    ) values (
        v_case.id, v_case.couple_id, v_rounds + 1, v_uid,
        case when v_case.prosecutor_id = v_uid then v_case.defendant_id else v_case.prosecutor_id end,
        btrim(p_reason), now() + interval '12 hours'
    )
    returning * into v_row;

    update public.court_cases cc set status = 'APPEALED' where cc.id = v_case.id;
    return v_row;
end;
$$;

create or replace function public.reply_appeal(p_appeal_id uuid, p_reply text)
returns public.court_appeals
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.court_appeals;
begin
    select * into v_row from public.court_appeals a where a.id = p_appeal_id for update;
    if not found or not public.is_couple_member(v_row.couple_id) then
        raise exception 'APPEAL_NOT_FOUND' using errcode = 'P0001';
    end if;
    if v_row.respondent_id <> auth.uid() then
        raise exception 'NOT_RESPONDENT' using errcode = 'P0001';
    end if;
    if v_row.status <> 'AWAITING_REPLY' or v_row.respondent_reply is not null then
        raise exception 'REPLY_CLOSED' using errcode = 'P0001';
    end if;
    if now() >= v_row.reply_deadline then
        raise exception 'REPLY_DEADLINE_PASSED' using errcode = 'P0001';
    end if;

    update public.court_appeals a
    set respondent_reply = btrim(p_reply), replied_at = now()
    where a.id = p_appeal_id
    returning * into v_row;
    return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Service-role RPCs (Edge Function) — same shape as the first-instance ones
-- -----------------------------------------------------------------------------
create or replace function public.claim_appeal_for_verdict(p_appeal_id uuid)
returns setof public.court_appeals
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.court_appeals;
begin
    select * into v_row from public.court_appeals a where a.id = p_appeal_id for update;
    if not found or v_row.verdict_attempts >= 5 then
        return;
    end if;

    if v_row.status = 'AWAITING_REPLY' then
        if v_row.respondent_reply is null then
            if now() < v_row.reply_deadline then
                return; -- reply lock engaged
            end if;
            v_row.respondent_reply := 'Karşı taraf 12 saatlik süre içinde itiraza cevap vermemiştir.';
            v_row.reply_timed_out := true;
        end if;
    elsif v_row.status = 'DELIBERATING' then
        if v_row.deliberation_started_at > now() - interval '5 minutes' then
            return;
        end if;
    else
        return;
    end if;

    update public.court_appeals a
    set status = 'DELIBERATING',
        respondent_reply = v_row.respondent_reply,
        reply_timed_out = v_row.reply_timed_out,
        deliberation_started_at = now(),
        verdict_attempts = a.verdict_attempts + 1,
        last_error = null
    where a.id = p_appeal_id
    returning * into v_row;
    return next v_row;
end;
$$;

create or replace function public.complete_appeal_verdict(
    p_appeal_id uuid,
    p_verdict_judge text,
    p_verdict_comedian text,
    p_fault_prosecutor int,
    p_fault_defendant int,
    p_penalty text
)
returns setof public.court_appeals
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row public.court_appeals;
begin
    update public.court_appeals a
    set verdict_judge = p_verdict_judge,
        verdict_comedian = p_verdict_comedian,
        fault_ratio_prosecutor = p_fault_prosecutor,
        fault_ratio_defendant = p_fault_defendant,
        penalty = p_penalty,
        status = 'JUDGED',
        judged_at = now(),
        last_error = null
    where a.id = p_appeal_id and a.status = 'DELIBERATING'
    returning * into v_row;
    if not found then
        return; -- someone else finished first
    end if;
    -- Back to JUDGED: the court_cases trigger sends VERDICT_READY to both.
    update public.court_cases cc set status = 'JUDGED'
    where cc.id = v_row.case_id and cc.status = 'APPEALED';
    return next v_row;
end;
$$;

create or replace function public.fail_appeal_verdict(p_appeal_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.court_appeals a
    set status = 'AWAITING_REPLY',
        deliberation_started_at = null,
        last_error = left(p_error, 500)
    where a.id = p_appeal_id and a.status = 'DELIBERATING';
end;
$$;

create or replace function public.list_claimable_appeals(p_limit int default 20)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
    select a.id from public.court_appeals a
    where a.verdict_attempts < 5
      and (
        (a.status = 'AWAITING_REPLY' and (a.respondent_reply is not null or a.reply_deadline <= now()))
        or (a.status = 'DELIBERATING' and a.deliberation_started_at <= now() - interval '5 minutes')
      )
    order by a.created_at
    limit greatest(1, least(p_limit, 100));
$$;

revoke execute on function
    public.file_appeal(uuid, text), public.reply_appeal(uuid, text),
    public.claim_appeal_for_verdict(uuid), public.complete_appeal_verdict(uuid, text, text, int, int, text),
    public.fail_appeal_verdict(uuid, text), public.list_claimable_appeals(int)
    from public, anon, authenticated;
grant execute on function public.file_appeal(uuid, text)  to authenticated;
grant execute on function public.reply_appeal(uuid, text) to authenticated;
grant execute on function public.claim_appeal_for_verdict(uuid)                          to service_role;
grant execute on function public.complete_appeal_verdict(uuid, text, text, int, int, text) to service_role;
grant execute on function public.fail_appeal_verdict(uuid, text)                         to service_role;
grant execute on function public.list_claimable_appeals(int)                             to service_role;

-- -----------------------------------------------------------------------------
-- Webhooks: notify the respondent; judge as soon as they reply. The 12 h
-- timeout path is picked up by the existing 10-minute court sweep.
-- -----------------------------------------------------------------------------
create or replace function private.tg_court_appeals_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        perform private.push(
            new.respondent_id, 'APPEAL_FILED', 'Karara itiraz edildi ⚖️',
            'Partnerin karara itiraz etti. Cevap için 12 saatin var.',
            jsonb_build_object('case_id', new.case_id, 'appeal_id', new.id)
        );
        return new;
    end if;
    if old.respondent_reply is null and new.respondent_reply is not null
       and not new.reply_timed_out and new.status = 'AWAITING_REPLY' then
        perform private.invoke_edge_function(
            'ai-court-verdict', jsonb_build_object('appeal_id', new.id)
        );
    end if;
    return new;
end;
$$;

create trigger court_appeals_events
    after insert or update on public.court_appeals
    for each row execute function private.tg_court_appeals_events();

revoke execute on function private.tg_court_appeals_events() from public, anon, authenticated;

alter publication supabase_realtime add table public.court_appeals;
