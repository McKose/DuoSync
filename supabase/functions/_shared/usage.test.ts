import { assertEquals } from 'jsr:@std/assert@1';
import {
  alertMessage,
  budgetLevel,
  crossedLevel,
  DEFAULT_LIMITS,
  isBillable,
  NO_USAGE,
  parseUsage,
  readLimits,
  totalsBefore,
  type Limits,
} from './usage.ts';

const L: Limits = { calls: 10, tokens: 1000, alertRatio: 0.8 };

Deno.test('parseUsage reads usageMetadata and survives junk', () => {
  assertEquals(
    parseUsage({ usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 301, thoughtsTokenCount: 40, totalTokenCount: 1153 } }),
    { prompt: 812, output: 301, thought: 40, total: 1153 },
  );
  // No total reported: summed.
  assertEquals(parseUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } }).total, 12);
  for (const body of [null, undefined, {}, { usageMetadata: 'x' }, { usageMetadata: { promptTokenCount: -3, totalTokenCount: 'NaN' } }]) {
    assertEquals(parseUsage(body), NO_USAGE);
  }
});

Deno.test('billable = the model may have processed the call (matches the SQL generated column)', () => {
  assertEquals(['ok', 'invalid_output', 'timeout', 'http_error', 'network_error'].map((o) => isBillable(o as never)), [
    true,
    true,
    true,
    false,
    false,
  ]);
});

Deno.test('readLimits: env overrides, bad values fall back to defaults', () => {
  assertEquals(readLimits(() => undefined), DEFAULT_LIMITS);
  const env: Record<string, string> = { GEMINI_DAILY_CALL_LIMIT: '40', GEMINI_DAILY_TOKEN_LIMIT: '90000' };
  assertEquals(readLimits((n) => env[n]), { calls: 40, tokens: 90000, alertRatio: 0.8 });
  for (const bad of ['0', '-1', '2.5', 'lots', ' ']) {
    assertEquals(readLimits((n) => (n === 'GEMINI_DAILY_CALL_LIMIT' ? bad : undefined)).calls, DEFAULT_LIMITS.calls, bad);
  }
});

Deno.test('budget level: either limit triggers; 80 % warns', () => {
  assertEquals(budgetLevel({ calls: 0, tokens: 0 }, L), 'ok');
  assertEquals(budgetLevel({ calls: 7, tokens: 799 }, L), 'ok');
  assertEquals(budgetLevel({ calls: 8, tokens: 0 }, L), 'warn');
  assertEquals(budgetLevel({ calls: 0, tokens: 800 }, L), 'warn');
  assertEquals(budgetLevel({ calls: 10, tokens: 0 }, L), 'exhausted');
  assertEquals(budgetLevel({ calls: 1, tokens: 1000 }, L), 'exhausted');
});

Deno.test('crossedLevel fires once per level, and jumps straight to exhausted', () => {
  assertEquals(crossedLevel({ calls: 7, tokens: 0 }, { calls: 8, tokens: 0 }, L), 'warn');
  assertEquals(crossedLevel({ calls: 8, tokens: 0 }, { calls: 9, tokens: 0 }, L), null);
  assertEquals(crossedLevel({ calls: 9, tokens: 0 }, { calls: 10, tokens: 0 }, L), 'exhausted');
  assertEquals(crossedLevel({ calls: 1, tokens: 100 }, { calls: 2, tokens: 1500 }, L), 'exhausted');
  assertEquals(crossedLevel({ calls: 10, tokens: 0 }, { calls: 11, tokens: 0 }, L), null);
});

Deno.test('totalsBefore undoes only billable calls', () => {
  const after = { calls: 8, tokens: 900 };
  const usage = { prompt: 100, output: 50, thought: 0, total: 150 };
  assertEquals(totalsBefore(after, 'ok', usage), { calls: 7, tokens: 750 });
  assertEquals(totalsBefore(after, 'timeout', NO_USAGE), { calls: 7, tokens: 900 });
  assertEquals(totalsBefore(after, 'http_error', NO_USAGE), after);
  assertEquals(totalsBefore({ calls: 0, tokens: 10 }, 'ok', usage), { calls: 0, tokens: 0 });
});

Deno.test('alert copy is Turkish and carries the numbers', () => {
  const warn = alertMessage('warn', { calls: 8, tokens: 1234 }, { calls: 10, tokens: 300000, alertRatio: 0.8 });
  assertEquals(warn.title, 'AI kullanımı %80 sınırında');
  assertEquals(warn.body, 'Bugün 8/10 çağrı, 1.234/300.000 token.');
  const done = alertMessage('exhausted', { calls: 10, tokens: 5 }, L);
  assertEquals(done.title, 'AI heyeti günlük limitte');
  assertEquals(done.body.endsWith('Yeni kararlar UTC gece yarısından sonra verilecek.'), true);
});
