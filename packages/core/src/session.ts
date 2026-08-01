import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyPair, noiseStaticFromIdentity } from './crypto/identity';
import {
  AEAD_TAG_BYTES,
  DH_BYTES,
  HandshakeInitiator,
  HandshakeResponder,
  NoiseSession,
  StaticKeyPair,
} from './crypto/noise';
import { LruSet } from './lru';
import { Contact, TrustStore } from './trust';

/**
 * L3 — encrypted 1:1 sessions carried over the flood mesh.
 *
 * The mesh has no routing table: a direct message is broadcast to everyone and
 * only the intended recipient can read it. That is good for delivery and bad
 * for metadata, so the addressing here is built to give relays as little as
 * possible.
 *
 * WHAT A RELAY SEES: an 8-byte tag that is fresh for every single message, and
 * a ciphertext. The tag is `HMAC(directional tag key, counter)`, so two messages
 * in the same conversation look no more related than two messages from
 * strangers. There is no recipient id, no conversation id, and nothing stable
 * to count.
 *
 * WHY A TAG AT ALL: without one, every node would have to attempt AEAD
 * decryption against every session it holds for every direct message that
 * crosses it — O(contacts) per frame on a device that is already
 * battery-constrained. Receivers pre-register the tags they expect, so the
 * lookup is a single map hit and non-recipients do zero crypto.
 *
 * The tag is a routing hint and nothing more. It is checked against the counter
 * inside the ciphertext, and the AEAD remains the only thing that decides
 * whether a message is authentic.
 */

/** Bytes of routing tag prefixed to every session-layer payload. */
export const SESSION_TAG_BYTES = 8;

/**
 * How many message counters ahead of the highest seen a receiver keeps tags
 * registered for — and how many behind it retains, so a message that took a
 * slower path through the mesh still lands.
 */
export const DEFAULT_TAG_WINDOW = 128;

/** Pending handshakes older than this are abandoned. */
export const HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * Sessions kept per contact. Two, because simultaneous initiation from both
 * sides is normal when a link comes up — both sessions stay readable and the
 * newer one is used for sending.
 */
export const MAX_SESSIONS_PER_CONTACT = 2;

const LABEL_IK_TARGET = 'whisper-mesh/ik-target/v1';
const LABEL_IK_REPLY = 'whisper-mesh/ik-reply/v1';
const LABEL_TAG_I2R = 'whisper-mesh/tag/i2r/v1';
const LABEL_TAG_R2I = 'whisper-mesh/tag/r2i/v1';

const utf8 = (s: string) => new TextEncoder().encode(s);

export class SessionError extends Error {}

export interface SessionManagerOptions {
  now?: () => number;
  tagWindow?: number;
  handshakeTimeoutMs?: number;
  /** Bound on remembered initiator ephemerals, which is the replay defence. */
  handshakeReplayCapacity?: number;
}

export interface OpenedMessage {
  contact: Contact;
  plaintext: Uint8Array;
}

interface Established {
  contact: Contact;
  session: NoiseSession;
  sendTagKey: Uint8Array;
  recvTagKey: Uint8Array;
  establishedAt: number;
  /** Inclusive bounds of the counter range currently registered in `tagIndex`. */
  tagLow: number;
  tagHigh: number;
}

interface Pending {
  contact: Contact;
  handshake: HandshakeInitiator;
  startedAt: number;
}

const DEFAULTS = {
  tagWindow: DEFAULT_TAG_WINDOW,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  handshakeReplayCapacity: 512,
};

export class SessionManager {
  private readonly noiseStatic: StaticKeyPair;
  private readonly opts: Required<SessionManagerOptions>;

  /** replyTagHex -> in-flight handshake we started. */
  private readonly pending = new Map<string, Pending>();
  /** identityHex -> sessions, newest last. */
  private readonly sessions = new Map<string, Established[]>();
  /** tagHex -> the session that expects it. The whole point of the design. */
  private readonly tagIndex = new Map<string, Established>();
  /** Initiator ephemerals already answered, so a captured message 1 is inert. */
  private readonly seenHandshakes: LruSet<string>;

