// DuoSync — migration + RLS + business-rule tests on PGlite (Postgres in WASM).
// Supabase-specific pieces (auth, roles, vault, pg_net, pg_cron, realtime
// publication) are stubbed with the same names/signatures.
//
// Run: node supabase/tests/rls.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const mig = (f) => readFileSync(join(here, '..', 'migrations', f), 'utf8');

const db = new PGlite();

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create publication supabase_realtime;

create schema extensions;
create schema net;
create table net.calls (id bigint generated always as identity, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int)
  returns bigint language sql as
  $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
create schema vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
insert into vault.decrypted_secrets values
  ('duosync_project_url', 'https://test.supabase.co'), ('duosync_internal_secret', 's3cret');
create schema cron;
create table cron.jobs (name text primary key, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as
  $$ insert into cron.jobs values (n, s, c) on conflict (name) do update set schedule = excluded.schedule returning 1::bigint $$;
`;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';

/** Run SQL as an authenticated user (or anon/service when uid is a role name). */
async function as(who, sql, params = []) {
  await db.exec('reset role');
  if (who === 'service') {
    await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`);
  } else if (who === 'anon') {
    await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  } else {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [who]);
    await db.exec('set role authenticated');
  }
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
  }
}
const su = (sql, params = []) => db.query(sql, params);

async function rejects(p, pattern) {
  await assert.rejects(p, (e) => {
    assert.match(e.message, pattern);
    return true;
  });
}

console.log('Applying migrations…');
await db.exec(STUBS);
await db.exec(mig('20261008000000_init_schema.sql'));
await db.exec(
  mig('20261008000100_jobs_and_webhooks.sql').replace(/^create extension.*$/gim, '-- (stubbed) $&'),
);
await su(
  `insert into auth.users (id, email, raw_user_meta_data) values
   ($1, 'ayse@example.com', '{"display_name":"Ayşe"}'), ($2, 'berk@example.com', '{}'), ($3, 'eve@example.com', '{}')`,
  [A, B, C],
);

console.log('Profiles & pairing');
await test('sign-up trigger creates profiles', async () => {
  const r = await su(`select id, display_name from public.profiles order by id`);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].display_name, 'Ayşe');
  assert.equal(r.rows[1].display_name, 'berk');
});

let code;
await test('A creates a pairing code (6 chars, unambiguous alphabet)', async () => {
  const r = await as(A, `select * from public.create_pairing_code()`);
  code = r.rows[0].pairing_code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(r.rows[0].is_active, false);
});

await test('regenerating returns the same pending couple with a new code', async () => {
  const r = await as(A, `select * from public.create_pairing_code()`);
  assert.notEqual(r.rows[0].pairing_code, undefined);
  code = r.rows[0].pairing_code;
  const n = await su(`select count(*)::int n from public.couples`);
  assert.equal(n.rows[0].n, 1);
});

await test('A cannot pair with own code', async () => {
  const r = await as(A, `select * from public.pair_with_code($1)`, [code]);
  assert.equal(r.rows.length, 0);
});

await test('B pairs with lowercase/whitespace-padded code', async () => {
  const r = await as(B, `select * from public.pair_with_code($1)`, [`  ${code.toLowerCase()} `]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].is_active, true);
  assert.equal(r.rows[0].user_b_id, B);
  assert.equal(r.rows[0].pairing_code, null);
});

await test('third party C cannot see the couple', async () => {
  const r = await as(C, `select * from public.couples`);
  assert.equal(r.rows.length, 0);
});

await test('C cannot reuse the consumed code; failures are throttled at 10/h', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await as(C, `select * from public.pair_with_code($1)`, [code]);
    assert.equal(r.rows.length, 0);
  }
  await rejects(as(C, `select * from public.pair_with_code($1)`, [code]), /RATE_LIMITED/);
});

await test('A cannot create a new code while paired', async () => {
  await rejects(as(A, `select * from public.create_pairing_code()`), /ALREADY_PAIRED/);
});

await test('partner profile visible, stranger profile not', async () => {
  const b = await as(B, `select id from public.profiles order by id`);
  assert.deepEqual(b.rows.map((r) => r.id), [A, B]);
  const c = await as(C, `select id from public.profiles`);
  assert.deepEqual(c.rows.map((r) => r.id), [C]);
});

await test('push tokens are private even from the partner', async () => {
  await as(A, `insert into public.push_tokens (user_id, token, platform) values ($1, 'ExponentPushToken[aaaaaaaa]', 'ios')`, [A]);
  const b = await as(B, `select * from public.push_tokens`);
  assert.equal(b.rows.length, 0);
  await rejects(
    as(B, `insert into public.push_tokens (user_id, token, platform) values ($1, 'ExponentPushToken[spoofed]', 'ios')`, [A]),
    /row-level security/,
  );
});

