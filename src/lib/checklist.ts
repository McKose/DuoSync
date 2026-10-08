// Pure checklist helpers: used by optimistic updates, rendering and the
// demo backend. No imports beyond types, so it is safe from import cycles.
import type { ChecklistItem, Json } from '../types/database.types';


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