  readonly stats = {
    handshakesStarted: 0,
    handshakesCompleted: 0,
    handshakesRejected: 0,
    handshakeReplaysDropped: 0,
    messagesSealed: 0,
    messagesOpened: 0,
    messagesUndecryptable: 0,
  };

  constructor(
    private readonly identity: KeyPair,
    private readonly trust: TrustStore,
    options: SessionManagerOptions = {},
  ) {
    this.opts = { ...DEFAULTS, now: () => Date.now(), ...options } as Required<SessionManagerOptions>;
    this.noiseStatic = noiseStaticFromIdentity(identity);
    this.seenHandshakes = new LruSet<string>(
      this.opts.handshakeReplayCapacity,
      this.opts.handshakeTimeoutMs * 10,
    );
  }

  get noisePublicKey(): Uint8Array {
    return this.noiseStatic.publicKey;
  }

  hasSession(contact: Contact): boolean {
    return (this.sessions.get(hex(contact.identityKey))?.length ?? 0) > 0;
  }

  /** Live sessions, for a UI that shows which conversations are ready. */
  establishedWith(): Contact[] {
    return [...this.sessions.values()].flatMap((list) => (list[0] ? [list[0].contact] : []));
  }

  // ------------------------------------------------------------- handshake

  /**
   * Start an IK handshake with a paired contact.
   *
   * `contact` must come from the trust store — there is no overload taking a
   * raw key, because a handshake with an unpaired key is exactly the thing this
   * design refuses to make expressible.
   */
  beginHandshake(contact: Contact): Uint8Array {
    if (!this.trust.byIdentity(contact.identityKey)) {
      throw new SessionError('cannot handshake with an unpaired contact');
    }
    const handshake = new HandshakeInitiator(this.noiseStatic, contact.noiseKey);
    const messageA = handshake.writeMessageA();

    const target = targetTag(contact.noiseKey, handshake.ephemeralPublicKey);
    const reply = replyTag(handshake.ephemeralPublicKey);
    this.pending.set(hex(reply), { contact, handshake, startedAt: this.opts.now() });
    this.stats.handshakesStarted++;

    return concat(target, messageA);
  }

  /** True if the payload is addressed to us. Cheap enough to run on every frame. */
  isHandshakeForUs(payload: Uint8Array): boolean {
    if (payload.length < SESSION_TAG_BYTES + DH_BYTES) return false;
    const ephemeral = payload.subarray(
      SESSION_TAG_BYTES,
      SESSION_TAG_BYTES + DH_BYTES,
    );
    const expected = targetTag(this.noiseStatic.publicKey, ephemeral);
    return equalBytes(payload.subarray(0, SESSION_TAG_BYTES), expected);
  }

  /**
   * Handle an inbound message 1. Returns the reply to broadcast plus the
   * contact it came from, or null if the handshake is not for us, is a replay,
   * or comes from someone we have not paired with.
   */
  handleHandshakeInit(payload: Uint8Array): { reply: Uint8Array; contact: Contact } | null {
    if (!this.isHandshakeForUs(payload)) return null;

    const ephemeral = payload.subarray(SESSION_TAG_BYTES, SESSION_TAG_BYTES + DH_BYTES);
    const ephemeralHex = hex(ephemeral);
    const now = this.opts.now();

    // A replayed message 1 carries the same ephemeral. Answering it again costs
    // three scalar multiplications and buys the attacker nothing, so don't.
    if (!this.seenHandshakes.add(ephemeralHex, now)) {
      this.stats.handshakeReplaysDropped++;
      return null;
    }

    const responder = new HandshakeResponder(this.noiseStatic);
    let remoteStatic: Uint8Array;
    try {
      ({ remoteStatic } = responder.readMessageA(payload.subarray(SESSION_TAG_BYTES)));
    } catch {
      this.stats.handshakesRejected++;
      return null;
    }

    // THE trust decision. Noise proved the peer holds this static key; only the
    // trust store can say whether that key belongs to someone we have met.
    const contact = this.trust.byNoiseKey(remoteStatic);
    if (!contact) {
      this.stats.handshakesRejected++;
      return null;
    }

    let message: Uint8Array;
    let session: NoiseSession;
    try {
      ({ message, session } = responder.writeMessageB());
    } catch {
      this.stats.handshakesRejected++;
      return null;
    }

    this.establish(contact, session, false, now);
    this.stats.handshakesCompleted++;
    return { reply: concat(replyTag(ephemeral), message), contact };
  }

