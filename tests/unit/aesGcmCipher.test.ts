// expo-crypto binding of the encrypted storage (ROADMAP B4, fixed in A4).
//
// The fake below mirrors the *Android native* signatures of expo-crypto 57
// (android/.../aes/AesCryptoModule.kt), backed by real AES-GCM from Node's
// WebCrypto:
// - SealedData.fromCombined(combined: ByteArray) — bytes only; a base64 string
//   fails type conversion. Passing a string here discarded the Supabase session
//   on the first phone run (2026-11-09).
// - decryptAsync returns the provider's whole output buffer; `overAllocate`
//   simulates a provider whose getOutputSize() does not subtract the GCM tag.
// Run: npm run test:unit
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';
import { base64ToBytes, createAesGcmCipher, IV_BYTES, TAG_BYTES, type ExpoAesApi } from '../../src/lib/aesGcmCipher';
import { createEncryptedStorage, ENVELOPE_PREFIX } from '../../src/lib/encryptedStorage';

const subtle = webcrypto.subtle;
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

class FakeKey {
  constructor(readonly raw: Uint8Array) {}
  async encoded(encoding: 'base64') {
    assert.equal(encoding, 'base64');
    return b64(this.raw);
  }
}

class FakeSealed {
  constructor(readonly content: Uint8Array) {}
  async combined(format: 'base64') {
    assert.equal(format, 'base64');
    return b64(this.content);
  }
}

/** Kotlin `ByteArray` parameter: anything but bytes fails conversion. */
function requireBytes(v: unknown, param: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new TypeError(`Cannot convert '${typeof v}' to ByteArray (${param})`);
  return v;
}

const aesKey = (k: FakeKey) => subtle.importKey('raw', k.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

function androidLikeApi(opts: { overAllocate?: number } = {}) {
  const calls = { fromCombined: 0 };
  const api: ExpoAesApi<FakeKey, FakeSealed> = {
    generateKey: async () => new FakeKey(webcrypto.getRandomValues(new Uint8Array(32))),
    importKey: async (s) => new FakeKey(new Uint8Array(Buffer.from(s, 'base64'))),
    encryptAsync: async (plaintext, key, { additionalData }) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await aesKey(key), requireBytes(plaintext, 'plaintext')),
      );
      return new FakeSealed(Uint8Array.from([...iv, ...ct]));
    },
    fromCombined: (combined) => {
      calls.fromCombined++;
      return new FakeSealed(requireBytes(combined, 'combined'));
    },
    decryptAsync: async (sealed, key, { output, additionalData }) => {
      assert.equal(output, 'bytes');
      const c = sealed.content;
      const pt = new Uint8Array(
        await subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, IV_BYTES), additionalData }, await aesKey(key), c.slice(IV_BYTES)),
      );
      const buf = new Uint8Array(pt.length + (opts.overAllocate ?? 0)); // trailing zeros, like ByteBuffer.array()
      buf.set(pt);
      return buf;
    },
  };
  return { api, calls };
}

function storageWith(
  api: ExpoAesApi<FakeKey, FakeSealed>,
  shared: { store?: Map<string, string>; keys?: Map<string, string> } = {},
) {
  const store = shared.store ?? new Map<string, string>();
  const keys = shared.keys ?? new Map<string, string>();
  const unreadable: string[] = [];
  const s = createEncryptedStorage({
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => void store.set(k, v),
      removeItem: async (k) => void store.delete(k),
    },
    keyStore: { get: async (n) => keys.get(n) ?? null, set: async (n, v) => void keys.set(n, v) },
    cipher: createAesGcmCipher(api),
    keyName: 'test.key',
    onUnreadable: (k) => unreadable.push(k),
  });
  return { s, store, keys, unreadable };
}

/** Write in one process, read in a fresh one (no in-memory copy): forces the native decrypt path. */
async function writeThenRestart(api: ExpoAesApi<FakeKey, FakeSealed>, entries: Record<string, string>) {
  const first = storageWith(api);
  for (const [k, v] of Object.entries(entries)) await first.s.setItem(k, v);
  return storageWith(api, { store: first.store, keys: first.keys });
}

