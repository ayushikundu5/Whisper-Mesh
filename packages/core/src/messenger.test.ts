import { generateIdentity, publicKeyToHex } from './crypto/identity';
import { MeshNode } from './mesh';
import { DirectMessageEvent, Messenger } from './messenger';
import { buildPairingPayload, parsePairingPayload } from './pairing';
import { SimNetwork } from './testing/simnet';
import { TrustStore } from './trust';
import { Contact } from './trust';
import { EPHEMERALLY_SIGNED, Frame, FrameType } from './types';

/**
 * M3 end to end: two paired phones hold an encrypted conversation across a mesh
 * of relays that have never met either of them.
 */

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

interface Phone {
  id: string;
  name: string;
  identity: ReturnType<typeof generateIdentity>;
  qr: ReturnType<typeof parsePairingPayload>;
  trust: TrustStore;
  mesh: MeshNode;
  messenger: Messenger;
  direct: DirectMessageEvent[];
  channel: Frame[];
  seenFrames: Frame[];
}

const NOW = 1_700_000_000_000;

function addPhone(net: SimNetwork, id: string, name: string): Phone {
  const identity = generateIdentity();
  const trust = new TrustStore();
  const mesh = new MeshNode(net.addNode(id), identity);
  const messenger = new Messenger(mesh, identity, trust);

  const phone: Phone = {
    id,
    name,
    identity,
    qr: parsePairingPayload(buildPairingPayload(identity, name)),
    trust,
    mesh,
    messenger,
    direct: [],
    channel: [],
    seenFrames: [],
  };

  messenger.onDirectMessage((e) => phone.direct.push(e));
  messenger.onChannelMessage((f) => phone.channel.push(f));
  mesh.onMessage((f) => phone.seenFrames.push(f));
  messenger.start();
  return phone;
}

/** Two people in the same room, scanning each other's codes. */
function scanQrCodes(a: Phone, b: Phone): void {
  a.trust.pair(b.qr, NOW);
  b.trust.pair(a.qr, NOW);
}

const contactFor = (owner: Phone, other: Phone): Contact =>
  owner.trust.byIdentity(other.qr.identityKey)!;

/**
 * Drain the network across several protocol round trips. A handshake plus a
 * queued message is three waves of frames, and each wave is only enqueued once
 * the previous one has been delivered and handled.
 */
