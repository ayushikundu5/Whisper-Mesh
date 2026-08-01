import { PeerId } from '../types';
import { PeerUnreachableError, Transport } from '../transport';

/**
 * In-memory radio simulator.
 *
 * Loss and partitioning are modelled as properties of the *network*, not as
 * separate transport subclasses — a dropped packet and an out-of-range peer are
 * network conditions, and expressing them that way lets one test vary both
 * without swapping implementations.
 *
 * Delivery is queued rather than reentrant. A synchronous hand-off would let
 * one `publish()` recurse through the entire mesh inside a single call stack,
 * which both risks stack overflow and makes ordering unlike anything real.
 */

interface QueuedChunk {
  from: PeerId;
  to: PeerId;
  chunk: Uint8Array;
}

/** Deterministic PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimOptions {
  /** Usable bytes per write. Defaults to BLE's worst case: 23-byte MTU, 20 usable. */
  mtu?: number;
  /** Probability in [0,1) that any single chunk is silently dropped. */
  lossRate?: number;
  seed?: number;
}

export class SimNetwork {
  private readonly transports = new Map<PeerId, SimTransport>();
  private readonly adjacency = new Map<PeerId, Set<PeerId>>();
  private readonly queue: QueuedChunk[] = [];
  private readonly rand: () => number;

  readonly mtu: number;
  lossRate: number;

  /** Total chunks that entered the network. Useful for airtime assertions. */
  chunksSent = 0;
  chunksDropped = 0;

  constructor(options: SimOptions = {}) {
    this.mtu = options.mtu ?? 20;
    this.lossRate = options.lossRate ?? 0;
    this.rand = mulberry32(options.seed ?? 1);
  }

  addNode(id: PeerId): SimTransport {
    const transport = new SimTransport(id, this);
    this.transports.set(id, transport);
    this.adjacency.set(id, new Set());
    return transport;
  }

  /** Put two nodes in radio range of each other. */
  link(a: PeerId, b: PeerId): void {
    if (a === b) return;
    if (this.adjacency.get(a)?.has(b)) return;
    this.adjacency.get(a)?.add(b);
    this.adjacency.get(b)?.add(a);
    this.transports.get(a)?.emitConnected(b);
    this.transports.get(b)?.emitConnected(a);
  }

  unlink(a: PeerId, b: PeerId): void {
    if (!this.adjacency.get(a)?.has(b)) return;
    this.adjacency.get(a)?.delete(b);
    this.adjacency.get(b)?.delete(a);
    this.transports.get(a)?.emitDisconnected(b);
    this.transports.get(b)?.emitDisconnected(a);
  }

  /** Sever every link touching `id` — models a device powering off. */
  isolate(id: PeerId): void {
    for (const other of [...(this.adjacency.get(id) ?? [])]) this.unlink(id, other);
  }

  /** Split the network into two mutually unreachable halves. */
  partition(groupA: PeerId[], groupB: PeerId[]): void {
    for (const a of groupA) for (const b of groupB) this.unlink(a, b);
  }

  neighbours(id: PeerId): PeerId[] {
    return [...(this.adjacency.get(id) ?? [])];
  }

  enqueue(from: PeerId, to: PeerId, chunk: Uint8Array): void {
    if (!this.adjacency.get(from)?.has(to)) throw new PeerUnreachableError(to);
    this.chunksSent++;
    if (this.rand() < this.lossRate) {
      this.chunksDropped++;
      return;
    }
    this.queue.push({ from, to, chunk });
  }

  /**
   * Drain the network until quiescent.
   *
   * `maxRounds` is not just a safety valve — it is the routing-loop detector.
   * A correct flood with TTL decrement and dedup always terminates, so a
   * network that will not settle is a protocol bug, and the suite asserts it
   * never fires.
   */
  async flush(maxRounds = 200_000): Promise<void> {
    let rounds = 0;
    while (this.queue.length > 0) {
      if (++rounds > maxRounds) {
        throw new Error(
          `network did not converge after ${maxRounds} deliveries — routing loop or TTL not decrementing`,
        );
      }
      const item = this.queue.shift()!;
      this.transports.get(item.to)?.deliver(item.from, item.chunk);
      // Let the receiver's async handler run before the next delivery.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

export class SimTransport implements Transport {
  private chunkHandlers: Array<(peer: PeerId, chunk: Uint8Array) => void> = [];
  private connectHandlers: Array<(peer: PeerId) => void> = [];
  private disconnectHandlers: Array<(peer: PeerId) => void> = [];

  constructor(
    readonly localPeerId: PeerId,
    private readonly net: SimNetwork,
  ) {}

  mtu(_peer: PeerId): number {
    return this.net.mtu;
  }

  peers(): PeerId[] {
    return this.net.neighbours(this.localPeerId);
  }

  async send(peer: PeerId, chunk: Uint8Array): Promise<void> {
    this.net.enqueue(this.localPeerId, peer, chunk);
  }

  onChunk(handler: (peer: PeerId, chunk: Uint8Array) => void): () => void {
    this.chunkHandlers.push(handler);
    return () => {
      this.chunkHandlers = this.chunkHandlers.filter((h) => h !== handler);
    };
  }

  onPeerConnected(handler: (peer: PeerId) => void): () => void {
    this.connectHandlers.push(handler);
    return () => {
      this.connectHandlers = this.connectHandlers.filter((h) => h !== handler);
    };
  }

  onPeerDisconnected(handler: (peer: PeerId) => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }

  deliver(from: PeerId, chunk: Uint8Array): void {
    for (const handler of this.chunkHandlers) handler(from, chunk);
  }

  emitConnected(peer: PeerId): void {
    for (const handler of this.connectHandlers) handler(peer);
  }

  emitDisconnected(peer: PeerId): void {
    for (const handler of this.disconnectHandlers) handler(peer);
  }
}
