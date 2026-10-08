// Demo backend contract tests: the fake server must enforce the same rules
// as the real one, otherwise testing on it proves nothing.
// Run: npm run test:demo
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createDemoBackend, DEMO_ME_ID, DEMO_PARTNER_ID, PARTNER_DELAYS } from '../../src/demo/engine';
import { demoVerdict } from '../../src/demo/judge';
import { errorCode, isNetworkError } from '../../src/lib/errors';

function setup() {
  const mem = new Map<string, string>();
  let clock = Date.parse('2026-10-09T10:00:00Z');
  const be = createDemoBackend({
    storage: {
      getItem: async (k) => mem.get(k) ?? null,
      setItem: async (k, v) => void mem.set(k, v),
      removeItem: async (k) => void mem.delete(k),
    },
    uuid: randomUUID,
    now: () => clock,
    sleep: async () => undefined,
  });
  const advance = async (ms: number) => {
    clock += ms;
    await be.tick();
  };
  return { be, mem, advance, now: () => clock };
}

async function paired() {
  const s = setup();
  await s.be.signUp('ayse@example.com', 'secret123', 'Ayşe');
  await s.be.pairWithCode('K7M2QX');
  const couple = (await s.be.fetchMyCouple(DEMO_ME_ID))!;
  return { ...s, couple };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return errorCode(e) ?? (e as Error).message;
  }
  return 'NO_ERROR';
};

