import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyPair, noiseStaticFromIdentity } from './crypto/identity';
import { PUBKEY_BYTES, SIG_BYTES } from './frame';
import { DH_BYTES } from './crypto/noise';
import { PublicKey } from './types';

/**
 * Out-of-band pairing.
 *
 * This module is the ONLY way a public key becomes trusted. Nothing in the
 * receive path may add to the trust store; keys arrive by someone physically
 * showing someone else a QR code. That is a deliberate usability cost, and it
 * is the entire reason a MITM cannot insert itself: there is no moment where
 * the app accepts a key it has not seen out of band.
 *
 * The payload binds the Ed25519 identity key to the X25519 Noise static key by
 * signing over both. Without that signature a MITM could hand over a real
 * identity key alongside its own Noise key, and the fingerprint two people
 * compare on screen would still match.
 *
 * Wire format (then base64url-encoded into the QR):
 *
 *   offset  size  field
 *   0       1     payload version
 *   1       32    identity key (Ed25519)
 *   33      32    noise static key (X25519)
 *   65      1     nameLen
 *   66      N     name (UTF-8)
 *   ------------- signed region ends -------------
 *   66+N    64    signature by the identity key
 */

export const PAIRING_VERSION = 1;
export const MAX_NAME_BYTES = 32;

const OFF_VERSION = 0;
const OFF_IDENTITY = 1;
const OFF_NOISE = 33;
const OFF_NAME_LEN = 65;
const OFF_NAME = 66;

export class PairingError extends Error {}

export interface PairingPayload {
  version: number;
  identityKey: PublicKey;
  noiseKey: Uint8Array;
  name: string;
}

/** Build the payload a device renders as its QR code. */
export function buildPairingPayload(keys: KeyPair, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > MAX_NAME_BYTES) {
    throw new PairingError(`name exceeds ${MAX_NAME_BYTES} bytes`);
  }
  const noise = noiseStaticFromIdentity(keys);

  const unsigned = new Uint8Array(OFF_NAME + nameBytes.length);
  unsigned[OFF_VERSION] = PAIRING_VERSION;
  unsigned.set(keys.publicKey, OFF_IDENTITY);
  unsigned.set(noise.publicKey, OFF_NOISE);
  unsigned[OFF_NAME_LEN] = nameBytes.length;
  unsigned.set(nameBytes, OFF_NAME);

  const signature = ed25519.sign(unsigned, keys.secretKey);
  const out = new Uint8Array(unsigned.length + SIG_BYTES);
  out.set(unsigned, 0);
  out.set(signature, unsigned.length);
  return out;
}

/**
 * Parse and verify a scanned payload.
 *
 * Throws rather than returning null: a QR that fails to verify is not a routine
 * network event to swallow, it is either a corrupt scan or an attack, and the
 * user has to be told which key they are being asked to trust.
 */
export function parsePairingPayload(bytes: Uint8Array): PairingPayload {
  if (bytes.length < OFF_NAME + SIG_BYTES) throw new PairingError('pairing payload too short');

  const version = bytes[OFF_VERSION]!;
  if (version !== PAIRING_VERSION) {
    throw new PairingError(`unsupported pairing version ${version}`);
  }

  const nameLen = bytes[OFF_NAME_LEN]!;
  const signedLength = OFF_NAME + nameLen;
  if (bytes.length !== signedLength + SIG_BYTES) {
    throw new PairingError('pairing payload length mismatch');
  }

  const identityKey = bytes.slice(OFF_IDENTITY, OFF_IDENTITY + PUBKEY_BYTES);
  const noiseKey = bytes.slice(OFF_NOISE, OFF_NOISE + DH_BYTES);
  const signature = bytes.subarray(signedLength);

  let ok = false;
  try {
    ok = ed25519.verify(signature, bytes.subarray(0, signedLength), identityKey);
  } catch {
    ok = false;
  }
  if (!ok) throw new PairingError('pairing payload signature invalid');

  return {
    version,
    identityKey,
    noiseKey,
    name: new TextDecoder().decode(bytes.subarray(OFF_NAME, signedLength)),
  };
}

/** What the camera actually reads. `whisper:` keeps it out of a browser. */
export function encodePairingUri(payload: Uint8Array): string {
  return `whisper:p/${base64UrlEncode(payload)}`;
}

export function decodePairingUri(uri: string): Uint8Array {
  const prefix = 'whisper:p/';
  if (!uri.startsWith(prefix)) throw new PairingError('not a whisper pairing URI');
  return base64UrlDecode(uri.slice(prefix.length));
}

/**
 * Six words two people read aloud to confirm they paired with each other and
 * not with a relay in between.
 *
 * Covers BOTH keys, not just the identity key. A fingerprint over the identity
 * key alone would still match if an attacker swapped only the Noise key, which
 * is exactly the substitution the payload signature exists to stop — the SAS is
 * the human-checkable half of the same defence.
 */
