-- =============================================================================
-- DuoSync — Gemini usage log + daily budget (ROADMAP D2)
--
-- One row per Gemini call made by ai-court-verdict: model, outcome, HTTP
-- status, latency and token counts from usageMetadata. Deliberately no case,
-- appeal, couple or user id and no text: this is operator telemetry, so it
-- survives an unpair (B2 deletes all shared data) without linking to anyone.
--
-- The Edge Function reads today's (UTC) totals before claiming work and stops
-- calling the model once its daily call or token budget is spent. Only calls
-- the model may have processed count ("billable": ok / timeout /
-- invalid_output); 429 / 503 and network errors are rejected before
-- generation and cost nothing.
--
-- The table lives in `private` (not exposed by the Data API). Service-only
-- RPCs in `public` are the only way in, like the other server RPCs.
-- =============================================================================

create table private.llm_usage (
    id             bigint generated always as identity primary key,
    created_at     timestamptz not null default now(),
    kind           text not null check (kind in ('case', 'appeal')),
    model          text not null check (char_length(model) between 1 and 100),
    outcome        text not null check (outcome in ('ok', 'invalid_output', 'timeout', 'http_error', 'network_error')),
    http_status    int check (http_status between 100 and 599),
    latency_ms     int not null check (latency_ms between 0 and 600000),
    prompt_tokens  int not null default 0 check (prompt_tokens >= 0),
    output_tokens  int not null default 0 check (output_tokens >= 0),
    thought_tokens int not null default 0 check (thought_tokens >= 0),
    total_tokens   int not null default 0 check (total_tokens >= 0),
    billable       boolean generated always as (outcome in ('ok', 'invalid_output', 'timeout')) stored
);

create index llm_usage_created_at on private.llm_usage (created_at);

-- Not reachable through the Data API anyway; deny-all is defence in depth.
alter table private.llm_usage enable row level security;
revoke all on private.llm_usage from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Today's billable totals (UTC day). The budget check before every claim.
-- -----------------------------------------------------------------------------
create or replace function public.llm_usage_today()
returns table (calls_today bigint, tokens_today bigint)
language sql
stable
security definer
set search_path = ''
as $$
    select count(*), coalesce(sum(u.total_tokens), 0)
    from private.llm_usage u
    where u.billable
      and u.created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
$$;

-- -----------------------------------------------------------------------------
-- Records one call and returns today's totals including it, so the caller can
-- tell whether this call crossed an alert threshold. Rows older than 90 days
-- are pruned here (index range delete), which needs no extra cron job.
-- -----------------------------------------------------------------------------
create or replace function public.record_llm_usage(
    p_kind text,
    p_model text,
    p_outcome text,
    p_http_status int,
    p_latency_ms int,
    p_prompt_tokens int,
    p_output_tokens int,
    p_thought_tokens int,
    p_total_tokens int
)
returns table (calls_today bigint, tokens_today bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into private.llm_usage
        (kind, model, outcome, http_status, latency_ms,
         prompt_tokens, output_tokens, thought_tokens, total_tokens)
    values
        (p_kind, p_model, p_outcome, p_http_status, greatest(coalesce(p_latency_ms, 0), 0),
         coalesce(p_prompt_tokens, 0), coalesce(p_output_tokens, 0),
         coalesce(p_thought_tokens, 0), coalesce(p_total_tokens, 0));

    delete from private.llm_usage u where u.created_at < now() - interval '90 days';

    return query select t.calls_today, t.tokens_today from public.llm_usage_today() t;
end;
$$;

revoke execute on function public.llm_usage_today() from public, anon, authenticated;
revoke execute on function public.record_llm_usage(text, text, text, int, int, int, int, int, int)
    from public, anon, authenticated;
grant execute on function public.llm_usage_today() to service_role;
grant execute on function public.record_llm_usage(text, text, text, int, int, int, int, int, int) to service_role;
