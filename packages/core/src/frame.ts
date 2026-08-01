import { Frame, FrameType, MessageId, PROTOCOL_VERSION } from './types';

/**
 * Wire format.
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------
 *   0       1     version        <- mutable, NOT signed
 *   1       1     ttl            <- mutable, NOT signed
 *   ---------------- signed region begins ----------------
 *   2       1     type
 *   3       1     flags
 *   4       16    msgId
 *   20      32    sender (Ed25519 public key)
 *   52      8     timestamp (u64 BE, ms)
 *   60      2     payloadLen (u16 BE)
 *   62      N     payload
 *   ---------------- signed region ends ------------------
 *   62+N    64    signature
 *
 * WHY THE SPLIT: BitChat's headline vulnerability was signing only the
 * payload, which left `senderPeerID` and `nickname` in the header forgeable —
 * anyone could impersonate anyone in a public channel. Here every field that
 * carries meaning is inside the signed region, `sender` above all.
 *
 * `ttl` is excluded because it MUST change at every hop; signing it would
 * break the signature on the first relay. That is safe precisely because TTL
 * carries no authenticity claim — the worst a tamperer can do is change
 * propagation range, and `mesh.ts` clamps it to MAX_TTL on receipt to close
 * the broadcast-storm vector.
 */

export const MSG_ID_BYTES = 16;
export const PUBKEY_BYTES = 32;
export const SIG_BYTES = 64;

const OFF_VERSION = 0;
const OFF_TTL = 1;
const OFF_SIGNED_START = 2;
const OFF_TYPE = 2;
const OFF_FLAGS = 3;
const OFF_MSG_ID = 4;
const OFF_SENDER = 20;
const OFF_TIMESTAMP = 52;
const OFF_PAYLOAD_LEN = 60;
const OFF_PAYLOAD = 62;

/** Bytes of framing overhead per message, excluding payload. */
export const FRAME_OVERHEAD = OFF_PAYLOAD + SIG_BYTES;

/** u16 payload length field caps a single frame's payload. */
export const MAX_PAYLOAD = 0xffff;

export class FrameDecodeError extends Error {}

/**
 * The exact bytes an Ed25519 signature must cover: everything from `type`
 * through the end of `payload`. Used by both the signer and the verifier so
 * the two can never drift apart.
 */
export function signedRegion(encoded: Uint8Array): Uint8Array {
  const payloadLen = readU16(encoded, OFF_PAYLOAD_LEN);
  return encoded.subarray(OFF_SIGNED_START, OFF_PAYLOAD + payloadLen);
}

/**
 * Serialise everything except the signature. Callers sign `signedRegion()` of
 * the result and then append via `attachSignature`.
 */
export function encodeUnsigned(
  frame: Omit<Frame, 'signature' | 'version'> & { version?: number },
): Uint8Array {
  if (frame.msgId.length !== MSG_ID_BYTES) {
    throw new FrameDecodeError(`msgId must be ${MSG_ID_BYTES} bytes`);
  }
  if (frame.sender.length !== PUBKEY_BYTES) {
    throw new FrameDecodeError(`sender must be ${PUBKEY_BYTES} bytes`);
  }
  if (frame.payload.length > MAX_PAYLOAD) {
    throw new FrameDecodeError(`payload exceeds ${MAX_PAYLOAD} bytes`);
  }

  const out = new Uint8Array(OFF_PAYLOAD + frame.payload.length);
  out[OFF_VERSION] = frame.version ?? PROTOCOL_VERSION;
  out[OFF_TTL] = frame.ttl;
  out[OFF_TYPE] = frame.type;
  out[OFF_FLAGS] = frame.flags;
  out.set(frame.msgId, OFF_MSG_ID);
  out.set(frame.sender, OFF_SENDER);
  writeU64(out, OFF_TIMESTAMP, frame.timestamp);
  writeU16(out, OFF_PAYLOAD_LEN, frame.payload.length);
  out.set(frame.payload, OFF_PAYLOAD);
  return out;
}

export function attachSignature(unsigned: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== SIG_BYTES) {
    throw new FrameDecodeError(`signature must be ${SIG_BYTES} bytes`);
  }
  const out = new Uint8Array(unsigned.length + SIG_BYTES);
  out.set(unsigned, 0);
  out.set(signature, unsigned.length);
  return out;
}

export function encode(frame: Frame): Uint8Array {
  return attachSignature(encodeUnsigned(frame), frame.signature);
}

export function decode(bytes: Uint8Array): Frame {
  if (bytes.length < FRAME_OVERHEAD) {
    throw new FrameDecodeError(`frame too short: ${bytes.length} < ${FRAME_OVERHEAD}`);
  }
  const payloadLen = readU16(bytes, OFF_PAYLOAD_LEN);
  const expected = FRAME_OVERHEAD + payloadLen;
  if (bytes.length !== expected) {
    // A truncated or over-long frame means a broken fragmenter or a hostile
    // peer. Either way it is not something to guess at.
    throw new FrameDecodeError(`length mismatch: got ${bytes.length}, header implies ${expected}`);
  }

  const type = bytes[OFF_TYPE]!;
  if (!(type in FrameType)) {
    throw new FrameDecodeError(`unknown frame type ${type}`);
  }

  return {
    version: bytes[OFF_VERSION]!,
    ttl: bytes[OFF_TTL]!,
    type: type as FrameType,
    flags: bytes[OFF_FLAGS]!,
    msgId: bytes.slice(OFF_MSG_ID, OFF_MSG_ID + MSG_ID_BYTES),
    sender: bytes.slice(OFF_SENDER, OFF_SENDER + PUBKEY_BYTES),
    timestamp: readU64(bytes, OFF_TIMESTAMP),
    payload: bytes.slice(OFF_PAYLOAD, OFF_PAYLOAD + payloadLen),
    signature: bytes.slice(OFF_PAYLOAD + payloadLen),
  };
}

/**
 * Rewrite TTL in place on an already-encoded frame. This is the only mutation
 * a relay performs, and it is why TTL sits outside the signed region.
 */
export function setTtl(encoded: Uint8Array, ttl: number): void {
  encoded[OFF_TTL] = ttl & 0xff;
}

/** Lowercase hex. Used as the map key for dedup and gossip sets. */
export function msgIdToHex(id: MessageId): string {
  let s = '';
  for (const b of id) s += b.toString(16).padStart(2, '0');
  return s;
}

function writeU16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function readU16(buf: Uint8Array, offset: number): number {
  return ((buf[offset]! << 8) | buf[offset + 1]!) >>> 0;
}

function writeU64(buf: Uint8Array, offset: number, value: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(offset, BigInt(Math.floor(value)), false);
}

function readU64(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return Number(view.getBigUint64(offset, false));
}
