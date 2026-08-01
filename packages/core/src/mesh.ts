import { BloomFilter } from './bloom';
import { KeyPair, newMessageId, signFrame, verifyFrame } from './crypto/identity';
import { decode, msgIdToHex, setTtl } from './frame';
import { Reassembler } from './link';
import { fragment } from './link';
import { LruSet } from './lru';
import { Transport } from './transport';
import {
  Frame,
  FrameType,
  MAX_TTL,
  PROTOCOL_VERSION,
  PeerId,
  StoredFrame,
} from './types';

/**
 * L2 — flood routing with store-and-forward and gossip sync.
 *
 * Routing model: TTL-bounded flooding, deduplicated by message id. There is no
 * routing table. In a mesh where every node is a phone in someone's pocket,
 * topology changes faster than any table converges, so flooding plus dedup is
 * both simpler and more robust. Cost is redundant transmissions, which gossip
 * sync exists to bound.
 */

export interface MeshOptions {
  /** Max message ids remembered for dedup. Bounded to resist memory exhaustion. */
  seenCapacity?: number;
  seenTtlMs?: number;
  /** Frames retained for store-and-forward to peers met later. */
  outboxCapacity?: number;
  outboxTtlMs?: number;
  /** Starting hop budget for locally originated messages. */
  defaultTtl?: number;
  now?: () => number;
}

export interface MeshStats {
  delivered: number;
  relayed: number;
  duplicatesDropped: number;
  invalidDropped: number;
  gossipSent: number;
  gossipDeltas: number;
}

const DEFAULTS = {
  seenCapacity: 5000,
  seenTtlMs: 24 * 60 * 60 * 1000,
  outboxCapacity: 500,
  outboxTtlMs: 12 * 60 * 60 * 1000,
  defaultTtl: MAX_TTL,
};

/** Frame types that are link-local: consumed by the neighbour, never flooded. */
const LINK_LOCAL = new Set<FrameType>([FrameType.GossipDigest, FrameType.GossipRequest]);

export class MeshNode {
  private readonly seen: LruSet<string>;
  private readonly outbox = new Map<string, StoredFrame>();
  private readonly reassembler = new Reassembler();
  private readonly opts: Required<MeshOptions>;
  private readonly unsubscribes: Array<() => void> = [];
  private fragCounter = 0;
  private running = false;

  readonly stats: MeshStats = {
    delivered: 0,
    relayed: 0,
    duplicatesDropped: 0,
    invalidDropped: 0,
    gossipSent: 0,
    gossipDeltas: 0,
  };

  private messageHandlers: Array<(frame: Frame) => void> = [];

  constructor(
    private readonly transport: Transport,
    private readonly keys: KeyPair,
    options: MeshOptions = {},
  ) {
    this.opts = {
      ...DEFAULTS,
      now: () => Date.now(),
      ...options,
    } as Required<MeshOptions>;
    this.seen = new LruSet<string>(this.opts.seenCapacity, this.opts.seenTtlMs);
  }

  get publicKey(): Uint8Array {
    return this.keys.publicKey;
  }

  onMessage(handler: (frame: Frame) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribes.push(
      this.transport.onChunk((peer, chunk) => {
        void this.handleChunk(peer, chunk);
      }),
      this.transport.onPeerConnected((peer) => {
        void this.sendGossipDigest(peer);
      }),
      this.transport.onPeerDisconnected((peer) => {
        this.reassembler.forget(peer);
      }),
    );
  }

  stop(): void {
    this.running = false;
    for (const off of this.unsubscribes.splice(0)) off();
  }

  /**
   * Originate a message and flood it to every current neighbour.
   *
   * `signingKeys` defaults to this node's identity. Session-layer frames pass an
   * ephemeral keypair instead so the `sender` field does not tell every relay
   * who is talking to whom — see `EPHEMERALLY_SIGNED` in `types.ts`.
   */
  async publish(
    type: FrameType,
    payload: Uint8Array,
    signingKeys: KeyPair = this.keys,
  ): Promise<Frame> {
    const now = this.opts.now();
    const encoded = signFrame(
      {
        ttl: this.opts.defaultTtl,
        type,
        flags: 0,
        msgId: newMessageId(),
        timestamp: now,
        payload,
      },
      signingKeys,
    );

    const frame = decode(encoded);
    this.seen.add(msgIdToHex(frame.msgId), now);
    this.store({ frame, encoded, receivedAt: now, from: null });
    await this.broadcast(encoded, null);
    return frame;
  }

  /** Housekeeping: expire the seen set, outbox, and stalled reassemblies. */
  maintain(): void {
    const now = this.opts.now();
    this.seen.prune(now);
    this.reassembler.prune(now);
    for (const [id, entry] of this.outbox) {
      if (now - entry.receivedAt > this.opts.outboxTtlMs) this.outbox.delete(id);
    }
  }

  get outboxSize(): number {
    return this.outbox.size;
  }

  get seenSize(): number {
    return this.seen.size;
  }

