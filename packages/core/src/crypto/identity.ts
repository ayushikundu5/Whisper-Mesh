import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Frame, PublicKey } from '../types';
import {
  MSG_ID_BYTES,
  attachSignature,
  decode,
  encodeUnsigned,
  signedRegion,
} from '../frame';
import { StaticKeyPair, staticFromSecret } from './noise';

/**
 * Node identity and frame authentication.
 *
 * The secret key never leaves this module in a real build — on device it lives
 * in `expo-secure-store` and is loaded once at startup.
 *
 * Design rule, learned from BitChat's MITM break: there is NO code path that
 * accepts a public key from the air and treats it as authenticated. Keys enter
 * the trust store only via out-of-band QR pairing. `verifyFrame` proves a frame
 * was signed by the key it *claims*; deciding whether that key is someone you
 * trust is a separate, deliberate step.
 */

export interface KeyPair {
  secretKey: Uint8Array;
  publicKey: PublicKey;
}

export function generateIdentity(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function identityFromSecret(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/**
 * Short human-verifiable fingerprint, rendered during QR pairing so two people
 * can eyeball that they got the same key.
 */
export function fingerprint(publicKey: PublicKey): string {
  const digest = sha256(publicKey);
  const hex = Array.from(digest.subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (hex.match(/.{4}/g) ?? []).join('-');
}

export function newMessageId(): Uint8Array {
  return randomBytes(MSG_ID_BYTES);
}

/** Domain separator. Changing it invalidates every existing Noise static key. */
const NOISE_STATIC_LABEL = 'whisper-mesh/noise-static/v1';

/**
 * The X25519 static key used for Noise sessions, derived from the Ed25519
 * identity seed.
 *
 * WHY DERIVE RATHER THAN REUSE: Ed25519 and X25519 keys are birationally
 * related, so it is tempting to convert the signing key to a DH key and be
 * done. Using one keypair for two algorithms means a flaw in either primitive's
 * use — a bad nonce, a confused signature oracle — costs you both. Deriving
 * through an HMAC costs nothing and keeps the failure domains separate.
 *
 * The binding between the two keys is not implicit either: the pairing payload
 * carries both and is signed by the identity key, so a peer can verify that
 * this Noise key really belongs to this identity (`pairing.ts`).
 *
 * Deterministic, so one seed in secure storage restores the whole identity.
 */
export function noiseStaticFromIdentity(keys: KeyPair): StaticKeyPair {
  const seed = hmac(sha256, new TextEncoder().encode(NOISE_STATIC_LABEL), keys.secretKey);
  return staticFromSecret(seed);
}

/**
 * Serialise and sign. The signature covers the immutable region only — every
 * field that carries meaning, `sender` included. See the comment block in
 * `frame.ts` for why TTL is excluded.
 */
export function signFrame(
  frame: Omit<Frame, 'signature' | 'sender' | 'version'> & { version?: number },
  keys: KeyPair,
): Uint8Array {
  const unsigned = encodeUnsigned({ ...frame, sender: keys.publicKey });
  const signature = ed25519.sign(signedRegion(unsigned), keys.secretKey);
  return attachSignature(unsigned, signature);
}

/**
 * Verify a frame's signature against the key it names.
 *
 * Returns false rather than throwing on malformed input: hostile peers send
 * garbage as a matter of course, and a dropped frame is the correct response,
 * not an exception that unwinds the receive loop.
 */
export function verifyFrame(encoded: Uint8Array): Frame | null {
  let frame: Frame;
  try {
    frame = decode(encoded);
  } catch {
    return null;
  }
  try {
    if (!ed25519.verify(frame.signature, signedRegion(encoded), frame.sender)) {
      return null;
    }
  } catch {
    // A malformed public key makes noble throw. Same outcome: drop it.
    return null;
  }
  return frame;
}

export function publicKeyToHex(key: PublicKey): string {
  return Array.from(key)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
