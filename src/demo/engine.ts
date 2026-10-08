// DuoSync demo backend — an on-device stand-in for Supabase.
//
// It mirrors the server's business rules (supabase/migrations/*.sql) closely
// enough that every screen, error and edge case can be tested without a
// database: same validation and error codes, defense lock + 24h timeout,
// RLS-equivalent visibility for the cooling-off room (silent cancel), per-item
// LWW checklist merge, presence/LOW_BATTERY logic and pairing rules.
//
// A simulated partner ("Deniz") reacts on a timer so two-person flows work
// with one phone. Dependencies (storage, clock, uuid, sleep) are injected so
// the engine runs unchanged under Node tests.

import { mergeChecklistItem, parseChecklist } from '../lib/checklist';
import { AppError } from '../lib/errors';
import type {
  ChecklistItem,
  Couple,
  CourtCase,
  DelayedMessage,
  Json,
  PartnerStatus,
  PendingQuestion,
  Plan,
  Profile,
} from '../types/database.types';
import { demoVerdict } from './judge';

export const DEMO_ME_ID = 'de000000-0000-4000-8000-000000000001';
export const DEMO_PARTNER_ID = 'de000000-0000-4000-8000-00000000beef';
export const DEMO_PARTNER_NAME = 'Deniz';

const STORAGE_KEY = 'duosync-demo-db-v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['CHORES', 'PLANS', 'COMMUNICATION', 'MONEY', 'FAMILY', 'OTHER'];
const TIMEOUT_PLEA = 'Davalı süre aşımı sebebiyle savunma yapmaktan imtina etmiştir.';

/** Simulated partner reaction delays (real seconds, not time-scaled). */
export const PARTNER_DELAYS = {
  join: 5_000,
  defend: 8_000,
  judge: 2_500,
  answer: 6_000,
} as const;

export type DemoTable = 'couples' | 'court_cases' | 'delayed_messages' | 'pending_questions' | 'plans' | 'profiles';
type Channel = DemoTable | 'auth' | 'settings';

export interface DemoSettings {
  /** 60 → one "minute" lasts one second (cooling-off, defense deadline). */
  timeScale: 1 | 60;
  /** Every API call fails with a network error, like airplane mode. */
  offline: boolean;
  /** Artificial latency per call, to make loading states visible. */
  latencyMs: number;
}

type ActionType = 'PARTNER_JOINS' | 'PARTNER_DEFENDS' | 'JUDGE_FINISH' | 'PARTNER_ANSWERS';
interface ScheduledAction {
  id: string;
  at: number;
  type: ActionType;
  ref?: string;
}

interface DemoState {
  version: 1;
  session: { userId: string; email: string } | null;
  profiles: Profile[];
  couple: Couple | null;
  cases: CourtCase[];
  messages: DelayedMessage[];
  questions: PendingQuestion[];
  plans: Plan[];
  scheduled: ScheduledAction[];
  settings: DemoSettings;
}

export interface DemoStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DemoDeps {
  storage: DemoStorage;
  uuid: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SETTINGS: DemoSettings = { timeScale: 60, offline: false, latencyMs: 250 };

const freshState = (): DemoState => ({
  version: 1,
  session: null,
  profiles: [],
  couple: null,
  cases: [],
  messages: [],
  questions: [],
  plans: [],
  scheduled: [],
  settings: { ...DEFAULT_SETTINGS },
});

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const len = (s: string | null | undefined) => (s ?? '').trim().length;
/** Same text Postgres puts in a CHECK violation, so toUserMessage maps it. */
const checkViolation = (what: string) => new Error(`new row violates check constraint "${what}"`);

export function createDemoBackend(deps: DemoDeps) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const iso = (t = now()) => new Date(t).toISOString();

  let state = freshState();
  // Keyed by string so callers may subscribe to any table name; tables the
  // demo never writes (push_tokens, pairing_attempts) simply never fire.
  const listeners = new Map<string, Set<() => void>>();
  const dirty = new Set<Channel>();

