# DuoSync — Claude Code working notes

Strictly 1-to-1 couples app (Expo + Supabase + Gemini). UI copy is Turkish;
code, comments and commit messages are English.

- Product + architecture + spec deviations: `README.md`
- Status, open tasks, acceptance criteria: @docs/ROADMAP.md  ← start here

The original chat spec's SQL / Edge Function snippets are **superseded** by
the files in this repo. Never copy them back (they contained an UPDATE-policy
hole and an unauthenticated verdict endpoint).

## Stack (actual, from package.json — not the old spec)
Expo SDK 57 · RN 0.86 · TS strict · NativeWind 4.2 (Tailwind 3) · Reanimated 4 ·
React Navigation 7 (NOT Expo Router) · Zustand 5 · TanStack Query 5 (+ AsyncStorage
persist) · Supabase (Postgres/RLS, Realtime, Edge Functions on Deno, pg_cron,
pg_net, Vault) · Gemini Flash via `GEMINI_MODEL` env (default `gemini-3.8-flash`,
**unverified against the live API**).

## Repo map
| Path | What |
|---|---|
| `supabase/migrations/20261008000000_init_schema.sql` | Tables, enums, RLS, all RPCs (source of truth) |
| `supabase/migrations/20261008000100_jobs_and_webhooks.sql` | pg_cron jobs, pg_net triggers → Edge Functions |
| `supabase/migrations/20261031000000_decision_wheel.sql` | Decision wheel tables, RLS, RPCs (C1) |
| `supabase/migrations/20261031000100_leave_couple.sql` | `leave_couple()`: unpair, cascade-delete all shared data (B2) |
| `supabase/migrations/20261102000000_appeals.sql` | Appeals (C3): `court_appeals`, reply lock, 12 h / 2-round rules, webhooks |
| `supabase/functions/ai-court-verdict/` | Claims case or appeal via RPC, calls Gemini, validates JSON, writes verdict |
| `supabase/functions/send-push-notification/` | Expo push sender (internal-secret auth) |
| `supabase/functions/_shared/verdict.ts` | Case + appeal prompts, schema validation, fault normalization, injection fence (+ `.test.ts`) |
| `supabase/tests/rls.test.mjs` | 65 PGlite tests: migrations, RLS, RPC rules, cross-couple isolation, decision wheel, appeals, leave couple, live-check script |
| `supabase/verify/live_check.sql` | Read-only post-setup check for the live project (A1/A2); run in SQL editor |
| `src/api/*` | One module per domain; **first line of every fn: `if (IS_DEMO) return demo.…`** |
| `src/demo/` | In-device fake backend mirroring server rules; partner bot "Deniz"; offline judge |
| `src/hooks/` | Query/mutation hooks, `useRealtimeSubscription`, `useBatterySync`, `usePushRegistration` |
| `src/store/useCoupleStore.ts` | Zustand: session, profile, couple |
| `src/lib/errors.ts` | P0001 error code → Turkish message map |
| `src/types/database.types.ts` | Hand-maintained in generator shape; regenerate after schema change |
| `src/lib/wheel.ts` | Wheel limits shared with the server + pure landing geometry (both phones stop on the same spot) |
| `src/lib/appeals.ts` | Appeal limits + `appealView()`: rounds, can-appeal, which verdict counts |
| `tests/demo/engine.test.ts` | 31 demo contract tests |
| `tests/e2e/demo.e2e.mjs` | Puppeteer E2E on web demo export (14 steps) |
| `.github/workflows/ci.yml` · `android-apk.yml` | CI (lint/type/db/demo/deno/e2e) · demo APK build (push to `apk-build` branch) |