describe('auth & pairing', () => {
  test('sign up → unpaired → create code → partner joins after delay', async () => {
    const { be, advance } = setup();
    await be.signUp('ayse@example.com', 'secret123', 'Ayşe');
    assert.equal((await be.getSession())?.userId, DEMO_ME_ID);
    assert.equal(await be.fetchMyCouple(DEMO_ME_ID), null);

    const pending = await be.createPairingCode();
    assert.match(pending.pairing_code!, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(pending.is_active, false);

    await advance(PARTNER_DELAYS.join - 1);
    assert.equal((await be.fetchMyCouple(DEMO_ME_ID))!.is_active, false);
    await advance(2);
    const c = (await be.fetchMyCouple(DEMO_ME_ID))!;
    assert.equal(c.is_active, true);
    assert.equal(c.user_b_id, DEMO_PARTNER_ID);
    assert.equal(c.pairing_code, null);
  });

  test('joining: invalid format and own code rejected; valid code pairs me as side b', async () => {
    const { be } = setup();
    await be.signIn('ayse@example.com', 'secret123');
    const own = await be.createPairingCode();
    assert.equal(await codeOf(be.pairWithCode('abc')), 'INVALID_CODE');
    assert.equal(await codeOf(be.pairWithCode(own.pairing_code!)), 'INVALID_CODE');
    const c = await be.pairWithCode('k7m2qx');
    assert.equal(c.user_a_id, DEMO_PARTNER_ID);
    assert.equal(c.user_b_id, DEMO_ME_ID);
    assert.equal(await codeOf(be.createPairingCode()), 'ALREADY_PAIRED');
  });

  test('auth errors use Supabase wording so the app maps them', async () => {
    const { be } = setup();
    assert.match(await codeOf(be.signIn('not-an-email', 'secret123')), /Invalid login credentials/);
    assert.match(await codeOf(be.signIn('a@b.co', '123')), /Password should be at least/);
  });

  test('state persists across instances (reload)', async () => {
    const { be, mem } = await paired();
    await be.askQuestion('Kalıcı mı?');
    const reopened = createDemoBackend({
      storage: { getItem: async (k) => mem.get(k) ?? null, setItem: async () => undefined, removeItem: async () => undefined },
      uuid: randomUUID,
    });
    assert.equal((await reopened.getSession())?.userId, DEMO_ME_ID);
  });
});

describe('court', () => {
  test('defense lock: no verdict until partner defends, then deliberation → judged', async () => {
    const { be, couple, advance } = await paired();
    const c = await be.fileCase({ title: 'Bulaşıklar', category: 'CHORES', plea: 'Üç gündür makine boşaltılmadı.' });
    assert.equal(c.defendant_id, DEMO_PARTNER_ID);
    assert.equal(await be.requestVerdict(c.id), 'already_handled'); // lock engaged

    await advance(PARTNER_DELAYS.defend);
    let now = await be.getCase(c.id);
    assert.equal(now.status, 'DELIBERATING');
    assert.ok(now.defendant_plea);

    await advance(PARTNER_DELAYS.judge);
    now = await be.getCase(c.id);
    assert.equal(now.status, 'JUDGED');
    assert.equal(now.fault_ratio_prosecutor! + now.fault_ratio_defendant!, 100);
    assert.ok(now.verdict_judge && now.verdict_comedian && now.penalty);
    assert.equal((await be.listCases(couple.id)).some((x) => x.id === c.id), true);
  });

  test('my defense on seeded case: only defendant, once, before deadline', async () => {
    const { be, couple, advance } = await paired();
    const mine = (await be.listCases(couple.id)).find((c) => c.defendant_id === DEMO_ME_ID && c.status === 'AWAITING_DEFENSE')!;
    const theirs = (await be.listCases(couple.id)).find((c) => c.prosecutor_id === DEMO_ME_ID)!;
    assert.equal(await codeOf(be.submitDefense(theirs.id, 'x')), 'NOT_DEFENDANT');
    const after = await be.submitDefense(mine.id, 'Toplantıdaydım.');
    assert.equal(after.status, 'DELIBERATING');
    assert.equal(await codeOf(be.submitDefense(mine.id, 'tekrar')), 'DEFENSE_CLOSED');
    await advance(PARTNER_DELAYS.judge);
    assert.equal((await be.getCase(mine.id)).status, 'JUDGED');
  });

  test('24h timeout: sweep injects default plea and judges', async () => {
    const { be, couple, advance } = await paired();
    const id = await be.panel.partnerFilesCase();
    await be.panel.expireMyDefenses();
    assert.equal(await codeOf(be.submitDefense(id, 'geç kaldım')), 'DEFENSE_DEADLINE_PASSED');
    await advance(1);
    const c = await be.getCase(id);
    assert.equal(c.defense_timed_out, true);
    assert.match(c.defendant_plea!, /süre aşımı/);
    await advance(PARTNER_DELAYS.judge);
    assert.equal((await be.getCase(id)).status, 'JUDGED');
    assert.ok((await be.listCases(couple.id)).length >= 3);
  });

  test('validation + daily limit', async () => {
    const { be } = await paired();
    assert.match(await codeOf(be.fileCase({ title: 'ab', category: 'CHORES', plea: 'yeterince uzun iddia' })), /check constraint/);
    assert.match(await codeOf(be.fileCase({ title: 'Başlık', category: 'NOPE', plea: 'yeterince uzun iddia' })), /check constraint/);
    for (let i = 0; i < 5; i++) await be.fileCase({ title: `Dava ${i}`, category: 'OTHER', plea: 'yeterince uzun iddia' });
    assert.equal(await codeOf(be.fileCase({ title: 'Altıncı', category: 'OTHER', plea: 'yeterince uzun iddia' })), 'DAILY_CASE_LIMIT');
  });
});

describe('cooling-off room (silent cancel)', () => {
  test('delay bounds; time-scaled release; too-late cancel', async () => {
    const { be, couple, advance } = await paired();
    assert.equal(await codeOf(be.scheduleMessage('kızgınım', 5)), 'INVALID_DELAY');
    const m = await be.scheduleMessage('Çok kızgınım!', 15); // 15 "min" = 15 s at 60×
    assert.equal(new Date(m.release_at).getTime() - new Date(m.created_at).getTime(), 15_000);
    await advance(15_000);
    const mine = (await be.listMessages(couple.id)).find((x) => x.id === m.id)!;
    assert.equal(mine.status, 'SENT');
    assert.equal(await be.cancelMessage(m.id), false);
  });

  test('my cancel: stays visible to me as CANCELLED', async () => {
    const { be, couple } = await paired();
    const m = await be.scheduleMessage('Geri çekeceğim', 30);
    assert.equal(await be.cancelMessage(m.id), true);
    const mine = (await be.listMessages(couple.id)).find((x) => x.id === m.id)!;
    assert.equal(mine.status, 'CANCELLED');
  });

  test('recipient view: partner PENDING invisible, partner CANCEL leaves no trace', async () => {
    const { be, couple, advance } = await paired();
    const before = (await be.listMessages(couple.id)).length;
    await be.panel.partnerSendsMessage();
    assert.equal((await be.listMessages(couple.id)).length, before, 'pending leaked to recipient');
    await be.panel.partnerCancelsPending();
    await advance(60_000);
    const after = await be.listMessages(couple.id);
    assert.equal(after.length, before, 'cancelled message leaked to recipient');
    assert.ok(after.every((x) => x.status !== 'CANCELLED' || x.sender_id === DEMO_ME_ID));
  });

  test('partner message released after its delay', async () => {
    const { be, couple, advance } = await paired();
    const before = (await be.listMessages(couple.id)).length;
    await be.panel.partnerSendsMessage();
    await advance(15_000);
    assert.equal((await be.listMessages(couple.id)).length, before + 1);
  });

  test('real-time scale (1×): 15 minutes means 15 minutes', async () => {
    const { be } = await paired();
    await be.panel.setTimeScale(1);
    const m = await be.scheduleMessage('Yavaş', 15);
    assert.equal(new Date(m.release_at).getTime() - new Date(m.created_at).getTime(), 15 * 60_000);
  });
});

describe('questions', () => {
  test('cannot answer own; partner answers mine; I answer theirs once', async () => {
    const { be, couple, advance } = await paired();
    const q = await be.askQuestion('Pazar annemlere gidelim mi?');
    assert.equal(await codeOf(be.answerQuestion(q.id, 'evet')), 'CANNOT_ANSWER_OWN');
    await advance(PARTNER_DELAYS.answer);
    assert.equal((await be.listQuestions(couple.id)).find((x) => x.id === q.id)!.is_answered, true);
    const theirs = (await be.listQuestions(couple.id)).find((x) => x.asker_id === DEMO_PARTNER_ID && !x.is_answered)!;
    await be.answerQuestion(theirs.id, 'Olur');
    assert.equal(await codeOf(be.answerQuestion(theirs.id, 'yine')), 'ALREADY_ANSWERED');
  });
});

describe('checklist LWW', () => {
  test('stale write loses, newer wins, future clamped, tombstone, partner edit', async () => {
    const { be, couple, now } = await paired();
    const plan = (await be.listPlans(couple.id))[0]!;
    const id = randomUUID();
    const at = (ms: number) => new Date(now() + ms).toISOString();
    await be.upsertChecklistItem(plan.id, { id, text: 'Masa', done: false, deleted: false, updated_at: at(0) });
    await be.upsertChecklistItem(plan.id, { id, text: 'Masa', done: true, deleted: false, updated_at: at(5_000) });
    let p = await be.upsertChecklistItem(plan.id, { id, text: 'Masa', done: false, deleted: false, updated_at: at(1_000) });
    const item = (p.checklist as { id: string; done: boolean; updated_at: string }[]).find((x) => x.id === id)!;
    assert.equal(item.done, true);

    p = await be.upsertChecklistItem(plan.id, { id, text: 'Masa', done: false, deleted: false, updated_at: '2099-01-01T00:00:00Z' });
    const ts = Date.parse((p.checklist as { id: string; updated_at: string }[]).find((x) => x.id === id)!.updated_at);
    assert.ok(ts <= now() + 60_000);

    assert.equal(await codeOf(be.upsertChecklistItem(plan.id, { id: 'nope', text: 'x', done: false, deleted: false, updated_at: at(0) })), 'INVALID_ITEM_ID');
    assert.equal(await be.panel.partnerTogglesFirstItem(), true);
  });
});

describe('presence', () => {
  test('LOW_BATTERY auto only over NORMAL; manual status sticks', async () => {
    const { be } = await paired();
    let c = await be.updatePresence({ battery: 10 });
    assert.equal(c.user_b_status, 'LOW_BATTERY');
    c = await be.updatePresence({ battery: 80 });
    assert.equal(c.user_b_status, 'NORMAL');
    await be.updatePresence({ status: 'BUSY' });
    c = await be.updatePresence({ battery: 5 });
    assert.equal(c.user_b_status, 'BUSY');
  });
});

describe('environment', () => {
  test('offline toggle: every API call fails with a network error; panel still works', async () => {
    const { be, couple } = await paired();
    await be.panel.setOffline(true);
    const err = await be.listCases(couple.id).catch((e) => e);
    assert.ok(isNetworkError(err));
    await be.panel.setOffline(false);
    assert.ok((await be.listCases(couple.id)).length > 0);
  });

  test('subscribers are notified per table', async () => {
    const { be } = await paired();
    let hits = 0;
    const off = be.subscribe('pending_questions', () => hits++);
    await be.askQuestion('Bildirim geliyor mu?');
    off();
    await be.askQuestion('Artık gelmemeli');
    assert.equal(hits, 1);
  });

  test('reset wipes everything back to signed-out', async () => {
    const { be } = await paired();
    await be.panel.reset();
    assert.equal(await be.getSession(), null);
  });
});

describe('demo judge', () => {
  test('always sums to 100, stays in 10..90, deterministic', () => {
    for (let i = 0; i < 300; i++) {
      for (const timedOut of [false, true]) {
        const v = demoVerdict({
          title: `T${i}`,
          category: ['CHORES', 'PLANS', 'MONEY', 'X'][i % 4]!,
          prosecutor_plea: `iddia ${i * 7}`,
          defendant_plea: `savunma ${i * 13}`,
          defense_timed_out: timedOut,
          prosecutorName: 'A',
          defendantName: 'B',
        });
        assert.equal(v.fault_ratio_prosecutor + v.fault_ratio_defendant, 100);
        assert.ok(v.fault_ratio_prosecutor >= 10 && v.fault_ratio_prosecutor <= 90);
        assert.ok(v.penalty.length > 0 && v.verdict_judge.includes('DEMO'));
      }
    }
    const a = demoVerdict({ title: 'x', category: 'CHORES', prosecutor_plea: 'p', defendant_plea: 'd', defense_timed_out: false, prosecutorName: 'A', defendantName: 'B' });
    const b = demoVerdict({ title: 'x', category: 'CHORES', prosecutor_plea: 'p', defendant_plea: 'd', defense_timed_out: false, prosecutorName: 'A', defendantName: 'B' });
    assert.deepEqual(a, b);
  });
});
