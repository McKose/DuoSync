import { FunctionsHttpError } from '@supabase/supabase-js';
import { unwrap } from '@/lib/errors';
import type { CaseCategory, CourtCase } from '@/types/database.types';
import { supabase } from './supabase';

export async function listCases(coupleId: string): Promise<CourtCase[]> {
  return unwrap(
    await supabase
      .from('court_cases')
      .select('*')
      .eq('couple_id', coupleId)
      .order('created_at', { ascending: false })
      .limit(100),
  );
}

export async function getCase(caseId: string): Promise<CourtCase> {
  return unwrap(await supabase.from('court_cases').select('*').eq('id', caseId).single());
}

export async function fileCase(input: {
  title: string;
  category: CaseCategory;
  plea: string;
}): Promise<CourtCase> {
  return unwrap(
    await supabase.rpc('file_case', {
      p_title: input.title.trim(),
      p_category: input.category,
      p_plea: input.plea.trim(),
    }),
  );
}

export async function submitDefense(caseId: string, plea: string): Promise<CourtCase> {
  return unwrap(await supabase.rpc('submit_defense', { p_case_id: caseId, p_plea: plea.trim() }));
}

export type VerdictRequestResult = 'judged' | 'already_handled' | 'failed';

/**
 * Client-side fallback trigger for the verdict. The DB webhook normally fires
 * first; the Edge Function's atomic claim turns duplicates into a 409, which
 * is a success from the client's point of view. The server re-checks the
 * defense lock, so calling this early is harmless (also 409).
 */
export async function requestVerdict(caseId: string): Promise<VerdictRequestResult> {
  const { error } = await supabase.functions.invoke('ai-court-verdict', {
    body: { case_id: caseId },
  });
  if (!error) return 'judged';
  if (error instanceof FunctionsHttpError) {
    const status = (error.context as Response | undefined)?.status;
    if (status === 409) return 'already_handled';
    if (status === 502) return 'failed';
  }
  throw error;
}

export type CasePhase =
  | 'AWAITING_DEFENSE'
  | 'DEFENSE_OVERDUE'
  | 'AWAITING_VERDICT'
  | 'DELIBERATING'
  | 'JUDGED'
  | 'APPEALED';

/** UI phase derived from status + plea + deadline. */
export function casePhase(c: CourtCase, now = Date.now()): CasePhase {
  if (c.status === 'JUDGED') return 'JUDGED';
  if (c.status === 'APPEALED') return 'APPEALED';
  if (c.status === 'DELIBERATING') return 'DELIBERATING';
  if (c.defendant_plea) return 'AWAITING_VERDICT';
  return new Date(c.defense_deadline).getTime() <= now ? 'DEFENSE_OVERDUE' : 'AWAITING_DEFENSE';
}

export const CATEGORY_META: Record<CaseCategory, { label: string; emoji: string }> = {
  CHORES: { label: 'Ev işleri', emoji: '🧽' },
  PLANS: { label: 'Planlar', emoji: '🗓️' },
  COMMUNICATION: { label: 'İletişim', emoji: '💬' },
  MONEY: { label: 'Para', emoji: '💸' },
  FAMILY: { label: 'Aile', emoji: '👪' },
  OTHER: { label: 'Diğer', emoji: '📎' },
};
