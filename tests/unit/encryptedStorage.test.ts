// Encrypted session / cache storage (ROADMAP B4).
// Real AES-256-GCM through Node's WebCrypto stands in for expo-crypto; maps
// stand in for AsyncStorage and the keystore.
// Run: npm run test:unit
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  createEncryptedStorage,
  ENVELOPE_PREFIX,
  utf8Decode,
  utf8Encode,
  type Cipher,
  type KeyStore,
} from '../../src/lib/encryptedStorage';

const subtle = webcrypto.subtle;
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

function webCryptoCipher(counter = { generated: 0 }): Cipher<CryptoKey> {
  return {
    generateKey: async () => {
      counter.generated++;
      return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    },
    exportKey: async (k) => b64(new Uint8Array(await subtle.exportKey('raw', k))),
    importKey: (s) => subtle.importKey('raw', unb64(s), 'AES-GCM', true, ['encrypt', 'decrypt']),
    encrypt: async (plain, key, aad) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
      return b64(Uint8Array.from([...iv, ...ct])); // iv ‖ ciphertext ‖ tag, like expo-crypto's combined()
    },
    decrypt: async (sealed, key, aad) => {
      const all = unb64(sealed);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12), additionalData: aad }, key, all.slice(12));
      return new Uint8Array(pt);
    },
  };
}

function setup(opts: { keyStore?: KeyStore; store?: Map<string, string>; keys?: Map<string, string> } = {}) {
  const store = opts.store ?? new Map<string, string>();
  const keys = opts.keys ?? new Map<string, string>();
  const counter = { generated: 0 };
  const discarded: string[] = [];
  const s = createEncryptedStorage({
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => void store.set(k, v),
      removeItem: async (k) => void store.delete(k),
    },
    keyStore: opts.keyStore ?? { get: async (n) => keys.get(n) ?? null, set: async (n, v) => void keys.set(n, v) },
    cipher: webCryptoCipher(counter),
    keyName: 'test.key',
    onDiscard: (k) => discarded.push(k),
  });
  return { s, store, keys, counter, discarded };
}

const SESSION = JSON.stringify({
  access_token: 'eyJhbGciOiJIUzI1NiJ9.secret-access',
  refresh_token: 'refresh-secret-123',
  user: { id: 'u1', email: 'ayşe@örnek.com', user_metadata: { display_name: 'Ayşe 💞' } },
});

