import { KeyPair, generateIdentity, publicKeyToHex } from './crypto/identity';
import { MeshNode } from './mesh';
import { SessionManager, SessionManagerOptions } from './session';
import { Contact, TrustStore } from './trust';
import { EPHEMERALLY_SIGNED, Frame, FrameType } from './types';

/**
 * The application-facing layer: identity, trust, sessions, and the mesh, wired
 * together.
 *
 * Everything below this is transport-agnostic protocol; everything above is UI.
 * The app package holds no protocol logic at all, which is what keeps the whole
 * stack testable in Node.
 */

export interface MessengerOptions extends SessionManagerOptions {
  /**
   * How long one ephemeral signing key is used for direct messages before it is
   * replaced. Direct-message frames carry this key in the clear as `sender`, so
   * its lifetime is exactly how long a relay can group your DMs together.
   */
  ephemeralRotationMs?: number;
  /** Same idea, bounded by volume rather than time. */
  ephemeralRotationMessages?: number;
  /** Plaintexts held per contact while a handshake completes. */
  outgoingQueueLimit?: number;
  now?: () => number;
}

const DEFAULTS = {
  ephemeralRotationMs: 15 * 60 * 1000,
  ephemeralRotationMessages: 64,
  outgoingQueueLimit: 32,
};

export interface DirectMessageEvent {
  contact: Contact;
  plaintext: Uint8Array;
  /** The carrying frame. Its `sender` is an ephemeral key, not an identity. */
  frame: Frame;
}

export class Messenger {
  private readonly sessions: SessionManager;
  private readonly opts: Required<MessengerOptions & { now: () => number }>;

  private ephemeral: KeyPair = generateIdentity();
  private ephemeralSince: number;
  private ephemeralUses = 0;

  /** identityHex -> plaintexts waiting for a session to come up. */
  private readonly queued = new Map<string, Uint8Array[]>();