  /** Message ids currently held. Used by tests and by gossip digest building. */
  heldMessageIds(): string[] {
    return [...this.outbox.keys()];
  }

  // ---------------------------------------------------------------- receive

  private async handleChunk(peer: PeerId, chunk: Uint8Array): Promise<void> {
    const complete = this.reassembler.accept(peer, chunk, this.opts.now());
    if (!complete) return;
    await this.handleFrame(peer, complete);
  }

  private async handleFrame(peer: PeerId, encoded: Uint8Array): Promise<void> {
    // ORDER MATTERS. Signature verification comes strictly before the dedup
    // set is touched.
    //
    // This is the exact shape of BitChat's cache-poisoning bug: if an
    // unauthenticated frame can insert its message id into the seen set, an
    // attacker mints a frame carrying the id of a message they want suppressed,
    // and the genuine frame is later dropped as a duplicate. Censorship with no
    // key material required. Verifying first makes the seen set reachable only
    // by frames that are already proven authentic.
    const frame = verifyFrame(encoded);
    if (!frame) {
      this.stats.invalidDropped++;
      return;
    }

    if (frame.version !== PROTOCOL_VERSION) {
      this.stats.invalidDropped++;
      return;
    }

    if (LINK_LOCAL.has(frame.type)) {
      await this.handleLinkLocal(peer, frame);
      return;
    }

    const now = this.opts.now();
    const id = msgIdToHex(frame.msgId);
    if (!this.seen.add(id, now)) {
      this.stats.duplicatesDropped++;
      return;
    }

    // Clamp before doing anything with TTL. An attacker who sets ttl=255 would
    // otherwise get a network-wide broadcast storm for one frame.
    const ttl = Math.min(frame.ttl, MAX_TTL);

    this.stats.delivered++;
    for (const handler of this.messageHandlers) handler(frame);
    this.store({ frame, encoded, receivedAt: now, from: peer });

    if (ttl > 1) {
      const relayBytes = encoded.slice();
      setTtl(relayBytes, ttl - 1);
      this.stats.relayed++;
      await this.broadcast(relayBytes, peer);
    }
  }

  // ----------------------------------------------------------------- gossip

  /**
   * On link establishment, tell the neighbour what we already hold so they can
   * send only the difference. Without this, every reconnect triggers a full
   * outbox reflood — the dominant airtime and battery cost in a BLE mesh.
   */
  private async sendGossipDigest(peer: PeerId): Promise<void> {
    const ids = [...this.outbox.keys()];
    const filter = BloomFilter.sized(Math.max(ids.length, 16));
    for (const id of ids) filter.add(id);

    const encoded = signFrame(
      {
        ttl: 1, // link-local; never relayed
        type: FrameType.GossipDigest,
        flags: 0,
        msgId: newMessageId(),
        timestamp: this.opts.now(),
        payload: filter.encode(),
      },
      this.keys,
    );

    this.stats.gossipSent++;
    await this.sendTo(peer, encoded);
  }

  private async handleLinkLocal(peer: PeerId, frame: Frame): Promise<void> {
    if (frame.type !== FrameType.GossipDigest) return;

    let filter: BloomFilter;
    try {
      filter = BloomFilter.decode(frame.payload);
    } catch {
      this.stats.invalidDropped++;
      return;
    }

    // Send everything the peer's digest says it is missing. A Bloom false
    // positive means we skip a frame the peer actually lacks; flooding is
    // redundant by design, so the next link or digest round covers it.
    for (const entry of this.outbox.values()) {
      const id = msgIdToHex(entry.frame.msgId);
      if (filter.mightHave(id)) continue;

      const ttl = Math.min(entry.frame.ttl, MAX_TTL);
      if (ttl <= 1) continue;
      const bytes = entry.encoded.slice();
      setTtl(bytes, ttl - 1);
      this.stats.gossipDeltas++;
      await this.sendTo(peer, bytes);
    }
  }

  // ------------------------------------------------------------------ send

  private async broadcast(encoded: Uint8Array, exclude: PeerId | null): Promise<void> {
    for (const peer of this.transport.peers()) {
      if (peer === exclude) continue;
      await this.sendTo(peer, encoded);
    }
  }

  private async sendTo(peer: PeerId, encoded: Uint8Array): Promise<void> {
    const fragId = this.fragCounter++ & 0xffff;
    let chunks: Uint8Array[];
    try {
      chunks = fragment(encoded, this.transport.mtu(peer), fragId);
    } catch {
      return; // frame too large for this link's MTU; nothing useful to do
    }
    for (const chunk of chunks) {
      try {
        await this.transport.send(peer, chunk);
      } catch {
        // Peer vanished mid-send. The outbox will retry when it reappears.
        return;
      }
    }
  }

  private store(entry: StoredFrame): void {
    const id = msgIdToHex(entry.frame.msgId);
    this.outbox.set(id, entry);
    while (this.outbox.size > this.opts.outboxCapacity) {
      const oldest = this.outbox.keys().next();
      if (oldest.done) break;
      this.outbox.delete(oldest.value);
    }
  }
}
