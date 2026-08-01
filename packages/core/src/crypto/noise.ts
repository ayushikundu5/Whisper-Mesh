import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Noise_IK_25519_ChaChaPoly_SHA256.
 *
 * WHY IK AND NOT XX: XX lets two strangers agree a key and *then* compare
 * fingerprints out of band. That is one unauthenticated round trip, and every
 * MITM break in this class of app lives in exactly that gap — including
 * BitChat's, where a key learned from the air was treated as authenticated.
 *
 * IK requires the initiator to already know the responder's static key. Here
 * that key can only have come from a QR pairing (`pairing.ts`), so "no
 * unauthenticated key exchange, ever" stops being a rule people have to
 * remember and becomes a thing the protocol cannot express. You cannot
 * handshake with someone you have not met.
 *
 *   IK:
 *     <- s                       (pre-message: learned by QR, never from the air)
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 *
 * IK also hides the initiator's static key from passive observers: it travels
 * inside the first message already encrypted under `es`. That matters on a
 * flood mesh where every relay sees every byte.
 *
 * Deviation from the Noise spec, and why: the spec assumes an ordered, reliable
 * transport and derives the AEAD nonce from an implicit counter both sides keep
 * in lockstep. A BLE flood mesh is neither ordered nor reliable — frames arrive
 * twice, out of order, or never. Transport messages therefore carry an explicit
 * counter and the receiver runs an anti-replay window (`ReplayWindow`), the same
 * shape of fix DTLS and IPsec apply for the same reason.
 */

export const DH_BYTES = 32;
export const HASH_BYTES = 32;
export const KEY_BYTES = 32;
export const AEAD_TAG_BYTES = 16;

/** 32 bytes exactly, so it is used as the initial `h` without hashing. */
const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/** Bytes on the wire for the explicit counter that precedes every ciphertext. */
export const COUNTER_BYTES = 8;

/**
 * Messages per key generation. At the end of each generation the sending key is
 * replaced by an irreversible `Rekey()`, so a key recovered from a device does
 * not decrypt traffic from earlier in the same session.
 */
export const REKEY_INTERVAL = 256;

/**
 * How far ahead a receiver will ratchet to catch up with a peer whose earlier
 * messages were lost. Bounded because each skipped generation costs a hash, and
 * an unbounded value would let a forged counter burn CPU.
 */
export const MAX_SKIPPED_GENERATIONS = 8;

/** Counters this far behind the highest seen are rejected as replays. */
export const REPLAY_WINDOW = 1024;

/** Session lifetime cap. Past this the peers must run a fresh handshake. */
export const MAX_SESSION_MESSAGES = 1 << 24;

export class NoiseError extends Error {}

export interface StaticKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateStatic(): StaticKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

export function staticFromSecret(secretKey: Uint8Array): StaticKeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

// --------------------------------------------------------------- primitives

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Noise's HKDF: two chained HMACs off a temp key. Not RFC 5869's expand step —
 * the info/label plumbing is absent by design, because the chaining key already
 * carries the transcript.
 */
function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const output1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const output2 = hmac(sha256, tempKey, concat(output1, Uint8Array.of(2)));
  return [output1, output2];
}

/** 96-bit ChaChaPoly nonce: 4 zero bytes then the counter, 64-bit little-endian. */
function nonceBytes(counter: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, BigInt(counter), true);
  return out;
}

const MAX_NONCE = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255]);

/**
 * Noise `Rekey()`: encrypt 32 zero bytes under the maximum nonce and keep the
 * first 32 bytes. One-way, so a captured generation cannot be wound backwards.
 */
function rekey(key: Uint8Array): Uint8Array {
  const out = chacha20poly1305(key, MAX_NONCE).encrypt(new Uint8Array(KEY_BYTES));
  return out.subarray(0, KEY_BYTES);
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    // A low-order or malformed point. Treat exactly like a failed handshake:
    // there is nothing to negotiate with a peer sending degenerate keys.
    throw new NoiseError('invalid public key in handshake');
  }
}

// ------------------------------------------------------------- CipherState

class CipherState {
  private key: Uint8Array | null = null;
  private counter = 0;

