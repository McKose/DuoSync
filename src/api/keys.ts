// Centralised React Query keys. Everything couple-scoped is prefixed with the
// couple id so a re-pair can never surface stale data from a previous couple.
export const qk = {
  couple: (userId: string) => ['couple', userId] as const,
  profiles: (coupleId: string) => ['profiles', coupleId] as const,
  cases: (coupleId: string) => ['cases', coupleId] as const,
  case: (caseId: string) => ['case', caseId] as const,
  plans: (coupleId: string) => ['plans', coupleId] as const,
  plan: (planId: string) => ['plan', planId] as const,
  messages: (coupleId: string) => ['messages', coupleId] as const,
  questions: (coupleId: string) => ['questions', coupleId] as const,
};

export const mk = {
  checklistUpsert: ['checklist', 'upsert'] as const,
};
