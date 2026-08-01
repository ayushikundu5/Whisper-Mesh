import { MeshNode } from './mesh';
import { SimNetwork, SimTransport } from './testing/simnet';
import { generateIdentity, newMessageId, signFrame } from './crypto/identity';
import { fragment } from './link';
import { setTtl } from './frame';
import { Frame, FrameType, MAX_TTL } from './types';

interface Node {
  id: string;
  mesh: MeshNode;
  transport: SimTransport;
  received: Frame[];
}

function addNode(net: SimNetwork, id: string): Node {
  const transport = net.addNode(id);
  const mesh = new MeshNode(transport, generateIdentity());
  const received: Frame[] = [];
  mesh.onMessage((f) => received.push(f));
  mesh.start();
  return { id, mesh, transport, received };
}

const text = (s: string) => new TextEncoder().encode(s);
const readText = (f: Frame) => new TextDecoder().decode(f.payload);

/** Injects arbitrary bytes onto a link, bypassing any MeshNode. Models an attacker. */
async function injectRaw(net: SimNetwork, from: SimTransport, to: string, encoded: Uint8Array) {
  for (const chunk of fragment(encoded, net.mtu, 0xbeef & 0xffff)) {
    await from.send(to, chunk);
  }
}

describe('delivery', () => {
  it('delivers between two directly linked nodes', async () => {
    const net = new SimNetwork();
    const a = addNode(net, 'A');
    const b = addNode(net, 'B');
    net.link('A', 'B');
    await net.flush();

    await a.mesh.publish(FrameType.ChannelMessage, text('hello'));
    await net.flush();

    expect(b.received.map(readText)).toEqual(['hello']);
    // Senders do not loop their own message back to themselves.
    expect(a.received).toHaveLength(0);
  });

  it('relays multi-hop across a line A -> B -> C', async () => {
    const net = new SimNetwork();
    const a = addNode(net, 'A');
    const b = addNode(net, 'B');
    const c = addNode(net, 'C');
    net.link('A', 'B');
    net.link('B', 'C');
    await net.flush();

    await a.mesh.publish(FrameType.ChannelMessage, text('over the mesh'));
    await net.flush();

    expect(readText(c.received[0]!)).toBe('over the mesh');
    expect(b.mesh.stats.relayed).toBe(1);
  });

  it('stops delivering when the relay in the middle goes away', async () => {
    const net = new SimNetwork();
    const a = addNode(net, 'A');
    addNode(net, 'B');
    const c = addNode(net, 'C');
    net.link('A', 'B');
    net.link('B', 'C');
    await net.flush();

    net.isolate('B'); // B walks out of range
    await a.mesh.publish(FrameType.ChannelMessage, text('unreachable'));
    await net.flush();

    expect(c.received).toHaveLength(0);
  });

  it('floods a 20-node mesh to every participant', async () => {
    const net = new SimNetwork({ seed: 42 });
    const nodes = Array.from({ length: 20 }, (_, i) => addNode(net, `n${i}`));

    // Ring for guaranteed connectivity, plus chords to keep the diameter
    // inside the TTL budget — roughly what a crowded room looks like.
    for (let i = 0; i < 20; i++) net.link(`n${i}`, `n${(i + 1) % 20}`);
    for (let i = 0; i < 20; i += 2) net.link(`n${i}`, `n${(i + 5) % 20}`);
    await net.flush();

    await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('broadcast'));
    await net.flush();

    for (const n of nodes.slice(1)) {
      expect(n.received.map(readText)).toEqual(['broadcast']);
    }
  });

  it('delivers exactly once per node despite redundant flooding', async () => {
    const net = new SimNetwork({ seed: 7 });
    const nodes = Array.from({ length: 12 }, (_, i) => addNode(net, `n${i}`));
    // Fully connected: every node hears every copy, maximising duplicates.
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) net.link(`n${i}`, `n${j}`);
    await net.flush();

    await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('once'));
    await net.flush();

    for (const n of nodes.slice(1)) expect(n.received).toHaveLength(1);
    expect(nodes[1]!.mesh.stats.duplicatesDropped).toBeGreaterThan(0);
  });
});