  /**
   * Handle an inbound message 2. Returns the contact whose session just came
   * up, or null if the reply is not one we are waiting for.
   */
  handleHandshakeResponse(payload: Uint8Array): Contact | null {
    if (payload.length < SESSION_TAG_BYTES + DH_BYTES + AEAD_TAG_BYTES) return null;

    const entry = this.pending.get(hex(payload.subarray(0, SESSION_TAG_BYTES)));
    if (!entry) return null;

    let session: NoiseSession;
    try {
      ({ session } = entry.handshake.readMessageB(payload.subarray(SESSION_TAG_BYTES)));
    } catch {
      // Only the real responder can produce a message that decrypts here, so a
      // failure is noise on the wire — but the pending handshake stays open, in
      // case the genuine reply is still in flight behind it.
      this.stats.handshakesRejected++;
      return null;
    }

    this.pending.delete(hex(replyTag(entry.handshake.ephemeralPublicKey)));
    this.establish(entry.contact, session, true, this.opts.now());
    this.stats.handshakesCompleted++;
    return entry.contact;
  }

  // -------------------------------------------------------------- messages

  /** Encrypt for a contact. Returns null when no session is up yet. */
  seal(contact: Contact, plaintext: Uint8Array): Uint8Array | null {
    const list = this.sessions.get(hex(contact.identityKey));
    const entry = list?.[list.length - 1];
    if (!entry) return null;

    const counter = entry.session.messagesSent;
    const message = entry.session.encrypt(plaintext);
    this.stats.messagesSealed++;
    return concat(sessionTag(entry.sendTagKey, counter), message);
  }

  /**
   * Try to open a direct message.
   *
   * Returns null for anything not addressed to us — which is the overwhelmingly
   * common case on a flood mesh, and costs one map lookup.
   */
  open(payload: Uint8Array): OpenedMessage | null {
    if (payload.length < SESSION_TAG_BYTES) return null;
    const tag = payload.subarray(0, SESSION_TAG_BYTES);
    const entry = this.tagIndex.get(hex(tag));
    if (!entry) return null;

    const message = payload.subarray(SESSION_TAG_BYTES);
    const counter = readCounter(message);
    if (counter === null) return null;

    // The tag has to be the one this counter should have produced. Cheap, and
    // it stops a tag being lifted off one message and pasted onto another.
    if (!equalBytes(tag, sessionTag(entry.recvTagKey, counter))) {
      this.stats.messagesUndecryptable++;
      return null;
    }

    const plaintext = entry.session.decrypt(message);
    if (!plaintext) {
      this.stats.messagesUndecryptable++;
      return null;
    }

    this.slideTags(entry, counter);
    this.stats.messagesOpened++;
    return { contact: entry.contact, plaintext };
  }

