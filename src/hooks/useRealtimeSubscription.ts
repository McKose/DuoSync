import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { supabase } from '@/api/supabase';
import type { Database } from '@/types/database.types';

type TableName = keyof Database['public']['Tables'];

interface Options<T extends TableName> {
  /** Unique per subscriber; also used as the channel topic suffix. */
  name: string;
  table: T;
  /** PostgREST-style filter, e.g. `couple_id=eq.<uuid>`. */
  filter?: string;
  /** Query keys invalidated on every change (and after reconnect/foreground). */
  invalidate: QueryKey[];
  enabled?: boolean;
  /**
   * Return true to skip invalidation for an event — e.g. while local
   * optimistic mutations are in flight, so a refetch doesn't briefly revert
   * them. The mutation's own onSettled refreshes afterwards.
   */
  skip?: () => boolean;
  onChange?: (payload: RealtimePostgresChangesPayload<Database['public']['Tables'][T]['Row']>) => void;
}

/**
 * Subscribes to postgres_changes for one table and keeps React Query fresh.
 *
 * Realtime delivers events subject to the subscriber's SELECT RLS, so e.g. a
 * partner never receives events for PENDING/CANCELLED cooling-off messages.
 *
 * Events can be missed while the socket is down or the app is backgrounded,
 * so we also invalidate on (re)subscribe and on return to foreground —
 * Realtime is treated as a hint, the database stays the source of truth.
 */
export function useRealtimeSubscription<T extends TableName>({
  name,
  table,
  filter,
  invalidate,
  enabled = true,
  skip,
  onChange,
}: Options<T>) {
  const queryClient = useQueryClient();
  const keysRef = useRef(invalidate);
  const onChangeRef = useRef(onChange);
  const skipRef = useRef(skip);
  keysRef.current = invalidate;
  onChangeRef.current = onChange;
  skipRef.current = skip;

  useEffect(() => {
    if (!enabled) return;

    const refresh = () => {
      if (skipRef.current?.()) return;
      for (const key of keysRef.current) void queryClient.invalidateQueries({ queryKey: key });
    };

    const channel = supabase
      .channel(`rt:${name}:${table}:${filter ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload) => {
          onChangeRef.current?.(
            payload as RealtimePostgresChangesPayload<Database['public']['Tables'][T]['Row']>,
          );
          refresh();
        },
      )
      .subscribe((status) => {
        // Covers the initial subscribe and every reconnect after a drop.
        if (status === 'SUBSCRIBED') refresh();
      });

    const appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });

    return () => {
      appStateSub.remove();
      void supabase.removeChannel(channel);
    };
  }, [enabled, name, table, filter, queryClient]);
}