await test('profile update limited to own display_name/avatar', async () => {
  await as(A, `update public.profiles set display_name = 'Ayşe K.' where id = $1`, [A]);
  const r = await as(B, `update public.profiles set display_name = 'hacked' where id = $1 returning id`, [A]);
  assert.equal(r.rows.length, 0);
});

await test('anon sees nothing', async () => {
  await rejects(as('anon', `select * from public.couples`), /permission denied/);
});

console.log('Presence');
await test('battery ≤15 flips NORMAL→LOW_BATTERY, recovers to NORMAL', async () => {
  let r = await as(A, `select * from public.update_my_presence(10::smallint, null)`);
  assert.equal(r.rows[0].user_a_status, 'LOW_BATTERY');
  assert.equal(r.rows[0].user_a_battery, 10);
  r = await as(A, `select * from public.update_my_presence(80::smallint, null)`);
  assert.equal(r.rows[0].user_a_status, 'NORMAL');
});

await test('manual BUSY is not overridden by low battery; invalid battery ignored', async () => {
  await as(B, `select * from public.update_my_presence(null, 'BUSY')`);
  const r = await as(B, `select * from public.update_my_presence((-1)::smallint, null)`);
  assert.equal(r.rows[0].user_b_status, 'BUSY');
  assert.equal(r.rows[0].user_b_battery, null);
  const r2 = await as(B, `select * from public.update_my_presence(5::smallint, null)`);
  assert.equal(r2.rows[0].user_b_status, 'BUSY');
});

await test('direct couples update is denied', async () => {
  await rejects(as(A, `update public.couples set user_b_battery = 1`), /permission denied/);
});

console.log('AI court');
let caseId;
await test('A files a case; defendant derived server-side; push queued to B', async () => {
  const r = await as(A, `select * from public.file_case('Bulaşıklar', 'CHORES', 'Üç gündür bulaşık makinesi boşaltılmadı.')`);
  caseId = r.rows[0].id;
  assert.equal(r.rows[0].defendant_id, B);
  assert.equal(r.rows[0].status, 'AWAITING_DEFENSE');
  const push = await su(`select body from net.calls where body->>'type' = 'CASE_FILED'`);
  assert.equal(push.rows[0].body.user_id, B);
});

await test('C cannot see the case', async () => {
  const r = await as(C, `select * from public.court_cases`);
  assert.equal(r.rows.length, 0);
});

await test('prosecutor cannot write verdict fields directly (spec UPDATE policy hole closed)', async () => {
  await rejects(
    as(A, `update public.court_cases set fault_ratio_prosecutor = 0, fault_ratio_defendant = 100 where id = $1`, [caseId]),
    /permission denied/,
  );
});

await test('defense lock: service cannot claim before defense or timeout', async () => {
  const r = await as('service', `select * from public.claim_case_for_verdict($1)`, [caseId]);
  assert.equal(r.rows.length, 0);
});

await test('only the defendant may submit defense', async () => {
  await rejects(as(A, `select * from public.submit_defense($1, 'kendi kendime')`, [caseId]), /NOT_DEFENDANT/);
});

await test('B submits defense; verdict webhook queued', async () => {
  await as(B, `select * from public.submit_defense($1, 'Makine doluydu, ben çamaşırı astım.')`, [caseId]);
  const calls = await su(`select url, body from net.calls where url like '%ai-court-verdict'`);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].body.case_id, caseId);
  await rejects(as(B, `select * from public.submit_defense($1, 'again')`, [caseId]), /DEFENSE_CLOSED/);
});

await test('claim is atomic: first claim wins, second gets nothing', async () => {
  const r1 = await as('service', `select * from public.claim_case_for_verdict($1)`, [caseId]);
  assert.equal(r1.rows[0].status, 'DELIBERATING');
  const r2 = await as('service', `select * from public.claim_case_for_verdict($1)`, [caseId]);
  assert.equal(r2.rows.length, 0);
});

await test('fault ratios must sum to 100', async () => {
  await rejects(
    as('service', `select * from public.complete_verdict($1, 'j', 'c', 70, 40, 'p')`, [caseId]),
    /fault_sum_100/,
  );
});

await test('complete_verdict → JUDGED, push to both parties', async () => {
  const r = await as('service', `select * from public.complete_verdict($1, 'Hüküm', 'Şerh', 35, 65, 'Bir hafta bulaşık')`, [caseId]);
  assert.equal(r.rows[0].status, 'JUDGED');
  const push = await su(`select body->>'user_id' u from net.calls where body->>'type' = 'VERDICT_READY' order by 1`);
  assert.deepEqual(push.rows.map((x) => x.u), [A, B]);
  const again = await as('service', `select * from public.complete_verdict($1, 'x', 'y', 50, 50, 'z')`, [caseId]);
  assert.equal(again.rows.length, 0);
});