  /** Drop timed-out handshakes. Call from the same tick as mesh maintenance. */
  maintain(): void {
    const now = this.opts.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt > this.opts.handshakeTimeoutMs) this.pending.delete(key);
    }
    this.seenHandshakes.prune(now);
  }

  get pendingHandshakes(): number {
    return this.pending.size;
  }

  get registeredTags(): number {
    return this.tagIndex.size;
  }

  // ---------------------------------------------------------------- internal

  private establish(
    contact: Contact,
    session: NoiseSession,
    asInitiator: boolean,
    now: number,
  ): void {
    // Directional tag keys come off the handshake hash, so they are unique to
    // this session's transcript and cannot be replayed into another one.
    const i2r = hmac(sha256, session.handshakeHash, utf8(LABEL_TAG_I2R));
    const r2i = hmac(sha256, session.handshakeHash, utf8(LABEL_TAG_R2I));

    const entry: Established = {
      contact,
      session,
      sendTagKey: asInitiator ? i2r : r2i,
      recvTagKey: asInitiator ? r2i : i2r,
      establishedAt: now,
      tagLow: 0,
      tagHigh: -1,
    };

    const key = hex(contact.identityKey);
    const list = this.sessions.get(key) ?? [];
    list.push(entry);
    while (list.length > MAX_SESSIONS_PER_CONTACT) {
      const evicted = list.shift();
      if (evicted) this.unregisterTags(evicted, evicted.tagLow, evicted.tagHigh);
    }
    this.sessions.set(key, list);

    this.registerTags(entry, 0, this.opts.tagWindow - 1);
    entry.tagLow = 0;
    entry.tagHigh = this.opts.tagWindow - 1;
  }

  /**
   * Move the registered tag range to straddle the counter just consumed:
   * `tagWindow` ahead so future messages are recognised, and `tagWindow` behind
   * so a message that took a longer path through the mesh still is.
   */
  private slideTags(entry: Established, counter: number): void {
    const window = this.opts.tagWindow;
    const high = Math.max(entry.tagHigh, counter + window);
    const low = Math.max(entry.tagLow, counter - window, 0);

    if (high > entry.tagHigh) this.registerTags(entry, entry.tagHigh + 1, high);
    if (low > entry.tagLow) this.unregisterTags(entry, entry.tagLow, low - 1);
    entry.tagLow = low;
    entry.tagHigh = high;
  }

  private registerTags(entry: Established, from: number, to: number): void {
    for (let c = from; c <= to; c++) {
      this.tagIndex.set(hex(sessionTag(entry.recvTagKey, c)), entry);
    }
  }

  private unregisterTags(entry: Established, from: number, to: number): void {
    for (let c = from; c <= to; c++) {
      const key = hex(sessionTag(entry.recvTagKey, c));
      // Guard against evicting a colliding tag that now belongs to a newer
      // session. An 8-byte tag makes this vanishingly rare, not impossible.
      if (this.tagIndex.get(key) === entry) this.tagIndex.delete(key);
    }
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Addresses message 1 without naming the recipient.
 *
 * Derived from the recipient's Noise key AND the sender's fresh ephemeral, so
 * it differs on every handshake. A relay cannot tell two handshakes to the same
 * person apart; only someone who already knows the recipient's key — that is,
 * someone they paired with — can recompute it.
 */
export function targetTag(responderNoiseKey: Uint8Array, initiatorEphemeral: Uint8Array): Uint8Array {
  return sha256(concat(utf8(LABEL_IK_TARGET), responderNoiseKey, initiatorEphemeral)).slice(
    0,
    SESSION_TAG_BYTES,
  );
}

/**
 * Addresses message 2 back to the initiator, keyed only on the initiator's
 * ephemeral so the initiator can precompute it.
 *
 * This does let an observer link a reply to the message-1 that provoked it,
 * since that ephemeral is on the wire in the clear. It reveals no identity, and
 * the two frames are adjacent in time anyway.
 */
export function replyTag(initiatorEphemeral: Uint8Array): Uint8Array {
  return sha256(concat(utf8(LABEL_IK_REPLY), initiatorEphemeral)).slice(0, SESSION_TAG_BYTES);
}

export function sessionTag(tagKey: Uint8Array, counter: number): Uint8Array {
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false);
  return hmac(sha256, tagKey, counterBytes).slice(0, SESSION_TAG_BYTES);
}

function readCounter(message: Uint8Array): number | null {
  if (message.length < 8) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const counter = Number(view.getBigUint64(0, false));
  return Number.isSafeInteger(counter) ? counter : null;
}

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

/** Constant-time within a length class. Tags are public, but habits matter. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
