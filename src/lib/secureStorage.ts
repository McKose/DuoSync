// React Native binding for the encrypted storage (ROADMAP B4): AES-256-GCM
// from expo-crypto, key in expo-secure-store (Android Keystore / iOS Keychain).
//
// Web keeps plain AsyncStorage (localStorage): there is no keystore, and a key
// stored next to the ciphertext would protect nothing. Web is only the demo /
// E2E target.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AESEncryptionKey, AESKeySize, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createEncryptedStorage, type Cipher, type KeyValueStorage } from './encryptedStorage';

/** Keystore entry; bump the suffix only together with a migration. */
const KEY_NAME = 'duosync.storage-key.v1';

// Readable after the first unlock (a token refresh right after boot works),
// never copied into device backups or onto a new device.
const KEYSTORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const aesGcm: Cipher<AESEncryptionKey> = {
  generateKey: () => AESEncryptionKey.generate(AESKeySize.AES256),
  exportKey: (key) => key.encoded('base64'),
  importKey: (encoded) => AESEncryptionKey.import(encoded, 'base64'),
  encrypt: async (plaintext, key, aad) =>
    (await aesEncryptAsync(plaintext, key, { additionalData: aad })).combined('base64'),
  decrypt: (sealed, key, aad) =>
    aesDecryptAsync(AESSealedData.fromCombined(sealed), key, { output: 'bytes', additionalData: aad }),
};

export const secureStorage: KeyValueStorage =
  Platform.OS === 'web'
    ? AsyncStorage
    : createEncryptedStorage({
        storage: AsyncStorage,
        keyStore: {
          get: (name) => SecureStore.getItemAsync(name, KEYSTORE_OPTIONS),
          set: (name, value) => SecureStore.setItemAsync(name, value, KEYSTORE_OPTIONS),
        },
        cipher: aesGcm,
        keyName: KEY_NAME,
        // Never log the value; the entry name is enough to explain a sign-out.
        onDiscard: (key) => console.warn(`[secureStorage] unreadable value for "${key}" discarded`),
      });