export function pairingWords(payload: PairingPayload): string[] {
  const digest = sha256(concatKeys(payload.identityKey, payload.noiseKey));
  const words: string[] = [];
  // One byte per word: the list is 256 long, so this is a clean 8 bits each
  // with no modulo bias.
  for (let i = 0; i < 6; i++) words.push(SAS_WORDS[digest[i]!]!);
  return words;
}

/** Short hex form for a contact list. Same input as `pairingWords`. */
export function pairingFingerprint(payload: PairingPayload): string {
  const digest = sha256(concatKeys(payload.identityKey, payload.noiseKey));
  const hex = Array.from(digest.subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (hex.match(/.{4}/g) ?? []).join('-');
}

function concatKeys(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// --------------------------------------------------------------- base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Hand-rolled because `Buffer` is a Node concept and this package must stay
 * runnable unchanged inside React Native's JS engine.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >>> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4)];
    if (b1 === undefined) break;
    out += B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)];
    if (b2 === undefined) break;
    out += B64[b2 & 0x3f];
  }
  return out;
}

export function base64UrlDecode(text: string): Uint8Array {
  const values: number[] = [];
  for (const ch of text) {
    const value = B64.indexOf(ch);
    if (value < 0) throw new PairingError(`invalid base64url character ${JSON.stringify(ch)}`);
    values.push(value);
  }
  const out = new Uint8Array(Math.floor((values.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let offset = 0;
  for (const value of values) {
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * 256 words, so each contributes exactly 8 bits and six words carry 48 — well
 * past the point where an attacker can grind a colliding key pair in the
 * seconds two people spend reading them out.
 *
 * Chosen to be short, common, and unambiguous when spoken over background
 * noise, which is the actual environment this app is for.
 */
export const SAS_WORDS: readonly string[] = [
  'acid', 'acorn', 'agent', 'album', 'alien', 'amber', 'ankle', 'apple',
  'arrow', 'atlas', 'audio', 'aunt', 'axis', 'bacon', 'badge', 'baker',
  'balm', 'banjo', 'barn', 'basil', 'batch', 'beach', 'beard', 'beast',
  'bench', 'berry', 'birch', 'bison', 'blade', 'blaze', 'blend', 'bliss',
  'bloom', 'blush', 'board', 'bolt', 'bonus', 'boost', 'booth', 'brass',
  'brave', 'bread', 'brick', 'brisk', 'broom', 'brush', 'bugle', 'bunch',
  'cabin', 'cable', 'cactus', 'camel', 'candy', 'canoe', 'cargo', 'carve',
  'cedar', 'chalk', 'charm', 'chase', 'chess', 'chief', 'chime', 'cider',
  'cinch', 'civic', 'clamp', 'clash', 'clay', 'clerk', 'cliff', 'cloak',
  'clock', 'cloud', 'clove', 'coach', 'coast', 'cobra', 'cocoa', 'comet',
  'coral', 'couch', 'cove', 'crane', 'crate', 'creek', 'crest', 'crisp',
  'crown', 'crumb', 'curve', 'daisy', 'dance', 'dawn', 'delta', 'denim',
  'depot', 'diner', 'ditch', 'diver', 'dock', 'dodge', 'donor', 'dough',
  'dozen', 'draft', 'drift', 'drum', 'dusk', 'eagle', 'earth', 'easel',
  'ebony', 'elbow', 'elder', 'ember', 'envoy', 'equal', 'error', 'ether',
  'exile', 'fable', 'fancy', 'farm', 'fault', 'feast', 'fence', 'ferry',
  'fever', 'fiber', 'field', 'films', 'finch', 'flame', 'flask', 'fleet',
  'flint', 'flock', 'flour', 'flute', 'foam', 'forge', 'fossil', 'frost',
  'fruit', 'fuse', 'gauge', 'gecko', 'giant', 'ginger', 'glade', 'glass',
  'globe', 'glove', 'gnome', 'grain', 'grape', 'grid', 'grove', 'gulf',
  'habit', 'harbor', 'haven', 'hazel', 'heron', 'hinge', 'hobby', 'honey',
  'horn', 'hotel', 'hound', 'humor', 'hymn', 'ice', 'index', 'inlet',
  'ivory', 'jazz', 'jelly', 'jewel', 'jolly', 'judge', 'juice', 'kayak',
  'kettle', 'kite', 'koala', 'lace', 'lagoon', 'lamp', 'lance', 'lantern',
  'larch', 'laser', 'latch', 'ledge', 'lemon', 'lens', 'lever', 'lilac',
  'linen', 'llama', 'lodge', 'lotus', 'lunar', 'lyric', 'magnet', 'maize',
  'mango', 'maple', 'marble', 'marsh', 'mason', 'meadow', 'medal', 'melon',
  'mercy', 'metal', 'meteor', 'mint', 'mirror', 'model', 'moss', 'motor',
  'mural', 'nectar', 'needle', 'nest', 'nickel', 'noble', 'north', 'notch',
  'nova', 'oasis', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'otter',
  'oven', 'owl', 'oxide', 'paddle', 'palm', 'panda', 'paper', 'parade',
  'parka', 'pastel', 'peach', 'pearl', 'pebble', 'pepper', 'perch', 'petal',
];
