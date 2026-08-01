import { PeerId } from './types';

/**
 * L1 — fragmentation and reassembly.
 *
 * BLE's default ATT MTU is 23 bytes, of which 20 are usable. Android can
 * negotiate up to 517 and iOS lands around 185, but negotiation can fail and
 * the floor is what you must survive. Since a signed frame carries 126 bytes
 * of header alone, fragmentation is mandatory on every path — it is not an
 * optimisation to add later.
 *
 * Fragment layout:
 *
 *   offset  size  field
 *   0       2     fragId (u16 BE, per-link rolling)
 *   2       1     index
 *   3       1     total
 *   4       N     chunk
 */

export const FRAG_HEADER_BYTES = 4;
const MAX_FRAGMENTS = 255; // `total` is a u8

/** Reassembly buffers are dropped after this long. Guards against half-sent frames. */
export const REASSEMBLY_TIMEOUT_MS = 30_000;

/**
 * Cap on concurrent in-flight reassemblies per peer. Without this, a hostile
 * neighbour can pin unbounded memory by opening fragment sets it never
 * finishes.
 */
export const MAX_PENDING_PER_PEER = 8;

export class FragmentationError extends Error {}

interface Pending {
  total: number;
  chunks: Array<Uint8Array | undefined>;
  received: number;
  startedAt: number;
  bytes: number;
}

export function fragment(payload: Uint8Array, mtu: number, fragId: number): Uint8Array[] {
  const usable = mtu - FRAG_HEADER_BYTES;
  if (usable <= 0) {
    throw new FragmentationError(`mtu ${mtu} too small for ${FRAG_HEADER_BYTES}-byte header`);
  }
  const total = Math.max(1, Math.ceil(payload.length / usable));
  if (total > MAX_FRAGMENTS) {
    throw new FragmentationError(
      `payload of ${payload.length}B needs ${total} fragments at mtu ${mtu}; max is ${MAX_FRAGMENTS}`,
    );
  }

  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const slice = payload.subarray(i * usable, Math.min((i + 1) * usable, payload.length));
    const frag = new Uint8Array(FRAG_HEADER_BYTES + slice.length);
    frag[0] = (fragId >>> 8) & 0xff;
    frag[1] = fragId & 0xff;
    frag[2] = i;
    frag[3] = total;
    frag.set(slice, FRAG_HEADER_BYTES);
    out.push(frag);
  }
  return out;
}

/**
 * Accumulates fragments per (peer, fragId) and emits the completed payload.
 *
 * Deliberately tolerant of duplicates and reordering — BLE gives no ordering
 * guarantee across reconnects, and the mesh floods redundantly on purpose.
 */
export class Reassembler {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs = REASSEMBLY_TIMEOUT_MS,
    private readonly maxPendingPerPeer = MAX_PENDING_PER_PEER,
  ) {}

  /** Returns the complete payload once the final missing fragment arrives. */
  accept(peer: PeerId, frag: Uint8Array, now: number): Uint8Array | null {
    if (frag.length < FRAG_HEADER_BYTES) return null;

    const fragId = ((frag[0]! << 8) | frag[1]!) >>> 0;
    const index = frag[2]!;
    const total = frag[3]!;
    if (total === 0 || index >= total) return null;

    const key = `${peer}:${fragId}`;
    let entry = this.pending.get(key);

    if (!entry) {
      this.evictIfOverLimit(peer, now);
      entry = {
        total,
        chunks: new Array<Uint8Array | undefined>(total),
        received: 0,
        startedAt: now,
        bytes: 0,
      };
      this.pending.set(key, entry);
    } else if (entry.total !== total) {
      // Same fragId claiming a different length: a confused or hostile sender.
      this.pending.delete(key);
      return null;
    }

    if (entry.chunks[index] === undefined) {
      const body = frag.slice(FRAG_HEADER_BYTES);
      entry.chunks[index] = body;
      entry.received++;
      entry.bytes += body.length;
    }

    if (entry.received !== entry.total) return null;

    this.pending.delete(key);
    const out = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      out.set(chunk!, offset);
      offset += chunk!.length;
    }
    return out;
  }

  /** Drop reassemblies that stalled. Call on the same tick as mesh maintenance. */
  prune(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.pending) {
      if (now - entry.startedAt > this.timeoutMs) {
        this.pending.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  forget(peer: PeerId): void {
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${peer}:`)) this.pending.delete(key);
    }
  }

  private evictIfOverLimit(peer: PeerId, now: number): void {
    const prefix = `${peer}:`;
    const mine = [...this.pending.entries()].filter(([k]) => k.startsWith(prefix));
    if (mine.length < this.maxPendingPerPeer) return;
    // Drop the least recently started; it is the most likely to be abandoned.
    mine.sort((a, b) => a[1].startedAt - b[1].startedAt);
    this.pending.delete(mine[0]![0]);
    void now;
  }
}
