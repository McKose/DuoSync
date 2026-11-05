// Shared HTTP helpers for DuoSync Edge Functions.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * Key for the service-role admin client. Prefers the new secret key
 * (SUPABASE_SECRET_KEYS: JSON keyed by name, Supabase injects `default`) and
 * falls back to the legacy service_role JWT, which stops working at the end
 * of 2026 and may be missing on projects created with the new key model.
 */
export function serviceKey(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): string {
  const raw = env('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const key = (JSON.parse(raw) as Record<string, unknown>).default;
      if (typeof key === 'string' && key.length > 0) return key;
    } catch {
      // Malformed JSON: fall through to the legacy key.
    }
  }
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('Missing server key: set SUPABASE_SECRET_KEYS (default) or SUPABASE_SERVICE_ROLE_KEY');
}

/** Constant-time string comparison (avoids timing side channels on the secret). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** True when the request carries the DB-webhook / cron shared secret. */
export function isInternalCall(req: Request): boolean {
  const expected = Deno.env.get('INTERNAL_WEBHOOK_SECRET');
  const got = req.headers.get('x-internal-secret');
  return Boolean(expected && got && safeEqual(got, expected));
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}
