import { deepStrictEqual as assertEquals, throws } from 'node:assert/strict';
import { serviceKey } from './http.ts';

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test('serviceKey prefers the new secret key, falls back to the legacy one', () => {
  const both = { SUPABASE_SECRET_KEYS: '{"default":"sb_secret_new"}', SUPABASE_SERVICE_ROLE_KEY: 'legacy.jwt' };
  assertEquals(serviceKey(envOf(both)), 'sb_secret_new');
  assertEquals(serviceKey(envOf({ SUPABASE_SERVICE_ROLE_KEY: 'legacy.jwt' })), 'legacy.jwt');
  // Malformed JSON or no `default` entry must not hide a usable legacy key.
  assertEquals(serviceKey(envOf({ SUPABASE_SECRET_KEYS: '{not json', SUPABASE_SERVICE_ROLE_KEY: 'legacy.jwt' })), 'legacy.jwt');
  assertEquals(serviceKey(envOf({ SUPABASE_SECRET_KEYS: '{"billing":"sb_secret_x"}', SUPABASE_SERVICE_ROLE_KEY: 'legacy.jwt' })), 'legacy.jwt');
  throws(() => serviceKey(envOf({})), /Missing server key/);
  throws(() => serviceKey(envOf({ SUPABASE_SECRET_KEYS: '{"default":""}' })), /Missing server key/);
});