async function settle(net: SimNetwork, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await net.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A -- r0 -- r1 -- ... -- B, with relays that know neither party. */
function lineOfRelays(relayCount: number) {
  const net = new SimNetwork({ mtu: 247, seed: 5 });
  const alice = addPhone(net, 'A', 'Alice');
  const bob = addPhone(net, 'B', 'Bob');
  const relays = Array.from({ length: relayCount }, (_, i) => addPhone(net, `r${i}`, `Relay${i}`));

  net.link('A', 'r0');
  for (let i = 0; i < relayCount - 1; i++) net.link(`r${i}`, `r${i + 1}`);
  net.link(`r${relayCount - 1}`, 'B');

  return { net, alice, bob, relays };
}

describe('encrypted conversation across a mesh', () => {
  it('delivers a direct message through relays that cannot read it', async () => {
    const { net, alice, bob, relays } = lineOfRelays(3);
    scanQrCodes(alice, bob);
    await settle(net);

    await alice.messenger.connect(contactFor(alice, bob));
    await settle(net);
    expect(alice.messenger.hasSession(contactFor(alice, bob))).toBe(true);

    await alice.messenger.sendDirect(contactFor(alice, bob), text('meet at the north gate'));
    await settle(net);

    expect(bob.direct.map((e) => read(e.plaintext))).toEqual(['meet at the north gate']);
    expect(bob.direct[0]!.contact.name).toBe('Alice');

    // Every relay carried the frame and none of them could open it.
    for (const relay of relays) {
      expect(relay.direct).toHaveLength(0);
      expect(relay.seenFrames.some((f) => f.type === FrameType.DirectMessage)).toBe(true);
    }
  });

  it('queues a message written before the session is up and sends it after', async () => {
    const { net, alice, bob } = lineOfRelays(2);
    scanQrCodes(alice, bob);
    await settle(net);

    // No handshake yet: sendDirect starts one and holds the plaintext.
    const sentImmediately = await alice.messenger.sendDirect(
      contactFor(alice, bob),
      text('sent before we were connected'),
    );
    expect(sentImmediately).toBe(false);
    await settle(net);

    expect(bob.direct.map((e) => read(e.plaintext))).toEqual(['sent before we were connected']);
  });

  it('carries a conversation in both directions', async () => {
    const { net, alice, bob } = lineOfRelays(2);
    scanQrCodes(alice, bob);
    await settle(net);

    await alice.messenger.sendDirect(contactFor(alice, bob), text('you there?'));
    await settle(net);
    await bob.messenger.sendDirect(contactFor(bob, alice), text('yeah, by the gate'));
    await settle(net);
    await alice.messenger.sendDirect(contactFor(alice, bob), text('on my way'));
    await settle(net);

    expect(bob.direct.map((e) => read(e.plaintext))).toEqual(['you there?', 'on my way']);
    expect(alice.direct.map((e) => read(e.plaintext))).toEqual(['yeah, by the gate']);
  });

  it('fires a session-established event on both sides', async () => {
    const { net, alice, bob } = lineOfRelays(1);
    scanQrCodes(alice, bob);

    const aliceUp: string[] = [];
    const bobUp: string[] = [];
    alice.messenger.onSessionEstablished((c) => aliceUp.push(c.name));
    bob.messenger.onSessionEstablished((c) => bobUp.push(c.name));

    await alice.messenger.connect(contactFor(alice, bob));
    await settle(net);

    expect(aliceUp).toEqual(['Bob']);
    expect(bobUp).toEqual(['Alice']);
  });

  it('reaches a contact who was out of range when the message was written', async () => {
    const net = new SimNetwork({ mtu: 247, seed: 9 });
    const alice = addPhone(net, 'A', 'Alice');
    const bob = addPhone(net, 'B', 'Bob');
    const carrier = addPhone(net, 'C', 'Carrier');
    scanQrCodes(alice, bob);

    net.link('A', 'C');
    await settle(net);

    // Bob is not in the mesh at all yet. The handshake and the message sit in
    // the carrier's outbox.
    await alice.messenger.sendDirect(contactFor(alice, bob), text('find me later'));
    await settle(net);
    expect(bob.direct).toHaveLength(0);

    net.link('C', 'B');
    await settle(net, 8);

    expect(bob.direct.map((e) => read(e.plaintext))).toEqual(['find me later']);
  });
});

describe('what the mesh reveals', () => {
  it('does not sign direct messages with the identity key', async () => {
    const { net, alice, bob, relays } = lineOfRelays(2);
    scanQrCodes(alice, bob);
    await settle(net);

    await alice.messenger.sendDirect(contactFor(alice, bob), text('who sent this?'));
    await settle(net);

    const identities = new Set([
      publicKeyToHex(alice.identity.publicKey),
      publicKeyToHex(bob.identity.publicKey),
    ]);
    // Driven off the constant rather than a hand-written list, so a new frame
    // type added to `EPHEMERALLY_SIGNED` is covered here automatically.
    const sessionFrames = relays[0]!.seenFrames.filter((f) => EPHEMERALLY_SIGNED.has(f.type));

    expect(sessionFrames.length).toBeGreaterThan(0);
    for (const frame of sessionFrames) {
      // A relay learns *a* key, but not one that identifies either participant.
      expect(identities.has(publicKeyToHex(frame.sender))).toBe(false);
    }
  });

  it('does sign channel messages with the identity key, which is the point', async () => {
    const { net, alice, bob } = lineOfRelays(1);
    await settle(net);

    await alice.messenger.sendChannel(text('anyone got water?'));
    await settle(net);

    expect(bob.channel.map((f) => read(f.payload))).toEqual(['anyone got water?']);
    expect(publicKeyToHex(bob.channel[0]!.sender)).toBe(publicKeyToHex(alice.identity.publicKey));
  });

  it('does not leak the plaintext of a direct message onto the wire', async () => {
    const { net, alice, bob, relays } = lineOfRelays(2);
    scanQrCodes(alice, bob);
    await settle(net);

    const secret = 'the code is 4417';
    await alice.messenger.sendDirect(contactFor(alice, bob), text(secret));
    await settle(net);

    for (const frame of relays[0]!.seenFrames) {
      expect(read(frame.payload)).not.toContain(secret);
    }
    expect(bob.direct.map((e) => read(e.plaintext))).toEqual([secret]);
  });
});

describe('unpaired peers', () => {
  it('will not open a session with a stranger who knows their key', async () => {
    const { net, alice, bob } = lineOfRelays(1);
    // One-sided: Bob scanned Alice at some point, Alice never scanned Bob.
    bob.trust.pair(alice.qr, NOW);
    await settle(net);

    await bob.messenger.connect(contactFor(bob, alice));
    await settle(net);

    expect(bob.messenger.hasSession(contactFor(bob, alice))).toBe(false);
    expect(alice.messenger.sessionManager.stats.handshakesRejected).toBe(1);
  });

  it('relays traffic for pairs it is not part of without learning anything', async () => {
    const { net, alice, bob, relays } = lineOfRelays(3);
    scanQrCodes(alice, bob);
    await settle(net);

    await alice.messenger.sendDirect(contactFor(alice, bob), text('private'));
    await settle(net);

    for (const relay of relays) {
      expect(relay.messenger.sessionManager.stats.messagesOpened).toBe(0);
      // Not even a failed decryption: the tag lookup misses and that is that.
      expect(relay.messenger.sessionManager.stats.messagesUndecryptable).toBe(0);
      expect(relay.mesh.stats.relayed).toBeGreaterThan(0);
    }
    expect(bob.direct).toHaveLength(1);
  });
});

describe('under adverse conditions', () => {
  it('gets a conversation through a 12-node mesh with 10% packet loss', async () => {
    const net = new SimNetwork({ mtu: 247, lossRate: 0.1, seed: 21 });
    const phones = Array.from({ length: 12 }, (_, i) => addPhone(net, `n${i}`, `P${i}`));
    for (let i = 0; i < 12; i++) net.link(`n${i}`, `n${(i + 1) % 12}`);
    for (let i = 0; i < 12; i += 2) net.link(`n${i}`, `n${(i + 4) % 12}`);

    const alice = phones[0]!;
    const bob = phones[6]!;
    scanQrCodes(alice, bob);
    await settle(net, 10);

    for (let i = 0; i < 5; i++) {
      await alice.messenger.sendDirect(contactFor(alice, bob), text(`message ${i}`));
      await settle(net, 6);
    }

    // Flooding gives many independent paths; some are expected to be lost.
    expect(bob.direct.length).toBeGreaterThanOrEqual(4);
    expect(new Set(bob.direct.map((e) => read(e.plaintext))).size).toBe(bob.direct.length);
  });

  it('does not deliver a direct message twice despite redundant flooding', async () => {
    const net = new SimNetwork({ mtu: 247, seed: 31 });
    const phones = Array.from({ length: 8 }, (_, i) => addPhone(net, `n${i}`, `P${i}`));
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) net.link(`n${i}`, `n${j}`);

    const alice = phones[0]!;
    const bob = phones[5]!;
    scanQrCodes(alice, bob);
    await settle(net);

    await alice.messenger.sendDirect(contactFor(alice, bob), text('exactly once'));
    await settle(net);

    expect(bob.direct).toHaveLength(1);
  });
});
