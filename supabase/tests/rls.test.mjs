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
const D = '00000000-0000-0000-0000-00000000000d';
const E = '00000000-0000-0000-0000-00000000000e';

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
await db.exec(mig('20261031000000_decision_wheel.sql'));
await db.exec(mig('20261031000100_leave_couple.sql'));
await db.exec(mig('20261102000000_appeals.sql'));
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

console.log('Second couple');
await test('joiner with own pending invite: invite discarded, pairing succeeds', async () => {
  await su(`insert into auth.users (id, email) values ($1, 'd@example.com'), ($2, 'e@example.com')`, [D, E]);
  const d = await as(D, `select * from public.create_pairing_code()`);
  const e = await as(E, `select * from public.create_pairing_code()`);
  const r = await as(E, `select * from public.pair_with_code($1)`, [d.rows[0].pairing_code]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].user_b_id, E);
  const eOld = await su(`select count(*)::int n from public.couples where id = $1`, [e.rows[0].id]);
  assert.equal(eOld.rows[0].n, 0);
});

await test('couple-to-couple isolation: D/E see none of A/B data and vice versa', async () => {
  for (const t of ['court_cases', 'delayed_messages', 'pending_questions', 'plans']) {
    const r = await as(D, `select count(*)::int n from public.${t}`);
    assert.equal(r.rows[0].n, 0, `D sees ${t}`);
  }
  const prof = await as(D, `select id from public.profiles order by id`);
  assert.deepEqual(prof.rows.map((x) => x.id), [D, E]);
  await as(D, `select * from public.file_case('Karşı dava', 'OTHER', 'Bu dava yalnız D ve E içindir.')`);
  const a = await as(A, `select count(*)::int n from public.court_cases where title = 'Karşı dava'`);
  assert.equal(a.rows[0].n, 0);
  await rejects(as(D, `select * from public.submit_defense($1, 'sızma')`, [caseId]), /CASE_NOT_FOUND/);
  await rejects(as(D, `select 1 from public.upsert_checklist_item($1, $2::jsonb)`, [planId, JSON.stringify({ id: item, text: 'x', done: true, updated_at: new Date().toISOString() })]), /PLAN_NOT_FOUND/);
});

await test('paired users cannot join a third couple', async () => {
  const c = await su(`select id from public.couples where user_a_id = $1`, [D]);
  await rejects(as(A, `select * from public.pair_with_code('ZZZZZZ')`), /ALREADY_PAIRED/);
  assert.ok(c.rows.length === 1);
});

console.log('Decision wheel');
const optionLabels = async (who) =>
  (await as(who, `select label from public.wheel_options order by created_at, id`)).rows.map((r) => r.label);
/** Move every spin back a minute so the 10 s cooldown does not block the next one. */
const pastCooldown = () => su(`update public.wheel_spins set created_at = created_at - interval '1 minute'`);

await test('both partners add options; label validation and case-insensitive duplicate guard', async () => {
  await as(A, `select * from public.add_wheel_option('  Sushi ')`);
  await as(B, `select * from public.add_wheel_option('Köfte')`);
  await rejects(as(A, `select * from public.add_wheel_option('   ')`), /INVALID_OPTION_LABEL/);
  await rejects(as(A, `select * from public.add_wheel_option($1)`, ['x'.repeat(31)]), /INVALID_OPTION_LABEL/);
  await rejects(as(B, `select * from public.add_wheel_option('sushi')`), /DUPLICATE_OPTION/);
  assert.deepEqual(await optionLabels(A), ['Sushi', 'Köfte']);
  assert.deepEqual(await optionLabels(B), ['Sushi', 'Köfte']);
});

await test('stranger and other couple: no visibility, cannot add or remove', async () => {
  assert.deepEqual(await optionLabels(C), []);
  assert.deepEqual(await optionLabels(D), []);
  await rejects(as(C, `select * from public.add_wheel_option('Pizza')`), /NOT_PAIRED/);
  const opt = await su(`select id from public.wheel_options where label = 'Sushi'`);
  await rejects(as(C, `select public.remove_wheel_option($1)`, [opt.rows[0].id]), /OPTION_NOT_FOUND/);
  await rejects(as(D, `select public.remove_wheel_option($1)`, [opt.rows[0].id]), /OPTION_NOT_FOUND/);
  await rejects(as('anon', `select public.spin_wheel()`), /permission denied/);
});