  initializeKey(key: Uint8Array | null): void {
    this.key = key;
    this.counter = 0;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    const out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).encrypt(plaintext);
    this.counter++;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    let out: Uint8Array;
    try {
      out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError('handshake decryption failed');
    }
    this.counter++;
    return out;
  }
}

// ---------------------------------------------------------- SymmetricState

class SymmetricState {
  private chainingKey: Uint8Array;
  private hash: Uint8Array;
  private readonly cipher = new CipherState();

  constructor() {
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    // Exactly HASH_BYTES long, so the spec says use it verbatim as `h`.
    this.hash = name.slice();
    this.chainingKey = this.hash.slice();
  }

  mixKey(input: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.chainingKey, input);
    this.chainingKey = ck;
    this.cipher.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concat(this.hash, data));
  }

  get handshakeHash(): Uint8Array {
    return this.hash.slice();
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Final key derivation. Returns [initiator->responder, responder->initiator]. */
  split(): [Uint8Array, Uint8Array] {
    return hkdf2(this.chainingKey, new Uint8Array(0));
  }
}

// ------------------------------------------------------------ replay window

/**
 * Sliding-window replay filter over the explicit message counter.
 *
 * Accepts anything newer than the high-water mark, accepts out-of-order
 * messages inside the window once, and rejects everything older. Without this,
 * an attacker who captured one ciphertext could re-inject it forever and the
 * mesh would happily re-deliver it — the flood layer's own dedup does not help,
 * because a replay attacker can simply re-wrap the payload in a fresh frame id.
 */
export class ReplayWindow {
  private readonly words: Uint32Array;
  private highest = -1;

  constructor(private readonly size = REPLAY_WINDOW) {
    if (size % 32 !== 0) throw new Error('replay window size must be a multiple of 32');
    this.words = new Uint32Array(size / 32);
  }

  /** Marks `counter` as seen and returns false if it was already seen or too old. */
  accept(counter: number): boolean {
    if (counter < 0 || !Number.isSafeInteger(counter)) return false;

    if (counter > this.highest) {
      this.clearBetween(this.highest + 1, counter);
      this.highest = counter;
      this.set(counter);
      return true;
    }
    if (this.highest - counter >= this.size) return false; // fell out of the window
    if (this.get(counter)) return false; // exact replay
    this.set(counter);
    return true;
  }

  private clearBetween(from: number, to: number): void {
    if (to - from >= this.size) {
      this.words.fill(0);
      return;
    }
    for (let c = from; c < to; c++) this.clear(c);
  }

  private index(counter: number): [number, number] {
    const bit = counter % this.size;
    return [bit >>> 5, bit & 31];
  }

  private set(counter: number): void {
    const [word, bit] = this.index(counter);
    this.words[word] = (this.words[word]! | (1 << bit)) >>> 0;
  }

  private clear(counter: number): void {
    const [word, bit] = this.index(counter);
    this.words[word] = (this.words[word]! & ~(1 << bit)) >>> 0;
  }

  private get(counter: number): boolean {
    const [word, bit] = this.index(counter);
    return (this.words[word]! & (1 << bit)) !== 0;
  }
}

// ----------------------------------------------------------- transport keys

class SendCipher {
  private counter = 0;
  private generation = 0;

  constructor(private key: Uint8Array) {}

  get messagesSent(): number {
    return this.counter;
  }

  next(): { counter: number; key: Uint8Array } {
    if (this.counter >= MAX_SESSION_MESSAGES) {
      throw new NoiseError('session message limit reached; rehandshake required');
    }
    const generation = Math.floor(this.counter / REKEY_INTERVAL);
    while (this.generation < generation) {
      this.key = rekey(this.key);
      this.generation++;
    }
    return { counter: this.counter++, key: this.key };
  }
}

class RecvCipher {
  private generation = 0;
  private previous: Uint8Array | null = null;
  private readonly window = new ReplayWindow();

  constructor(private key: Uint8Array) {}

