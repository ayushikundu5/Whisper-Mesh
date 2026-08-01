import { KeyPair, generateIdentity, identityFromSecret, publicKeyToHex } from '@whisper/core';
import * as SecureStore from 'expo-secure-store';

/**
 * The device's long-term identity.
 *
 * Only the 32-byte Ed25519 seed is persisted. Everything else — the public key,
 * the X25519 Noise static key — is derived from it on load, so there is exactly
 * one secret in the world and exactly one place it lives.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is chosen over the default deliberately:
 *
 *  - `THIS_DEVICE_ONLY` keeps the seed out of any cloud or device-to-device
 *    backup. An identity that syncs to a new phone is an identity two devices
 *    can sign as, and paired contacts have no way to tell them apart.
 *  - `WHEN_UNLOCKED` means a phone seized while locked does not surrender the
 *    key to a filesystem dump.
 *
 * The cost is real and should be stated: losing the phone means losing the
 * identity, and every contact has to re-pair. That is the correct trade for a
 * key whose whole value is that it cannot be copied.
 */

const SEED_KEY = 'whisper.identity.seed.v1';
const NAME_KEY = 'whisper.identity.name.v1';

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface StoredIdentity {
  keys: KeyPair;
  name: string;
  /** True if this run created the identity — the app shows onboarding. */
  isNew: boolean;
}

export async function loadOrCreateIdentity(defaultName = 'Anonymous'): Promise<StoredIdentity> {
  const existing = await SecureStore.getItemAsync(SEED_KEY, SECURE_OPTIONS);
  if (existing) {
    return {
      keys: identityFromSecret(hexToBytes(existing)),
      name: (await SecureStore.getItemAsync(NAME_KEY, SECURE_OPTIONS)) ?? defaultName,
      isNew: false,
    };
  }

  const keys = generateIdentity();
  await SecureStore.setItemAsync(SEED_KEY, bytesToHex(keys.secretKey), SECURE_OPTIONS);
  await SecureStore.setItemAsync(NAME_KEY, defaultName, SECURE_OPTIONS);
  return { keys, name: defaultName, isNew: true };
}

export async function setDisplayName(name: string): Promise<void> {
  await SecureStore.setItemAsync(NAME_KEY, name, SECURE_OPTIONS);
}

/**
 * Destroy the identity. Irreversible, and every contact must re-pair — which is
 * exactly why it exists: it is the only way to actually stop being the person
 * a mesh has been watching.
 */
export async function destroyIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(SEED_KEY, SECURE_OPTIONS);
  await SecureStore.deleteItemAsync(NAME_KEY, SECURE_OPTIONS);
}

export const identityFingerprintHex = publicKeyToHex;

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
