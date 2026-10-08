// Demo mode: the whole app runs against an on-device fake backend — no
// Supabase, no network, no LLM. Enabled explicitly with
// EXPO_PUBLIC_DEMO_MODE=1, or automatically when Supabase env vars are absent
// (so a fresh clone opens in Expo Go instead of crashing).
//
// EXPO_PUBLIC_* vars are inlined at bundle time; they must be referenced
// statically (process.env.EXPO_PUBLIC_X), never via dynamic lookup.
export const IS_DEMO =
  process.env.EXPO_PUBLIC_DEMO_MODE === '1' ||
  !process.env.EXPO_PUBLIC_SUPABASE_URL ||
  !process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
