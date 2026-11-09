-- =============================================================================
-- DuoSync — Gemini usage report (ROADMAP D2). Read-only; run in the SQL editor
-- of the DuoSync project. Days are UTC, like the daily budget in
-- ai-court-verdict (GEMINI_DAILY_CALL_LIMIT / GEMINI_DAILY_TOKEN_LIMIT,
-- defaults 150 calls / 300 000 tokens). "billable" = the model may have
-- processed the call (ok / invalid_output / timeout); 429 / 503 and network
-- errors cost nothing and do not count toward the budget.
-- =============================================================================
select
    (u.created_at at time zone 'UTC')::date                         as day_utc,
    count(*) filter (where u.billable)                              as billable_calls,
    sum(u.total_tokens)                                             as tokens,
    sum(u.prompt_tokens)                                            as prompt_tokens,
    sum(u.output_tokens)                                            as output_tokens,
    sum(u.thought_tokens)                                           as thought_tokens,
    count(*) filter (where u.outcome = 'ok')                        as ok,
    count(*) filter (where u.outcome = 'http_error' and u.http_status = 503) as overloaded_503,
    count(*) filter (where u.outcome = 'http_error' and u.http_status = 429) as rate_limited_429,
    count(*) filter (where u.outcome = 'timeout')                   as timeouts,
    count(*) filter (where u.outcome = 'invalid_output')            as invalid_output,
    count(*) filter (where u.outcome in ('http_error', 'network_error')
                     and coalesce(u.http_status, 0) not in (429, 503)) as other_errors,
    round(avg(u.latency_ms) filter (where u.outcome = 'ok'))        as avg_ok_latency_ms,
    max(u.latency_ms) filter (where u.outcome = 'ok')               as max_ok_latency_ms,
    string_agg(distinct u.model, ', ')                              as models
from private.llm_usage u
where u.created_at > now() - interval '14 days'
group by 1
order by 1 desc;