await test('direct writes to wheel tables are denied', async () => {
  const cid = (await su(`select id from public.couples where user_a_id = $1`, [A])).rows[0].id;
  await rejects(as(A, `insert into public.wheel_options (couple_id, label) values ($1, 'Pizza')`, [cid]), /permission denied/);
  await rejects(
    as(A, `insert into public.wheel_spins (couple_id, option_labels, result_index, result_label) values ($1, '["a","b"]', 0, 'a')`, [cid]),
    /permission denied/,
  );
  await rejects(as(A, `update public.wheel_options set label = 'Pizza'`), /permission denied/);
});

await test('cap of 12 options per couple', async () => {
  for (let i = 1; i <= 10; i++) await as(i % 2 ? A : B, `select * from public.add_wheel_option($1)`, [`Seçenek ${i}`]);
  await rejects(as(A, `select * from public.add_wheel_option('On üçüncü')`), /WHEEL_FULL/);
  assert.equal((await optionLabels(A)).length, 12);
});

await test('spin needs at least two options', async () => {
  await rejects(as(D, `select * from public.spin_wheel()`), /NOT_ENOUGH_OPTIONS/);
  await as(D, `select * from public.add_wheel_option('Mantı')`);
  await rejects(as(D, `select * from public.spin_wheel()`), /NOT_ENOUGH_OPTIONS/);
});

let spinId;
await test('spin is drawn and stored server-side; both members see the same row, nobody else does', async () => {
  const r = (await as(A, `select * from public.spin_wheel()`)).rows[0];
  spinId = r.id;
  assert.equal(r.spun_by, A);
  assert.deepEqual(r.option_labels, await optionLabels(A));
  assert.equal(r.option_labels[r.result_index], r.result_label);
  const seen = await as(B, `select id, result_label from public.wheel_spins`);
  assert.deepEqual(seen.rows, [{ id: r.id, result_label: r.result_label }]);
  assert.equal((await as(C, `select count(*)::int n from public.wheel_spins`)).rows[0].n, 0);
  assert.equal((await as(D, `select count(*)::int n from public.wheel_spins`)).rows[0].n, 0);
});

await test('10 s cooldown applies to the couple, not the user', async () => {
  await rejects(as(B, `select * from public.spin_wheel()`), /SPIN_COOLDOWN/);
  // The other couple is unaffected.
  await as(E, `select * from public.add_wheel_option('Lahmacun')`);
  const d = (await as(D, `select * from public.spin_wheel()`)).rows[0];
  assert.ok(['Mantı', 'Lahmacun'].includes(d.result_label));
  assert.equal((await as(A, `select count(*)::int n from public.wheel_spins where id = $1`, [d.id])).rows[0].n, 0);
});

await test('stored result cannot be rewritten; a mismatched result is rejected even for the service role', async () => {
  await rejects(as(B, `update public.wheel_spins set result_label = 'Köfte' where id = $1`, [spinId]), /permission denied/);
  await rejects(as(A, `delete from public.wheel_spins where id = $1`, [spinId]), /permission denied/);
  const cid = (await su(`select id from public.couples where user_a_id = $1`, [A])).rows[0].id;
  await rejects(
    su(`insert into public.wheel_spins (couple_id, option_labels, result_index, result_label) values ($1, '["a","b"]', 0, 'b')`, [cid]),
    /wheel_spins_result_matches/,
  );
});

await test('partner can remove an option; draw covers every option; history capped at 20', async () => {
  const extra = await su(`select id from public.wheel_options where label like 'Seçenek %' or label = 'Köfte'`);
  for (const [i, row] of extra.rows.entries()) await as(i % 2 ? A : B, `select public.remove_wheel_option($1)`, [row.id]);
  await as(B, `select * from public.add_wheel_option('Pide')`);
  await as(A, `select * from public.add_wheel_option('Döner')`);
  assert.deepEqual(await optionLabels(A), ['Sushi', 'Pide', 'Döner']);
  const wins = new Set();
  for (let i = 0; i < 60; i++) {
    await pastCooldown();
    wins.add((await as(i % 2 ? A : B, `select result_label from public.spin_wheel()`)).rows[0].result_label);
  }
  // P(an option never wins in 60 uniform draws of 3) ≈ 3·(2/3)^60 ≈ 3e-10.
  assert.deepEqual([...wins].sort(), ['Döner', 'Pide', 'Sushi']);
  assert.equal((await as(A, `select count(*)::int n from public.wheel_spins`)).rows[0].n, 20);
});

