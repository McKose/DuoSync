# DuoSync — working notes for Claude Code

Strictly 1-to-1 couples app. Read README.md for setup, architecture and the
table of deliberate deviations from the original spec. The original spec's SQL
and Edge Function snippets are **superseded** by the files below — do not
copy them back in (they contained an UPDATE-policy hole and an unauthenticated
verdict endpoint).

## Source of truth
- Schema / RLS / RPCs: `supabase/migrations/20261008000000_init_schema.sql`
- Cron + webhooks:     `supabase/migrations/20261008000100_jobs_and_webhooks.sql`
- Types:               `src/types/database.types.ts` (hand-maintained in generator shape;
                       regenerate with `supabase gen types` after schema changes)

## Non-negotiable rules
1. Every couple-scoped table: SELECT via `public.is_couple_member(couple_id)`.
   New write paths with business rules go through `SECURITY DEFINER` RPCs with
   `SET search_path = ''`; revoke EXECUTE from public/anon/authenticated, then
   grant explicitly.
2. AI court: the LLM is only reachable through `claim_case_for_verdict()`.
   Never pass pleas in an Edge Function request body.
3. Cooling-off: recipient SELECT policy must stay `status = 'SENT'`. Any new
   trigger/notification on `delayed_messages` must fire only on PENDING→SENT.
4. Battery: no background tasks/listeners/polling. `useBatterySync` only.
5. Checklist: mutate only through `upsert_checklist_item` (per-item LWW).

## Before declaring work done
```
npm run typecheck
npm run test:db                         # add a test for every new RLS/RPC rule
deno test supabase/functions/_shared
```

## Conventions
- Dependencies: `EXPO_OFFLINE=1 npx expo install <pkg>` (SDK-matched versions).
- Navigation: React Navigation (spec requirement), not Expo Router.
- Errors: RPCs raise `P0001` with an UPPER_SNAKE code; add the Turkish copy to
  `src/lib/errors.ts`.
- UI copy is Turkish; code and comments are English.
