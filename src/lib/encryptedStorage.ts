// Encrypted key-value storage (ROADMAP B4).
//
// Values live in AsyncStorage as AES-256-GCM ciphertext; the 32-byte key lives
// in the platform keystore (expo-secure-store → Android Keystore / iOS
// Keychain). SecureStore alone cannot hold the data: a Supabase session is
// larger than its 2 KB per-item limit on iOS, the key is not.
//
// Pure and dependency-injected so it runs under Node with WebCrypto in tests;
// the React Native binding is src/lib/secureStorage.ts.

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Where the encryption key is kept (the keystore, never AsyncStorage). */
export interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

/** AES-GCM primitives. `sealed` is base64 of iv ‖ ciphertext ‖ tag. */
export interface Cipher<K> {
  generateKey(): Promise<K>;
  exportKey(key: K): Promise<string>;
  importKey(encoded: string): Promise<K>;
  encrypt(plaintext: Uint8Array, key: K, aad: Uint8Array): Promise<string>;
  decrypt(sealed: string, key: K, aad: Uint8Array): Promise<Uint8Array>;
}

/** Marks an encrypted value; anything else is treated as legacy plaintext. */
export const ENVELOPE_PREFIX = 'enc1:';

export interface EncryptedStorageOptions<K> {
  storage: KeyValueStorage;
  keyStore: KeyStore;
  cipher: Cipher<K>;
  /** Keystore entry name of the encryption key. */
  keyName: string;
  /** Called when a stored value cannot be decrypted (after one retry); the value is kept. */
  onUnreadable?: (key: string, error: unknown) => void;
}

// Design notes (first phone run, 2026-11-09 — ROADMAP B4):
// - supabase-js reads the session from storage on *every* request. Each read
//   used to be a native AES call; one failed read deleted the session for good
//   and every later request went out as anon. Now each entry is decrypted at
//   most once per process and then served from memory (the same plaintext
//   supabase-js holds in memory anyway; at-rest protection is unchanged).
// - An unreadable value is no longer deleted: GCM already guarantees that
//   tampered data never decrypts, so deleting adds no safety, but it turned a
//   transient native error into a permanent sign-out. The next write simply
//   replaces it.
// - Operations on one entry run in call order, so the cache and AsyncStorage
//   cannot disagree after concurrent writes.
export function createEncryptedStorage<K>(opts: EncryptedStorageOptions<K>): KeyValueStorage {
  const { storage, keyStore, cipher, keyName, onUnreadable } = opts;
  let keyPromise: Promise<K> | null = null;
  const cache = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();

  const serial = <T>(name: string, op: () => Promise<T>): Promise<T> => {
    const run = (queues.get(name) ?? Promise.resolve()).then(op, op);
    queues.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };

  // Single flight: two first writes racing must not create two keys, or the
  // value written with the overwritten key could never be read again.
  const getKey = (): Promise<K> => {
    keyPromise ??= (async () => {
      const stored = await keyStore.get(keyName);
      if (stored) return cipher.importKey(stored);
      const key = await cipher.generateKey();
      await keyStore.set(keyName, await cipher.exportKey(key));
      return key;
    })().catch((e: unknown) => {
      keyPromise = null; // let the next call retry instead of caching a failure
      throw e;
    });
    return keyPromise;
  };

  const write = async (name: string, value: string): Promise<void> => {
    const key = await getKey();
    // The entry name is authenticated data: a value copied under another
    // name fails to decrypt instead of being accepted.
    const sealed = await cipher.encrypt(utf8Encode(value), key, utf8Encode(name));
    await storage.setItem(name, ENVELOPE_PREFIX + sealed);
    cache.set(name, value);
  };

  const open = async (name: string, raw: string): Promise<string> => {
    const key = await getKey();
    return utf8Decode(await cipher.decrypt(raw.slice(ENVELOPE_PREFIX.length), key, utf8Encode(name)));
  };

  const read = async (name: string): Promise<string | null> => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit; // a read queued behind a write
    const raw = await storage.getItem(name);
    if (raw === null) return null;
    if (!raw.startsWith(ENVELOPE_PREFIX)) {
      // Written before encryption existed: encrypt it in place, keep using it.
      await write(name, raw);
      return raw;
    }
    let value: string;
    try {
      // One retry: a transient native or keystore error must not cost the session.
      value = await open(name, raw).catch(() => open(name, raw));
    } catch (e) {
      // Tampered value, or the key is gone (app data restored without the
      // keystore): unreadable, so the caller sees "no value". Never plaintext,
      // never deleted — see the design notes above.
      onUnreadable?.(name, e);
      return null;
    }
    cache.set(name, value);
    return value;
  };

  return {
    getItem: (name) => {
      const hit = cache.get(name);
      return hit !== undefined ? Promise.resolve(hit) : serial(name, () => read(name));
    },
    setItem: (name, value) => serial(name, () => write(name, value)),
    removeItem: (name) => {
      cache.delete(name); // at once: a read issued after this call must not see the old value
      return serial(name, async () => {
        cache.delete(name);
        await storage.removeItem(name);
      });
    },
  };
}

// UTF-8 by hand: AES APIs take bytes (or base64), and TextDecoder is not
// guaranteed on every Hermes build. Lone surrogates become U+FFFD, as with
// TextEncoder.
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i] ?? 0;
    const need = c < 0x80 ? 0 : c < 0xc0 ? -1 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : c < 0xf8 ? 3 : -1;
    let cp = need === 0 ? c : need === 1 ? c & 0x1f : need === 2 ? c & 0x0f : c & 0x07;
    let ok = need >= 0 && i + need < b.length;
    for (let k = 1; ok && k <= need; k++) {
      const n = b[i + k] ?? 0;
      if ((n & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (n & 0x3f);
    }
    if (!ok || cp > 0x10ffff) {
      s += '�';
      i += 1;
      continue;
    }
    s += String.fromCodePoint(cp);
    i += need + 1;
  }
  return s;
}