console.log('Appeals (istinaf)');
let appealId;
const appealCalls = async (type) => (await su(`select body from net.calls where body->>'type' = $1 order by id`, [type])).rows.map((r) => r.body);
const caseStatus = async (id) => (await su(`select status from public.court_cases where id = $1`, [id])).rows[0].status;

await test('appeal needs a JUDGED case; strangers, the other couple and anon are refused', async () => {
  const open = (await su(`select id from public.court_cases where title = 'Geç kalma'`)).rows[0].id;
  await rejects(as(A, `select * from public.file_appeal($1, 'Bu karar haksız, yeniden bakılsın.')`, [open]), /APPEAL_NOT_ALLOWED/);
  await rejects(as(C, `select * from public.file_appeal($1, 'Bu karar haksız, yeniden bakılsın.')`, [caseId]), /CASE_NOT_FOUND/);
  await rejects(as(D, `select * from public.file_appeal($1, 'Bu karar haksız, yeniden bakılsın.')`, [caseId]), /CASE_NOT_FOUND/);
  await rejects(as('anon', `select * from public.file_appeal($1, 'Bu karar haksız, yeniden bakılsın.')`, [caseId]), /permission denied/);
  const cid = (await su(`select couple_id from public.court_cases where id = $1`, [caseId])).rows[0].couple_id;
  await rejects(
    as(B, `insert into public.court_appeals (case_id, couple_id, round, appellant_id, respondent_id, appellant_reason, reply_deadline)
           values ($1, $2, 1, $3, $4, 'Doğrudan yazmaya çalışıyorum.', now())`, [caseId, cid, B, A]),
    /permission denied/,
  );
});

await test('defendant B appeals round 1: respondent is A, case goes APPEALED, A is notified', async () => {
  await rejects(as(B, `select * from public.file_appeal($1, 'kısa')`, [caseId]), /check constraint/);
  const r = (await as(B, `select * from public.file_appeal($1, 'Çamaşır emeği hiç hesaba katılmadı.')`, [caseId])).rows[0];
  appealId = r.id;
  assert.equal(r.round, 1);
  assert.equal(r.respondent_id, A);
  assert.equal(r.status, 'AWAITING_REPLY');
  const hours = (new Date(r.reply_deadline) - new Date(r.created_at)) / 3_600_000;
  assert.equal(Math.round(hours), 12);
  assert.equal(await caseStatus(caseId), 'APPEALED');
  const push = await appealCalls('APPEAL_FILED');
  assert.deepEqual(push.map((b) => [b.user_id, b.data.appeal_id]), [[A, appealId]]);
  assert.ok(!JSON.stringify(push[0]).includes('Çamaşır'));
  await rejects(as(A, `select * from public.file_appeal($1, 'Ben de itiraz ediyorum, sırayla.')`, [caseId]), /APPEAL_PENDING/);
  for (const who of [A, B]) assert.equal((await as(who, `select count(*)::int n from public.court_appeals`)).rows[0].n, 1);
  for (const who of [C, D]) assert.equal((await as(who, `select count(*)::int n from public.court_appeals`)).rows[0].n, 0);
});

await test('reply lock: no LLM claim before the reply; only the respondent replies, once', async () => {
  assert.equal((await as('service', `select * from public.claim_appeal_for_verdict($1)`, [appealId])).rows.length, 0);
  await rejects(as(B, `select * from public.reply_appeal($1, 'Kendime cevap')`, [appealId]), /NOT_RESPONDENT/);
  await rejects(as(C, `select * from public.reply_appeal($1, 'Sızma')`, [appealId]), /APPEAL_NOT_FOUND/);
  const before = (await su(`select count(*)::int n from net.calls where body->>'appeal_id' = $1`, [appealId])).rows[0].n;
  await as(A, `select * from public.reply_appeal($1, 'Çamaşır zaten onun sırasıydı.')`, [appealId]);
  const hooks = await su(`select url from net.calls where body->>'appeal_id' = $1`, [appealId]);
  assert.equal(hooks.rows.length, before + 1);
  assert.match(hooks.rows.at(-1).url, /ai-court-verdict$/);
  await rejects(as(A, `select * from public.reply_appeal($1, 'Bir daha')`, [appealId]), /REPLY_CLOSED/);
});

