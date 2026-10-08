import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  answerQuestion,
  askQuestion,
  cancelMessage,
  deleteQuestion,
  listMessages,
  listQuestions,
  scheduleMessage,
  type DelayMinutes,
} from '@/api/buffer';
import { qk } from '@/api/keys';
import { AppError } from '@/lib/errors';
import type { DelayedMessage, PendingQuestion } from '@/types/database.types';
import { useRealtimeSubscription } from './useRealtimeSubscription';

// ---------------------------------------------------------------------------
// Cooling-off room
// ---------------------------------------------------------------------------

export function useMessages(coupleId: string) {
  // RLS-filtered: the partner only ever receives events for SENT rows.
  useRealtimeSubscription({
    name: 'cooling',
    table: 'delayed_messages',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.messages(coupleId)],
  });
  return useQuery({
    queryKey: qk.messages(coupleId),
    queryFn: () => listMessages(coupleId),
    // Server flips PENDING→SENT on a 1-minute cron; poll while something of
    // ours is due so the sender sees the transition even if Realtime lags.
    refetchInterval: (q) => {
      const due = (q.state.data ?? []).some(
        (m) => m.status === 'PENDING' && new Date(m.release_at).getTime() <= Date.now(),
      );
      return due ? 15_000 : false;
    },
  });
}

export function useScheduleMessage(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { content: string; delay: DelayMinutes }) => scheduleMessage(v.content, v.delay),
    onSuccess: (row) =>
      queryClient.setQueryData<DelayedMessage[]>(qk.messages(coupleId), (prev) => [row, ...(prev ?? [])]),
  });
}

/**
 * Silent cancel. Only the sender's cache changes; nothing is sent to the
 * partner (no push, no Realtime event — enforced server-side by RLS).
 */
export function useCancelMessage(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const ok = await cancelMessage(id);
      if (!ok) throw new AppError('TOO_LATE_TO_CANCEL', 'TOO_LATE_TO_CANCEL');
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: qk.messages(coupleId) });
      const prev = queryClient.getQueryData<DelayedMessage[]>(qk.messages(coupleId));
      queryClient.setQueryData<DelayedMessage[]>(qk.messages(coupleId), (list) =>
        list?.map((m) =>
          m.id === id ? { ...m, status: 'CANCELLED', cancelled_at: new Date().toISOString() } : m,
        ),
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(qk.messages(coupleId), ctx.prev);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.messages(coupleId) }),
  });
}

// ---------------------------------------------------------------------------
// Questions vault
// ---------------------------------------------------------------------------

export function useQuestions(coupleId: string) {
  useRealtimeSubscription({
    name: 'vault',
    table: 'pending_questions',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.questions(coupleId)],
  });
  return useQuery({ queryKey: qk.questions(coupleId), queryFn: () => listQuestions(coupleId) });
}

export function useAskQuestion(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => askQuestion(text),
    onSuccess: (row) =>
      queryClient.setQueryData<PendingQuestion[]>(qk.questions(coupleId), (prev) => [row, ...(prev ?? [])]),
  });
}

export function useAnswerQuestion(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; answer: string }) => answerQuestion(v.id, v.answer),
    onSuccess: (row) =>
      queryClient.setQueryData<PendingQuestion[]>(qk.questions(coupleId), (prev) =>
        prev?.map((q) => (q.id === row.id ? row : q)),
      ),
  });
}

export function useDeleteQuestion(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteQuestion(id),
    onSuccess: (_v, id) =>
      queryClient.setQueryData<PendingQuestion[]>(qk.questions(coupleId), (prev) => prev?.filter((q) => q.id !== id)),
  });
}