// What supabase-js writes after signUp (shape only; values are fake).
const SESSION_KEY = 'sb-ndxpbbvfgupxlgoqoesh-auth-token';
const SESSION = JSON.stringify({
  access_token: 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(600),
  refresh_token: 'r3fr3sh',
  expires_at: 1_794_255_000,
  user: { id: '00000000-0000-4000-8000-000000000000', user_metadata: { display_name: 'Çağla Ğöküş 💞' } },
});

describe('expo-crypto AES-GCM binding (Android-strict fake)', () => {
  test('session written after sign-up reads back intact (the A4 bug: it was discarded)', async () => {
    const { api, calls } = androidLikeApi();
    const { s, store, unreadable } = await writeThenRestart(api, { [SESSION_KEY]: SESSION });
    assert.ok(store.get(SESSION_KEY)?.startsWith(ENVELOPE_PREFIX));
    assert.equal(await s.getItem(SESSION_KEY), SESSION);
    assert.equal(await s.getItem(SESSION_KEY), SESSION, 'every request re-reads the session');
    assert.deepEqual(unreadable, []);
    assert.equal(calls.fromCombined, 1, 'decrypted once, then served from memory');
    assert.deepEqual(JSON.parse((await s.getItem(SESSION_KEY))!), JSON.parse(SESSION));
  });

  test('provider that over-allocates the output buffer: trailing zeros are trimmed', async () => {
    const { api } = androidLikeApi({ overAllocate: TAG_BYTES });
    const { s, unreadable } = await writeThenRestart(api, { [SESSION_KEY]: SESSION });
    const back = await s.getItem(SESSION_KEY);
    assert.equal(back, SESSION);
    assert.equal(back?.includes('\u0000'), false);
    assert.deepEqual(unreadable, []);
  });

  test('empty string round trips (zero-length plaintext)', async () => {
    const { s } = await writeThenRestart(androidLikeApi().api, { k: '' });
    assert.equal(await s.getItem('k'), '');
  });

  test('stored layout is iv ‖ ciphertext ‖ tag (decryptable with plain WebCrypto)', async () => {
    const { api } = androidLikeApi();
    const cipher = createAesGcmCipher(api);
    const key = await cipher.generateKey();
    const aad = new TextEncoder().encode('name');
    const sealed = await cipher.encrypt(new TextEncoder().encode('hello'), key, aad);
    const all = new Uint8Array(Buffer.from(sealed, 'base64'));
    assert.equal(all.length, IV_BYTES + 5 + TAG_BYTES);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, IV_BYTES), additionalData: aad }, await aesKey(key), all.slice(IV_BYTES));
    assert.equal(new TextDecoder().decode(pt), 'hello');
  });

  test('truncated or non-base64 envelope: null, never reaches native, value kept', async () => {
    const { api, calls } = androidLikeApi();
    const { s, store, unreadable } = await writeThenRestart(api, { a: 'x' }); // creates the key
    store.set('short', ENVELOPE_PREFIX + b64(new Uint8Array(IV_BYTES + TAG_BYTES - 1)));
    store.set('junk', ENVELOPE_PREFIX + '***not base64***');
    calls.fromCombined = 0;
    assert.equal(await s.getItem('short'), null);
    assert.equal(await s.getItem('junk'), null);
    assert.deepEqual(unreadable, ['short', 'junk']);
    assert.equal(calls.fromCombined, 0);
    assert.ok(store.has('short') && store.has('junk'));
  });
});

describe('base64ToBytes', () => {
  test('matches Buffer for every length 0..96, padded and unpadded', () => {
    for (let n = 0; n <= 96; n++) {
      const bytes = webcrypto.getRandomValues(new Uint8Array(n));
      const padded = b64(bytes);
      assert.deepEqual(base64ToBytes(padded), bytes, `padded, n=${n}`);
      assert.deepEqual(base64ToBytes(padded.replace(/=+$/, '')), bytes, `unpadded, n=${n}`);
    }
  });

  test('rejects characters outside the standard alphabet and impossible lengths', () => {
    assert.throws(() => base64ToBytes('ab-_'), /invalid base64 character/); // base64url is not used here
    assert.throws(() => base64ToBytes('ab c'), /invalid base64 character/);
    assert.throws(() => base64ToBytes('abcde'), /invalid base64 length/);
  });
});