  private directHandlers: Array<(event: DirectMessageEvent) => void> = [];
  private channelHandlers: Array<(frame: Frame) => void> = [];
  private sessionHandlers: Array<(contact: Contact) => void> = [];
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly mesh: MeshNode,
    readonly identity: KeyPair,
    readonly trust: TrustStore,
    options: MessengerOptions = {},
  ) {
    this.opts = {
      ...DEFAULTS,
      now: () => Date.now(),
      ...options,
    } as Required<MessengerOptions & { now: () => number }>;
    this.sessions = new SessionManager(identity, trust, options);
    this.ephemeralSince = this.opts.now();
  }

  get sessionManager(): SessionManager {
    return this.sessions;
  }

  get noisePublicKey(): Uint8Array {
    return this.sessions.noisePublicKey;
  }

  onDirectMessage(handler: (event: DirectMessageEvent) => void): () => void {
    this.directHandlers.push(handler);
    return () => {
      this.directHandlers = this.directHandlers.filter((h) => h !== handler);
    };
  }

  onChannelMessage(handler: (frame: Frame) => void): () => void {
    this.channelHandlers.push(handler);
    return () => {
      this.channelHandlers = this.channelHandlers.filter((h) => h !== handler);
    };
  }

  /** Fires when a session with a contact becomes usable, in either direction. */
  onSessionEstablished(handler: (contact: Contact) => void): () => void {
    this.sessionHandlers.push(handler);
    return () => {
      this.sessionHandlers = this.sessionHandlers.filter((h) => h !== handler);
    };
  }

  start(): void {
    if (this.unsubscribe) return;
    this.mesh.start();
    this.unsubscribe = this.mesh.onMessage((frame) => {
      void this.dispatch(frame);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.mesh.stop();
  }

  // -------------------------------------------------------------- outbound

  /** Public channel message. Signed by the real identity, on purpose. */
  async sendChannel(payload: Uint8Array): Promise<Frame> {
    return this.publish(FrameType.ChannelMessage, payload);
  }

  /**
   * Encrypt and flood a direct message.
   *
   * If no session is up, the plaintext is queued and a handshake is started;
   * it goes out as soon as the session completes. Returns true if the message
   * left immediately.
   */
  async sendDirect(contact: Contact, plaintext: Uint8Array): Promise<boolean> {
    const sealed = this.sessions.seal(contact, plaintext);
    if (sealed) {
      await this.publish(FrameType.DirectMessage, sealed);
      return true;
    }
    this.enqueue(contact, plaintext);
    await this.connect(contact);
    return false;
  }

  /** Begin a Noise IK handshake. Safe to call repeatedly; it is just a frame. */
  async connect(contact: Contact): Promise<void> {
    await this.publish(FrameType.HandshakeInit, this.sessions.beginHandshake(contact));
  }

  hasSession(contact: Contact): boolean {
    return this.sessions.hasSession(contact);
  }

  maintain(): void {
    this.mesh.maintain();
    this.sessions.maintain();
  }

  // --------------------------------------------------------------- inbound

  private async dispatch(frame: Frame): Promise<void> {
    switch (frame.type) {
      case FrameType.ChannelMessage:
        for (const handler of this.channelHandlers) handler(frame);
        return;

      case FrameType.HandshakeInit: {
        const result = this.sessions.handleHandshakeInit(frame.payload);
        if (!result) return; // not for us, or from someone we have not paired with
        await this.publish(FrameType.HandshakeResponse, result.reply);
        this.announceSession(result.contact);
        await this.flush(result.contact);
        return;
      }

      case FrameType.HandshakeResponse: {
        const contact = this.sessions.handleHandshakeResponse(frame.payload);
        if (!contact) return;
        this.announceSession(contact);
        await this.flush(contact);
        return;
      }

      case FrameType.DirectMessage: {
        const opened = this.sessions.open(frame.payload);
        // A null here is the normal case: the frame belongs to someone else and
        // we are only carrying it. The mesh has already relayed it.
        if (!opened) return;
        for (const handler of this.directHandlers) {
          handler({ contact: opened.contact, plaintext: opened.plaintext, frame });
        }
        return;
      }

      default:
        return;
    }
  }

  // -------------------------------------------------------------- internals

  /**
   * Every frame this layer originates goes through here, so the choice of
   * signing key is made in exactly one place from exactly one table. Deciding
   * it at each call site is how a new frame type eventually ships signed with
   * the identity key by accident, quietly undoing the property.
   */
  private publish(type: FrameType, payload: Uint8Array): Promise<Frame> {
    const keys = EPHEMERALLY_SIGNED.has(type) ? this.ephemeralKeys() : this.identity;
    return this.mesh.publish(type, payload, keys);
  }

  /**
   * The keypair used to sign session-layer frames.
   *
   * Rotated by age and by use. The rotation bound is a privacy knob, not a
   * cryptographic one: nothing about the session depends on this key, and its
   * only job is to stop `sender` becoming a stable handle a relay can follow.
   */
  private ephemeralKeys(): KeyPair {
    const now = this.opts.now();
    const stale =
      now - this.ephemeralSince >= this.opts.ephemeralRotationMs ||
      this.ephemeralUses >= this.opts.ephemeralRotationMessages;
    if (stale) {
      this.ephemeral = generateIdentity();
      this.ephemeralSince = now;
      this.ephemeralUses = 0;
    }
    this.ephemeralUses++;
    return this.ephemeral;
  }

  private announceSession(contact: Contact): void {
    for (const handler of this.sessionHandlers) handler(contact);
  }

  private enqueue(contact: Contact, plaintext: Uint8Array): void {
    const key = publicKeyToHex(contact.identityKey);
    const list = this.queued.get(key) ?? [];
    list.push(plaintext);
    while (list.length > this.opts.outgoingQueueLimit) list.shift();
    this.queued.set(key, list);
  }

  private async flush(contact: Contact): Promise<void> {
    const key = publicKeyToHex(contact.identityKey);
    const list = this.queued.get(key);
    if (!list?.length) return;
    this.queued.delete(key);
    for (const plaintext of list) {
      const sealed = this.sessions.seal(contact, plaintext);
      if (!sealed) {
        this.enqueue(contact, plaintext);
        continue;
      }
      await this.publish(FrameType.DirectMessage, sealed);
    }
  }
}