await test('clients cannot call service-only functions', async () => {
  await rejects(as(A, `select * from public.claim_case_for_verdict($1)`, [caseId]), /permission denied/);
  await rejects(as(A, `select public.release_due_messages()`), /permission denied/);
});

await test('24h timeout: claim injects default plea and marks timed_out', async () => {
  const r = await as(B, `select * from public.file_case('Geç kalma', 'PLANS', 'Sinemaya yarım saat geç kaldı.')`);
  const id = r.rows[0].id;
  await su(`update public.court_cases set defense_deadline = now() - interval '1 minute' where id = $1`, [id]);
  await rejects(as(A, `select * from public.submit_defense($1, 'geç')`, [id]), /DEFENSE_DEADLINE_PASSED/);
  const listed = await as('service', `select * from public.list_claimable_cases(10)`);
  assert.ok(listed.rows.some((x) => Object.values(x)[0] === id));
  const c = await as('service', `select * from public.claim_case_for_verdict($1)`, [id]);
  assert.equal(c.rows[0].defense_timed_out, true);
  assert.match(c.rows[0].defendant_plea, /süre aşımı/);
  await as('service', `select public.fail_verdict($1, 'Gemini 503')`, [id]);
  const after = await su(`select status, last_error, defendant_plea from public.court_cases where id = $1`, [id]);
  assert.equal(after.rows[0].status, 'AWAITING_DEFENSE');
  assert.equal(after.rows[0].last_error, 'Gemini 503');
  assert.match(after.rows[0].defendant_plea, /süre aşımı/);
});

await test('daily case limit (5/24h per prosecutor)', async () => {
  for (let i = 0; i < 4; i++) {
    await as(A, `select * from public.file_case($1, 'OTHER', 'Yeterince uzun bir iddia metni.')`, [`Dava ${i}`]);
  }
  await rejects(as(A, `select * from public.file_case('Altıncı', 'OTHER', 'Yeterince uzun bir iddia metni.')`), /DAILY_CASE_LIMIT/);
});

console.log('Cooling-off room');
let msgId;
await test('delay must be 15–60 min', async () => {
  await rejects(as(A, `select * from public.schedule_delayed_message('çok kızgınım', 5)`), /INVALID_DELAY/);
});

await test('recipient cannot see PENDING message', async () => {
  const r = await as(A, `select * from public.schedule_delayed_message('Sana çok kızgınım!', 15)`);
  msgId = r.rows[0].id;
  assert.equal(r.rows[0].recipient_id, B);
  const b = await as(B, `select * from public.delayed_messages`);
  assert.equal(b.rows.length, 0);
});

