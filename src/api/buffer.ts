import { unwrap } from '@/lib/errors';
import type { DelayedMessage, PendingQuestion } from '@/types/database.types';
import { supabase } from './supabase';
import { demo, IS_DEMO } from '@/demo';

// ---------------------------------------------------------------------------
// Cooling-off room
// ---------------------------------------------------------------------------

export const DELAY_OPTIONS = [15, 30, 45, 60] as const;
export type DelayMinutes = (typeof DELAY_OPTIONS)[number];

/**
 * RLS returns: all of my own messages (any status) + partner messages that
 * are already SENT. Pending/cancelled partner messages are never visible.
 */
export async function listMessages(coupleId: string): Promise<DelayedMessage[]> {
  if (IS_DEMO) return demo.listMessages(coupleId);
  return unwrap(
    await supabase
      .from('delayed_messages')
      .select('*')
      .eq('couple_id', coupleId)
      .order('created_at', { ascending: false })
      .limit(200),
  );
}

export async function scheduleMessage(content: string, delayMinutes: DelayMinutes): Promise<DelayedMessage> {
  if (IS_DEMO) return demo.scheduleMessage(content, delayMinutes);
  return unwrap(
    await supabase.rpc('schedule_delayed_message', {
      p_content: content.trim(),
      p_delay_minutes: delayMinutes,
    }),
  );
}

/** Returns false if the message was already released (too late to cancel). */
export async function cancelMessage(messageId: string): Promise<boolean> {
  if (IS_DEMO) return demo.cancelMessage(messageId);
  return unwrap(await supabase.rpc('cancel_delayed_message', { p_message_id: messageId }));
}

// ---------------------------------------------------------------------------
// Questions vault
// ---------------------------------------------------------------------------

export async function listQuestions(coupleId: string): Promise<PendingQuestion[]> {
  if (IS_DEMO) return demo.listQuestions(coupleId);
  return unwrap(
    await supabase
      .from('pending_questions')
      .select('*')
      .eq('couple_id', coupleId)
      .order('is_answered', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(200),
  );
}

export async function askQuestion(text: string): Promise<PendingQuestion> {
  if (IS_DEMO) return demo.askQuestion(text);
  return unwrap(await supabase.rpc('ask_question', { p_text: text.trim() }));
}

export async function answerQuestion(questionId: string, answer: string): Promise<PendingQuestion> {
  if (IS_DEMO) return demo.answerQuestion(questionId, answer);
  return unwrap(await supabase.rpc('answer_question', { p_question_id: questionId, p_answer: answer.trim() }));
}

export async function deleteQuestion(questionId: string): Promise<void> {
  if (IS_DEMO) return demo.deleteQuestion(questionId);
  unwrap(await supabase.from('pending_questions').delete().eq('id', questionId));
}
