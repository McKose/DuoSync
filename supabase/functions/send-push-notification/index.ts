// DuoSync — push notification relay (internal only).
//
// Invoked exclusively by database triggers through pg_net with the
// x-internal-secret header. Looks up the recipient's Expo push token with
// the service role (tokens are invisible to partners via RLS) and forwards
// to the Expo Push API. Unregistered tokens are pruned.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { isInternalCall, json, requireEnv } from '../_shared/http.ts';

const admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Optional: enable "Enhanced push security" in Expo and set this.
const EXPO_ACCESS_TOKEN = Deno.env.get('EXPO_ACCESS_TOKEN');

const ALLOWED_TYPES = new Set([
  'CASE_FILED',
  'VERDICT_READY',
  'MESSAGE_RELEASED',
  'QUESTION_ASKED',
  'QUESTION_ANSWERED',
]);

interface PushRequest {
  user_id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

function isPushRequest(v: unknown): v is PushRequest {
  const o = v as Record<string, unknown>;
  return (
    typeof o === 'object' && o !== null &&
    typeof o.user_id === 'string' && typeof o.type === 'string' &&
    typeof o.title === 'string' && typeof o.body === 'string' &&
    (o.data === undefined || (typeof o.data === 'object' && o.data !== null))
  );
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!isInternalCall(req)) return json({ error: 'FORBIDDEN' }, 403);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'INVALID_JSON' }, 400);
  }
  if (!isPushRequest(payload) || !ALLOWED_TYPES.has(payload.type)) {
    return json({ error: 'INVALID_PAYLOAD' }, 400);
  }

  const { data: tokenRow, error } = await admin
    .from('push_tokens')
    .select('token')
    .eq('user_id', payload.user_id)
    .maybeSingle();
  if (error) {
    console.error('token lookup failed', error.message);
    return json({ error: 'LOOKUP_FAILED' }, 500);
  }
  if (!tokenRow) return json({ skipped: 'NO_TOKEN' });

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      to: tokenRow.token,
      title: payload.title.slice(0, 120),
      body: payload.body.slice(0, 240),
      data: { type: payload.type, ...(payload.data ?? {}) },
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }),
  });

  const result = (await res.json().catch(() => null)) as
    | { data?: { status?: string; message?: string; details?: { error?: string } } }
    | null;

  if (!res.ok) {
    console.error('expo push http error', res.status, JSON.stringify(result));
    return json({ error: 'EXPO_HTTP_ERROR', status: res.status }, 502);
  }

  const ticket = result?.data;
  if (ticket?.status === 'error') {
    if (ticket.details?.error === 'DeviceNotRegistered') {
      await admin.from('push_tokens').delete().eq('user_id', payload.user_id).eq('token', tokenRow.token);
    }
    console.warn('expo push ticket error', ticket.details?.error, ticket.message);
    return json({ delivered: false, reason: ticket.details?.error ?? 'UNKNOWN' });
  }
  return json({ delivered: true });
});