await test('silent cancel: CANCELLED, still invisible to B, no push', async () => {
  const before = await su(`select count(*)::int n from net.calls`);
  const r = await as(A, `select public.cancel_delayed_message($1) ok`, [msgId]);
  assert.equal(r.rows[0].ok, true);
  const st = await su(`select status from public.delayed_messages where id = $1`, [msgId]);
  assert.equal(st.rows[0].status, 'CANCELLED');
  const b = await as(B, `select * from public.delayed_messages`);
  assert.equal(b.rows.length, 0);
  const after = await su(`select count(*)::int n from net.calls`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

await test('B cannot cancel A’s message; direct UPDATE denied', async () => {
  const r = await as(A, `select * from public.schedule_delayed_message('İkinci mesaj', 20)`);
  const id = r.rows[0].id;
  const x = await as(B, `select public.cancel_delayed_message($1) ok`, [id]);
  assert.equal(x.rows[0].ok, false);
  await rejects(as(A, `update public.delayed_messages set status = 'SENT' where id = $1`, [id]), /permission denied/);
  msgId = id;
});

await test('release job: PENDING→SENT, B sees it, push has no content', async () => {
  await su(`update public.delayed_messages set created_at = now() - interval '30 minutes', release_at = now() - interval '1 second' where id = $1`, [msgId]);
  const n = await as('service', `select public.release_due_messages() n`);
  assert.equal(n.rows[0].n, 1);
  const b = await as(B, `select content, status from public.delayed_messages`);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].status, 'SENT');
  const push = await su(`select body from net.calls where body->>'type' = 'MESSAGE_RELEASED'`);
  assert.equal(push.rows.length, 1);
  assert.ok(!JSON.stringify(push.rows[0].body).includes('İkinci mesaj'));
  const late = await as(A, `select public.cancel_delayed_message($1) ok`, [msgId]);
  assert.equal(late.rows[0].ok, false);
});

console.log('Questions vault');
await test('ask / cannot self-answer / partner answers', async () => {
  const q = await as(A, `select * from public.ask_question('Hafta sonu annemlere gidelim mi?')`);
  const id = q.rows[0].id;
  await rejects(as(A, `select * from public.answer_question($1, 'evet')`, [id]), /CANNOT_ANSWER_OWN/);
  const a = await as(B, `select * from public.answer_question($1, 'Pazar olur.')`, [id]);
  assert.equal(a.rows[0].is_answered, true);
  const c = await as(C, `select * from public.pending_questions`);
  assert.equal(c.rows.length, 0);
});

console.log('Plans & checklist LWW');
let planId;
const item = '11111111-1111-4111-8111-111111111111';
await test('member creates plan; stranger cannot see or insert into couple', async () => {
  const couple = await su(`select id from public.couples`);
  const cid = couple.rows[0].id;
  const r = await as(A, `insert into public.plans (couple_id, created_by, title) values ($1, $2, 'Cuma akşamı') returning id`, [cid, A]);
  planId = r.rows[0].id;
  assert.equal((await as(C, `select * from public.plans`)).rows.length, 0);
  await rejects(
    as(C, `insert into public.plans (couple_id, created_by, title) values ($1, $2, 'sızma')`, [cid, C]),
    /row-level security/,
  );
});

await test('per-item LWW: newer write wins, stale write is ignored', async () => {
  await as(B, `select * from public.upsert_checklist_item($1, $2::jsonb)`, [
    planId, JSON.stringify({ id: item, text: 'Masa ayırt', done: false, updated_at: '2026-10-08T10:00:00Z' }),
  ]);
  await as(A, `select * from public.upsert_checklist_item($1, $2::jsonb)`, [
    planId, JSON.stringify({ id: item, text: 'Masa ayırt', done: true, updated_at: '2026-10-08T10:05:00Z' }),
  ]);
  const stale = await as(B, `select checklist from public.upsert_checklist_item($1, $2::jsonb)`, [
    planId, JSON.stringify({ id: item, text: 'Masa ayırt', done: false, updated_at: '2026-10-08T10:01:00Z' }),
  ]);
  assert.equal(stale.rows[0].checklist[0].done, true);
});

await test('concurrent edits on different items both survive', async () => {
  const i2 = '22222222-2222-4222-8222-222222222222';
  const i3 = '33333333-3333-4333-8333-333333333333';
  await as(A, `select 1 from public.upsert_checklist_item($1, $2::jsonb)`, [planId, JSON.stringify({ id: i2, text: 'Çiçek al', done: false, updated_at: new Date().toISOString() })]);
  await as(B, `select 1 from public.upsert_checklist_item($1, $2::jsonb)`, [planId, JSON.stringify({ id: i3, text: 'Taksi', done: false, updated_at: new Date().toISOString() })]);
  const r = await su(`select jsonb_array_length(checklist) n from public.plans where id = $1`, [planId]);
  assert.equal(r.rows[0].n, 3);
});

await test('future timestamps are clamped (clock-skew guard)', async () => {
  const r = await as(A, `select checklist from public.upsert_checklist_item($1, $2::jsonb)`, [
    planId, JSON.stringify({ id: item, text: 'Masa ayırt', done: false, updated_at: '2099-01-01T00:00:00Z' }),
  ]);
  const ts = new Date(r.rows[0].checklist[0].updated_at).getTime();
  assert.ok(ts < Date.now() + 2 * 60_000);
});

await test('tombstone delete; stranger cannot merge', async () => {
  const r = await as(B, `select checklist from public.upsert_checklist_item($1, $2::jsonb)`, [
    planId, JSON.stringify({ id: item, text: 'Masa ayırt', done: false, deleted: true, updated_at: new Date(Date.now() + 90_000).toISOString() }),
  ]);
  assert.equal(r.rows[0].checklist.find((x) => x.id === item).deleted, true);
  await rejects(
    as(C, `select 1 from public.upsert_checklist_item($1, $2::jsonb)`, [planId, JSON.stringify({ id: item, text: 'x', done: true, updated_at: new Date().toISOString() })]),
    /PLAN_NOT_FOUND/,
  );
});

await test('direct checklist overwrite denied; title update allowed', async () => {
  await rejects(as(A, `update public.plans set checklist = '[]' where id = $1`, [planId]), /permission denied/);
  const r = await as(B, `update public.plans set title = 'Cuma — İtalyan' where id = $1 returning title`, [planId]);
  assert.equal(r.rows[0].title, 'Cuma — İtalyan');
});

console.log('Schedules');
await test('cron jobs registered', async () => {
  const r = await su(`select name from cron.jobs order by name`);
  assert.deepEqual(r.rows.map((x) => x.name), ['duosync-court-sweep', 'duosync-prune-pairing-attempts', 'duosync-release-messages']);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
