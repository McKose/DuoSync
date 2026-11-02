-- =============================================================================
-- DuoSync — live project check (ROADMAP A1 acceptance + A2 pre-checks)
--
-- Read-only. Run in the SQL editor of the DuoSync project (never the gym
-- project) after README §Kurulum: `db push`, both Vault secrets,
-- `secrets set`, `functions deploy`. Wait >= 10 min after the deploy so the
-- court sweep has fired at least once. All 14 rows must show ok = true.
--
-- Secret values are never returned; only presence and shape are tested.
-- "relation ... does not exist" means a prerequisite is missing:
--   supabase_migrations.* → migrations were not applied with `db push`
--   cron.* / net.*        → the jobs migration did not run
-- Edge Function state (ACTIVE) is not visible from SQL: `npx supabase functions list`.
-- Covered by supabase/tests/rls.test.mjs ("Live check script").
-- =============================================================================
with
expected_tables(name) as (
    values ('profiles'), ('push_tokens'), ('couples'), ('pairing_attempts'),
           ('court_cases'), ('delayed_messages'), ('pending_questions'), ('plans'),
           ('wheel_options'), ('wheel_spins'), ('court_appeals')
),
mig as (
    select count(*) filter (where version in ('20261008000000', '20261008000100', '20261031000000', '20261031000100', '20261102000000')) as n,
           coalesce(string_agg(version, ', ' order by version), 'none') as versions
    from supabase_migrations.schema_migrations
),
ext as (
    select count(*) as n,
           coalesce(string_agg(extname || ' ' || extversion, ', ' order by extname), 'none') as list
    from pg_extension where extname in ('pg_cron', 'pg_net')
),
jobs as (
    select count(*) filter (where active) as n_active,
           coalesce(string_agg(jobname || ' [' || schedule || ']'
                               || case when active then '' else ' INACTIVE' end, ', ' order by jobname), 'none') as list
    from cron.job where jobname like 'duosync-%'
),
runs as (
    select count(*) filter (where d.status = 'failed') as n_failed,
           max(d.start_time) filter (where j.jobname = 'duosync-release-messages') as last_release,
           (array_agg(left(d.return_message, 120) order by d.start_time desc)
                filter (where d.status = 'failed'))[1] as last_error
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname like 'duosync-%' and d.start_time > now() - interval '1 hour'
),
vlt as (
    select count(*) as n,
           coalesce(bool_or(name = 'duosync_project_url'
                            and decrypted_secret ~ '^https://[a-z0-9]+\.supabase\.co/?$'), false) as url_ok,
           coalesce(max(length(decrypted_secret)) filter (where name = 'duosync_internal_secret'), 0) as secret_len
    from vault.decrypted_secrets
    where name in ('duosync_project_url', 'duosync_internal_secret')
),
-- pg_net keeps responses ~6 h but not the URL; the sweep identifies itself
-- in its 202 body, every other failure is reported by status code.
http as (
    select count(*) filter (where status_code = 202 and content like '%"task":"sweep"%') as n_sweep_ok,
           count(*) filter (where status_code >= 400 or timed_out or error_msg is not null) as n_bad,
           coalesce(string_agg(distinct coalesce(status_code::text, 'ERR'), ', '), 'no responses') as codes
    from net._http_response
    where created > now() - interval '15 minutes'
),
rls as (
    select count(*) filter (where c.relrowsecurity) as n_on,
           string_agg(t.name, ', ') filter (where c.oid is null) as absent
    from expected_tables t
    left join pg_class c on c.oid = to_regclass('public.' || t.name)
),
rls_off as (
    select string_agg(c.relname, ', ' order by c.relname) as list
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
),
pub as (
    select count(*) as n
    from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename in ('couples', 'court_cases', 'delayed_messages', 'pending_questions', 'plans',
                        'wheel_options', 'wheel_spins', 'court_appeals')
),
anon_exec as (
    select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname) as list
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')
),
svc_exec as (
    select string_agg(p.proname, ', ' order by p.proname) as list
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('claim_case_for_verdict', 'complete_verdict', 'fail_verdict',
                        'list_claimable_cases', 'release_due_messages',
                        'claim_appeal_for_verdict', 'complete_appeal_verdict',
                        'fail_appeal_verdict', 'list_claimable_appeals')
      and has_function_privilege('authenticated', p.oid, 'execute')
),
-- The migrations narrow Supabase's default Data API grants instead of granting
-- from scratch; with "Automatically expose new tables" off these are missing
-- and every client query fails with "permission denied".
grants as (
    select string_agg(x.who || ' ' || x.priv || ' ' || x.tbl, ', ' order by x.who, x.tbl) as missing
    from (values
        ('authenticated', 'select', 'profiles'), ('authenticated', 'select', 'push_tokens'),
        ('authenticated', 'select', 'couples'), ('authenticated', 'select', 'court_cases'),
        ('authenticated', 'select', 'delayed_messages'), ('authenticated', 'select', 'pending_questions'),
        ('authenticated', 'select', 'plans'), ('authenticated', 'insert', 'plans'),
        ('authenticated', 'select', 'wheel_options'), ('authenticated', 'select', 'wheel_spins'),
        ('authenticated', 'select', 'court_appeals'), ('service_role', 'select', 'court_appeals'),
        ('service_role', 'select', 'court_cases'), ('service_role', 'select', 'push_tokens'),
        ('service_role', 'delete', 'push_tokens')
    ) as x(who, priv, tbl)
    where to_regclass('public.' || x.tbl) is null
       or not has_table_privilege(x.who, 'public.' || x.tbl, x.priv)
),
definer_path as (
    select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname) as list
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                      where cfg in ('search_path=""', 'search_path='))
)
select n, item, ok, detail from (
    select 1 as n, 'migrations applied (5)' as item, mig.n = 5 as ok, mig.versions as detail from mig
    union all
    select 2, 'extensions pg_cron + pg_net', ext.n = 2, ext.list from ext
    union all
    select 3, 'cron: 3 active duosync jobs', jobs.n_active = 3, jobs.list from jobs
    union all
    select 4, 'cron: runs healthy (last 1 h)',
           runs.n_failed = 0 and runs.last_release > now() - interval '3 minutes',
           case when runs.n_failed > 0 then runs.n_failed || ' failed; last: ' || runs.last_error
                when runs.last_release is null then 'release-messages has not run in the last hour'
                else 'release-messages last ran ' || to_char(now() - runs.last_release, 'MI:SS') || ' ago' end
    from runs
    union all
    select 5, 'vault: both secrets present', vlt.n = 2, vlt.n || '/2 found' from vlt
    union all
    select 6, 'vault: project url shape', vlt.url_ok,
           case when vlt.url_ok then 'https://<ref>.supabase.co'
                else 'expected https://<ref>.supabase.co (no path)' end
    from vlt
    union all
    select 7, 'vault: internal secret >= 32 chars', vlt.secret_len >= 32, 'length ' || vlt.secret_len from vlt
    union all
    select 8, 'webhook round-trip (sweep 202, no errors, 15 min)',
           http.n_sweep_ok > 0 and http.n_bad = 0,
           'codes: ' || http.codes
           || case when http.n_bad > 0
                   then ' | 401=gateway JWT on (deploy --no-verify-jwt), 403=INTERNAL_WEBHOOK_SECRET'
                        || ' != vault secret, 404=function not deployed or wrong project url'
                   when http.n_sweep_ok = 0 then ' | no sweep yet: wait for the next */10 run'
                   else '' end
    from http
    union all
    select 9, 'RLS on all 11 tables', rls.n_on = 11 and rls_off.list is null,
           coalesce(nullif(concat_ws(' | ', 'absent: ' || rls.absent, 'RLS off: ' || rls_off.list), ''),
                    rls.n_on || '/11 with RLS')
    from rls, rls_off
    union all
    select 10, 'realtime publication (8 tables)', pub.n = 8, pub.n || '/8 published' from pub
    union all
    select 11, 'anon executes no public/private fn', anon_exec.list is null,
           coalesce(anon_exec.list, 'none') from anon_exec
    union all
    select 12, 'service-only RPCs closed to authenticated', svc_exec.list is null,
           coalesce(svc_exec.list, 'none') from svc_exec
    union all
    select 13, 'SECURITY DEFINER fns pin search_path = ''''', definer_path.list is null,
           coalesce(definer_path.list, 'none') from definer_path
    union all
    select 14, 'Data API grants present', grants.missing is null,
           coalesce('missing: ' || grants.missing || ' | was "Automatically expose new tables" disabled?', 'all present')
    from grants
) checks
order by n;
