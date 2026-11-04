// DuoSync — AI Court verdict Edge Function.
//
// Callers:
//   1. DB webhook (pg_net) right after the defendant submits a defense
//      → { case_id }          header x-internal-secret
//   2. pg_cron sweep every 10 min (24h timeouts, retries, stale workers)
//      → { mode: "sweep" }    header x-internal-secret
//   3. The mobile client as a fallback after submitting a defense
//      → { case_id }          header Authorization: Bearer <user JWT>
//   4. Appeals (istinaf): the same three paths with { appeal_id } — webhook
//      after the respondent replies, the sweep after the 12 h reply window,
//      the client as a fallback.
//
// The defense lock is enforced in the database by claim_case_for_verdict()
// (appeals: claim_appeal_for_verdict()): the LLM is never called unless the
// other side has answered or its deadline has passed, and only one worker
// can hold a case or appeal at a time.
// Request bodies never carry pleas — the function reads them from the DB,
// so a client cannot inject a fabricated defense.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { bearerToken, corsHeaders, isInternalCall, json, requireEnv, serviceKey } from '../_shared/http.ts';
import {
  buildAppealPrompt,
  buildUserPrompt,
  extractCandidateText,
  parseVerdict,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  VerdictValidationError,
  type CaseForJudgement,
  type PriorVerdict,
} from '../_shared/verdict.ts';

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = serviceKey();
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
  const [cases, appeals] = await Promise.all([
    admin.rpc('list_claimable_cases', { p_limit: SWEEP_BATCH }),
    admin.rpc('list_claimable_appeals', { p_limit: SWEEP_BATCH }),
  ]);
  if (cases.error) throw new Error(`list_claimable_cases: ${cases.error.message}`);
  if (appeals.error) throw new Error(`list_claimable_appeals: ${appeals.error.message}`);
  const queue: Target[] = [
    ...((cases.data as string[] | null) ?? []).map((id) => ({ kind: 'case' as const, id })),
    ...((appeals.data as string[] | null) ?? []).map((id) => ({ kind: 'appeal' as const, id })),
  ];
  const results: JudgeOutcome[] = [];
  for (const t of queue) {
    if (Date.now() - started > SWEEP_BUDGET_MS) {
      console.log(`sweep budget reached; ${results.length} judged, rest deferred to next run`);
      break;
    }
    // sequential: bounded LLM concurrency/cost
    results.push(await (t.kind === 'case' ? judgeCase(t.id) : judgeAppeal(t.id)));
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

interface ClaimedAppeal {
  id: string;
  case_id: string;
  round: number;
  appellant_id: string;
  appellant_reason: string;
  respondent_reply: string;
  reply_timed_out: boolean;
}

/** First-instance case context an appeal is judged against. */
interface AppealedCase extends CaseForJudgement, Omit<PriorVerdict, 'round'> {
  prosecutor_id: string;
}

interface Target {
  kind: 'case' | 'appeal';
  id: string;
}

type JudgeOutcome =
  | ({ status: 'judged'; adjusted: boolean } & Target)
  | ({ status: 'not_claimable' } & Target)
  | ({ status: 'failed'; error: string } & Target);

/** complete_* / fail_* RPCs for each kind; they differ only in name and id parameter. */
const RPC = {
  case: { complete: 'complete_verdict', fail: 'fail_verdict', idParam: 'p_case_id' },
  appeal: { complete: 'complete_appeal_verdict', fail: 'fail_appeal_verdict', idParam: 'p_appeal_id' },
} as const;

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

/**
 * Runs the LLM for an already-claimed case or appeal: bounded retries, then
 * the validated verdict goes to complete_*; on final failure fail_* releases
 * the claim so the sweep can retry later.
 */
async function deliberate(target: Target, prompt: string): Promise<JudgeOutcome> {
  const rpc = RPC[target.kind];
  const tag = `[${target.kind}:${target.id}]`;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      const text = await callGemini(prompt);
      const { verdict, adjusted } = parseVerdict(text);
      const { data: done, error: doneErr } = await admin.rpc(rpc.complete, {
        [rpc.idParam]: target.id,
        p_verdict_judge: verdict.verdict_judge,
        p_verdict_comedian: verdict.verdict_comedian,
        p_fault_prosecutor: verdict.fault_ratio_prosecutor,
        p_fault_defendant: verdict.fault_ratio_defendant,
        p_penalty: verdict.penalty,
      });
      if (doneErr) throw new Error(`${rpc.complete} failed: ${doneErr.message}`);
      if (!(done as unknown[] | null)?.length) {
        // Lost it to a reclaim after our claim went stale; nothing to do.
        return { status: 'not_claimable', ...target };
      }
      if (adjusted) console.warn(`${tag} fault ratios normalised to sum 100`);
      return { status: 'judged', adjusted, ...target };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const retryable = e instanceof RetryableError || e instanceof VerdictValidationError;
      console.error(`${tag} attempt ${attempt} failed: ${lastError}`);
      if (!retryable || attempt === MAX_LLM_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  await admin.rpc(rpc.fail, { [rpc.idParam]: target.id, p_error: lastError });
  return { status: 'failed', error: lastError, ...target };
}

async function judgeCase(caseId: string): Promise<JudgeOutcome> {
  const { data: claimed, error: claimErr } = await admin.rpc('claim_case_for_verdict', { p_case_id: caseId });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const row = (claimed as ClaimedCase[] | null)?.[0];
  if (!row) return { status: 'not_claimable', kind: 'case', id: caseId };
  return deliberate({ kind: 'case', id: caseId }, buildUserPrompt(row));
}

async function judgeAppeal(appealId: string): Promise<JudgeOutcome> {
  const target: Target = { kind: 'appeal', id: appealId };
  const { data: claimed, error: claimErr } = await admin.rpc('claim_appeal_for_verdict', { p_appeal_id: appealId });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const a = (claimed as ClaimedAppeal[] | null)?.[0];
  if (!a) return { status: 'not_claimable', ...target };

  let prompt: string;
  try {
    const [kase, earlier] = await Promise.all([
      admin
        .from('court_cases')
        .select(
          'title, category, prosecutor_plea, defendant_plea, defense_timed_out, prosecutor_id, ' +
            'verdict_judge, fault_ratio_prosecutor, fault_ratio_defendant, penalty',
        )
        .eq('id', a.case_id)
        .single(),
      admin
        .from('court_appeals')
        .select('round, verdict_judge, fault_ratio_prosecutor, fault_ratio_defendant, penalty')
        .eq('case_id', a.case_id)
        .eq('status', 'JUDGED')
        .lt('round', a.round)
        .order('round'),
    ]);
    if (kase.error || !kase.data) throw new Error(`case lookup failed: ${kase.error?.message ?? 'not found'}`);
    if (earlier.error) throw new Error(`appeal history lookup failed: ${earlier.error.message}`);
    const c = kase.data as unknown as AppealedCase;
    prompt = buildAppealPrompt(
      c,
      {
        round: a.round,
        appellant_role: a.appellant_id === c.prosecutor_id ? 'prosecutor' : 'defendant',
        appellant_reason: a.appellant_reason,
        respondent_reply: a.respondent_reply,
        reply_timed_out: a.reply_timed_out,
      },
      [{ ...c, round: 0 }, ...((earlier.data as PriorVerdict[] | null) ?? [])],
    );
  } catch (e) {
    // Release the claim; the sweep retries (the attempt still counts toward the cap).
    const error = e instanceof Error ? e.message : String(e);
    await admin.rpc('fail_appeal_verdict', { p_appeal_id: appealId, p_error: error });
    return { status: 'failed', error, ...target };
  }
  return deliberate(target, prompt);
}

/** For user-initiated calls: the caller must be a party to the case / appeal. */
async function assertCaller(req: Request, target: Target): Promise<Response | null> {
  const jwt = bearerToken(req);
  if (!jwt) return json({ error: 'UNAUTHORIZED' }, 401);
  const { data: auth, error } = await admin.auth.getUser(jwt);
  if (error || !auth.user) return json({ error: 'UNAUTHORIZED' }, 401);

  const lookup =
    target.kind === 'case'
      ? admin.from('court_cases').select('prosecutor_id, defendant_id')
      : admin.from('court_appeals').select('appellant_id, respondent_id');
  const { data: row, error: rErr } = await lookup.eq('id', target.id).maybeSingle();
  if (rErr) return json({ error: 'LOOKUP_FAILED' }, 500);
  if (!row || !Object.values(row as Record<string, string>).includes(auth.user.id)) {
    // Same response for "doesn't exist" and "not yours": no existence oracle.
    return json({ error: target.kind === 'case' ? 'CASE_NOT_FOUND' : 'APPEAL_NOT_FOUND' }, 404);
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

  let body: { case_id?: unknown; appeal_id?: unknown; mode?: unknown };
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

    const kind = body.appeal_id !== undefined ? 'appeal' : 'case';
    const id = kind === 'appeal' ? body.appeal_id : body.case_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return json({ error: kind === 'appeal' ? 'INVALID_APPEAL_ID' : 'INVALID_CASE_ID' }, 400);
    }
    const target: Target = { kind, id };
    const judge = () => (kind === 'appeal' ? judgeAppeal(id) : judgeCase(id));
    if (internal) {
      return runInBackground(`${kind}:${id}`, judge);
    }
    const denied = await assertCaller(req, target);
    if (denied) return denied;

    // User-initiated (client fallback): synchronous so the app gets a result.
    const outcome = await judge();
    const status = outcome.status === 'judged' ? 200 : outcome.status === 'not_claimable' ? 409 : 502;
    return json(outcome, status);
  } catch (e) {
    console.error('ai-court-verdict fatal:', e);
    return json({ error: 'INTERNAL_ERROR' }, 500);
  }
});
