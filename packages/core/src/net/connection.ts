import { PeerId } from '../types';

/**
 * Which neighbours to actually connect to, and when.
 *
 * A BLE mesh phone is both a central (it scans and dials) and a peripheral (it
 * advertises and accepts). That symmetry is what makes an ad-hoc mesh possible
 * and it is also the source of every connection bug in one:
 *
 *  - **Both sides dial.** A sees B, B sees A, both connect. Android happily
 *    creates two GATT links between the same pair of phones, burning two of the
 *    seven connection slots each side has, for one logical link.
 *  - **Everyone dials everyone.** In a crowded room a phone can see thirty
 *    peers and has room for about seven. Without a policy it thrashes:
 *    connect, hit the limit, fail, retry, repeat, at full radio power.
 *  - **Ghost peers.** A phone that walked away is still in the scan cache. Left
 *    alone, a device will retry a peer that is not there hundreds of times an
 *    hour.
 *
 * This module is the policy for all three, kept out of the BLE code so it can
 * be tested without a radio. It decides; the transport obeys.
 */

export interface ConnectionOptions {
  /** Our own advertised id. Used for role arbitration, so it must be stable
   *  for as long as the advertisement is. */
  localPeerId: PeerId;
  /** Concurrent links. Android's practical ceiling as a central is about 7. */
  maxConnections?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** A peer not seen in a scan for this long is treated as gone. */
  staleAfterMs?: number;
  /**
   * How long to wait for a peer that should be dialling us before dialling it
   * ourselves. Role arbitration assumes both sides can act as peripheral; iOS
   * in the background often cannot, so passive waiting has to time out or those
   * links never form at all.
   */
  passiveTimeoutMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface Discovery {
  peerId: PeerId;
  /** dBm, negative. Closer to zero is nearer. */
  rssi: number;
  seenAt: number;
}

interface PeerRecord {
  peerId: PeerId;
  rssi: number;
  lastSeen: number;
  connected: boolean;
  failures: number;
  /** Earliest time we may dial again. Set by backoff. */
  nextAttemptAt: number;
  /** When we first saw it while waiting for it to dial us. */
  passiveSince: number | null;
  lastConnectedAt: number;
}

const DEFAULTS = {
  maxConnections: 7,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  staleAfterMs: 30_000,
  passiveTimeoutMs: 15_000,
};

export class ConnectionManager {
  private readonly peers = new Map<PeerId, PeerRecord>();
  private readonly opts: Required<ConnectionOptions>;

  readonly stats = {
    dialsPlanned: 0,
    connectFailures: 0,
    disconnects: 0,
    stalePeersDropped: 0,
  };

  constructor(options: ConnectionOptions) {
    this.opts = { random: Math.random, ...DEFAULTS, ...options } as Required<ConnectionOptions>;
  }

