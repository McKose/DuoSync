// DuoSync — AI Court verdict Edge Function.
//
// Callers:
//   1. DB webhook (pg_net) right after the defendant submits a defense
//      → { case_id }          header x-internal-secret
//   2. pg_cron sweep every 10 min (24h timeouts, retries, stale workers)
//      → { mode: "sweep" }    header x-internal-secret
//   3. The mobile client as a fallback after submitting a defense
//      → { case_id }          header Authorization: Bearer <user JWT>
//
// The defense lock is enforced in the database by claim_case_for_verdict():
// the LLM is never called unless the defendant has pleaded or the 24h
// deadline has passed, and only one worker can hold a case at a time.
// Request bodies never carry pleas — the function reads them from the DB,
// so a client cannot inject a fabricated defense.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { bearerToken, corsHeaders, isInternalCall, json, requireEnv } from '../_shared/http.ts';
import {
  buildUserPrompt,
  extractCandidateText,
  parseVerdict,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  VerdictValidationError,
  type CaseForJudgement,
} from '../_shared/verdict.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_API_KEY = requireEnv('GEMINI_API_KEY');
// gemini-1.5-flash (in the original spec) was shut down on 2025-09-29.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash';
// Override only for local/integration testing against a stub server.
const GEMINI_BASE_URL = Deno.env.get('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com';

const GEMINI_TIMEOUT_MS = 45_000;
const MAX_LLM_ATTEMPTS = 2; // per claim; the cron sweep retries across claims (cap 5)
const SWEEP_BATCH = 5;
// Wall clock limit is 150 s (Free) / 400 s (paid) per worker, including
// background work. A single case is ≤ ~92 s worst case (2 × 45 s + backoff),
// so we stop *starting* new cases after 50 s: 50 + 92 < 150.
const SWEEP_BUDGET_MS = 50_000;

// Supabase Edge Runtime global (absent under plain `deno`).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/**
 * Internal callers (pg_net webhook, pg_cron) use a 10 s HTTP timeout and
 * never read the response, while an LLM call can take 30–90 s. Acknowledge
 * immediately and keep working in the background so the caller's timeout
 * can't race the judgement.
 */
function runInBackground(label: string, work: () => Promise<unknown>): Response {
  const task = work().catch((e) => console.error(`${label} background failure:`, e));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task);
  return json({ accepted: true, task: label }, 202);
}

async function sweep(): Promise<JudgeOutcome[]> {
  const started = Date.now();
  const { data: ids, error } = await admin.rpc('list_claimable_cases', { p_limit: SWEEP_BATCH });
  if (error) throw new Error(`list_claimable_cases: ${error.message}`);
  const results: JudgeOutcome[] = [];
  for (const id of (ids as string[] | null) ?? []) {
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      console.log(`sweep budget reached; ${results.length} judged, rest deferred to next run`);
      break;
    }
    results.push(await judgeCase(id)); // sequential: bounded LLM concurrency/cost
  }
  console.log('sweep results', JSON.stringify(results));
  return results;
}

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface ClaimedCase extends CaseForJudgement {
  id: string;
  couple_id: string;
}

type JudgeOutcome =
  | { status: 'judged'; case_id: string; adjusted: boolean }
  | { status: 'not_claimable'; case_id: string }
  | { status: 'failed'; case_id: string; error: string };

class RetryableError extends Error {}

async function callGemini(prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          // Header, not ?key= — query strings end up in proxy/access logs.
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.9,
            maxOutputTokens: 4096,
          },
        }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? res.statusText;
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`Gemini ${res.status}: ${msg}`);
      throw new Error(`Gemini ${res.status}: ${msg}`);
    }
    return extractCandidateText(body);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new RetryableError(`Gemini timeout after ${GEMINI_TIMEOUT_MS} ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function judgeCase(caseId: string): Promise<JudgeOutcome> {
  const { data: claimed, error: claimErr } = await admin.rpc('claim_case_for_verdict', { p_case_id: caseId });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const row = (claimed as ClaimedCase[] | null)?.[0];
  if (!row) return { status: 'not_claimable', case_id: caseId };

  const prompt = buildUserPrompt(row);
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      const text = await callGemini(prompt);
      const { verdict, adjusted } = parseVerdict(text);
      const { data: done, error: doneErr } = await admin.rpc('complete_verdict', {
        p_case_id: caseId,
        p_verdict_judge: verdict.verdict_judge,
        p_verdict_comedian: verdict.verdict_comedian,
        p_fault_prosecutor: verdict.fault_ratio_prosecutor,
        p_fault_defendant: verdict.fault_ratio_defendant,
        p_penalty: verdict.penalty,
      });
      if (doneErr) throw new Error(`complete_verdict failed: ${doneErr.message}`);
      if (!(done as unknown[] | null)?.length) {
        // Lost the case to a reclaim after our claim went stale; nothing to do.
        return { status: 'not_claimable', case_id: caseId };
      }
      if (adjusted) console.warn(`[${caseId}] fault ratios normalised to sum 100`);
      return { status: 'judged', case_id: caseId, adjusted };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof RetryableError || e instanceof VerdictValidationError;
      console.error(`[${caseId}] attempt ${attempt} failed: ${lastError}`);
      if (!retryable || attempt === MAX_LLM_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  await admin.rpc('fail_verdict', { p_case_id: caseId, p_error: lastError });
  return { status: 'failed', case_id: caseId, error: lastError };
}

/** For user-initiated calls: the caller must be a party to the case. */
async function assertCaller(req: Request, caseId: string): Promise<Response | null> {
  const jwt = bearerToken(req);
  if (!jwt) return json({ error: 'UNAUTHORIZED' }, 401);
  const { data: auth, error } = await admin.auth.getUser(jwt);
  if (error || !auth.user) return json({ error: 'UNAUTHORIZED' }, 401);

  const { data: c, error: cErr } = await admin
    .from('court_cases')
    .select('prosecutor_id, defendant_id')
    .eq('id', caseId)
    .maybeSingle();
  if (cErr) return json({ error: 'LOOKUP_FAILED' }, 500);
  if (!c || (c.prosecutor_id !== auth.user.id && c.defendant_id !== auth.user.id)) {
    // Same response for "doesn't exist" and "not yours": no existence oracle.
    return json({ error: 'CASE_NOT_FOUND' }, 404);
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

  let body: { case_id?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const internal = isInternalCall(req);

  try {
    if (body.mode === 'sweep') {
      if (!internal) return json({ error: 'FORBIDDEN' }, 403);
      return runInBackground('sweep', sweep);
    }

    const caseId = body.case_id;
    if (typeof caseId !== 'string' || !UUID_RE.test(caseId)) {
      return json({ error: 'INVALID_CASE_ID' }, 400);
    }
    if (internal) {
      return runInBackground(`case:${caseId}`, () => judgeCase(caseId));
    }
    const denied = await assertCaller(req, caseId);
    if (denied) return denied;

    // User-initiated (client fallback): synchronous so the app gets a result.
    const outcome = await judgeCase(caseId);
    const status = outcome.status === 'judged' ? 200 : outcome.status === 'not_claimable' ? 409 : 502;
    return json(outcome, status);
  } catch (e) {
    console.error('ai-court-verdict fatal:', e);
    return json({ error: 'INTERNAL_ERROR' }, 500);
  }
});
