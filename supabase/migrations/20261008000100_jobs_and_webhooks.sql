-- =============================================================================
-- DuoSync — scheduled jobs + push/verdict webhooks
--
-- Requires two Vault secrets (create once per project, NOT in a migration,
-- so they never land in git):
--
--   select vault.create_secret('https://<ref>.supabase.co', 'duosync_project_url');
--   select vault.create_secret('<long random string>',      'duosync_internal_secret');
--
-- The same internal secret must be set for the Edge Functions:
--   supabase secrets set INTERNAL_WEBHOOK_SECRET=<long random string>
--
-- If the secrets are missing, webhooks log a WARNING and no-op; the client
-- fallback (it invokes ai-court-verdict after a defense) still works.
-- =============================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Generic async Edge Function invoker (pg_net queues the request; it is sent
-- after the transaction commits, so a rolled-back write never notifies).
-- -----------------------------------------------------------------------------
create or replace function private.invoke_edge_function(p_name text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_url text;
    v_secret text;
begin
    select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'duosync_project_url';
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'duosync_internal_secret';

    if v_url is null or v_secret is null then
        raise warning 'duosync: vault secrets missing, skipping edge call %', p_name;
        return;
    end if;

    perform net.http_post(
        url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
        body := p_body,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-internal-secret', v_secret
        ),
        timeout_milliseconds := 10000
    );
end;
$$;

create or replace function private.push(
    p_user_id uuid, p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
    select private.invoke_edge_function(
        'send-push-notification',
        jsonb_build_object(
            'user_id', p_user_id, 'type', p_type,
            'title', p_title, 'body', p_body, 'data', p_data
        )
    );
$$;

-- -----------------------------------------------------------------------------
-- Court webhooks
-- -----------------------------------------------------------------------------
create or replace function private.tg_court_cases_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        perform private.push(
            new.defendant_id, 'CASE_FILED', 'Mahkemeye çağrıldınız ⚖️',
            'Hakkınızda bir dava açıldı. Savunma için 24 saatiniz var.',
            jsonb_build_object('case_id', new.id)
        );
        return new;
    end if;

    -- Defense submitted by the defendant (not a timeout default) -> judge now.
    if old.defendant_plea is null and new.defendant_plea is not null
       and not new.defense_timed_out and new.status = 'AWAITING_DEFENSE' then
        perform private.invoke_edge_function(
            'ai-court-verdict', jsonb_build_object('case_id', new.id)
        );
    end if;

    if old.status <> 'JUDGED' and new.status = 'JUDGED' then
        perform private.push(new.prosecutor_id, 'VERDICT_READY', 'Karar açıklandı 🔨',
            new.title, jsonb_build_object('case_id', new.id));
        perform private.push(new.defendant_id, 'VERDICT_READY', 'Karar açıklandı 🔨',
            new.title, jsonb_build_object('case_id', new.id));
    end if;
    return new;
end;
$$;

create trigger court_cases_events
    after insert or update on public.court_cases
    for each row execute function private.tg_court_cases_events();

-- -----------------------------------------------------------------------------
-- Cooling-off webhook — fires ONLY on PENDING -> SENT.
-- PENDING -> CANCELLED intentionally emits nothing.
-- Push body never contains message content (lock-screen privacy).
-- -----------------------------------------------------------------------------
create or replace function private.tg_delayed_messages_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if old.status = 'PENDING' and new.status = 'SENT' then
        perform private.push(
            new.recipient_id, 'MESSAGE_RELEASED', 'Partnerinden bir mesaj var 💌',
            'Soğuma odasından yeni bir mesaj çıktı.',
            jsonb_build_object('message_id', new.id)
        );
    end if;
    return new;
end;
$$;

create trigger delayed_messages_events
    after update of status on public.delayed_messages
    for each row execute function private.tg_delayed_messages_events();

-- -----------------------------------------------------------------------------
-- Questions vault webhooks
-- -----------------------------------------------------------------------------
create or replace function private.tg_pending_questions_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_partner uuid;
begin
    if tg_op = 'INSERT' then
        select case when c.user_a_id = new.asker_id then c.user_b_id else c.user_a_id end
        into v_partner
        from public.couples c where c.id = new.couple_id;
        if v_partner is not null then
            perform private.push(v_partner, 'QUESTION_ASKED', 'Soru kasasına yeni soru 🗝️',
                'Müsait olduğunda cevaplayabilirsin.', jsonb_build_object('question_id', new.id));
        end if;
    elsif not old.is_answered and new.is_answered then
        perform private.push(new.asker_id, 'QUESTION_ANSWERED', 'Sorun cevaplandı ✅',
            left(new.question_text, 80), jsonb_build_object('question_id', new.id));
    end if;
    return new;
end;
$$;

create trigger pending_questions_events
    after insert or update of is_answered on public.pending_questions
    for each row execute function private.tg_pending_questions_events();

revoke execute on all functions in schema private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Scheduled jobs (pg_cron; schedule() upserts by job name)
-- -----------------------------------------------------------------------------
-- Release due cooling-off messages. Worst-case delivery latency ≈ 60 s.
select cron.schedule('duosync-release-messages', '* * * * *',
    $$select public.release_due_messages();$$);

-- Court sweep: 24h defense timeouts, failed LLM calls, stale DELIBERATING.
select cron.schedule('duosync-court-sweep', '*/10 * * * *',
    $$select private.invoke_edge_function('ai-court-verdict', '{"mode":"sweep"}'::jsonb);$$);

-- Housekeeping.
select cron.schedule('duosync-prune-pairing-attempts', '17 3 * * *',
    $$delete from public.pairing_attempts where attempted_at < now() - interval '1 day';$$);
