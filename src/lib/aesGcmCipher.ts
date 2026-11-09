// AES-256-GCM cipher for the encrypted storage (ROADMAP B4), written against
// what expo-crypto's *native* side accepts, not what its TypeScript types say.
//
// Pure and dependency-injected (src/lib/secureStorage.ts passes the real
// expo-crypto functions) so tests/unit/aesGcmCipher.test.ts can run it against
// a fake with the same strictness as the Android module.
//
// Why the narrow interface below: expo-crypto 57's `AESSealedData.fromCombined`
// is typed `BinaryInput` (bytes or base64 string) and its JS wrapper forwards a
// string unchanged, but the Kotlin side is `fromCombined(combined: ByteArray)`.
// A base64 string therefore throws on Android; the storage treated that as an
// unreadable value and discarded the Supabase session after every write, so
// every request went out without the user's token (A4, 2026-11-09). Encrypt,
// decrypt and key import do take `Either<ByteArray, String>`.
import type { Cipher } from './encryptedStorage';

/** GCM layout produced by expo-crypto with default options: iv ‖ ciphertext ‖ tag. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface AesKeyLike {
  encoded(encoding: 'base64'): Promise<string>;
}

export interface SealedLike {
  combined(format: 'base64'): Promise<string>;
}

/** The subset of expo-crypto used here, typed as the native module accepts it. */
export interface ExpoAesApi<K extends AesKeyLike, S extends SealedLike> {
  generateKey(): Promise<K>;
  importKey(base64: string): Promise<K>;
  encryptAsync(plaintext: Uint8Array, key: K, options: { additionalData: Uint8Array }): Promise<S>;
  /** Native: `ByteArray` only — never pass a string here. */
  fromCombined(combined: Uint8Array): S;
  decryptAsync(sealed: S, key: K, options: { output: 'bytes'; additionalData: Uint8Array }): Promise<Uint8Array>;
}

export function createAesGcmCipher<K extends AesKeyLike, S extends SealedLike>(api: ExpoAesApi<K, S>): Cipher<K> {
  const inFlight = new Set<S>();
  return {
    generateKey: () => api.generateKey(),
    exportKey: (key) => key.encoded('base64'),
    importKey: (encoded) => api.importKey(encoded),
    encrypt: async (plaintext, key, aad) =>
      (await api.encryptAsync(plaintext, key, { additionalData: aad })).combined('base64'),
    decrypt: async (sealed, key, aad) => {
      const combined = base64ToBytes(sealed);
      if (combined.length < IV_BYTES + TAG_BYTES) throw new Error('sealed value too short');
      // Precaution: keep the native SealedData reachable until the async call
      // has finished, so a GC of the JS wrapper cannot release it mid-call.
      const sealedData = api.fromCombined(combined);
      inFlight.add(sealedData);
      let plain: Uint8Array;
      try {
        plain = await api.decryptAsync(sealedData, key, { output: 'bytes', additionalData: aad });
      } finally {
        inFlight.delete(sealedData);
      }
      // GCM is a stream mode: plaintext length = combined − iv − tag, exactly.
      // The Android module returns its whole output buffer, sized by the
      // provider's getOutputSize(); trim so a provider that over-allocates
      // cannot append zero bytes to the session JSON.
      return plain.subarray(0, combined.length - IV_BYTES - TAG_BYTES);
    },
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

/**
 * Standard base64 (with or without padding) → bytes. Throws on anything else,
 * so a corrupted value fails closed instead of decoding to garbage. Written
 * out because `atob` is not guaranteed on every Hermes build.
 */
export function base64ToBytes(s: string): Uint8Array {
  const body = s.endsWith('==') ? s.slice(0, -2) : s.endsWith('=') ? s.slice(0, -1) : s;
  if (body.length % 4 === 1) throw new Error('invalid base64 length');
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of body) {
    const v = B64_INDEX[ch];
    if (v === undefined) throw new Error('invalid base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
