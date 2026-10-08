import { unwrap } from '@/lib/errors';
import { useCoupleStore } from '@/store/useCoupleStore';
import { clearQueryCache } from './queryClient';
import { supabase } from './supabase';
import { demo, IS_DEMO } from '@/demo';

export async function signIn(email: string, password: string): Promise<void> {
  if (IS_DEMO) return demo.signIn(email, password);
  unwrap(await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password }));
}

/** Returns true if a session was issued immediately (email confirmation off). */
export async function signUp(email: string, password: string, displayName: string): Promise<boolean> {
  if (IS_DEMO) return demo.signUp(email, password, displayName);
  const data = unwrap(
    await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { display_name: displayName.trim() } },
    }),
  );
  return data.session !== null;
}

export async function signOut(): Promise<void> {
  // Local sign-out still succeeds offline; clear cached couple data regardless
  // so the next person on this device sees nothing.
  try {
    if (IS_DEMO) await demo.signOut();
    else await supabase.auth.signOut({ scope: 'local' });
  } finally {
    await clearQueryCache();
    useCoupleStore.getState().reset();
  }
}