await test('claim is atomic; ratios must sum to 100; verdict lands, original kept, both notified', async () => {
  const original = (await su(`select verdict_judge, fault_ratio_prosecutor, judged_at from public.court_cases where id = $1`, [caseId])).rows[0];
  const c1 = await as('service', `select * from public.claim_appeal_for_verdict($1)`, [appealId]);
  assert.equal(c1.rows[0].status, 'DELIBERATING');
  assert.equal((await as('service', `select * from public.claim_appeal_for_verdict($1)`, [appealId])).rows.length, 0);
  await rejects(as('service', `select * from public.complete_appeal_verdict($1, 'j', 'c', 70, 40, 'p')`, [appealId]), /appeal_fault_sum_100/);
  const verdictsBefore = (await appealCalls('VERDICT_READY')).length;
  const done = (await as('service', `select * from public.complete_appeal_verdict($1, 'İstinaf hükmü', 'Şerh', 55, 45, 'Ortak çamaşır günü')`, [appealId])).rows[0];
  assert.equal(done.status, 'JUDGED');
  assert.equal(await caseStatus(caseId), 'JUDGED');
  const now = (await su(`select verdict_judge, fault_ratio_prosecutor, judged_at from public.court_cases where id = $1`, [caseId])).rows[0];
  assert.deepEqual(now, original);
  const pushes = (await appealCalls('VERDICT_READY')).slice(verdictsBefore).map((b) => b.user_id).sort();
  assert.deepEqual(pushes, [A, B].sort());
  assert.equal((await as('service', `select * from public.complete_appeal_verdict($1, 'x', 'y', 50, 50, 'z')`, [appealId])).rows.length, 0);
});

await test('clients cannot call service-only appeal functions', async () => {
  for (const sql of [
    `select * from public.claim_appeal_for_verdict($1)`,
    `select * from public.complete_appeal_verdict($1, 'a', 'b', 50, 50, 'c')`,
    `select public.fail_appeal_verdict($1, 'x')`,
  ]) await rejects(as(A, sql, [appealId]), /permission denied/);
  await rejects(as(A, `select * from public.list_claimable_appeals(5)`), /permission denied/);
});

await test('round 2 by the other party: reply timeout, failure retry, then the limit of 2', async () => {
  const r2 = (await as(A, `select * from public.file_appeal($1, 'İstinaf kararına da itiraz ediyorum.')`, [caseId])).rows[0];
  assert.equal(r2.round, 2);
  assert.equal(r2.respondent_id, B);
  await su(`update public.court_appeals set reply_deadline = now() - interval '1 minute' where id = $1`, [r2.id]);
  await rejects(as(B, `select * from public.reply_appeal($1, 'Geç kaldım')`, [r2.id]), /REPLY_DEADLINE_PASSED/);
  const listed = await as('service', `select * from public.list_claimable_appeals(10)`);
  assert.ok(listed.rows.some((x) => Object.values(x)[0] === r2.id));
  const claimed = (await as('service', `select * from public.claim_appeal_for_verdict($1)`, [r2.id])).rows[0];
  assert.equal(claimed.reply_timed_out, true);
  assert.match(claimed.respondent_reply, /cevap vermemiştir/);
  await as('service', `select public.fail_appeal_verdict($1, 'Gemini 503')`, [r2.id]);
  const failed = (await su(`select status, last_error, respondent_reply from public.court_appeals where id = $1`, [r2.id])).rows[0];
  assert.equal(failed.status, 'AWAITING_REPLY');
  assert.equal(failed.last_error, 'Gemini 503');
  assert.match(failed.respondent_reply, /cevap vermemiştir/);
  await as('service', `select * from public.claim_appeal_for_verdict($1)`, [r2.id]);
  await as('service', `select * from public.complete_appeal_verdict($1, 'İkinci istinaf', 'Şerh', 50, 50, 'Beraber çamaşır')`, [r2.id]);
  assert.equal(await caseStatus(caseId), 'JUDGED');
  await rejects(as(B, `select * from public.file_appeal($1, 'Üçüncü kez itiraz ediyorum.')`, [caseId]), /APPEAL_LIMIT_REACHED/);
});

