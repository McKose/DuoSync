import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useCallback } from 'react';
import { mk, qk } from '@/api/keys';
import {
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  mergeChecklistItem,
  parseChecklist,
  updatePlanMeta,
} from '@/api/plans';
import type { ChecklistMutationVars } from '@/api/queryClient';
import { isNetworkError } from '@/lib/errors';
import type { ChecklistItem, Json, Plan } from '@/types/database.types';
import { useRealtimeSubscription } from './useRealtimeSubscription';

function useChecklistPending() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.isMutating({ mutationKey: mk.checklistUpsert }) > 0,
    [queryClient],
  );
}

export function usePlans(coupleId: string) {
  const pending = useChecklistPending();
  useRealtimeSubscription({
    name: 'plans-list',
    table: 'plans',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.plans(coupleId)],
    skip: pending,
  });
  return useQuery({ queryKey: qk.plans(coupleId), queryFn: () => listPlans(coupleId) });
}

export function usePlan(coupleId: string, planId: string) {
  const queryClient = useQueryClient();
  const pending = useChecklistPending();
  useRealtimeSubscription({
    name: `plan-${planId}`,
    table: 'plans',
    filter: `id=eq.${planId}`,
    invalidate: [qk.plan(planId)],
    skip: pending,
  });
  return useQuery({
    queryKey: qk.plan(planId),
    queryFn: () => getPlan(planId),
    initialData: () => queryClient.getQueryData<Plan[]>(qk.plans(coupleId))?.find((p) => p.id === planId),
    initialDataUpdatedAt: () => queryClient.getQueryState(qk.plans(coupleId))?.dataUpdatedAt,
  });
}

export function useCreatePlan(coupleId: string, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; location: string | null; planDate: string | null }) =>
      createPlan({ coupleId, userId, ...input }),
    onSuccess: (plan) => {
      queryClient.setQueryData(qk.plan(plan.id), plan);
      queryClient.setQueryData<Plan[]>(qk.plans(coupleId), (prev) => [...(prev ?? []), plan]);
    },
  });
}

export function useUpdatePlanMeta(coupleId: string, planId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: { title?: string; location?: string | null; plan_date?: string | null }) =>
      updatePlanMeta(planId, patch),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.plan(planId) });
      void queryClient.invalidateQueries({ queryKey: qk.plans(coupleId) });
    },
  });
}

export function useDeletePlan(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => deletePlan(planId),
    onSuccess: (_v, planId) => {
      queryClient.setQueryData<Plan[]>(qk.plans(coupleId), (prev) => prev?.filter((p) => p.id !== planId));
      queryClient.removeQueries({ queryKey: qk.plan(planId) });
    },
  });
}

/**
 * Offline-resilient checklist upsert.
 *
 * - Item ids are client-generated UUIDs, so an item created offline has a
 *   stable identity before the server ever sees it.
 * - updated_at is stamped at intent time; the server applies per-item
 *   last-write-wins on it, so a toggle made offline at 10:00 does not
 *   overwrite the partner's online toggle at 10:05 when it syncs later.
 * - The mutationFn is registered via setMutationDefaults (queryClient.ts),
 *   so paused mutations resume even after an app restart.
 */
export function useChecklistUpsert(coupleId: string, planId: string) {
  const queryClient = useQueryClient();

  const mutation = useMutation<Plan, Error, ChecklistMutationVars, { prev: Plan | undefined }>({
    mutationKey: mk.checklistUpsert,
    onMutate: async ({ item }) => {
      await queryClient.cancelQueries({ queryKey: qk.plan(planId) });
      const prev = queryClient.getQueryData<Plan>(qk.plan(planId));
      const apply = (p: Plan): Plan => ({
        ...p,
        checklist: mergeChecklistItem(parseChecklist(p.checklist), item) as unknown as Json,
      });
      if (prev) queryClient.setQueryData(qk.plan(planId), apply(prev));
      queryClient.setQueryData<Plan[]>(qk.plans(coupleId), (list) =>
        list?.map((p) => (p.id === planId ? apply(p) : p)),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      // Network errors keep the optimistic state (the mutation stays queued /
      // retries). Business errors (e.g. CHECKLIST_FULL) roll back.
      if (!isNetworkError(err) && ctx?.prev) queryClient.setQueryData(qk.plan(planId), ctx.prev);
    },
    onSettled: () => {
      // Only refetch once the last queued change has landed, otherwise the
      // server snapshot would briefly hide still-pending optimistic edits.
      if (queryClient.isMutating({ mutationKey: mk.checklistUpsert }) <= 1) {
        void queryClient.invalidateQueries({ queryKey: qk.plan(planId) });
        void queryClient.invalidateQueries({ queryKey: qk.plans(coupleId) });
      }
    },
  });

  const stamp = (patch: Omit<ChecklistItem, 'updated_at'>): ChecklistMutationVars => ({
    planId,
    item: { ...patch, updated_at: new Date().toISOString() },
  });

  return {
    error: mutation.error,
    add: (text: string) =>
      mutation.mutate(stamp({ id: Crypto.randomUUID(), text: text.trim(), done: false, deleted: false })),
    toggle: (item: ChecklistItem) => mutation.mutate(stamp({ ...item, done: !item.done })),
    remove: (item: ChecklistItem) => mutation.mutate(stamp({ ...item, deleted: true })),
    rename: (item: ChecklistItem, text: string) => mutation.mutate(stamp({ ...item, text: text.trim() })),
  };
}
