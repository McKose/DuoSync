# DuoSync — Status & Roadmap

Last updated: 2026-10-31 (handoff from claude.ai chat sessions to Claude Code).
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

## 2. Current state

| Area | State |
|---|---|
| AI Mahkemesi (file → defense / 24 h timeout → verdict) | ✅ code + tests, ❌ never hit live Gemini |
| Soğuma Odası (15–60 min delay, silent cancel) | ✅ code + tests, ❌ live Realtime leak test pending |
| Soru Kasası | ✅ |
| Canlı Masa: plans + checklist (offline, per-item LWW) | ✅ |
| Canlı Masa: **karar çarkı / tie-breaker** | ❌ not started |
| Pasif pil / durum senkronu | ✅ |
| **Acil durum alarmı (sessiz modu aşan)** | ❌ not started |
| İstinaf (`APPEALED`) | ❌ enum only, no rules defined |
| Hesap silme / eşleşme bozma | ❌ not started |
| Live Supabase project | ❌ none |
| Physical device run | ❌ never |

## 3. Open product decision — ASK THE USER BEFORE PHASE B

**Target: personal use (two phones, sideloaded APK) or store release?**
- Personal → B1, B3 can be deferred; go A → C. Roughly halves the remaining work.
- Store → order below as written; C2 on iOS is limited to *Time Sensitive*.

Also unresolved: appeal (C3) rules — who may appeal, how many times, within what window.

## 4. Tasks

Effort in developer-days. Each task: do it, satisfy acceptance, run Definition of Done (CLAUDE.md), update §2.

### Phase A — Go live (blocks everything)

- [ ] **A1. Dedicated Supabase project** (0.5 d)
  Create a new project (NOT the gym project the MCP is linked to). `supabase link`, `db push`,
  create Vault secrets `duosync_project_url`, `duosync_internal_secret`; set function secrets
  `GEMINI_API_KEY`, `INTERNAL_WEBHOOK_SECRET`, optional `GEMINI_MODEL`; deploy both functions.
  *Accept:* `list_migrations` shows both migrations; `cron.job` has 3 DuoSync jobs; both functions ACTIVE.
  Requires user: project creation, API keys.
- [ ] **A2. Advisor audit** (0.5 d)
  Run security + performance advisors; fix every ERROR/WARN in a new migration; mirror in tests.
  *Accept:* zero security ERRORs; WARNs either fixed or justified in this file.
- [ ] **A3. Gemini live check** (0.5 d)
  Verify model id exists (`GET /v1beta/models`), `responseSchema` accepted, one real verdict
  stored with ratios summing to 100. Update default model if needed.
  *Accept:* a `court_cases` row reaches `DECIDED` from a real call; function logs clean.
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
  *Accept:* all rows pass; results table pasted here.

### Phase B — Lifecycle & security (store-blocking)

- [ ] **B1. Account deletion** (1 d) — RPC to tear down couple data + Edge Function calling
  `auth.admin.deleteUser`; in-app entry point. Required by Apple 5.1.1(v) and Google Play.
  *Accept:* deleting user A leaves no A rows; partner B returns cleanly to pairing screen; RLS test added; demo mirrored.
- [ ] **B2. Unpair / leave couple** (1 d) — design together with B1 (same data lifecycle).
  Decide: are shared rows (cases, plans) deleted or archived? Ask user.
- [ ] **B3. KVKK notice + explicit consent screen** (1 d + legal) — pleas are sent to Google
  (cross-border transfer, KVKK art. 9). Block court usage until consent recorded per user.
  Legal text must come from the user/lawyer; Claude provides the mechanism only.
- [ ] **B4. Encrypted session storage** (0.5 d) — AES key in SecureStore, encrypted AsyncStorage
  adapter for the Supabase client (SecureStore alone hits 2 KB limit).

### Phase C — Missing modules

- [ ] **C1. Decision wheel "Ne yesek?"** (1.5 d)
  Result must be produced **server-side** (RPC selecting with `gen_random_uuid()`/`random()` inside
  SECURITY DEFINER) and stored, so neither partner can manipulate it; both screens animate to the
  same stored result via Realtime. Options list editable by both.
  *Accept:* same result on both phones; client cannot write the result column; RLS + demo tests.
- [ ] **C2. Emergency alarm that bypasses silent mode** (2–3 d)
  Android: high-importance channel with bypass-DND + `USE_FULL_SCREEN_INTENT` (Play declaration on
  Android 14+). iOS: *Critical Alerts* needs Apple entitlement (unlikely to be granted) → fall back to
  `interruptionLevel: time-sensitive`. Rate-limit server-side to prevent abuse.
  *Accept:* on Android with DND on, alarm sounds; iOS behavior documented here.
- [ ] **C3. Appeal flow (`APPEALED`)** (1.5 d) — blocked on rules from user (§3).

### Phase D — Closed beta
- [ ] **D1.** Play internal testing track; production signing via `eas build --profile production`.
- [ ] **D2.** Gemini cost/quota monitoring (log tokens per call, alert threshold).

### Backlog (trigger-based)
| Task | Trigger |
|---|---|
| `push_tokens` PK → `(user_id, token)` | a user uses a second device |
| Cooling-off latency < 60 s via Supabase Queues | user complaint |
| Store assets, iOS build | store decision |

## 5. Estimates
Remaining ≈ 12–15 dev-days solo (A ≈ 4, B ≈ 3.5, C ≈ 5–6, D ≈ 1). Evening/weekend pace ≈ 4–6 weeks.
Rationale for order: building features before A means building on an unverified base; a device-level
NativeWind/Reanimated failure would force rewrites of C's UI.
