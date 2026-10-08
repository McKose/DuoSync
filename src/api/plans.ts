import { unwrap } from '@/lib/errors';
import type { ChecklistItem, Json, Plan } from '@/types/database.types';
import { supabase } from './supabase';
import { demo, IS_DEMO } from '@/demo';

export async function listPlans(coupleId: string): Promise<Plan[]> {
  if (IS_DEMO) return demo.listPlans(coupleId);
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
  if (IS_DEMO) return demo.getPlan(planId);
  return unwrap(await supabase.from('plans').select('*').eq('id', planId).single());
}

export async function createPlan(input: {
  coupleId: string;
  userId: string;
  title: string;
  location: string | null;
  planDate: string | null;
}): Promise<Plan> {
  if (IS_DEMO) return demo.createPlan(input);
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
  if (IS_DEMO) return demo.updatePlanMeta(planId, patch);
  unwrap(await supabase.from('plans').update(patch).eq('id', planId));
}

export async function deletePlan(planId: string): Promise<void> {
  if (IS_DEMO) return demo.deletePlan(planId);
  unwrap(await supabase.from('plans').delete().eq('id', planId));
}

/** Server-side atomic per-item LWW merge (see upsert_checklist_item). */
export async function upsertChecklistItem(planId: string, item: ChecklistItem): Promise<Plan> {
  if (IS_DEMO) return demo.upsertChecklistItem(planId, item);
  return unwrap(
    await supabase.rpc('upsert_checklist_item', {
      p_plan_id: planId,
      p_item: item as unknown as Json,
    }),
  );
}

// Pure checklist helpers live in lib/ (shared with the demo backend).
export { mergeChecklistItem, parseChecklist, visibleItems } from '@/lib/checklist';
