import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchMyCouple } from '@/api/couple';
import { qk } from '@/api/keys';
import { supabase } from '@/api/supabase';
import { useCoupleStore } from '@/store/useCoupleStore';
import { useRealtimeSubscription } from './useRealtimeSubscription';

export type SessionStatus = 'loading' | 'signed_out' | 'unpaired' | 'paired' | 'error';

/**
 * Root session hook: auth state → couple row → Zustand store.
 * Mounted once by AppNavigator; screens read the store.
 */
export function useCoupleSession() {
  const authReady = useCoupleStore((s) => s.authReady);
  const userId = useCoupleStore((s) => s.userId);
  const couple = useCoupleStore((s) => s.couple);
  const setAuth = useCoupleStore((s) => s.setAuth);
  const setCouple = useCoupleStore((s) => s.setCouple);

  // 1) Auth bootstrap + listener. The callback must stay synchronous:
  //    awaiting Supabase calls inside onAuthStateChange can deadlock the client.
  useEffect(() => {
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => mounted && setAuth(data.session))
      .catch(() => mounted && setAuth(null));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setAuth(session));
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [setAuth]);

  // 2) Couple row (persisted cache makes this work offline after first load).
  const coupleQuery = useQuery({
    queryKey: qk.couple(userId ?? 'anon'),
    queryFn: () => fetchMyCouple(userId!),
    enabled: Boolean(userId),
  });

  useEffect(() => {
    if (coupleQuery.data !== undefined) setCouple(coupleQuery.data);
  }, [coupleQuery.data, setCouple]);

  // 3) Live updates: partner joining my code, partner battery/status changes.
  useRealtimeSubscription({
    name: 'couple-self',
    table: 'couples',
    filter: couple ? `id=eq.${couple.id}` : `user_a_id=eq.${userId}`,
    invalidate: [qk.couple(userId ?? 'anon')],
    enabled: Boolean(userId),
  });

  let status: SessionStatus;
  if (!authReady) status = 'loading';
  else if (!userId) status = 'signed_out';
  else if (coupleQuery.data === undefined) status = coupleQuery.isError ? 'error' : 'loading';
  else status = coupleQuery.data?.is_active ? 'paired' : 'unpaired';

  return {
    status,
    userId,
    couple: coupleQuery.data ?? null,
    error: coupleQuery.error,
    retry: () => void coupleQuery.refetch(),
  };
}