describe('TTL', () => {
  it('bounds propagation to exactly MAX_TTL hops on a line', async () => {
    const net = new SimNetwork();
    const nodes = Array.from({ length: 12 }, (_, i) => addNode(net, `n${i}`));
    for (let i = 0; i < 11; i++) net.link(`n${i}`, `n${i + 1}`);
    await net.flush();

    await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('far'));
    await net.flush();

    // Originator sends at ttl=7; each hop decrements; a node receiving ttl=1
    // delivers but does not relay. So n1..n7 receive, n8+ do not.
    for (let i = 1; i <= MAX_TTL; i++) {
      expect(nodes[i]!.received).toHaveLength(1);
    }
    for (let i = MAX_TTL + 1; i < 12; i++) {
      expect(nodes[i]!.received).toHaveLength(0);
    }
  });

  it('clamps an inflated TTL so one frame cannot trigger a broadcast storm', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const witness = addNode(net, 'W');
    const attackerKeys = generateIdentity();
    const attacker = net.addNode('X');
    net.link('X', 'V');
    net.link('V', 'W');
    await net.flush();

    // TTL sits outside the signed region by design, so an attacker can set it
    // freely without breaking their own valid signature. Clamping is the
    // defence, not signing.
    const encoded = signFrame(
      {
        ttl: MAX_TTL,
        type: FrameType.ChannelMessage,
        flags: 0,
        msgId: newMessageId(),
        timestamp: Date.now(),
        payload: text('storm'),
      },
      attackerKeys,
    );
    setTtl(encoded, 255);

    await injectRaw(net, attacker, 'V', encoded);
    await net.flush();

    expect(victim.received).toHaveLength(1);
    expect(witness.received).toHaveLength(1);
    // Clamped to MAX_TTL on receipt, then decremented once for the relay.
    expect(witness.received[0]!.ttl).toBe(MAX_TTL - 1);
  });
});

describe('store and forward', () => {
  it('delivers to a node that was offline when the message was sent', async () => {
    const net = new SimNetwork();
    const a = addNode(net, 'A');
    const b = addNode(net, 'B');
    const c = addNode(net, 'C');

    net.link('A', 'B');
    await net.flush();

    // C is powered off entirely.
    await a.mesh.publish(FrameType.ChannelMessage, text('left behind'));
    await net.flush();
    expect(c.received).toHaveLength(0);
    expect(b.mesh.outboxSize).toBe(1);

    // C comes into range later; gossip sync hands over what it missed.
    net.link('B', 'C');
    await net.flush();

    expect(c.received.map(readText)).toEqual(['left behind']);
    expect(b.mesh.stats.gossipDeltas).toBeGreaterThan(0);
  });

  it('reconverges both halves after a partition heals', async () => {
    const net = new SimNetwork({ seed: 3 });
    const nodes = Array.from({ length: 6 }, (_, i) => addNode(net, `n${i}`));
    const left = ['n0', 'n1', 'n2'];
    const right = ['n3', 'n4', 'n5'];
    for (const g of [left, right]) {
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) net.link(g[i]!, g[j]!);
    }
    await net.flush();

    // Each side talks amongst itself while split.
    await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('from-left'));
    await nodes[3]!.mesh.publish(FrameType.ChannelMessage, text('from-right'));
    await net.flush();

    expect(nodes[4]!.received.map(readText)).toEqual(['from-right']);
    expect(nodes[1]!.received.map(readText)).toEqual(['from-left']);

    // A single bridging link heals the split.
    net.link('n2', 'n3');
    await net.flush();

    const all = (n: Node) => n.received.map(readText).sort();
    expect(all(nodes[1]!)).toEqual(['from-left', 'from-right']);
    expect(all(nodes[4]!)).toEqual(['from-left', 'from-right']);
  });

  it('sends only the delta when peers already share history', async () => {
    const net = new SimNetwork();
    const a = addNode(net, 'A');
    const b = addNode(net, 'B');
    net.link('A', 'B');
    await net.flush();

    for (let i = 0; i < 20; i++) {
      await a.mesh.publish(FrameType.ChannelMessage, text(`msg-${i}`));
    }
    await net.flush();
    expect(b.received).toHaveLength(20);

    // Drop and restore the link. Both sides hold the same 20 messages, so the
    // digest exchange should move (almost) nothing.
    const before = b.mesh.stats.gossipDeltas + a.mesh.stats.gossipDeltas;
    net.unlink('A', 'B');
    net.link('A', 'B');
    await net.flush();
    const moved = b.mesh.stats.gossipDeltas + a.mesh.stats.gossipDeltas - before;

    expect(moved).toBeLessThanOrEqual(2); // bloom false positives only
    expect(b.received).toHaveLength(20); // and no duplicate deliveries
  });
});

