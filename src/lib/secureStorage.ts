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

import { createAesGcmCipher } from './aesGcmCipher';
import { createEncryptedStorage, type KeyValueStorage } from './encryptedStorage';

/** Keystore entry; bump the suffix only together with a migration. */
const KEY_NAME = 'duosync.storage-key.v1';

// Readable after the first unlock (a token refresh right after boot works),
// never copied into device backups or onto a new device.
const KEYSTORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Narrowed to what the native module accepts (see aesGcmCipher.ts): in
// particular fromCombined gets bytes, never a base64 string.
const aesGcm = createAesGcmCipher({
  generateKey: () => AESEncryptionKey.generate(AESKeySize.AES256),
  importKey: (base64) => AESEncryptionKey.import(base64, 'base64'),
  encryptAsync: (plaintext, key, options) => aesEncryptAsync(plaintext, key, options),
  fromCombined: (combined) => AESSealedData.fromCombined(combined),
  decryptAsync: (sealed, key, options) => aesDecryptAsync(sealed, key, options),
});

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
