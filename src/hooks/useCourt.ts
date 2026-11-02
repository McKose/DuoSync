import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fileAppeal,
  fileCase,
  getCase,
  listAppeals,
  listCases,
  replyAppeal,
  requestAppealVerdict,
  requestVerdict,
  submitDefense,
} from '@/api/court';
import { qk } from '@/api/keys';
import type { CaseCategory, CourtAppeal, CourtCase } from '@/types/database.types';
import { useRealtimeSubscription } from './useRealtimeSubscription';

export function useCases(coupleId: string) {
  useRealtimeSubscription({
    name: 'court-list',
    table: 'court_cases',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.cases(coupleId)],
  });
  return useQuery({ queryKey: qk.cases(coupleId), queryFn: () => listCases(coupleId) });
}

export function useCase(coupleId: string, caseId: string) {
  const queryClient = useQueryClient();
  useRealtimeSubscription({
    name: `court-case-${caseId}`,
    table: 'court_cases',
    filter: `id=eq.${caseId}`,
    invalidate: [qk.case(caseId), qk.cases(coupleId)],
  });
  return useQuery({
    queryKey: qk.case(caseId),
    queryFn: () => getCase(caseId),
    // Instant render from the list cache when navigating from CourtHome.
    initialData: () => queryClient.getQueryData<CourtCase[]>(qk.cases(coupleId))?.find((c) => c.id === caseId),
    initialDataUpdatedAt: () => queryClient.getQueryState(qk.cases(coupleId))?.dataUpdatedAt,
  });
}

export function useFileCase(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; category: CaseCategory; plea: string }) => fileCase(input),
    onSuccess: (row) => {
      queryClient.setQueryData(qk.case(row.id), row);
      queryClient.setQueryData<CourtCase[]>(qk.cases(coupleId), (prev) => [row, ...(prev ?? [])]);
    },
  });
}

export function useSubmitDefense(coupleId: string, caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (plea: string) => {
      const row = await submitDefense(caseId, plea);
      queryClient.setQueryData(qk.case(caseId), row);
      // Fallback trigger in case the DB webhook isn't configured or failed.
      // A 409 just means the webhook got there first. Never block the user
      // on this: their defense is already saved.
      requestVerdict(caseId).catch(() => undefined);
      return row;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.cases(coupleId) }),
  });
}

/** Manual retry after a failed LLM attempt (last_error set). */
export function useRetryVerdict(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => requestVerdict(caseId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.case(caseId) }),
  });
}

/** Every appeal round of the couple; screens pick a case's rounds via appealView(). */
export function useAppeals(coupleId: string) {
  useRealtimeSubscription({
    name: 'court-appeals',
    table: 'court_appeals',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.appeals(coupleId)],
  });
  return useQuery({ queryKey: qk.appeals(coupleId), queryFn: () => listAppeals(coupleId) });
}

export function useFileAppeal(coupleId: string, caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => fileAppeal(caseId, reason),
    onSuccess: (row) =>
      queryClient.setQueryData<CourtAppeal[]>(qk.appeals(coupleId), (prev) => [...(prev ?? []), row]),
    // The case flips to APPEALED server-side.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.case(caseId) });
      void queryClient.invalidateQueries({ queryKey: qk.cases(coupleId) });
    },
  });
}

export function useReplyAppeal(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ appealId, reply }: { appealId: string; reply: string }) => {
      const row = await replyAppeal(appealId, reply);
      // Fallback trigger, as for defenses: the webhook normally wins (409).
      requestAppealVerdict(appealId).catch(() => undefined);
      return row;
    },
    onSuccess: (row) =>
      queryClient.setQueryData<CourtAppeal[]>(qk.appeals(coupleId), (prev) =>
        prev?.map((a) => (a.id === row.id ? row : a)),
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.appeals(coupleId) }),
  });
}

/** Manual retry after a failed LLM attempt on an appeal round. */
export function useRetryAppealVerdict(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (appealId: string) => requestAppealVerdict(appealId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.appeals(coupleId) }),
  });
}
