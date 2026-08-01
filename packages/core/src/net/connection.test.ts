import { ConnectionManager } from './connection';

const NOW = 1_000_000;

/** Deterministic jitter, so backoff assertions are exact. */
const noJitter = () => 0.5;

function manager(localPeerId: string, options = {}) {
  return new ConnectionManager({ localPeerId, random: noJitter, ...options });
}

/** `aaa` sorts below `zzz`, so `aaa` is the central of that pair. */
const LOW = 'aaa';
const HIGH = 'zzz';

describe('role arbitration', () => {
  it('makes exactly one side of a pair the dialler', () => {
    const low = manager(LOW);
    const high = manager(HIGH);
    expect(low.isCentralFor(HIGH)).toBe(true);
    expect(high.isCentralFor(LOW)).toBe(false);
  });

  it('only the central dials when both sides can see each other', () => {
    const low = manager(LOW);
    const high = manager(HIGH);
    low.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    high.observe({ peerId: LOW, rssi: -50, seenAt: NOW });

    expect(low.plan(NOW)).toEqual([HIGH]);
    expect(high.plan(NOW)).toEqual([]);
  });

  /**
   * iOS in the background often cannot advertise usefully, so a peer that
   * "should" dial us sometimes never will. Waiting forever means the link never
   * forms; the timeout is what stops arbitration from becoming a deadlock.
   */
  it('dials anyway once the peer has clearly failed to dial us', () => {
    const high = manager(HIGH, { passiveTimeoutMs: 15_000 });
    high.observe({ peerId: LOW, rssi: -50, seenAt: NOW });

    expect(high.plan(NOW + 14_000)).toEqual([]);
    expect(high.plan(NOW + 15_000)).toEqual([LOW]);
  });

  it('restarts the passive wait after a disconnect', () => {
    const high = manager(HIGH, { passiveTimeoutMs: 15_000, baseBackoffMs: 1_000 });
    high.observe({ peerId: LOW, rssi: -50, seenAt: NOW });
    high.onConnected(LOW, NOW + 1_000);
    high.onDisconnected(LOW, NOW + 2_000);

    expect(high.shouldDial(LOW, NOW + 10_000)).toBe(false);
    expect(high.shouldDial(LOW, NOW + 17_001)).toBe(true);
  });
});

describe('connection budget', () => {
  it('never plans more dials than there are free slots', () => {
    const cm = manager(LOW, { maxConnections: 3 });
    for (let i = 0; i < 20; i++) {
      cm.observe({ peerId: `zz${i}`, rssi: -60, seenAt: NOW });
    }
    expect(cm.plan(NOW)).toHaveLength(3);
  });

  it('accounts for links already up', () => {
    const cm = manager(LOW, { maxConnections: 3 });
    for (let i = 0; i < 20; i++) cm.observe({ peerId: `zz${i}`, rssi: -60, seenAt: NOW });
    cm.onConnected('zz0', NOW);
    cm.onConnected('zz1', NOW);

    expect(cm.plan(NOW)).toHaveLength(1);
    expect(cm.connectionCount).toBe(2);
  });

  it('plans nothing when full', () => {
    const cm = manager(LOW, { maxConnections: 2 });
    cm.observe({ peerId: 'zz0', rssi: -60, seenAt: NOW });
    cm.observe({ peerId: 'zz1', rssi: -60, seenAt: NOW });
    cm.onConnected('zz0', NOW);
    cm.onConnected('zz1', NOW);
    expect(cm.plan(NOW)).toEqual([]);
  });

  it('prefers the strongest signal, because weak links lose whole frames', () => {
    const cm = manager(LOW, { maxConnections: 2 });
    cm.observe({ peerId: 'zz-far', rssi: -95, seenAt: NOW });
    cm.observe({ peerId: 'zz-near', rssi: -40, seenAt: NOW });
    cm.observe({ peerId: 'zz-mid', rssi: -70, seenAt: NOW });

    expect(cm.plan(NOW)).toEqual(['zz-near', 'zz-mid']);
  });

  it('breaks ties toward whoever we have gone longest without', () => {
    const cm = manager(LOW, { maxConnections: 1, baseBackoffMs: 0 });
    cm.observe({ peerId: 'zz-a', rssi: -60, seenAt: NOW });
    cm.observe({ peerId: 'zz-b', rssi: -60, seenAt: NOW });

    cm.onConnected('zz-a', NOW);
    cm.onDisconnected('zz-a', NOW + 1_000);
    expect(cm.plan(NOW + 2_000)).toEqual(['zz-b']);
  });
});

