import { PeerId } from './types';

/**
 * L0 — the only surface the mesh knows about.
 *
 * Everything above this interface is pure TypeScript and testable in Node. The
 * BLE implementation (central via react-native-ble-plx, peripheral via the
 * local `whisper-ble` Expo module) lives in the app package and is the only
 * part that needs hardware. Keeping the boundary this thin is what lets the
 * whole protocol be validated before a single line of Kotlin is written.
 */
export interface Transport {
  /** Stable local handle. Rotates with the advertising id, by design. */
  readonly localPeerId: PeerId;

  /** Largest single write this transport will accept, post-MTU-negotiation. */
  mtu(peer: PeerId): number;

  /** Currently reachable neighbours (one radio hop away). */
  peers(): PeerId[];

  /** Deliver one already-fragmented chunk. Rejects if the peer vanished. */
  send(peer: PeerId, chunk: Uint8Array): Promise<void>;

  onChunk(handler: (peer: PeerId, chunk: Uint8Array) => void): () => void;
  onPeerConnected(handler: (peer: PeerId) => void): () => void;
  onPeerDisconnected(handler: (peer: PeerId) => void): () => void;
}

export class PeerUnreachableError extends Error {
  constructor(peer: PeerId) {
    super(`peer unreachable: ${peer}`);
  }
}
