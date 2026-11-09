// Gemini usage accounting and the daily budget (ROADMAP D2). Pure, so it is
// unit-testable with `deno test`; the DB side is
// supabase/migrations/20261108000000_llm_usage.sql.

export interface TokenUsage {
  prompt: number;
  output: number;
  thought: number;
  total: number;
}

export const NO_USAGE: TokenUsage = { prompt: 0, output: 0, thought: 0, total: 0 };

/** What happened to one Gemini call; mirrors the llm_usage.outcome check. */
export type CallOutcome = 'ok' | 'invalid_output' | 'timeout' | 'http_error' | 'network_error';

/**
 * Whether the model may have processed (and billed) the call. 429 / 503 and
 * network errors are rejected before generation; a timeout may have generated.
 * Must match the generated `billable` column in private.llm_usage.
 */
export function isBillable(outcome: CallOutcome): boolean {
  return outcome === 'ok' || outcome === 'invalid_output' || outcome === 'timeout';
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Token counts from a generateContent response's usageMetadata (absent → 0). */
export function parseUsage(body: unknown): TokenUsage {
  const m = (body as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata;
  if (!m || typeof m !== 'object') return NO_USAGE;
  const prompt = count(m.promptTokenCount);
  const output = count(m.candidatesTokenCount);
  const thought = count(m.thoughtsTokenCount);
  const total = count(m.totalTokenCount) || prompt + output + thought;
  return { prompt, output, thought, total };
}

export interface Totals {
  calls: number;
  tokens: number;
}

export interface Limits {
  calls: number;
  tokens: number;
  /** Fraction of either limit at which to alert (0 < r < 1). */
  alertRatio: number;
}

/**
 * Defaults sized from the app's own caps: 2 users × 5 cases/day, ≤ 2 appeal
 * rounds each → ≤ 30 verdict rounds/day, ≤ 2 model calls per claim ≈ 60
 * billable calls; at ≈ 2–4 k tokens per call that is ≤ ≈ 240 k tokens.
 */
export const DEFAULT_LIMITS: Limits = { calls: 150, tokens: 300_000, alertRatio: 0.8 };

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** GEMINI_DAILY_CALL_LIMIT / GEMINI_DAILY_TOKEN_LIMIT; bad values fall back to the defaults. */
export function readLimits(env: (name: string) => string | undefined): Limits {
  return {
    calls: positiveInt(env('GEMINI_DAILY_CALL_LIMIT'), DEFAULT_LIMITS.calls),
    tokens: positiveInt(env('GEMINI_DAILY_TOKEN_LIMIT'), DEFAULT_LIMITS.tokens),
    alertRatio: DEFAULT_LIMITS.alertRatio,
  };
}

export type BudgetLevel = 'ok' | 'warn' | 'exhausted';

export function budgetLevel(t: Totals, l: Limits): BudgetLevel {
  if (t.calls >= l.calls || t.tokens >= l.tokens) return 'exhausted';
  if (t.calls >= l.calls * l.alertRatio || t.tokens >= l.tokens * l.alertRatio) return 'warn';
  return 'ok';
}

const RANK: Record<BudgetLevel, number> = { ok: 0, warn: 1, exhausted: 2 };

/** The level this call newly reached, or null when it stayed at the same level. */
export function crossedLevel(before: Totals, after: Totals, l: Limits): Exclude<BudgetLevel, 'ok'> | null {
  const b = budgetLevel(before, l);
  const a = budgetLevel(after, l);
  return RANK[a] > RANK[b] ? (a as Exclude<BudgetLevel, 'ok'>) : null;
}

/** Totals just before the call that produced `after` (the RPC returns totals including it). */
export function totalsBefore(after: Totals, outcome: CallOutcome, usage: TokenUsage): Totals {
  if (!isBillable(outcome)) return after;
  return { calls: Math.max(0, after.calls - 1), tokens: Math.max(0, after.tokens - usage.total) };
}

/** Push copy for the owner (Turkish UI language). */
export function alertMessage(level: Exclude<BudgetLevel, 'ok'>, t: Totals, l: Limits): { title: string; body: string } {
  const usage = `Bugün ${t.calls}/${l.calls} çağrı, ${t.tokens.toLocaleString('tr-TR')}/${l.tokens.toLocaleString('tr-TR')} token.`;
  return level === 'exhausted'
    ? { title: 'AI heyeti günlük limitte', body: `${usage} Yeni kararlar UTC gece yarısından sonra verilecek.` }
    : { title: 'AI kullanımı %80 sınırında', body: usage };
}