  get connectionCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.connected) count++;
    return count;
  }

  get knownPeers(): number {
    return this.peers.size;
  }

  /** Record a scan result. */
  observe({ peerId, rssi, seenAt }: Discovery): void {
    if (peerId === this.opts.localPeerId) return;
    const existing = this.peers.get(peerId);
    if (existing) {
      existing.rssi = rssi;
      existing.lastSeen = seenAt;
      if (existing.passiveSince === null && !existing.connected) existing.passiveSince = seenAt;
      return;
    }
    this.peers.set(peerId, {
      peerId,
      rssi,
      lastSeen: seenAt,
      connected: false,
      failures: 0,
      nextAttemptAt: 0,
      passiveSince: this.isCentralFor(peerId) ? null : seenAt,
      lastConnectedAt: 0,
    });
  }

  /**
   * Deterministic role arbitration: of any two peers, the one with the smaller
   * id dials. Both sides compute the same answer from data both already have,
   * with no negotiation round trip — which matters because the negotiation
   * would itself need a connection.
   */
  isCentralFor(peerId: PeerId): boolean {
    return this.opts.localPeerId < peerId;
  }

  /**
   * True if we should dial this peer now: either we are the central for it, or
   * we have waited long enough that it clearly is not going to dial us.
   */
  shouldDial(peerId: PeerId, now: number): boolean {
    if (this.isCentralFor(peerId)) return true;
    const peer = this.peers.get(peerId);
    if (!peer || peer.passiveSince === null) return false;
    return now - peer.passiveSince >= this.opts.passiveTimeoutMs;
  }

  /**
   * The peers to dial right now, best first and no more than the free slots.
   *
   * Ranked by signal strength: on BLE a strong link is not merely faster, it is
   * far less likely to drop mid-frame, and a dropped frame at the 20-byte MTU
   * costs the whole message (there is no application-level ARQ).
   */
  plan(now: number): PeerId[] {
    this.dropStale(now);

    const free = this.opts.maxConnections - this.connectionCount;
    if (free <= 0) return [];

    const candidates = [...this.peers.values()]
      .filter((peer) => !peer.connected)
      .filter((peer) => now >= peer.nextAttemptAt)
      .filter((peer) => this.shouldDial(peer.peerId, now))
      .sort((a, b) => {
        if (b.rssi !== a.rssi) return b.rssi - a.rssi; // strongest first
        // Then whoever we have gone longest without talking to, so one strong
        // neighbour cannot monopolise every slot forever.
        return a.lastConnectedAt - b.lastConnectedAt;
      })
      .slice(0, free);

    this.stats.dialsPlanned += candidates.length;
    return candidates.map((peer) => peer.peerId);
  }

  onConnected(peerId: PeerId, now: number): void {
    const peer = this.peers.get(peerId) ?? this.adopt(peerId, now);
    peer.connected = true;
    peer.failures = 0;
    peer.nextAttemptAt = 0;
    peer.passiveSince = null;
    peer.lastSeen = now;
    peer.lastConnectedAt = now;
  }

  /**
   * A clean disconnect still gets a backoff step. A peer that connects and
   * immediately drops — a phone at the edge of range, or one refusing us — is
   * the most expensive failure mode there is, because it looks like success and
   * would otherwise retry instantly, forever.
   */
  onDisconnected(peerId: PeerId, now: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.connected = false;
    peer.passiveSince = this.isCentralFor(peerId) ? null : now;
    this.stats.disconnects++;
    this.applyBackoff(peer, now);
  }

  onConnectFailed(peerId: PeerId, now: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.connected = false;
    peer.failures++;
    this.stats.connectFailures++;
    this.applyBackoff(peer, now);
  }

  /** Milliseconds until this peer may be dialled again. Zero if it may now. */
  backoffRemaining(peerId: PeerId, now: number): number {
    const peer = this.peers.get(peerId);
    if (!peer) return 0;
    return Math.max(0, peer.nextAttemptAt - now);
  }

  forget(peerId: PeerId): void {
    this.peers.delete(peerId);
  }

  /**
   * Exponential with jitter. The jitter is not cosmetic: without it, a room
   * full of phones that all lost the same peer retry in lockstep and collide on
   * the same advertising channels every time.
   */
  private applyBackoff(peer: PeerRecord, now: number): void {
    const exponent = Math.min(peer.failures, 10);
    const base = Math.min(this.opts.baseBackoffMs * 2 ** exponent, this.opts.maxBackoffMs);
    const jitter = 0.75 + this.opts.random() * 0.5; // ±25%
    peer.nextAttemptAt = now + Math.round(base * jitter);
  }

  private dropStale(now: number): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.connected) continue;
      if (now - peer.lastSeen > this.opts.staleAfterMs) {
        this.peers.delete(peerId);
        this.stats.stalePeersDropped++;
      }
    }
  }

  /** A peer that dialled us before we ever saw it in a scan. */
  private adopt(peerId: PeerId, now: number): PeerRecord {
    const peer: PeerRecord = {
      peerId,
      rssi: -127,
      lastSeen: now,
      connected: false,
      failures: 0,
      nextAttemptAt: 0,
      passiveSince: null,
      lastConnectedAt: 0,
    };
    this.peers.set(peerId, peer);
    return peer;
  }
}
