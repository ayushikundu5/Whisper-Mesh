/**
 * The BLE contract. Both roles — central and peripheral — and both platforms
 * must agree on every value in this file, so it is the one place they are
 * defined.
 *
 * GATT layout:
 *
 *   Service  8e7a0001-…   advertised, so peers can filter for us in a scan
 *     ├─ INBOX  8e7a0002-…  write-without-response  (peer -> us)
 *     └─ OUTBOX 8e7a0003-…  notify                  (us -> peer)
 *
 * WHY TWO CHARACTERISTICS AND NOT ONE: a GATT link is asymmetric — the central
 * writes, the peripheral notifies — but the mesh above it is not. Two
 * characteristics give the transport a symmetric duplex pipe, so `Transport` on
 * either side looks identical and `@whisper/core` never learns which role this
 * phone happens to be playing on a given link.
 *
 * Write-without-response, not write-with-response: an ack per fragment would
 * halve throughput at the exact MTU where a frame already needs nine fragments.
 * Losses are handled above, by the mesh's redundant flooding.
 */

export const SERVICE_UUID = '8e7a0001-6d15-4f9c-9a2b-1c7d3f5e9b04';

/** Peer writes fragments here. Write-without-response. */
export const INBOX_CHARACTERISTIC_UUID = '8e7a0002-6d15-4f9c-9a2b-1c7d3f5e9b04';

/** We push fragments out through here. Notify. */
export const OUTBOX_CHARACTERISTIC_UUID = '8e7a0003-6d15-4f9c-9a2b-1c7d3f5e9b04';

/** Standard Client Characteristic Configuration Descriptor, to enable notifies. */
export const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';

/**
 * Advertisement service data:
 *
 *   0  1   protocol version
 *   1  6   ephemeral peer id
 *
 * Seven bytes, which is what fits. A legacy advertisement is 31 bytes: three go
 * to flags, and a service-data field carrying a 128-bit UUID costs eighteen
 * more. That leaves ten, and this uses seven of them.
 *
 * THE ID IS EPHEMERAL AND IT MATTERS. A stable identifier in an advertisement
 * turns every user into a beacon that any passive receiver can follow across a
 * city — this is exactly how retail analytics tracked phones before MAC
 * randomisation. The id here is random, rotates, and is never derived from the
 * identity key. `PeerId` and identity are separate types in the core for the
 * same reason.
 */
export const ADVERTISEMENT_VERSION = 1;
export const PEER_ID_BYTES = 6;
export const ADVERTISEMENT_BYTES = 1 + PEER_ID_BYTES;

/**
 * The id rides in manufacturer data rather than service data, and the reason is
 * a byte count.
 *
 * Service data keyed by a 128-bit UUID repeats the whole UUID before the first
 * useful byte: 2 + 16 + 7 = 25 of the 31 a legacy scan response holds. Real
 * adapters reject that far more often than the arithmetic suggests, and a
 * refusal is total — `ADVERTISE_FAILED_DATA_TOO_LARGE`, no advertisement, and a
 * phone that scans perfectly while being invisible to everyone else.
 * Manufacturer data costs 2 + 2 + 7 = 11 for the same payload.
 *
 * 0xFFFF is the SIG's id for exactly this: internal use, never assigned to a
 * company, so it cannot collide with a real vendor's advertisements.
 */
export const MANUFACTURER_ID = 0xffff;

/**
 * How long one advertised id is used.
 *
 * A real tension, not a free knob. Rotating often shrinks the window in which a
 * tracker can follow you; rotating while links are up breaks them, because a
 * peer that reconnects under a new id looks like a stranger and pays for a
 * fresh handshake. Fifteen minutes matches the ephemeral signing-key rotation
 * in `Messenger`, so the two identifiers a relay can see turn over together —
 * rotating one but not the other would leak the link between them.
 *
 * `WhisperBleTransport` defers a rotation while a link is active and applies it
 * at the next quiet moment.
 */
export const PEER_ID_ROTATION_MS = 15 * 60 * 1000;

/**
 * MTU to ask Android for. iOS negotiates on its own and settles near 185.
 *
 * This is a reliability setting, not a throughput one. With no application ARQ,
 * a frame arrives only if every fragment does, so delivery per link is
 * (1-p)^fragments — at the 23-byte floor a signed frame is nine fragments and
 * 30% loss leaves about 4%. The core's simulation suite measures exactly this
 * gap; see the "lossy links" tests.
 */
export const PREFERRED_MTU = 517;

/** ATT overhead per write. Usable payload is the negotiated MTU minus this. */
export const ATT_HEADER_BYTES = 3;

/** Assume the BLE floor until a negotiation says otherwise. */
export const DEFAULT_MTU = 23;

/**
 * Concurrent GATT links. Android's stack becomes unreliable well before its
 * nominal limit, and each link costs power whether or not it carries traffic.
 * Mesh connectivity comes from many short links over time, not many at once.
 */
export const MAX_CONNECTIONS = 7;

/** A connect attempt that has not completed by now is treated as failed. */
export const CONNECT_TIMEOUT_MS = 10_000;

export function encodeAdvertisement(peerIdBytes: Uint8Array): Uint8Array {
  if (peerIdBytes.length !== PEER_ID_BYTES) {
    throw new Error(`peer id must be ${PEER_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(ADVERTISEMENT_BYTES);
  out[0] = ADVERTISEMENT_VERSION;
  out.set(peerIdBytes, 1);
  return out;
}

/** Returns null for anything that is not one of ours, including other versions. */
export function decodeAdvertisement(bytes: Uint8Array): string | null {
  if (bytes.length < ADVERTISEMENT_BYTES) return null;
  if (bytes[0] !== ADVERTISEMENT_VERSION) return null;
  return bytesToHex(bytes.subarray(1, 1 + PEER_ID_BYTES));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** react-native-ble-plx hands base64 across the bridge; the core speaks bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary);
}
