import { publicKeyToHex } from './crypto/identity';
import { PairingPayload, pairingFingerprint } from './pairing';
import { PublicKey } from './types';

/**
 * The set of people this device has physically met.
 *
 * Two rules, both of which exist because breaking either is how real messengers
 * have been MITM'd:
 *
 * 1. **Nothing on the receive path may write here.** The only entry point is
 *    `pair()`, called from the QR scanner. There is deliberately no
 *    `trustFromFrame()`, no TOFU, no "remember this key" prompt driven by
 *    network input.
 *
 * 2. **Keys are pinned.** If a known identity turns up with a different Noise
 *    key, that is refused, not silently accepted. A messenger that quietly
 *    re-pins on key change hands an attacker a one-message window to become the
 *    new key. Replacing a key requires `repair()` — an explicit user action
 *    after re-scanning, which puts the fingerprint back in front of a human.
 */

export interface Contact {
  /** Ed25519 identity key. Stable for the life of the identity. */
  identityKey: PublicKey;
  /** X25519 Noise static key, bound to `identityKey` by the pairing signature. */
  noiseKey: Uint8Array;
  name: string;
  pairedAt: number;
  /** Human-comparable digest over both keys. Cached for the contact list. */
  fingerprint: string;
}

export class TrustError extends Error {}

export class TrustStore {
  private readonly byIdentityHex = new Map<string, Contact>();
  private readonly byNoiseHex = new Map<string, Contact>();

  get size(): number {
    return this.byIdentityHex.size;
  }

  contacts(): Contact[] {
    return [...this.byIdentityHex.values()];
  }

  /**
   * Record a scanned, signature-verified pairing payload.
   *
   * Idempotent for a repeat scan of the same person. Throws if the identity is
   * known but the Noise key changed — see rule 2.
   */
  pair(payload: PairingPayload, now: number): Contact {
    const identityHex = publicKeyToHex(payload.identityKey);
    const noiseHex = publicKeyToHex(payload.noiseKey);

    const existing = this.byIdentityHex.get(identityHex);
    if (existing) {
      if (publicKeyToHex(existing.noiseKey) !== noiseHex) {
        throw new TrustError(
          'this contact already exists with a different key; re-pair explicitly to replace it',
        );
      }
      existing.name = payload.name;
      return existing;
    }

    // A Noise key already bound to a *different* identity means someone is
    // trying to make two identities share a session. Refuse both ways round.
    const collision = this.byNoiseHex.get(noiseHex);
    if (collision) {
      throw new TrustError('this key is already paired to a different identity');
    }

    const contact: Contact = {
      identityKey: payload.identityKey.slice(),
      noiseKey: payload.noiseKey.slice(),
      name: payload.name,
      pairedAt: now,
      fingerprint: pairingFingerprint(payload),
    };
    this.byIdentityHex.set(identityHex, contact);
    this.byNoiseHex.set(noiseHex, contact);
    return contact;
  }

  /**
   * Replace a contact's keys after the user re-scanned and re-confirmed the
   * fingerprint. Separate from `pair()` so a key change can never happen
   * without a deliberate act.
   */
  repair(payload: PairingPayload, now: number): Contact {
    this.forget(payload.identityKey);
    return this.pair(payload, now);
  }

  forget(identityKey: PublicKey): boolean {
    const identityHex = publicKeyToHex(identityKey);
    const existing = this.byIdentityHex.get(identityHex);
    if (!existing) return false;
    this.byIdentityHex.delete(identityHex);
    this.byNoiseHex.delete(publicKeyToHex(existing.noiseKey));
    return true;
  }

  byIdentity(identityKey: PublicKey): Contact | undefined {
    return this.byIdentityHex.get(publicKeyToHex(identityKey));
  }

  /** Used after a Noise handshake to answer "is this someone I know?". */
  byNoiseKey(noiseKey: Uint8Array): Contact | undefined {
    return this.byNoiseHex.get(publicKeyToHex(noiseKey));
  }

  isTrusted(identityKey: PublicKey): boolean {
    return this.byIdentityHex.has(publicKeyToHex(identityKey));
  }

  /** Serialisable snapshot for the device's encrypted store. */
  toJSON(): SerialisedContact[] {
    return this.contacts().map((c) => ({
      identityKey: publicKeyToHex(c.identityKey),
      noiseKey: publicKeyToHex(c.noiseKey),
      name: c.name,
      pairedAt: c.pairedAt,
    }));
  }

  static fromJSON(entries: SerialisedContact[]): TrustStore {
    const store = new TrustStore();
    for (const entry of entries) {
      const identityKey = hexToBytes(entry.identityKey);
      const noiseKey = hexToBytes(entry.noiseKey);
      const payload: PairingPayload = {
        version: 1,
        identityKey,
        noiseKey,
        name: entry.name,
      };
      store.pair(payload, entry.pairedAt);
    }
    return store;
  }
}

export interface SerialisedContact {
  identityKey: string;
  noiseKey: string;
  name: string;
  pairedAt: number;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TrustError('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new TrustError('invalid hex string');
    out[i] = byte;
  }
  return out;
}
