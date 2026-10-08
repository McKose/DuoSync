import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';
import type { Couple } from '@/types/database.types';

/**
 * Client-side session context. Server data (cases, plans, …) lives in React
 * Query; this store only holds identity + the couple row so any component
 * can resolve "who am I / who is my partner / which couple" synchronously.
 */
interface CoupleState {
  authReady: boolean;
  session: Session | null;
  userId: string | null;
  couple: Couple | null;
  side: 'a' | 'b' | null;
  partnerId: string | null;

  setAuth: (session: Session | null) => void;
  setCouple: (couple: Couple | null) => void;
  reset: () => void;
}

export const useCoupleStore = create<CoupleState>((set, get) => ({
  authReady: false,
  session: null,
  userId: null,
  couple: null,
  side: null,
  partnerId: null,

  setAuth: (session) =>
    set({
      authReady: true,
      session,
      userId: session?.user.id ?? null,
      ...(session ? {} : { couple: null, side: null, partnerId: null }),
    }),

  setCouple: (couple) => {
    const uid = get().userId;
    if (!couple || !uid) {
      set({ couple, side: null, partnerId: null });
      return;
    }
    const isA = couple.user_a_id === uid;
    set({
      couple,
      side: isA ? 'a' : 'b',
      partnerId: isA ? couple.user_b_id : couple.user_a_id,
    });
  },

  reset: () => set({ session: null, userId: null, couple: null, side: null, partnerId: null }),
}));

/** Active couple id or null. */
export const useActiveCoupleId = () =>
  useCoupleStore((s) => (s.couple?.is_active ? s.couple.id : null));

/** Non-null identity for screens that are only mounted when paired. */
export function usePairedContext() {
  const userId = useCoupleStore((s) => s.userId);
  const couple = useCoupleStore((s) => s.couple);
  const partnerId = useCoupleStore((s) => s.partnerId);
  if (!userId || !couple?.is_active || !partnerId) {
    throw new Error('usePairedContext used outside of a paired session');
  }
  return { userId, couple, coupleId: couple.id, partnerId };
}
