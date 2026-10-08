import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { AppError, unwrap } from '@/lib/errors';
import type { Couple, PartnerStatus, Profile } from '@/types/database.types';
import { supabase } from './supabase';

/**
 * The caller's couple row — active, or their own pending invite.
 * RLS restricts couples to rows where the caller is user_a or user_b.
 */
export async function fetchMyCouple(userId: string): Promise<Couple | null> {
  const rows = unwrap(
    await supabase
      .from('couples')
      .select('*')
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
      .order('is_active', { ascending: false })
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function fetchCoupleProfiles(): Promise<Profile[]> {
  // RLS returns exactly: me + my active partner.
  return unwrap(await supabase.from('profiles').select('*'));
}

export async function createPairingCode(): Promise<Couple> {
  return unwrap(await supabase.rpc('create_pairing_code'));
}

export async function pairWithCode(code: string): Promise<Couple> {
  const rows = unwrap(await supabase.rpc('pair_with_code', { p_code: code }));
  const row = rows[0];
  if (!row) throw new AppError('INVALID_CODE', 'INVALID_CODE');
  return row;
}

export async function updatePresence(input: {
  battery?: number | null;
  status?: PartnerStatus | null;
}): Promise<Couple> {
  return unwrap(
    await supabase.rpc('update_my_presence', {
      p_battery: input.battery ?? null,
      p_status: input.status ?? null,
    }),
  );
}

export async function updateDisplayName(userId: string, displayName: string): Promise<void> {
  unwrap(await supabase.from('profiles').update({ display_name: displayName.trim() }).eq('id', userId));
}

export async function savePushToken(userId: string, token: string): Promise<void> {
  if (!Device.isDevice) return;
  unwrap(
    await supabase.from('push_tokens').upsert(
      {
        user_id: userId,
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    ),
  );
}

/** Which side of the couple row the user occupies, plus their partner id. */
export function coupleSides(couple: Couple, userId: string) {
  const isA = couple.user_a_id === userId;
  return {
    side: isA ? ('a' as const) : ('b' as const),
    partnerId: isA ? couple.user_b_id : couple.user_a_id,
    me: {
      battery: isA ? couple.user_a_battery : couple.user_b_battery,
      status: isA ? couple.user_a_status : couple.user_b_status,
      seenAt: isA ? couple.user_a_seen_at : couple.user_b_seen_at,
    },
    partner: {
      battery: isA ? couple.user_b_battery : couple.user_a_battery,
      status: isA ? couple.user_b_status : couple.user_a_status,
      seenAt: isA ? couple.user_b_seen_at : couple.user_a_seen_at,
    },
  };
}