describe('backoff', () => {
  it('grows exponentially with consecutive failures', () => {
    const cm = manager(LOW, { baseBackoffMs: 1_000, maxBackoffMs: 60_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });

    cm.onConnectFailed(HIGH, NOW);
    expect(cm.backoffRemaining(HIGH, NOW)).toBe(2_000); // 1000 * 2^1

    cm.onConnectFailed(HIGH, NOW);
    expect(cm.backoffRemaining(HIGH, NOW)).toBe(4_000);

    cm.onConnectFailed(HIGH, NOW);
    expect(cm.backoffRemaining(HIGH, NOW)).toBe(8_000);
  });

  it('is capped, so a peer is never abandoned permanently', () => {
    const cm = manager(LOW, { baseBackoffMs: 1_000, maxBackoffMs: 10_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    for (let i = 0; i < 30; i++) cm.onConnectFailed(HIGH, NOW);
    expect(cm.backoffRemaining(HIGH, NOW)).toBe(10_000);
  });

  it('holds a peer out of the plan until its backoff expires', () => {
    const cm = manager(LOW, { baseBackoffMs: 1_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    cm.onConnectFailed(HIGH, NOW);

    expect(cm.plan(NOW + 1_000)).toEqual([]);
    expect(cm.plan(NOW + 2_000)).toEqual([HIGH]);
  });

  it('clears the backoff once a connection succeeds', () => {
    const cm = manager(LOW, { baseBackoffMs: 1_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    cm.onConnectFailed(HIGH, NOW);
    cm.onConnectFailed(HIGH, NOW);
    cm.onConnected(HIGH, NOW);
    cm.onDisconnected(HIGH, NOW + 1);

    // Back to one step, not still at four.
    expect(cm.backoffRemaining(HIGH, NOW + 1)).toBe(1_000);
  });

  /**
   * A link that comes up and instantly drops is the worst case: it looks like
   * success, so without a backoff it retries at full radio power forever.
   */
  it('backs off after a clean disconnect too, not only after a failure', () => {
    const cm = manager(LOW, { baseBackoffMs: 1_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    cm.onConnected(HIGH, NOW);
    cm.onDisconnected(HIGH, NOW + 100);

    expect(cm.backoffRemaining(HIGH, NOW + 100)).toBeGreaterThan(0);
  });

  it('spreads retries with jitter so a room does not retry in lockstep', () => {
    const delays = new Set<number>();
    let seed = 0;
    for (let i = 0; i < 20; i++) {
      const cm = new ConnectionManager({
        localPeerId: LOW,
        baseBackoffMs: 10_000,
        random: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648),
      });
      cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
      cm.onConnectFailed(HIGH, NOW);
      delays.add(cm.backoffRemaining(HIGH, NOW));
    }
    expect(delays.size).toBeGreaterThan(10);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(15_000); // 20s ±25%
      expect(delay).toBeLessThanOrEqual(25_000);
    }
  });
});

describe('peer lifecycle', () => {
  it('forgets a peer that has not been seen in a scan', () => {
    const cm = manager(LOW, { staleAfterMs: 30_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });

    expect(cm.plan(NOW + 29_000)).toEqual([HIGH]);
    expect(cm.plan(NOW + 31_000)).toEqual([]);
    expect(cm.knownPeers).toBe(0);
    expect(cm.stats.stalePeersDropped).toBe(1);
  });

  it('keeps a connected peer even if it stops appearing in scans', () => {
    const cm = manager(LOW, { staleAfterMs: 30_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    cm.onConnected(HIGH, NOW);

    cm.plan(NOW + 120_000);
    expect(cm.connectionCount).toBe(1);
  });

  it('refreshes staleness on each new scan result', () => {
    const cm = manager(LOW, { staleAfterMs: 30_000 });
    cm.observe({ peerId: HIGH, rssi: -50, seenAt: NOW });
    cm.observe({ peerId: HIGH, rssi: -55, seenAt: NOW + 20_000 });
    expect(cm.plan(NOW + 40_000)).toEqual([HIGH]);
  });

  it('ignores its own advertisement', () => {
    const cm = manager(LOW);
    cm.observe({ peerId: LOW, rssi: -30, seenAt: NOW });
    expect(cm.knownPeers).toBe(0);
  });

  it('adopts a peer that dialled us before we ever scanned it', () => {
    const cm = manager(LOW);
    cm.onConnected('zz-inbound', NOW);
    expect(cm.connectionCount).toBe(1);
    cm.onDisconnected('zz-inbound', NOW + 1);
    expect(cm.connectionCount).toBe(0);
  });

  it('survives events for peers it has forgotten', () => {
    const cm = manager(LOW);
    expect(() => {
      cm.onDisconnected('ghost', NOW);
      cm.onConnectFailed('ghost', NOW);
      cm.forget('ghost');
    }).not.toThrow();
  });
});

describe('a crowded room', () => {
  /**
   * The scenario the whole module exists for: thirty phones in range, seven
   * slots, and no coordinator. Every device has to reach a stable set of links
   * on its own without thrashing the radio.
   */
  it('settles on a full, stable set of links without churning', () => {
    const cm = manager('aaa', { maxConnections: 7 });
    for (let i = 0; i < 30; i++) {
      cm.observe({ peerId: `peer-${String(i).padStart(2, '0')}`, rssi: -40 - i, seenAt: NOW });
    }

    for (const peerId of cm.plan(NOW)) cm.onConnected(peerId, NOW);
    expect(cm.connectionCount).toBe(7);

    // Steady state: further planning rounds ask for nothing more.
    expect(cm.plan(NOW + 1_000)).toEqual([]);
    expect(cm.plan(NOW + 10_000)).toEqual([]);
    expect(cm.stats.dialsPlanned).toBe(7);
  });

  it('refills a slot when one link drops, after that peer has backed off', () => {
    const cm = manager('aaa', { maxConnections: 3, baseBackoffMs: 1_000 });
    for (let i = 0; i < 6; i++) {
      cm.observe({ peerId: `peer-${i}`, rssi: -40 - i, seenAt: NOW });
    }
    for (const peerId of cm.plan(NOW)) cm.onConnected(peerId, NOW);

    cm.onDisconnected('peer-0', NOW + 5_000);
    const refill = cm.plan(NOW + 5_100);

    expect(refill).toHaveLength(1);
    expect(refill[0]).not.toBe('peer-0'); // still backing off
  });
});
