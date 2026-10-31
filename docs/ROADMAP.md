# DuoSync — Status & Roadmap

Last updated: 2026-10-31 (first Claude Code session: baseline re-verified, target decided, A1 check script, C1 decision wheel).
Keep this file current: tick tasks, add findings, never delete history rows.

## 1. History (what has been done)

| Date | Work | Result |
|---|---|---|
| 2026-10-08 | Full 4-phase implementation from the Turkish product spec: schema + RLS + RPCs, AI court Edge Function, push function, all screens | 13 documented deviations from spec to close security holes (README §Spec'ten sapmalar) |
| 2026-10-08 | Verification harness: PGlite RLS suite, Deno unit tests, Android Hermes export | 40 → 43 DB tests green |
| 2026-10-09..12 | Bug-hunt pass: Realtime channel-reuse race, court sweep exceeding Edge wall-clock, notification tap before nav ready, stale "auto-retry" UI after max attempts, +5 others; ESLint (react-hooks, `exhaustive-deps`=error); GitHub Actions CI; Deno resolved npm against root package.json → fixed with `supabase/functions/deno.json` | CI green |
| 2026-10-12 | **Demo mode** (`src/demo/`): offline backend mirroring every server rule, partner bot "Deniz", deterministic non-AI judge, control panel (offline sim, time scale, latency). Auto-enabled when Supabase env vars are absent | 20 demo contract tests |
| 2026-10-12 | Puppeteer E2E on web export → found & fixed: crash on partner join (status flipped before store), clipped tab labels, web confirm dialogs no-op (→ `ConfirmHost`), share fallback | E2E 11/11 in CI, screenshots uploaded |
| 2026-10-13 | `android-apk.yml`: prebuild + Gradle assembleRelease (arm64-v8a, armeabi-v7a), debug-signed, demo baked in. Triggers: manual, push to `apk-build`, `v*` tag | 23 MB APK built (~15 min) |
| 2026-10-30 | Audit + roadmap: typecheck 0, test:db 43/43, test:demo 20/20 re-run. **No live backend exists**; never run on a physical device | This roadmap |
| 2026-10-31 | Claude Code session start: full DoD re-run in a clean container (lint 0, typecheck 0, test:functions 7/7, test:demo 20/20). Decision §3 = **personal use**. Added `supabase/verify/live_check.sql` (13 read-only checks for A1 + A2 pre-checks, secrets never selected) + 2 PGlite tests (healthy project passes; 6 injected misconfigs flagged on the right row) | test:db 45/45; A1 waiting on user |
| 2026-10-31 | **C1 decision wheel** built while A1 waits on the user: migration `20261031000000_decision_wheel.sql` (`wheel_options`, `wheel_spins`, RPCs `add_wheel_option` / `remove_wheel_option` / `spin_wheel`, SELECT-only RLS, Realtime), demo mirror + panel action "Deniz çarkı çevirsin", `DecisionWheelScreen` built with core `Animated` + plain Views (no SVG/Reanimated → no new device risk ahead of A4). Mutation-tested: dropping the cooldown or granting direct INSERT each fails a test. Fixed during E2E review: labels were oriented for the unrotated wheel and read upside down at rest | test:db 54/54, test:demo 24/24, E2E 12/12 |

## 2. Current state

| Area | State |
|---|---|
| AI Mahkemesi (file → defense / 24 h timeout → verdict) | ✅ code + tests, ❌ never hit live Gemini |
| Soğuma Odası (15–60 min delay, silent cancel) | ✅ code + tests, ❌ live Realtime leak test pending |
| Soru Kasası | ✅ |
| Canlı Masa: plans + checklist (offline, per-item LWW) | ✅ |
| Canlı Masa: karar çarkı / tie-breaker | ✅ code + tests (server, demo, E2E), ❌ not yet on 2 physical phones (A5) |
| Pasif pil / durum senkronu | ✅ |
| **Acil durum alarmı (sessiz modu aşan)** | ❌ not started |
| İstinaf (`APPEALED`) | ❌ enum only, no rules defined |
| Hesap silme / eşleşme bozma | ❌ not started |
| Live Supabase project | ❌ none |
| Physical device run | ❌ never |

## 3. Product decisions

**Target — DECIDED 2026-10-31: personal use (two Android phones, sideloaded APK).**
- Order: A → C, then B2/B4. B1, B3, D1 deferred until a store release is decided (backlog trigger).
- Correction to the earlier estimate: this does **not** halve the dev work. Deferred dev effort is
  B1 1 d + B3 1 d + D1 ≈ 0.5 d ≈ 2.5 d of 12–15 d (~20 %). The larger saving is non-dev: no legal
  text, privacy policy, store listing or Play declarations (e.g. `USE_FULL_SCREEN_INTENT` for C2).
- Store → order below as written; C2 on iOS is limited to *Time Sensitive*.

A1 setup is done **by the user** (project creation, keys, `db push`, deploy); Claude verifies.

**C3 appeal rules — DECIDED 2026-10-31 (user):** 12 h appeal window, at most 2 appeals.
Still open before building C3: per case or per person; who may appeal (either party vs. the one found
more at fault); can the other side reply (proposed: yes, 12 h, then judged anyway); does a new verdict
replace or stack (proposed: history kept, latest one counts).

**B2 data lifecycle — DECIDED 2026-10-31 (user):** on unpair all shared data is **deleted**.

## 4. Tasks

Effort in developer-days. Each task: do it, satisfy acceptance, run Definition of Done (CLAUDE.md), update §2.

### Phase A — Go live (blocks everything)

- [ ] **A1. Dedicated Supabase project** (0.5 d)
  Create a new project (NOT the gym project the MCP is linked to). `supabase link`, `db push`,
  create Vault secrets `duosync_project_url`, `duosync_internal_secret`; set function secrets
  `GEMINI_API_KEY`, `INTERNAL_WEBHOOK_SECRET`, optional `GEMINI_MODEL`; deploy both functions.
  *Accept:* `list_migrations` shows all 3 migrations; `cron.job` has 3 DuoSync jobs; both functions ACTIVE.
  Requires user: project creation, API keys.
  *Verify:* ≥ 10 min after deploy run `supabase/verify/live_check.sql` in the SQL editor → all 13 rows
  `ok = true` (row 8 proves URL + secret + deploy end-to-end via the sweep's 202); `npx supabase functions list` → both ACTIVE.
- [ ] **A2. Advisor audit** (0.5 d)
  Run security + performance advisors; fix every ERROR/WARN in a new migration; mirror in tests.
  *Accept:* zero security ERRORs; WARNs either fixed or justified in this file.
  Predicted from the schema (confirm against real advisor output):
  - Performance WARN `multiple_permissive_policies` on `delayed_messages` (sender + recipient SELECT
    policies for `authenticated`). Proposed: justify, do not merge — 2-user scale makes the cost nil,
    and a merged OR-policy obscures rule #3 (recipient sees only `SENT`).
  - INFO `rls_enabled_no_policy` on `pairing_attempts` — intentional deny-all (RPC-only access).
  - `auth_rls_initplan` not expected: all policies already use `(select auth.uid())`.
- [ ] **A3. Gemini live check** (0.5 d)
  Verify model id exists (`GET /v1beta/models`), `responseSchema` accepted, one real verdict
  stored with ratios summing to 100. Update default model if needed.
  *Accept:* a `court_cases` row reaches `JUDGED` from a real call; function logs clean.
  (Was "`DECIDED`" until 2026-10-31 — no such `case_status` value; a check on it would never match.)
- [ ] **A4. Android dev build on 2 physical phones** (1–2 d)
  `eas init`, `eas build --profile development -p android`. Walk every screen.
  If NativeWind 4.2 + Reanimated 4 + RN 0.86 breaks, record it here and decide: NativeWind 5 RC vs StyleSheet.
  *Accept:* all screens render; no red box; push token registered for both users.
- [ ] **A5. Live verification matrix** (1 d)
  | Scenario | Expected |
  |---|---|
  | File case → partner defends | verdict within ~1 min, push to both |
  | File case → no defense | sweep claims after 24 h (temporarily lower interval in a branch DB to test) |
  | Cooling-off cancel before due | recipient receives **zero** Realtime frames / pushes (inspect WS traffic) |
  | Cooling-off due | delivered ≤ 60 s late, push sent |
  | Checklist concurrent edits on 2 phones, one offline | both items survive, no loss |
  | Battery | update only on foreground; none while backgrounded |
  | Third user | sees nothing, cannot write |
  | Decision wheel: A spins while B has the screen open | B animates to the same segment and label; B's spin within 10 s → `SPIN_COOLDOWN` |
  *Accept:* all rows pass; results table pasted here.

### Phase B — Lifecycle & security (store-blocking)

- [ ] **B1. Account deletion** (1 d) — *deferred (personal use)* — RPC to tear down couple data + Edge Function calling
  `auth.admin.deleteUser`; in-app entry point. Required by Apple 5.1.1(v) and Google Play.
  *Accept:* deleting user A leaves no A rows; partner B returns cleanly to pairing screen; RLS test added; demo mirrored.
- [ ] **B2. Unpair / leave couple** (1 d) — design together with B1 (same data lifecycle).
  Decide: are shared rows (cases, plans) deleted or archived? Ask user.
- [ ] **B3. KVKK notice + explicit consent screen** (1 d + legal) — *deferred (personal use)* — pleas are sent to Google
  (cross-border transfer, KVKK art. 9). Block court usage until consent recorded per user.
  Legal text must come from the user/lawyer; Claude provides the mechanism only.
- [ ] **B4. Encrypted session storage** (0.5 d) — AES key in SecureStore, encrypted AsyncStorage
  adapter for the Supabase client (SecureStore alone hits 2 KB limit).

### Phase C — Missing modules

- [x] **C1. Decision wheel "Ne yesek?"** (1.5 d) — done 2026-10-31; two-phone check moved into the A5 matrix
  Result must be produced **server-side** (RPC selecting with `gen_random_uuid()`/`random()` inside
  SECURITY DEFINER) and stored, so neither partner can manipulate it; both screens animate to the
  same stored result via Realtime. Options list editable by both.
  *Accept:* same result on both phones; client cannot write the result column; RLS + demo tests.
  *Delivered:* draw = `order by gen_random_uuid() limit 1` inside `spin_wheel()`; the row stores the option
  snapshot + index + label (`CHECK` ties label to snapshot), so the landing angle is a pure function of the row
  (`src/lib/wheel.ts`, offset seeded by spin id). Clients have SELECT only (direct INSERT/UPDATE/DELETE →
  `permission denied`, tested). Limits: 12 options, 30 chars, case-insensitive duplicates, 10 s couple-wide
  cooldown (> 4 s animation), last 20 spins kept. Known: Realtime DELETE events on `wheel_options` are not
  RLS-filtered by Supabase (PK only, no label) — same as `plans`; the client just refetches.
- [ ] **C2. Emergency alarm that bypasses silent mode** (2–3 d)
  Android: high-importance channel with bypass-DND + `USE_FULL_SCREEN_INTENT` (Play declaration on
  Android 14+). iOS: *Critical Alerts* needs Apple entitlement (unlikely to be granted) → fall back to
  `interruptionLevel: time-sensitive`. Rate-limit server-side to prevent abuse.
  *Accept:* on Android with DND on, alarm sounds; iOS behavior documented here.
- [ ] **C3. Appeal flow (`APPEALED`)** (1.5 d) — blocked on rules from user (§3).

### Phase D — Closed beta
- [ ] **D1.** — *deferred (personal use; sideloaded APK)* — Play internal testing track; production signing via `eas build --profile production`.
- [ ] **D2.** Gemini cost/quota monitoring (log tokens per call, alert threshold).

### Backlog (trigger-based)
| Task | Trigger |
|---|---|
| `push_tokens` PK → `(user_id, token)` | a user uses a second device |
| Cooling-off latency < 60 s via Supabase Queues | user complaint |
| Store assets, iOS build | store decision |
| B1, B3, D1 | store decision |

## 5. Estimates
Remaining ≈ 12–15 dev-days solo (A ≈ 4, B ≈ 3.5, C ≈ 5–6, D ≈ 1). Evening/weekend pace ≈ 4–6 weeks.
Personal-use path (2026-10-31): A ≈ 4, B2 + B4 ≈ 1.5, C ≈ 5–6, D2 ≈ 0.5 → ≈ 11–12 dev-days.
Rationale for order: building features before A means building on an unverified base; a device-level
NativeWind/Reanimated failure would force rewrites of C's UI.