  /**
   * Resolve the key for `counter` WITHOUT mutating state.
   *
   * Committing the ratchet before the tag verifies would be a free denial of
   * service: one forged frame carrying a far-future counter would advance us
   * past our peer's real generation and every genuine message after it would
   * fail to decrypt. State only moves once the AEAD says the message is real.
   */
  keyFor(counter: number): { key: Uint8Array; generation: number } | null {
    if (counter < 0 || counter >= MAX_SESSION_MESSAGES || !Number.isSafeInteger(counter)) {
      return null;
    }
    const generation = Math.floor(counter / REKEY_INTERVAL);
    if (generation === this.generation) return { key: this.key, generation };
    if (generation === this.generation - 1 && this.previous) {
      return { key: this.previous, generation };
    }
    if (generation < this.generation) return null; // ratcheted past; unrecoverable
    if (generation > this.generation + MAX_SKIPPED_GENERATIONS) return null;

    let key = this.key;
    for (let g = this.generation; g < generation; g++) key = rekey(key);
    return { key, generation };
  }

  /** Called only after the tag verified. Returns false on replay. */
  commit(counter: number, key: Uint8Array, generation: number): boolean {
    if (!this.window.accept(counter)) return false;
    if (generation > this.generation) {
      this.previous = generation === this.generation + 1 ? this.key : null;
      this.key = key;
      this.generation = generation;
    }
    return true;
  }
}

/**
 * A live encrypted channel with one paired peer.
 *
 * Wire format per message: `counter (u64 BE) || ciphertext || tag`.
 */
export class NoiseSession {
  private readonly send: SendCipher;
  private readonly recv: RecvCipher;

  constructor(
    sendKey: Uint8Array,
    recvKey: Uint8Array,
    /** The peer's Noise static key. Already known-good: it came from pairing. */
    readonly remoteStatic: Uint8Array,
    /**
     * Final handshake hash. Both sides derive the same value only if they saw
     * the same transcript, which makes it a channel binder — anything signed
     * over it cannot be lifted into a different session.
     */
    readonly handshakeHash: Uint8Array,
  ) {
    this.send = new SendCipher(sendKey);
    this.recv = new RecvCipher(recvKey);
  }

  get messagesSent(): number {
    return this.send.messagesSent;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    const { counter, key } = this.send.next();
    const ciphertext = chacha20poly1305(key, nonceBytes(counter), ad).encrypt(plaintext);
    const out = new Uint8Array(COUNTER_BYTES + ciphertext.length);
    new DataView(out.buffer).setBigUint64(0, BigInt(counter), false);
    out.set(ciphertext, COUNTER_BYTES);
    return out;
  }

  /** Returns null for anything that is not an authentic, non-replayed message. */
  decrypt(message: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array | null {
    if (message.length < COUNTER_BYTES + AEAD_TAG_BYTES) return null;
    const counter = Number(
      new DataView(message.buffer, message.byteOffset, message.byteLength).getBigUint64(0, false),
    );

    const resolved = this.recv.keyFor(counter);
    if (!resolved) return null;

    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(resolved.key, nonceBytes(counter), ad).decrypt(
        message.subarray(COUNTER_BYTES),
      );
    } catch {
      return null;
    }

    if (!this.recv.commit(counter, resolved.key, resolved.generation)) return null;
    return plaintext;
  }
}

// ---------------------------------------------------------------- handshake

function initSymmetric(prologue: Uint8Array): SymmetricState {
  const state = new SymmetricState();
  state.mixHash(prologue);
  return state;
}

/** Length of handshake message 1: e || Enc(s) || Enc(payload). */
export function handshakeMessageALength(payloadLength: number): number {
  return DH_BYTES + (DH_BYTES + AEAD_TAG_BYTES) + payloadLength + AEAD_TAG_BYTES;
}

/** Length of handshake message 2: e || Enc(payload). */
export function handshakeMessageBLength(payloadLength: number): number {
  return DH_BYTES + payloadLength + AEAD_TAG_BYTES;
}

/**
 * The side that already holds the peer's static key — i.e. the side that
 * scanned, or was scanned by, a pairing QR.
 */
export class HandshakeInitiator {
  private readonly state: SymmetricState;
  private readonly ephemeral: StaticKeyPair;
  private done = false;

  constructor(
    private readonly s: StaticKeyPair,
    private readonly rs: Uint8Array,
    prologue: Uint8Array = new Uint8Array(0),
    ephemeral: StaticKeyPair = generateStatic(),
  ) {
    if (rs.length !== DH_BYTES) throw new NoiseError('remote static key must be 32 bytes');
    this.state = initSymmetric(prologue);
    this.state.mixHash(rs); // pre-message: `<- s`
    this.ephemeral = ephemeral;
  }

