/**
 * Shared protocol types.
 *
 * Nothing in `@whisper/core` may import from `react-native`. The entire
 * protocol has to be runnable under plain Node so the simulation suite can
 * drive a 20-node mesh without touching hardware.
 */

/** Wire protocol version. Frame byte 0. Bump only on a breaking change. */
export const PROTOCOL_VERSION = 1;

/**
 * Hard ceiling on hop count. Received frames are clamped to this before
 * relaying — see the note in `mesh.ts` about why TTL is deliberately not
 * covered by the signature.
 */
export const MAX_TTL = 7;

export enum FrameType {
  /** Public channel message. Readable by anyone with the channel key. */
  ChannelMessage = 1,
  /** 1:1 direct message. Opaque ciphertext to every relay in between. */
  DirectMessage = 2,
  /** Bloom digest of held message ids, sent on link establishment. */
  GossipDigest = 3,
  /** Explicit request for message ids absent from a peer's digest. */
  GossipRequest = 4,
  /** Noise IK message 1. Addressed by a per-handshake tag, not by name. */
  HandshakeInit = 5,
  /** Noise IK message 2. */
  HandshakeResponse = 6,
}

/**
 * Frame types whose `sender` field is an ephemeral key rather than a stable
 * identity.
 *
 * A public channel message is attributable on purpose — that is the property
 * that stops impersonation. A direct message must not be: if DMs were signed by
 * the identity key, every relay in the mesh would learn who is talking, even
 * without reading a word. Authenticity for these frames comes from the Noise
 * session inside, so the outer signature only has to prove the frame was not
 * mangled in flight, and an ephemeral key does that just as well.
 */
export const EPHEMERALLY_SIGNED = new Set<FrameType>([
  FrameType.DirectMessage,
  FrameType.HandshakeInit,
  FrameType.HandshakeResponse,
]);

/** Ed25519 public key, 32 bytes. Doubles as a node's stable identity. */
export type PublicKey = Uint8Array;

/**
 * Opaque handle for a link-layer neighbour. This is the *ephemeral* id from
 * the BLE advertisement, NOT the identity key — the two must never be
 * conflated or the rotating-id privacy property is lost.
 */
export type PeerId = string;

/** 16-byte random message identifier, used for dedup and gossip digests. */
export type MessageId = Uint8Array;

export interface Frame {
  version: number;
  /** Mutable across hops. Not signed. Clamped to MAX_TTL on receipt. */
  ttl: number;
  type: FrameType;
  flags: number;
  msgId: MessageId;
  /** Ed25519 public key of the originator. Signed, therefore unforgeable. */
  sender: PublicKey;
  /** Milliseconds since epoch, as claimed by the sender. */
  timestamp: number;
  payload: Uint8Array;
  /** Ed25519 signature over the immutable region. */
  signature: Uint8Array;
}

/** A frame plus the bookkeeping the mesh layer needs to relay it. */
export interface StoredFrame {
  frame: Frame;
  /**
   * The exact bytes as received. Relays forward these verbatim (with only TTL
   * rewritten) rather than re-serialising, so a signature that verified here
   * cannot be invalidated by an encoder quirk downstream.
   */
  encoded: Uint8Array;
  /** Local receipt time — drives outbox expiry. Never trust `frame.timestamp`. */
  receivedAt: number;
  /** Link the frame arrived on, so we never echo it straight back. */
  from: PeerId | null;
}