await test('12 h window runs from the latest verdict', async () => {
  // Fresh JUDGED case for D/E, judged 13 h ago.
  const de = (await as(D, `select * from public.file_case('Kumanda', 'OTHER', 'Kumanda yine ortada yok.')`)).rows[0].id;
  await as(E, `select * from public.submit_defense($1, 'Ben kullanmadım.')`, [de]);
  await as('service', `select * from public.claim_case_for_verdict($1)`, [de]);
  await as('service', `select * from public.complete_verdict($1, 'h', 's', 60, 40, 'p')`, [de]);
  await su(`update public.court_cases set judged_at = now() - interval '13 hours' where id = $1`, [de]);
  await rejects(as(E, `select * from public.file_appeal($1, 'Süre geçti ama deniyorum.')`, [de]), /APPEAL_WINDOW_CLOSED/);
  await su(`update public.court_cases set judged_at = now() - interval '11 hours' where id = $1`, [de]);
  const a1 = (await as(E, `select * from public.file_appeal($1, 'Süre içinde itiraz ediyorum.')`, [de])).rows[0];
  await as(D, `select * from public.reply_appeal($1, 'Kumandayı o saklıyor.')`, [a1.id]);
  await as('service', `select * from public.claim_appeal_for_verdict($1)`, [a1.id]);
  await as('service', `select * from public.complete_appeal_verdict($1, 'h', 's', 50, 50, 'p')`, [a1.id]);
  // Round 2's window is measured from round 1's verdict, not the original one.
  await su(`update public.court_appeals set judged_at = now() - interval '13 hours' where id = $1`, [a1.id]);
  await rejects(as(D, `select * from public.file_appeal($1, 'İkinci tur, süre geçti.')`, [de]), /APPEAL_WINDOW_CLOSED/);
  assert.equal((await as(A, `select count(*)::int n from public.court_appeals where case_id = $1`, [de])).rows[0].n, 0);
});

console.log('Leave couple');
const SHARED = ['court_cases', 'court_appeals', 'plans', 'delayed_messages', 'pending_questions', 'wheel_options', 'wheel_spins'];
const sharedCounts = async (cid) => {
  const out = {};
  for (const t of SHARED) out[t] = (await su(`select count(*)::int n from public.${t} where couple_id = $1`, [cid])).rows[0].n;
  return out;
};

await test('stranger cannot leave anyone’s couple; anon cannot call it', async () => {
  await rejects(as(C, `select public.leave_couple()`), /NOT_PAIRED/);
  await rejects(as('anon', `select public.leave_couple()`), /permission denied/);
});

await test('A leaves: couple + every shared row deleted, personal rows kept, only B notified', async () => {
  const cid = (await su(`select id from public.couples where user_a_id = $1`, [A])).rows[0].id;
  const de = (await su(`select id from public.couples where user_a_id = $1`, [D])).rows[0].id;
  // An unsent cooling-off message must vanish without ever being released.
  const pending = (await as(B, `select id from public.schedule_delayed_message('Gönderilmeyecek gizli mesaj', 15)`)).rows[0].id;
  // Already due: if it survived the leave, the release job below would send it.
  await su(`update public.delayed_messages set created_at = now() - interval '30 minutes', release_at = now() - interval '1 second' where id = $1`, [pending]);
  const before = await sharedCounts(cid);
  for (const t of ['court_cases', 'court_appeals', 'plans', 'delayed_messages', 'wheel_options', 'wheel_spins']) {
    assert.ok(before[t] > 0, `fixture has no ${t}`);
  }
  const otherBefore = await sharedCounts(de);
  const tokens = (await su(`select count(*)::int n from public.push_tokens where user_id in ($1, $2)`, [A, B])).rows[0].n;
  const calls = (await su(`select coalesce(max(id), 0)::int n from net.calls`)).rows[0].n;

  await as(A, `select public.leave_couple()`);

  assert.equal((await su(`select count(*)::int n from public.couples where id = $1`, [cid])).rows[0].n, 0);
  assert.deepEqual(await sharedCounts(cid), Object.fromEntries(SHARED.map((t) => [t, 0])));
  assert.deepEqual(await sharedCounts(de), otherBefore);
  assert.equal((await su(`select count(*)::int n from public.profiles where id in ($1, $2)`, [A, B])).rows[0].n, 2);
  assert.equal((await su(`select count(*)::int n from public.push_tokens where user_id in ($1, $2)`, [A, B])).rows[0].n, tokens);

  const sent = await su(`select body from net.calls where id > $1 order by id`, [calls]);
  assert.deepEqual(sent.rows.map((r) => [r.body.type, r.body.user_id]), [['COUPLE_ENDED', B]]);
  assert.ok(!JSON.stringify(sent.rows[0].body).includes('gizli'));
  assert.equal((await as('service', `select public.release_due_messages() n`)).rows[0].n, 0);
});