describe('lossy links', () => {
  /** Floods one message through a fully-connected mesh and counts recipients. */
  async function deliveriesUnderLoss(mtu: number, lossRate: number, seed: number) {
    const net = new SimNetwork({ seed, lossRate, mtu });
    const nodes = Array.from({ length: 10 }, (_, i) => addNode(net, `n${i}`));
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) net.link(`n${i}`, `n${j}`);
    await net.flush();

    await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('resilient'));
    await net.flush();

    return {
      delivered: nodes.slice(1).filter((n) => n.received.length > 0).length,
      dropped: net.chunksDropped,
    };
  }

  it('delivers to nearly everyone at 30% loss once MTU is negotiated up', async () => {
    // 247 is what Android typically settles on. A ~136-byte frame then fits in
    // a single write, so flooding redundancy across many paths does its job.
    const { delivered, dropped } = await deliveriesUnderLoss(247, 0.3, 11);
    expect(delivered).toBeGreaterThanOrEqual(8);
    expect(dropped).toBeGreaterThan(0);
  });

  /**
   * CHARACTERISATION, NOT AN ASPIRATION.
   *
   * There is no application-level ARQ: a frame arrives only if every one of its
   * fragments does, so delivery probability per link is (1-p)^fragments. At the
   * 20-byte BLE floor a signed frame is 9 fragments, which at 30% loss is
   * 0.7^9 ≈ 4% — and no amount of path redundancy repairs a first hop that has
   * to win nine independent coin flips.
   *
   * Real connection-oriented BLE retransmits at the link layer, so this rate is
   * pessimistic for GATT writes. It is NOT pessimistic for a connectionless
   * advertising-based transport. Two consequences for M1:
   *   1. MTU negotiation is a reliability feature, not a throughput tweak.
   *   2. If we ever carry frames over advertisements, L1 needs real ARQ first.
   */
  it('degrades sharply at minimum MTU, because fragment count compounds loss', async () => {
    const small = await deliveriesUnderLoss(20, 0.3, 11);
    const large = await deliveriesUnderLoss(247, 0.3, 11);
    expect(small.delivered).toBeLessThan(large.delivered);
  });

  it('tolerates light loss even at the 20-byte floor', async () => {
    const { delivered } = await deliveriesUnderLoss(20, 0.02, 5);
    expect(delivered).toBeGreaterThanOrEqual(5);
  });
});