describe('encrypted storage', () => {
  test('round trip; nothing readable at rest', async () => {
    const { s, store } = setup();
    await s.setItem('sb-auth-token', SESSION);
    const raw = store.get('sb-auth-token')!;
    assert.ok(raw.startsWith(ENVELOPE_PREFIX));
    for (const secret of ['secret-access', 'refresh-secret-123', 'ayşe', 'u1']) assert.ok(!raw.includes(secret), secret);
    assert.equal(await s.getItem('sb-auth-token'), SESSION);
    assert.equal(await s.getItem('missing'), null);
  });

  test('same plaintext encrypts differently every time (fresh nonce)', async () => {
    const { s, store } = setup();
    await s.setItem('k', 'same');
    const first = store.get('k');
    await s.setItem('k', 'same');
    assert.notEqual(store.get('k'), first);
  });

  test('key lives only in the keystore and survives an app restart', async () => {
    const first = setup();
    await first.s.setItem('k', SESSION);
    assert.equal(first.keys.size, 1);
    assert.ok(![...first.store.values()].some((v) => v.includes(first.keys.get('test.key')!)));
    // New process: same AsyncStorage + keystore contents, fresh module state.
    const restarted = setup({ store: first.store, keys: first.keys });
    assert.equal(await restarted.s.getItem('k'), SESSION);
    assert.equal(restarted.counter.generated, 0);
  });

  test('concurrent first writes create exactly one key', async () => {
    const { s, counter } = setup();
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => s.setItem(k, k.repeat(3))));
    assert.equal(counter.generated, 1);
    assert.deepEqual(await Promise.all(['a', 'b', 'c', 'd'].map((k) => s.getItem(k))), ['aaa', 'bbb', 'ccc', 'ddd']);
  });

  test('legacy plaintext value is returned and encrypted in place', async () => {
    const { s, store } = setup();
    store.set('sb-auth-token', SESSION); // written by the pre-B4 build
    assert.equal(await s.getItem('sb-auth-token'), SESSION);
    assert.ok(store.get('sb-auth-token')!.startsWith(ENVELOPE_PREFIX));
    assert.equal(await s.getItem('sb-auth-token'), SESSION);
  });

  test('tampered ciphertext fails closed: discarded, null', async () => {
    const { s, store, discarded } = setup();
    await s.setItem('k', SESSION);
    const raw = store.get('k')!;
    const body = Buffer.from(raw.slice(ENVELOPE_PREFIX.length), 'base64');
    body[20] = (body[20] ?? 0) ^ 0x01; // flip one ciphertext bit
    store.set('k', ENVELOPE_PREFIX + body.toString('base64'));
    assert.equal(await s.getItem('k'), null);
    assert.equal(store.has('k'), false);
    assert.deepEqual(discarded, ['k']);
  });

  test('a value copied under another entry name does not decrypt (name is authenticated)', async () => {
    const { s, store } = setup();
    await s.setItem('duosync-query-cache', '{"cached":true}');
    store.set('sb-auth-token', store.get('duosync-query-cache')!);
    assert.equal(await s.getItem('sb-auth-token'), null);
    assert.equal(await s.getItem('duosync-query-cache'), '{"cached":true}');
  });

  test('keystore lost (data restored without the key): null, then works with a new key', async () => {
    const first = setup();
    await first.s.setItem('k', SESSION);
    const restored = setup({ store: first.store }); // AsyncStorage came back, keystore did not
    assert.equal(await restored.s.getItem('k'), null);
    assert.equal(restored.store.has('k'), false);
    await restored.s.setItem('k', 'after sign-in');
    assert.equal(await restored.s.getItem('k'), 'after sign-in');
  });

  test('keystore failure fails closed on write and is retried on the next call', async () => {
    let fail = true;
    const keys = new Map<string, string>();
    const { s, store } = setup({
      keyStore: {
        get: async (n) => {
          if (fail) throw new Error('keystore unavailable');
          return keys.get(n) ?? null;
        },
        set: async (n, v) => void keys.set(n, v),
      },
    });
    await assert.rejects(s.setItem('k', SESSION), /keystore unavailable/);
    assert.equal(store.has('k'), false); // never falls back to plaintext
    fail = false;
    await s.setItem('k', SESSION);
    assert.equal(await s.getItem('k'), SESSION);
  });

  test('removeItem deletes the entry', async () => {
    const { s, store } = setup();
    await s.setItem('k', 'v');
    await s.removeItem('k');
    assert.equal(store.has('k'), false);
    assert.equal(await s.getItem('k'), null);
  });
});

describe('utf8', () => {
  const samples = ['', 'plain ascii', 'Şeyma çiçek ığdır ÖÜĞ', '日本語', 'emoji 💞🙂👨‍👩‍👧', '\u0000\u007f\u0080߿ࠀ￿'];
  test('matches TextEncoder / TextDecoder', () => {
    for (const s of samples) {
      assert.deepEqual(utf8Encode(s), new TextEncoder().encode(s), s);
      assert.equal(utf8Decode(new TextEncoder().encode(s)), s, s);
    }
  });
  test('lone surrogates become U+FFFD like TextEncoder', () => {
    for (const s of ['a\ud800b', '\udc00', 'x\ud83d']) assert.deepEqual(utf8Encode(s), new TextEncoder().encode(s), JSON.stringify(s));
  });
  test('invalid bytes decode to U+FFFD instead of throwing', () => {
    for (const bytes of [[0xff], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xf7, 0xbf, 0xbf, 0xbf], [0xc3], [0x80, 0x41]]) {
      assert.equal(utf8Decode(Uint8Array.from(bytes)), new TextDecoder().decode(Uint8Array.from(bytes)), JSON.stringify(bytes));
    }
  });
});
