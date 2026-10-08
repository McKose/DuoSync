import { unwrap } from '@/lib/errors';
import type { ChecklistItem, Json, Plan } from '@/types/database.types';
import { supabase } from './supabase';

export async function listPlans(coupleId: string): Promise<Plan[]> {
  return unwrap(
    await supabase
      .from('plans')
      .select('*')
      .eq('couple_id', coupleId)
      .order('plan_date', { ascending: true, nullsFirst: false })
      .limit(100),
  );
}

export async function getPlan(planId: string): Promise<Plan> {
  return unwrap(await supabase.from('plans').select('*').eq('id', planId).single());
}

export async function createPlan(input: {
  coupleId: string;
  userId: string;
  title: string;
  location: string | null;
  planDate: string | null;
}): Promise<Plan> {
  return unwrap(
    await supabase
      .from('plans')
      .insert({
        couple_id: input.coupleId,
        created_by: input.userId,
        title: input.title.trim(),
        location: input.location?.trim() || null,
        plan_date: input.planDate,
      })
      .select('*')
      .single(),
  );
}

export async function updatePlanMeta(
  planId: string,
  patch: { title?: string; location?: string | null; plan_date?: string | null },
): Promise<void> {
  unwrap(await supabase.from('plans').update(patch).eq('id', planId));
}

export async function deletePlan(planId: string): Promise<void> {
  unwrap(await supabase.from('plans').delete().eq('id', planId));
}

/** Server-side atomic per-item LWW merge (see upsert_checklist_item). */
export async function upsertChecklistItem(planId: string, item: ChecklistItem): Promise<Plan> {
  return unwrap(
    await supabase.rpc('upsert_checklist_item', {
      p_plan_id: planId,
      p_item: item as unknown as Json,
    }),
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by optimistic updates and rendering)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defensive parse of the JSONB checklist; drops malformed entries. */
export function parseChecklist(raw: Json): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistItem[] = [];
  for (const v of raw) {
    if (!isObj(v) || typeof v.id !== 'string' || typeof v.text !== 'string') continue;
    out.push({
      id: v.id,
      text: v.text,
      done: v.done === true,
      deleted: v.deleted === true,
      updated_at: typeof v.updated_at === 'string' ? v.updated_at : new Date(0).toISOString(),
    });
  }
  return out;
}

/** Client mirror of the server merge rule: newer updated_at wins; ties → incoming. */
export function mergeChecklistItem(list: ChecklistItem[], incoming: ChecklistItem): ChecklistItem[] {
  const idx = list.findIndex((i) => i.id === incoming.id);
  if (idx === -1) return [...list, incoming];
  const existing = list[idx]!;
  if (new Date(existing.updated_at).getTime() > new Date(incoming.updated_at).getTime()) return list;
  const next = list.slice();
  next[idx] = incoming;
  return next;
}

export function visibleItems(list: ChecklistItem[]): ChecklistItem[] {
  return list.filter((i) => !i.deleted);
}