describe('adversarial', () => {
  it('drops a frame whose signature does not match its sender', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const attacker = net.addNode('X');
    net.link('X', 'V');
    await net.flush();

    const impostor = generateIdentity();
    const encoded = signFrame(
      {
        ttl: MAX_TTL,
        type: FrameType.ChannelMessage,
        flags: 0,
        msgId: newMessageId(),
        timestamp: Date.now(),
        payload: text('trust me'),
      },
      impostor,
    );
    // Swap in someone else's identity — the BitChat impersonation attack.
    encoded.set(generateIdentity().publicKey, 20);

    await injectRaw(net, attacker, 'V', encoded);
    await net.flush();

    expect(victim.received).toHaveLength(0);
    expect(victim.mesh.stats.invalidDropped).toBe(1);
  });

  /**
   * Regression test for BitChat's cache-poisoning class of bug.
   *
   * If an unverified frame could enter the dedup set, an attacker would mint a
   * frame carrying the id of a message they want suppressed; the genuine frame
   * would then arrive and be discarded as a duplicate. Censorship with no keys
   * required. Verification must therefore happen strictly before dedup.
   */
  it('does not let an unauthenticated frame poison the dedup set', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const attacker = net.addNode('X');
    const legitimate = generateIdentity();
    net.link('X', 'V');
    await net.flush();

    const targetId = newMessageId();

    const forged = signFrame(
      {
        ttl: MAX_TTL,
        type: FrameType.ChannelMessage,
        flags: 0,
        msgId: targetId,
        timestamp: Date.now(),
        payload: text('poison'),
      },
      legitimate,
    );
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 0xff; // corrupt the signature

    await injectRaw(net, attacker, 'V', forged);
    await net.flush();
    expect(victim.received).toHaveLength(0);
    expect(victim.mesh.seenSize).toBe(0); // the id must NOT have been recorded

    // The real message, same id, must still get through.
    const genuine = signFrame(
      {
        ttl: MAX_TTL,
        type: FrameType.ChannelMessage,
        flags: 0,
        msgId: targetId,
        timestamp: Date.now(),
        payload: text('the real message'),
      },
      legitimate,
    );
    await injectRaw(net, attacker, 'V', genuine);
    await net.flush();

    expect(victim.received.map(readText)).toEqual(['the real message']);
  });

  it('drops replays rather than re-delivering them', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const attacker = net.addNode('X');
    const sender = generateIdentity();
    net.link('X', 'V');
    await net.flush();

    const encoded = signFrame(
      {
        ttl: MAX_TTL,
        type: FrameType.ChannelMessage,
        flags: 0,
        msgId: newMessageId(),
        timestamp: Date.now(),
        payload: text('replay me'),
      },
      sender,
    );

    for (let i = 0; i < 5; i++) {
      await injectRaw(net, attacker, 'V', encoded);
      await net.flush();
    }

    expect(victim.received).toHaveLength(1);
    expect(victim.mesh.stats.duplicatesDropped).toBe(4);
  });

  it('drops garbage without disturbing the receive loop', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const attacker = net.addNode('X');
    net.link('X', 'V');
    await net.flush();

    for (let i = 0; i < 20; i++) {
      await injectRaw(net, attacker, 'V', new Uint8Array(200).fill(i));
    }
    await net.flush();
    expect(victim.received).toHaveLength(0);

    // A well-formed frame after the garbage still works.
    const good = addNode(net, 'G');
    net.link('G', 'V');
    await net.flush();
    await good.mesh.publish(FrameType.ChannelMessage, text('still alive'));
    await net.flush();
    expect(victim.received.map(readText)).toEqual(['still alive']);
  });

  it('keeps the dedup set bounded under a flood of distinct ids', async () => {
    const net = new SimNetwork();
    const victim = addNode(net, 'V');
    const attacker = net.addNode('X');
    const keys = generateIdentity();
    net.link('X', 'V');
    await net.flush();

    const mesh = new MeshNode(victim.transport, keys, { seenCapacity: 50 });
    void mesh;

    for (let i = 0; i < 200; i++) {
      const encoded = signFrame(
        {
          ttl: 1,
          type: FrameType.ChannelMessage,
          flags: 0,
          msgId: newMessageId(),
          timestamp: Date.now(),
          payload: text(`flood-${i}`),
        },
        keys,
      );
      await injectRaw(net, attacker, 'V', encoded);
    }
    await net.flush();

    expect(victim.mesh.seenSize).toBeLessThanOrEqual(5000);
    expect(victim.received).toHaveLength(200);
  });
});

describe('convergence', () => {
  // SimNetwork.flush() throws if the queue will not drain, so any routing loop
  // or missing TTL decrement fails this outright rather than hanging.
  it('terminates on a topology dense with cycles', async () => {
    const net = new SimNetwork({ seed: 99 });
    const nodes = Array.from({ length: 15 }, (_, i) => addNode(net, `n${i}`));
    for (let i = 0; i < 15; i++) {
      net.link(`n${i}`, `n${(i + 1) % 15}`);
      net.link(`n${i}`, `n${(i + 3) % 15}`);
      net.link(`n${i}`, `n${(i + 7) % 15}`);
    }
    await net.flush();

    await expect(
      (async () => {
        await nodes[0]!.mesh.publish(FrameType.ChannelMessage, text('cycles'));
        await net.flush();
      })(),
    ).resolves.toBeUndefined();

    for (const n of nodes.slice(1)) expect(n.received).toHaveLength(1);
  });
});