### Schema objects
Tables: `profiles, couples, pairing_attempts, push_tokens, court_cases, plans,
delayed_messages, pending_questions, wheel_options, wheel_spins, court_appeals`. Enums: `case_status`
(incl. `DELIBERATING`, `APPEALED` while a round is open), `appeal_status`, `message_status`
(`PENDING/SENT/CANCELLED`), `partner_status`.
Client RPCs: `create_pairing_code, pair_with_code, my_active_couple, update_my_presence,
file_case, submit_defense, upsert_checklist_item, schedule_delayed_message,
cancel_delayed_message, ask_question, answer_question, add_wheel_option,
remove_wheel_option, spin_wheel, leave_couple, file_appeal, reply_appeal`.
Service-only RPCs: `claim_case_for_verdict, complete_verdict, fail_verdict,
list_claimable_cases, release_due_messages, claim_appeal_for_verdict, complete_appeal_verdict,
fail_appeal_verdict, list_claimable_appeals`.
Cron: `duosync-release-messages` (1 min), `duosync-court-sweep` (10 min),
`duosync-prune-pairing-attempts`.

## Non-negotiable rules
1. **Isolation.** Every couple-scoped table: SELECT via `public.is_couple_member(couple_id)`.
   Business-rule writes go through `SECURITY DEFINER` RPCs with `SET search_path = ''`;
   `REVOKE EXECUTE ... FROM public, anon, authenticated`, then grant explicitly.
   Add a third-party-user isolation test for every new table/RPC.
2. **AI court.** The LLM is reachable only through `claim_case_for_verdict()`, which
   returns an empty set unless the defense exists OR 24 h elapsed (appeals:
   `claim_appeal_for_verdict()`, reply exists OR 12 h elapsed). Never accept pleas,
   appeal reasons or replies in an Edge Function request body. Output: judge text, comedian text,
   `fault_ratio_plaintiff + fault_ratio_defendant = 100` (DB CHECK), practical sanction.
3. **Cooling-off.** Recipient SELECT policy stays `status = 'SENT'`. Cancel = silent
   `CANCELLED`; no event, notification or "deleted" marker may reach the recipient.
   Any trigger on `delayed_messages` fires only on `PENDING → SENT`.
   Accepted exception (user, 2026-11-02): at unpair, Supabase Realtime sends PK-only DELETE
   frames for every deleted row, unsent ones included (ROADMAP B2, option a).
4. **Battery.** No background tasks, listeners or polling. Only `useBatterySync`
   (single read on AppState → active, throttled 2 min / 5 %).
5. **Checklist.** Mutate only via `upsert_checklist_item` (per-item LWW, clock-skew cap).
6. **Demo parity.** Any change to an RPC, policy or error code must be mirrored in
   `src/demo/engine.ts` and covered in `tests/demo/engine.test.ts`.
7. **Errors.** RPCs raise `P0001` with an UPPER_SNAKE code; add Turkish copy in
   `src/lib/errors.ts`. Every async UI path shows loading + error + retry
   (`components/common/StateViews.tsx`, `OfflineBanner`).
8. **No placeholders.** No `// TODO` stubs in delivered code; ship complete, typed code.

## Environment cautions
- The Supabase MCP connected to this account points at a **different project**
  (`jvkytncwedjcvssilhih`, gym app). **Do not apply DuoSync migrations or deploy
  functions there.** DuoSync has its own project since 2026-10-31: ref `gfjkepyaubdstinqgtqw`.
  Before any live call, check `get_project_url` returns that ref.
- Never commit `.env`, API keys or Vault secrets. Vault secrets are created by hand
  in the SQL editor (see README §Kurulum).
- Dependencies: `EXPO_OFFLINE=1 npx expo install <pkg>` for SDK-matched versions.
- Web: `Alert.alert` / `window.confirm` are no-ops → use `src/lib/confirm.ts` + `ConfirmHost`.

## Definition of done
```bash
npm run lint && npm run typecheck
npm run test:db          # + new test for every RLS/RPC rule
npm run test:functions   # runs inside supabase/functions (own deno.json)
npm run test:demo
# UI change → run tests/e2e/demo.e2e.mjs (see file header); also runs in CI
```
Then update the status table in `docs/ROADMAP.md`.