  get ephemeralPublicKey(): Uint8Array {
    return this.ephemeral.publicKey;
  }

  /** `-> e, es, s, ss` */
  writeMessageA(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.done) throw new NoiseError('handshake already complete');
    this.state.mixHash(this.ephemeral.publicKey);
    this.state.mixKey(dh(this.ephemeral.secretKey, this.rs));
    const encryptedStatic = this.state.encryptAndHash(this.s.publicKey);
    this.state.mixKey(dh(this.s.secretKey, this.rs));
    const encryptedPayload = this.state.encryptAndHash(payload);
    return concat(this.ephemeral.publicKey, encryptedStatic, encryptedPayload);
  }

  /** `<- e, ee, se` — completes the handshake and yields the transport session. */
  readMessageB(message: Uint8Array): { payload: Uint8Array; session: NoiseSession } {
    if (this.done) throw new NoiseError('handshake already complete');
    if (message.length < DH_BYTES + AEAD_TAG_BYTES) {
      throw new NoiseError('handshake message B too short');
    }
    const re = message.subarray(0, DH_BYTES);
    this.state.mixHash(re);
    this.state.mixKey(dh(this.ephemeral.secretKey, re));
    this.state.mixKey(dh(this.s.secretKey, re));
    const payload = this.state.decryptAndHash(message.subarray(DH_BYTES));

    const [c1, c2] = this.state.split();
    this.done = true;
    // Initiator sends on the first key, receives on the second.
    return {
      payload,
      session: new NoiseSession(c1, c2, this.rs, this.state.handshakeHash),
    };
  }
}

/**
 * The side being contacted. Learns who the initiator is only after decrypting
 * message 1, which is why `readMessageA` hands the static key back to the
 * caller: the trust decision ("is this someone I paired with?") belongs to the
 * trust store, not to the crypto.
 */
export class HandshakeResponder {
  private readonly state: SymmetricState;
  private readonly ephemeral: StaticKeyPair;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;

  constructor(
    private readonly s: StaticKeyPair,
    prologue: Uint8Array = new Uint8Array(0),
    ephemeral: StaticKeyPair = generateStatic(),
  ) {
    this.state = initSymmetric(prologue);
    this.state.mixHash(s.publicKey); // pre-message: `<- s`
    this.ephemeral = ephemeral;
  }

  /** `-> e, es, s, ss` — returns the initiator's static key for vetting. */
  readMessageA(message: Uint8Array): { payload: Uint8Array; remoteStatic: Uint8Array } {
    if (this.rs) throw new NoiseError('message A already consumed');
    const minimum = DH_BYTES + DH_BYTES + AEAD_TAG_BYTES + AEAD_TAG_BYTES;
    if (message.length < minimum) throw new NoiseError('handshake message A too short');

    const re = message.subarray(0, DH_BYTES);
    this.state.mixHash(re);
    this.state.mixKey(dh(this.s.secretKey, re));

    const rs = this.state.decryptAndHash(
      message.subarray(DH_BYTES, DH_BYTES + DH_BYTES + AEAD_TAG_BYTES),
    );
    this.state.mixKey(dh(this.s.secretKey, rs));
    const payload = this.state.decryptAndHash(
      message.subarray(DH_BYTES + DH_BYTES + AEAD_TAG_BYTES),
    );

    this.re = re.slice();
    this.rs = rs;
    return { payload, remoteStatic: rs.slice() };
  }

  /** `<- e, ee, se` */
  writeMessageB(payload: Uint8Array = new Uint8Array(0)): {
    message: Uint8Array;
    session: NoiseSession;
  } {
    if (!this.re || !this.rs) throw new NoiseError('message A not yet consumed');
    this.state.mixHash(this.ephemeral.publicKey);
    this.state.mixKey(dh(this.ephemeral.secretKey, this.re));
    this.state.mixKey(dh(this.ephemeral.secretKey, this.rs));
    const encryptedPayload = this.state.encryptAndHash(payload);

    const [c1, c2] = this.state.split();
    // Mirror of the initiator: responder receives on the first key, sends on
    // the second.
    return {
      message: concat(this.ephemeral.publicKey, encryptedPayload),
      session: new NoiseSession(c2, c1, this.rs.slice(), this.state.handshakeHash),
    };
  }
}