  const ready: Promise<void> = (async () => {
    try {
      const raw = await deps.storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DemoState;
        if (parsed.version === 1) state = { ...freshState(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...parsed.settings } };
      }
    } catch {
      state = freshState(); // corrupt store → start clean rather than crash
    }
  })();

  // ---------------------------------------------------------------------------
  // plumbing
  // ---------------------------------------------------------------------------
  const touch = (...chs: Channel[]) => chs.forEach((c) => dirty.add(c));

  async function flush() {
    if (dirty.size === 0) return;
    const chs = [...dirty];
    dirty.clear();
    await deps.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    for (const ch of chs) listeners.get(ch)?.forEach((fn) => fn());
  }

  /** Every public API call goes through here: offline check, latency, persist, notify. */
  async function op<T>(fn: () => T): Promise<T> {
    await ready;
    if (state.settings.offline) throw new TypeError('Network request failed');
    if (state.settings.latencyMs > 0) await sleep(state.settings.latencyMs);
    if (state.settings.offline) throw new TypeError('Network request failed');
    const result = fn();
    await flush();
    return clone(result);
  }

  /** Control-panel actions: no latency, work even while "offline". */
  async function local<T>(fn: () => T): Promise<T> {
    await ready;
    const result = fn();
    await flush();
    return clone(result);
  }

  const scaledMs = (minutes: number) => (minutes * 60_000) / state.settings.timeScale;

  function schedule(type: ActionType, delayMs: number, ref?: string) {
    state.scheduled.push({ id: deps.uuid(), at: now() + delayMs, type, ref });
  }

  function me(): string {
    const uid = state.session?.userId;
    if (!uid) throw new AppError('NOT_AUTHENTICATED', 'NOT_AUTHENTICATED');
    return uid;
  }

  function activeCouple(): Couple {
    const uid = me();
    const c = state.couple;
    if (!c || !c.is_active || (c.user_a_id !== uid && c.user_b_id !== uid)) {
      throw new AppError('NOT_PAIRED', 'NOT_PAIRED');
    }
    return c;
  }

  const partnerOf = (c: Couple, uid: string) => (c.user_a_id === uid ? c.user_b_id! : c.user_a_id);
  const nameOf = (id: string) => state.profiles.find((p) => p.id === id)?.display_name ?? 'Partner';

  function ensureProfile(id: string, name: string) {
    const existing = state.profiles.find((p) => p.id === id);
    if (existing) return existing;
    const p: Profile = { id, display_name: name.slice(0, 40), avatar_url: null, created_at: iso(), updated_at: iso() };
    state.profiles.push(p);
    touch('profiles');
    return p;
  }

  // ---------------------------------------------------------------------------
  // seed data — created the moment a couple becomes active
  // ---------------------------------------------------------------------------
  function seedCouple(couple: Couple, uid: string) {
    const partner = partnerOf(couple, uid);
    const t = now();
    const friday = new Date(t);
    friday.setDate(friday.getDate() + (((5 - friday.getDay() + 7) % 7) || 7));
    friday.setHours(20, 0, 0, 0);

    const item = (text: string, done: boolean): ChecklistItem => ({
      id: deps.uuid(),
      text,
      done,
      deleted: false,
      updated_at: iso(t - 3_600_000),
    });

    state.plans.push({
      id: deps.uuid(),
      couple_id: couple.id,
      created_by: partner,
      title: 'Cuma akşamı yemek',
      location: 'Moda sahil',
      plan_date: friday.toISOString(),
      checklist: [item('Masa ayırt', true), item('Çiçek al', false), item('Taksi çağır', false)] as unknown as Json,
      created_at: iso(t - 7_200_000),
      updated_at: iso(t - 3_600_000),
    });

    // A case against *me*, awaiting my defense.
    state.cases.push(
      baseCase(couple.id, partner, uid, {
        title: 'Telefonun sürekli sessizde kalması',
        category: 'COMMUNICATION',
        prosecutor_plea:
          'Dün akşam üç kez aradım, hiçbiri açılmadı. Telefon yine sessizdeymiş. Merak ettim, sinirlendim.',
        // Filed "30 minutes ago" on the demo clock, so the 24h window is
        // still open at any time scale (at 60× it closes ~24 real min later).
        created_at: iso(t - scaledMs(30)),
        defense_deadline: iso(t - scaledMs(30) + scaledMs(24 * 60)),
      }),
    );

    // A finished case so the verdict screen can be inspected immediately.
    const judged = baseCase(couple.id, uid, partner, {
      title: 'Bulaşık makinesi boşaltılmadı',
      category: 'CHORES',
      prosecutor_plea: 'Üç gündür makine temiz bulaşıkla dolu bekliyor, ben boşaltmazsam kimse boşaltmıyor.',
      created_at: iso(t - 86_400_000),
    });
    judged.defendant_plea = 'Makine doluyken ben de çamaşırları astım, katlayıp yerleştirdim. Görev paylaşımı diye bir şey var.';
    judged.defense_submitted_at = iso(t - 80_000_000);
    Object.assign(
      judged,
      demoVerdict({
        title: judged.title,
        category: judged.category,
        prosecutor_plea: judged.prosecutor_plea,
        defendant_plea: judged.defendant_plea,
        defense_timed_out: false,
        prosecutorName: nameOf(uid),
        defendantName: nameOf(partner),
      }),
      { status: 'JUDGED', judged_at: iso(t - 79_000_000), verdict_attempts: 1 },
    );
    state.cases.push(judged);

    state.questions.push({
      id: deps.uuid(),
      couple_id: couple.id,
      asker_id: partner,
      question_text: 'Pazar günü annemlere öğle yemeğine gidebilir miyiz?',
      answer_text: null,
      is_answered: false,
      answered_at: null,
      created_at: iso(t - 5_400_000),
    });

    state.messages.push({
      id: deps.uuid(),
      couple_id: couple.id,
      sender_id: partner,
      recipient_id: uid,
      content: 'Sabah biraz sert konuştum, kusura bakma. Akşam konuşalım mı?',
      delay_minutes: 30,
      release_at: iso(t - 600_000),
      status: 'SENT',
      sent_at: iso(t - 600_000),
      cancelled_at: null,
      created_at: iso(t - 2_400_000),
    });

    const pSide = couple.user_a_id === partner ? 'a' : 'b';
    couple[`user_${pSide}_battery`] = 64;
    couple[`user_${pSide}_status`] = 'NORMAL';
    couple[`user_${pSide}_seen_at`] = iso(t - 180_000);

    touch('plans', 'court_cases', 'pending_questions', 'delayed_messages', 'couples');
  }

  function baseCase(
    coupleId: string,
    prosecutor: string,
    defendant: string,
    f: { title: string; category: string; prosecutor_plea: string; created_at?: string; defense_deadline?: string },
  ): CourtCase {
    const created = f.created_at ?? iso();
    return {
      id: deps.uuid(),
      couple_id: coupleId,
      prosecutor_id: prosecutor,
      defendant_id: defendant,
      title: f.title,
      category: f.category,
      prosecutor_plea: f.prosecutor_plea,
      defendant_plea: null,
      defense_timed_out: false,
      status: 'AWAITING_DEFENSE',
      verdict_judge: null,
      verdict_comedian: null,
      penalty: null,
      fault_ratio_prosecutor: null,
      fault_ratio_defendant: null,
      defense_deadline: f.defense_deadline ?? iso(new Date(created).getTime() + scaledMs(24 * 60)),
      defense_submitted_at: null,
      deliberation_started_at: null,
      verdict_attempts: 0,
      last_error: null,
      created_at: created,
      judged_at: null,
    };
  }

  function activate(couple: Couple, uid: string) {
    couple.is_active = true;
    couple.pairing_code = null;
    couple.pairing_code_expires_at = null;
    couple.paired_at = iso();
    state.scheduled = state.scheduled.filter((a) => a.type !== 'PARTNER_JOINS');
    seedCouple(couple, uid);
    touch('couples');
  }

  // ---------------------------------------------------------------------------
  // court pipeline (mirrors claim_case_for_verdict / complete_verdict)
  // ---------------------------------------------------------------------------
  function claim(c: CourtCase): boolean {
    if (c.status !== 'AWAITING_DEFENSE' || c.verdict_attempts >= 5) return false;
    if (c.defendant_plea === null) {
      if (now() < new Date(c.defense_deadline).getTime()) return false; // defense lock
      c.defendant_plea = TIMEOUT_PLEA;
      c.defense_timed_out = true;
    }
    c.status = 'DELIBERATING';
    c.deliberation_started_at = iso();
    c.verdict_attempts += 1;
    c.last_error = null;
    schedule('JUDGE_FINISH', PARTNER_DELAYS.judge, c.id);
    touch('court_cases');
    return true;
  }

  function finishJudgement(c: CourtCase) {
    if (c.status !== 'DELIBERATING' || c.defendant_plea === null) return;
    Object.assign(
      c,
      demoVerdict({
        title: c.title,
        category: c.category,
        prosecutor_plea: c.prosecutor_plea,
        defendant_plea: c.defendant_plea,
        defense_timed_out: c.defense_timed_out,
        prosecutorName: nameOf(c.prosecutor_id),
        defendantName: nameOf(c.defendant_id),
      }),
    );
    c.status = 'JUDGED';
    c.judged_at = iso();
    touch('court_cases');
  }

  const PARTNER_DEFENSES: Record<string, string> = {
    CHORES: 'Bu hafta iki kez çöpü ben çıkardım, kimse alkışlamadı. Adalet istiyorum.',
    PLANS: 'Geç kaldım çünkü sana sürpriz tatlı almak için yol değiştirdim. Sürprizi bozduğun için teşekkürler.',
    COMMUNICATION: 'Toplantıdaydım, çıkar çıkmaz yazdım. Mesajın 2 dakika okunmadı diye dava açılır mı?',
    MONEY: 'O harcama ikimiz içindi, faturası da masada duruyor. İncelemenizi rica ederim.',
    FAMILY: 'Annemi aramadım çünkü o beni aradı ve ben açtım. Teknik olarak iletişim kuruldu.',
    OTHER: 'Suçlamaları kabul etmiyorum, ama bir sonraki filmi sen seçebilirsin.',
  };

  // ---------------------------------------------------------------------------
  // background tick: scheduled partner actions, message release, 24h sweep
  // ---------------------------------------------------------------------------
  async function tick() {
    await ready;
    const t = now();

    const due = state.scheduled.filter((a) => a.at <= t);
    if (due.length) {
      state.scheduled = state.scheduled.filter((a) => a.at > t);
      for (const a of due) runAction(a);
    }

    for (const m of state.messages) {
      if (m.status === 'PENDING' && new Date(m.release_at).getTime() <= t) {
        m.status = 'SENT';
        m.sent_at = iso(t);
        touch('delayed_messages');
      }
    }

    for (const c of state.cases) {
      if (c.status === 'AWAITING_DEFENSE' && c.defendant_plea === null && new Date(c.defense_deadline).getTime() <= t) {
        claim(c); // 24h sweep
      }
    }
    await flush();
  }

  function runAction(a: ScheduledAction) {
    const uid = state.session?.userId;
    switch (a.type) {
      case 'PARTNER_JOINS': {
        const c = state.couple;
        if (c && !c.is_active && uid && c.user_a_id === uid) {
          ensureProfile(DEMO_PARTNER_ID, DEMO_PARTNER_NAME);
          c.user_b_id = DEMO_PARTNER_ID;
          activate(c, uid);
        }
        break;
      }
      case 'PARTNER_DEFENDS': {
        const c = state.cases.find((x) => x.id === a.ref);
        if (c && c.status === 'AWAITING_DEFENSE' && c.defendant_plea === null && now() < new Date(c.defense_deadline).getTime()) {
          c.defendant_plea = PARTNER_DEFENSES[c.category] ?? PARTNER_DEFENSES.OTHER!;
          c.defense_submitted_at = iso();
          touch('court_cases');
          claim(c); // the DB webhook fires right after a defense
        }
        break;
      }
      case 'JUDGE_FINISH': {
        const c = state.cases.find((x) => x.id === a.ref);
        if (c) finishJudgement(c);
        break;
      }
      case 'PARTNER_ANSWERS': {
        const q = state.questions.find((x) => x.id === a.ref);
        if (q && !q.is_answered) {
          q.answer_text = 'Olur, bence de iyi fikir. Akşam detayları konuşalım 🙂';
          q.is_answered = true;
          q.answered_at = iso();
          touch('pending_questions');
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // public API — same signatures and errors as src/api/*
  // ---------------------------------------------------------------------------
  const api = {
    ready,
    tick,

    subscribe(channel: Channel | (string & {}), fn: () => void): () => void {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },

    // ---- auth ----
    async getSession() {
      await ready;
      return clone(state.session);
    },
    async signIn(email: string, password: string): Promise<void> {
      return op(() => {
        const e = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new Error('Invalid login credentials');
        if (password.length < 6) throw new Error('Password should be at least 6 characters');
        ensureProfile(DEMO_ME_ID, e.split('@')[0] ?? 'Ben');
        state.session = { userId: DEMO_ME_ID, email: e };
        touch('auth');
      });
    },
    async signUp(email: string, password: string, displayName: string): Promise<boolean> {
      await api.signIn(email, password);
      return local(() => {
        const p = state.profiles.find((x) => x.id === DEMO_ME_ID)!;
        if (displayName.trim()) p.display_name = displayName.trim().slice(0, 40);
        touch('profiles');
        return true;
      });
    },
    async signOut(): Promise<void> {
      return local(() => {
        state.session = null;
        touch('auth');
      });
    },

    // ---- couple ----
    async fetchMyCouple(userId: string): Promise<Couple | null> {
      return op(() => {
        const c = state.couple;
        return c && (c.user_a_id === userId || c.user_b_id === userId) ? c : null;
      });
    },
    async fetchCoupleProfiles(): Promise<Profile[]> {
      return op(() => {
        const uid = me();
        const c = state.couple;
        const partner = c?.is_active ? partnerOf(c, uid) : null;
        return state.profiles.filter((p) => p.id === uid || p.id === partner);
      });
    },
    async createPairingCode(): Promise<Couple> {
      return op(() => {
        const uid = me();
        if (state.couple?.is_active) throw new AppError('ALREADY_PAIRED', 'ALREADY_PAIRED');
        const seed = deps.uuid().replace(/-/g, '');
        let code = '';
        for (let i = 0; i < 6; i++) code += CODE_ALPHABET[parseInt(seed.slice(i * 2, i * 2 + 2), 16) % 32];
        state.couple = {
          id: state.couple?.id ?? deps.uuid(),
          user_a_id: uid,
          user_b_id: null,
          pairing_code: code,
          pairing_code_expires_at: iso(now() + 24 * 3_600_000),
          is_active: false,
          user_a_battery: null,
          user_b_battery: null,
          user_a_status: 'NORMAL',
          user_b_status: 'NORMAL',
          user_a_seen_at: null,
          user_b_seen_at: null,
          created_at: iso(),
          paired_at: null,
        };
        state.scheduled = state.scheduled.filter((a) => a.type !== 'PARTNER_JOINS');
        schedule('PARTNER_JOINS', PARTNER_DELAYS.join);
        touch('couples');
        return state.couple;
      });
    },
    async pairWithCode(code: string): Promise<Couple> {
      return op(() => {
        const uid = me();
        const c = code.toUpperCase().trim();
        if (state.couple?.is_active) throw new AppError('ALREADY_PAIRED', 'ALREADY_PAIRED');
        if (!CODE_RE.test(c) || state.couple?.pairing_code === c) throw new AppError('INVALID_CODE', 'INVALID_CODE');
        // Any well-formed code "belongs" to the simulated partner. Partner is
        // user_a here, so the app's side-b code paths get exercised too.
        ensureProfile(DEMO_PARTNER_ID, DEMO_PARTNER_NAME);
        const couple: Couple = {
          id: deps.uuid(),
          user_a_id: DEMO_PARTNER_ID,
          user_b_id: uid,
          pairing_code: null,
          pairing_code_expires_at: null,
          is_active: false,
          user_a_battery: null,
          user_b_battery: null,
          user_a_status: 'NORMAL',
          user_b_status: 'NORMAL',
          user_a_seen_at: null,
          user_b_seen_at: null,
          created_at: iso(),
          paired_at: null,
        };
        state.couple = couple; // my own pending invite (if any) is discarded
        activate(couple, uid);
        return couple;
      });
    },
    async updatePresence(input: { battery?: number | null; status?: PartnerStatus | null }): Promise<Couple> {
      return op(() => {
        const uid = me();
        const c = activeCouple();
        const side = c.user_a_id === uid ? 'a' : 'b';
        const battery = input.battery != null && input.battery >= 0 && input.battery <= 100 ? input.battery : null;
        let next: PartnerStatus = input.status ?? c[`user_${side}_status`];
        if (!input.status) {
          if (battery !== null && battery <= 15 && next === 'NORMAL') next = 'LOW_BATTERY';
          else if ((battery === null || battery > 15) && next === 'LOW_BATTERY') next = 'NORMAL';
        }
        if (battery !== null) c[`user_${side}_battery`] = battery;
        c[`user_${side}_status`] = next;
        c[`user_${side}_seen_at`] = iso();
        touch('couples');
        return c;
      });
    },

    // ---- court ----
    async listCases(coupleId: string): Promise<CourtCase[]> {
      return op(() => {
        activeCouple();
        return state.cases
          .filter((c) => c.couple_id === coupleId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
    },
    async getCase(caseId: string): Promise<CourtCase> {
      return op(() => {
        const couple = activeCouple();
        const c = state.cases.find((x) => x.id === caseId && x.couple_id === couple.id);
        if (!c) throw new Error('JSON object requested, multiple (or no) rows returned');
        return c;
      });
    },
    async fileCase(input: { title: string; category: string; plea: string }): Promise<CourtCase> {
      return op(() => {
        const uid = me();
        const couple = activeCouple();
        if (len(input.title) < 3 || len(input.title) > 120) throw checkViolation('court_cases_title_check');
        if (!CATEGORIES.includes(input.category)) throw checkViolation('court_cases_category_check');
        if (len(input.plea) < 10 || len(input.plea) > 4000) throw checkViolation('court_cases_prosecutor_plea_check');
        const today = state.cases.filter(
          (c) => c.prosecutor_id === uid && now() - new Date(c.created_at).getTime() < 86_400_000,
        ).length;
        if (today >= 5) throw new AppError('DAILY_CASE_LIMIT', 'DAILY_CASE_LIMIT');
        const c = baseCase(couple.id, uid, partnerOf(couple, uid), {
          title: input.title.trim(),
          category: input.category,
          prosecutor_plea: input.plea.trim(),
        });
        state.cases.push(c);
        schedule('PARTNER_DEFENDS', PARTNER_DELAYS.defend, c.id);
        touch('court_cases');
        return c;
      });
    },
    async submitDefense(caseId: string, plea: string): Promise<CourtCase> {
      return op(() => {
        const uid = me();
        const couple = activeCouple();
        const c = state.cases.find((x) => x.id === caseId && x.couple_id === couple.id);
        if (!c) throw new AppError('CASE_NOT_FOUND', 'CASE_NOT_FOUND');
        if (c.defendant_id !== uid) throw new AppError('NOT_DEFENDANT', 'NOT_DEFENDANT');
        if (c.status !== 'AWAITING_DEFENSE' || c.defendant_plea !== null) throw new AppError('DEFENSE_CLOSED', 'DEFENSE_CLOSED');
        if (now() >= new Date(c.defense_deadline).getTime()) {
          throw new AppError('DEFENSE_DEADLINE_PASSED', 'DEFENSE_DEADLINE_PASSED');
        }
        if (len(plea) < 1 || len(plea) > 4000) throw checkViolation('court_cases_defendant_plea_check');
        c.defendant_plea = plea.trim();
        c.defense_submitted_at = iso();
        claim(c); // webhook equivalent
        touch('court_cases');
        return c;
      });
    },
    async requestVerdict(caseId: string): Promise<'judged' | 'already_handled'> {
      return op(() => {
        const c = state.cases.find((x) => x.id === caseId);
        return c && claim(c) ? 'judged' : 'already_handled';
      });
    },

    // ---- plans ----
    async listPlans(coupleId: string): Promise<Plan[]> {
      return op(() => {
        activeCouple();
        return state.plans
          .filter((p) => p.couple_id === coupleId)
          .sort((a, b) => (a.plan_date ?? '9999').localeCompare(b.plan_date ?? '9999'));
      });
    },
    async getPlan(planId: string): Promise<Plan> {
      return op(() => {
        const couple = activeCouple();
        const p = state.plans.find((x) => x.id === planId && x.couple_id === couple.id);
        if (!p) throw new AppError('PLAN_NOT_FOUND', 'PLAN_NOT_FOUND');
        return p;
      });
    },
    async createPlan(input: {
      coupleId: string;
      userId: string;
      title: string;
      location: string | null;
      planDate: string | null;
    }): Promise<Plan> {
      return op(() => {
        const couple = activeCouple();
        if (input.coupleId !== couple.id) throw new Error('new row violates row-level security policy');
        if (len(input.title) < 1 || len(input.title) > 120) throw checkViolation('plans_title_check');
        if ((input.location ?? '').length > 200) throw checkViolation('plans_location_check');
        const p: Plan = {
          id: deps.uuid(),
          couple_id: couple.id,
          created_by: input.userId,
          title: input.title.trim(),
          location: input.location?.trim() || null,
          plan_date: input.planDate,
          checklist: [],
          created_at: iso(),
          updated_at: iso(),
        };
        state.plans.push(p);
        touch('plans');
        return p;
      });
    },
    async updatePlanMeta(
      planId: string,
      patch: { title?: string; location?: string | null; plan_date?: string | null },
    ): Promise<void> {
      return op(() => {
        const couple = activeCouple();
        const p = state.plans.find((x) => x.id === planId && x.couple_id === couple.id);
        if (!p) return; // RLS: zero rows updated, no error
        if (patch.title !== undefined && (len(patch.title) < 1 || len(patch.title) > 120)) {
          throw checkViolation('plans_title_check');
        }
        Object.assign(p, patch, { updated_at: iso() });
        touch('plans');
      });
    },
    async deletePlan(planId: string): Promise<void> {
      return op(() => {
        const couple = activeCouple();
        state.plans = state.plans.filter((x) => !(x.id === planId && x.couple_id === couple.id));
        touch('plans');
      });
    },
    async upsertChecklistItem(planId: string, item: ChecklistItem): Promise<Plan> {
      return op(() => {
        const couple = activeCouple();
        if (!UUID_RE.test(item.id ?? '')) throw new AppError('INVALID_ITEM_ID', 'INVALID_ITEM_ID');
        const text = (item.text ?? '').trim();
        if (text.length < 1 || text.length > 200) throw new AppError('INVALID_ITEM_TEXT', 'INVALID_ITEM_TEXT');
        const ts = new Date(item.updated_at).getTime();
        if (Number.isNaN(ts)) throw new AppError('INVALID_ITEM_TIMESTAMP', 'INVALID_ITEM_TIMESTAMP');
        const p = state.plans.find((x) => x.id === planId && x.couple_id === couple.id);
        if (!p) throw new AppError('PLAN_NOT_FOUND', 'PLAN_NOT_FOUND');

        const clamped: ChecklistItem = {
          id: item.id.toLowerCase(),
          text,
          done: item.done === true,
          deleted: item.deleted === true,
          updated_at: iso(Math.min(ts, now() + 60_000)), // clock-skew guard
        };
        let list = parseChecklist(p.checklist).filter(
          (e) => !(e.deleted && now() - new Date(e.updated_at).getTime() > 30 * 86_400_000 && e.id !== clamped.id),
        );
        const exists = list.some((e) => e.id === clamped.id);
        if (!exists && list.filter((e) => !e.deleted).length >= 100) {
          throw new AppError('CHECKLIST_FULL', 'CHECKLIST_FULL');
        }
        list = mergeChecklistItem(list, clamped);
        p.checklist = list as unknown as Json;
        p.updated_at = iso();
        touch('plans');
        return p;
      });
    },

    // ---- cooling-off room ----
    async listMessages(coupleId: string): Promise<DelayedMessage[]> {
      return op(() => {
        const uid = me();
        activeCouple();
        // RLS mirror: own messages in any state + partner's SENT messages only.
        return state.messages
          .filter((m) => m.couple_id === coupleId)
          .filter((m) => m.sender_id === uid || (m.recipient_id === uid && m.status === 'SENT'))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
    },
    async scheduleMessage(content: string, delayMinutes: number): Promise<DelayedMessage> {
      return op(() => {
        const uid = me();
        const couple = activeCouple();
        if (!Number.isInteger(delayMinutes) || delayMinutes < 15 || delayMinutes > 60) {
          throw new AppError('INVALID_DELAY', 'INVALID_DELAY');
        }
        if (len(content) < 1 || len(content) > 2000) throw checkViolation('delayed_messages_content_check');
        const m: DelayedMessage = {
          id: deps.uuid(),
          couple_id: couple.id,
          sender_id: uid,
          recipient_id: partnerOf(couple, uid),
          content: content.trim(),
          delay_minutes: delayMinutes,
          release_at: iso(now() + scaledMs(delayMinutes)),
          status: 'PENDING',
          sent_at: null,
          cancelled_at: null,
          created_at: iso(),
        };
        state.messages.push(m);
        touch('delayed_messages');
        return m;
      });
    },
    async cancelMessage(messageId: string): Promise<boolean> {
      return op(() => {
        const uid = me();
        const m = state.messages.find((x) => x.id === messageId);
        if (!m || m.sender_id !== uid || m.status !== 'PENDING' || new Date(m.release_at).getTime() <= now()) {
          return false;
        }
        m.status = 'CANCELLED';
        m.cancelled_at = iso();
        touch('delayed_messages');
        return true;
      });
    },

    // ---- questions vault ----
    async listQuestions(coupleId: string): Promise<PendingQuestion[]> {
      return op(() => {
        activeCouple();
        return state.questions
          .filter((q) => q.couple_id === coupleId)
          .sort((a, b) => Number(a.is_answered) - Number(b.is_answered) || b.created_at.localeCompare(a.created_at));
      });
    },
    async askQuestion(text: string): Promise<PendingQuestion> {
      return op(() => {
        const uid = me();
        const couple = activeCouple();
        if (len(text) < 1 || len(text) > 1000) throw checkViolation('pending_questions_question_text_check');
        const q: PendingQuestion = {
          id: deps.uuid(),
          couple_id: couple.id,
          asker_id: uid,
          question_text: text.trim(),
          answer_text: null,
          is_answered: false,
          answered_at: null,
          created_at: iso(),
        };
        state.questions.push(q);
        schedule('PARTNER_ANSWERS', PARTNER_DELAYS.answer, q.id);
        touch('pending_questions');
        return q;
      });
    },
    async answerQuestion(questionId: string, answer: string): Promise<PendingQuestion> {
      return op(() => {
        const uid = me();
        const couple = activeCouple();
        const q = state.questions.find((x) => x.id === questionId && x.couple_id === couple.id);
        if (!q) throw new AppError('QUESTION_NOT_FOUND', 'QUESTION_NOT_FOUND');
        if (q.asker_id === uid) throw new AppError('CANNOT_ANSWER_OWN', 'CANNOT_ANSWER_OWN');
        if (q.is_answered) throw new AppError('ALREADY_ANSWERED', 'ALREADY_ANSWERED');
        if (len(answer) < 1 || len(answer) > 2000) throw checkViolation('pending_questions_answer_text_check');
        q.answer_text = answer.trim();
        q.is_answered = true;
        q.answered_at = iso();
        touch('pending_questions');
        return q;
      });
    },
    async deleteQuestion(questionId: string): Promise<void> {
      return op(() => {
        const uid = me();
        // RLS mirror: only the asker's own unanswered question; otherwise 0 rows.
        state.questions = state.questions.filter(
          (q) => !(q.id === questionId && q.asker_id === uid && !q.is_answered),
        );
        touch('pending_questions');
      });
    },
  };

  // ---------------------------------------------------------------------------
  // control panel — drive the simulated partner and the environment
  // ---------------------------------------------------------------------------
  const panel = {
    getSettings: async () => {
      await ready;
      return clone(state.settings);
    },
    setOffline: (offline: boolean) =>
      local(() => {
        state.settings.offline = offline;
        touch('settings');
      }),
    setTimeScale: (timeScale: 1 | 60) =>
      local(() => {
        state.settings.timeScale = timeScale;
        touch('settings');
      }),
    setLatency: (latencyMs: number) =>
      local(() => {
        state.settings.latencyMs = Math.max(0, Math.min(5000, latencyMs));
        touch('settings');
      }),
    partnerFilesCase: () =>
      local(() => {
        const uid = me();
        const couple = activeCouple();
        const c = baseCase(couple.id, partnerOf(couple, uid), uid, {
          title: 'Son dilim pizzayı sormadan yemek',
          category: 'OTHER',
          prosecutor_plea: 'Kutuda tek dilim kalmıştı ve "kimse yemiyor mu?" sorusu sorulmadan yendi. Bu bir güven meselesidir.',
        });
        state.cases.push(c);
        touch('court_cases');
        return c.id;
      }),
    expireMyDefenses: () =>
      local(() => {
        const uid = me();
        let n = 0;
        for (const c of state.cases) {
          if (c.defendant_id === uid && c.status === 'AWAITING_DEFENSE' && c.defendant_plea === null) {
            c.defense_deadline = iso(now() - 1000);
            n++;
          }
        }
        touch('court_cases');
        return n;
      }),
    partnerSendsMessage: () =>
      local(() => {
        const uid = me();
        const couple = activeCouple();
        const delay = 15;
        state.messages.push({
          id: deps.uuid(),
          couple_id: couple.id,
          sender_id: partnerOf(couple, uid),
          recipient_id: uid,
          content: 'Biraz kırıldım ama geçti. Akşam yemeği benden, tamam mı?',
          delay_minutes: delay,
          release_at: iso(now() + scaledMs(delay)),
          status: 'PENDING',
          sent_at: null,
          cancelled_at: null,
          created_at: iso(),
        });
        touch('delayed_messages');
      }),
    /** Partner silently withdraws their pending message — you must see nothing. */
    partnerCancelsPending: () =>
      local(() => {
        const uid = me();
        let n = 0;
        for (const m of state.messages) {
          if (m.recipient_id === uid && m.status === 'PENDING' && new Date(m.release_at).getTime() > now()) {
            m.status = 'CANCELLED';
            m.cancelled_at = iso();
            n++;
          }
        }
        touch('delayed_messages');
        return n;
      }),
    partnerAsksQuestion: () =>
      local(() => {
        const uid = me();
        const couple = activeCouple();
        state.questions.push({
          id: deps.uuid(),
          couple_id: couple.id,
          asker_id: partnerOf(couple, uid),
          question_text: 'Bu akşam ne yesek? Sushi mi, köfte mi?',
          answer_text: null,
          is_answered: false,
          answered_at: null,
          created_at: iso(),
        });
        touch('pending_questions');
      }),
    partnerTogglesFirstItem: () =>
      local(() => {
        const couple = activeCouple();
        const p = state.plans.find((x) => x.couple_id === couple.id);
        if (!p) return false;
        const items = parseChecklist(p.checklist);
        const first = items.find((i) => !i.deleted);
        if (!first) return false;
        p.checklist = mergeChecklistItem(items, { ...first, done: !first.done, updated_at: iso() }) as unknown as Json;
        p.updated_at = iso();
        touch('plans');
        return true;
      }),
    setPartnerPresence: (battery: number | null, status: PartnerStatus) =>
      local(() => {
        const uid = me();
        const c = activeCouple();
        const side = c.user_a_id === uid ? 'b' : 'a';
        c[`user_${side}_battery`] = battery;
        c[`user_${side}_status`] = status;
        c[`user_${side}_seen_at`] = iso();
        touch('couples');
      }),
    reset: async () => {
      await ready;
      state = freshState();
      await deps.storage.removeItem(STORAGE_KEY);
      for (const ch of ['auth', 'settings', 'couples', 'court_cases', 'delayed_messages', 'pending_questions', 'plans', 'profiles'] as Channel[]) {
        listeners.get(ch)?.forEach((fn) => fn());
      }
    },
  };

  return { ...api, panel };
}

export type DemoBackend = ReturnType<typeof createDemoBackend>;