await test('after leaving: neither side is paired, B cannot leave twice, nothing visible', async () => {
  for (const who of [A, B]) {
    assert.equal((await as(who, `select (public.my_active_couple()).id`)).rows[0].id, null);
    for (const t of SHARED) assert.equal((await as(who, `select count(*)::int n from public.${t}`)).rows[0].n, 0, `${t} still visible`);
  }
  await rejects(as(B, `select public.leave_couple()`), /NOT_PAIRED/);
  await rejects(as(B, `select * from public.file_case('Yeni dava', 'OTHER', 'Eşleşme yokken dava açılamaz.')`), /NOT_PAIRED/);
});

await test('both can pair again immediately', async () => {
  const code = (await as(A, `select * from public.create_pairing_code()`)).rows[0].pairing_code;
  const r = await as(B, `select * from public.pair_with_code($1)`, [code]);
  assert.equal(r.rows[0].is_active, true);
});

console.log('Schedules');
await test('cron jobs registered', async () => {
  const r = await su(`select name from cron.jobs order by name`);
  assert.deepEqual(r.rows.map((x) => x.name), ['duosync-court-sweep', 'duosync-prune-pairing-attempts', 'duosync-release-messages']);
});

// supabase/verify/live_check.sql reads the real catalog names; add those on
// top of the stubs and simulate a correctly configured project.
console.log('Live check script');
const liveCheck = readFileSync(join(here, '..', 'verify', 'live_check.sql'), 'utf8');
await db.exec(`
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key);
insert into supabase_migrations.schema_migrations values ('20261008000000'), ('20261008000100'), ('20261031000000'), ('20261031000100'), ('20261102000000');
create view cron.job as
  select row_number() over (order by name)::bigint as jobid, name as jobname, schedule, command, true as active
  from cron.jobs;
create table cron.job_run_details (jobid bigint, status text, return_message text, start_time timestamptz);
insert into cron.job_run_details
  select jobid, 'succeeded', '1 row', now() - interval '30 seconds' from cron.job;
create table net._http_response (
  id bigint generated always as identity, status_code int, content text,
  timed_out bool default false, error_msg text, created timestamptz default now());
insert into net._http_response (status_code, content) values (202, '{"accepted":true,"task":"sweep"}');
update vault.decrypted_secrets set decrypted_secret = repeat('ab', 32) where name = 'duosync_internal_secret';
update vault.decrypted_secrets set decrypted_secret = 'https://abcdefghijklmnopqrst.supabase.co'
  where name = 'duosync_project_url';
`);
// Check 2 (pg_cron/pg_net in pg_extension) cannot pass on PGlite: both are stubbed schemas.
const failingRows = async () =>
  (await su(liveCheck)).rows.filter((r) => !r.ok && r.n !== 2).map((r) => `${r.n} ${r.item}: ${r.detail}`);

await test('healthy project: all checks pass', async () => {
  assert.equal((await su(liveCheck)).rows.length, 14);
  assert.deepEqual(await failingRows(), []);
});

await test('misconfigurations are flagged on the right row', async () => {
  await db.exec(`
    insert into net._http_response (status_code, content) values (403, '{"error":"FORBIDDEN"}');
    insert into cron.job_run_details
      select jobid, 'failed', 'ERROR: boom', now() from cron.job where jobname = 'duosync-court-sweep';
    update vault.decrypted_secrets set decrypted_secret = 'short' where name = 'duosync_internal_secret';
    update vault.decrypted_secrets set decrypted_secret = 'https://abc.supabase.co/functions/v1'
      where name = 'duosync_project_url';
    create table public.leaky (id int);
    grant execute on function public.release_due_messages() to authenticated;
    revoke select on public.court_cases from service_role;
  `);
  const nums = (await failingRows()).map((s) => Number(s.split(' ')[0]));
  assert.deepEqual(nums, [4, 6, 7, 8, 9, 12, 14]);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
