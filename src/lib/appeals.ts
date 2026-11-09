// Appeal (istinaf) rules shared with the server
// (supabase/migrations/20261102000000_appeals.sql) and the derived view the
// court screens render: rounds so far, whether an appeal can be filed now,
// and which verdict currently counts.

import type { CourtAppeal, CourtCase } from '../types/database.types';

export const MAX_APPEALS = 2;
export const APPEAL_WINDOW_MS = 12 * 3_600_000;
export const APPEAL_REASON_MIN = 10;
export const APPEAL_TEXT_MAX = 2000;
/** Mirrors the verdict_attempts cap in claim_appeal_for_verdict(). */
export const MAX_APPEAL_VERDICT_ATTEMPTS = 5;

export interface VerdictFields {
  verdict_judge: string;
  verdict_comedian: string;
  penalty: string;
  fault_ratio_prosecutor: number;
  fault_ratio_defendant: number;
  judged_at: string;
}

/** Narrows a case or appeal row to a complete verdict, or null. */
export function verdictOf(row: Pick<CourtCase, keyof VerdictFields>): VerdictFields | null {
  const { verdict_judge, verdict_comedian, penalty, fault_ratio_prosecutor, fault_ratio_defendant, judged_at } = row;
  if (
    verdict_judge === null || verdict_comedian === null || penalty === null ||
    fault_ratio_prosecutor === null || fault_ratio_defendant === null || judged_at === null
  ) {
    return null;
  }
  return { verdict_judge, verdict_comedian, penalty, fault_ratio_prosecutor, fault_ratio_defendant, judged_at };
}

export interface AppealView {
  /** This case's rounds, oldest first. */
  rounds: CourtAppeal[];
  /** Round still waiting for a reply or a verdict. */
  open: CourtAppeal | null;
  /** Latest judged verdict: the last judged round, else the first instance. */
  current: VerdictFields | null;
  /** 0 = first instance is the current verdict. */
  currentRound: number;
  remaining: number;
  /** End of the window for filing the next appeal (null when none can follow). */
  windowEndsAt: number | null;
  canAppeal: boolean;
}

export function appealView(c: CourtCase, appeals: CourtAppeal[], now = Date.now()): AppealView {
  const rounds = appeals.filter((a) => a.case_id === c.id).sort((a, b) => a.round - b.round);
  const judged = rounds.filter((a) => a.status === 'JUDGED');
  const last = judged.at(-1);
  const current = (last && verdictOf(last)) || verdictOf(c);
  const remaining = Math.max(0, MAX_APPEALS - rounds.length);
  const open = rounds.find((a) => a.status !== 'JUDGED') ?? null;
  const lastVerdictAt = current ? new Date(current.judged_at).getTime() : null;
  // `open` too, not just the case status: right after filing, the cached case
  // can still read JUDGED for a moment while the new round is already listed.
  const windowEndsAt =
    c.status === 'JUDGED' && !open && remaining > 0 && lastVerdictAt !== null ? lastVerdictAt + APPEAL_WINDOW_MS : null;
  return {
    rounds,
    open,
    current,
    currentRound: last && verdictOf(last) ? last.round : 0,
    remaining,
    windowEndsAt,
    canAppeal: windowEndsAt !== null && now < windowEndsAt,
  };
}
