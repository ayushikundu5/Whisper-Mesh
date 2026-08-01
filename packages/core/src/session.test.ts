import { generateIdentity, KeyPair } from './crypto/identity';
import { buildPairingPayload, PairingPayload, parsePairingPayload } from './pairing';
import { DEFAULT_TAG_WINDOW, SESSION_TAG_BYTES, SessionError, SessionManager } from './session';
import { Contact, TrustStore } from './trust';

const NOW = 1_700_000_000_000;
const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

interface Peer {
  name: string;
  identity: KeyPair;
  payload: PairingPayload;
  trust: TrustStore;
  sessions: SessionManager;
}

function makePeer(name: string, options = {}): Peer {
  const identity = generateIdentity();
  const trust = new TrustStore();
  return {
    name,
    identity,
    payload: parsePairingPayload(buildPairingPayload(identity, name)),
    trust,
    sessions: new SessionManager(identity, trust, { now: () => NOW, ...options }),
  };
}

/** Models two people scanning each other's QR codes. */
function scanQrCodes(a: Peer, b: Peer): void {
  a.trust.pair(b.payload, NOW);
  b.trust.pair(a.payload, NOW);
}

const contactFor = (owner: Peer, other: Peer): Contact =>
  owner.trust.byIdentity(other.payload.identityKey)!;

/** Drives a full handshake and returns both sides' view of the contact. */
function connect(a: Peer, b: Peer): { atB: Contact; atA: Contact } {
  const init = a.sessions.beginHandshake(contactFor(a, b));
  const accepted = b.sessions.handleHandshakeInit(init);
  if (!accepted) throw new Error('handshake rejected');
  const contact = a.sessions.handleHandshakeResponse(accepted.reply);
  if (!contact) throw new Error('handshake response rejected');
  return { atB: accepted.contact, atA: contact };
}

describe('handshake over the mesh', () => {
  it('establishes a session between two paired peers', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);

    const { atA, atB } = connect(alice, bob);
    expect(atA.name).toBe('Bob');
    expect(atB.name).toBe('Alice');
    expect(alice.sessions.hasSession(contactFor(alice, bob))).toBe(true);
    expect(bob.sessions.hasSession(contactFor(bob, alice))).toBe(true);
  });

  /**
   * The central property. An unpaired peer holds a perfectly valid keypair and
   * can produce a perfectly valid Noise message; it still gets nowhere, because
   * it never learned the responder's static key and the responder never learned
   * its identity.
   */
  it('refuses a handshake from someone who was never paired', () => {
    const alice = makePeer('Alice');
    const stranger = makePeer('Stranger');
    // One-way: the stranger scraped Alice's key somehow, Alice never saw theirs.
    stranger.trust.pair(alice.payload, NOW);

    const init = stranger.sessions.beginHandshake(contactFor(stranger, alice));
    expect(alice.sessions.handleHandshakeInit(init)).toBeNull();
    expect(alice.sessions.stats.handshakesRejected).toBe(1);
  });

  it('cannot even begin a handshake with an unpaired contact', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    const orphan: Contact = {
      identityKey: bob.payload.identityKey,
      noiseKey: bob.payload.noiseKey,
      name: 'Bob',
      pairedAt: NOW,
      fingerprint: 'x',
    };
    expect(() => alice.sessions.beginHandshake(orphan)).toThrow(SessionError);
  });

  it('ignores a handshake addressed to somebody else', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    const carol = makePeer('Carol');
    scanQrCodes(alice, bob);
    scanQrCodes(alice, carol);

    const forBob = alice.sessions.beginHandshake(contactFor(alice, bob));
    expect(carol.sessions.isHandshakeForUs(forBob)).toBe(false);
    expect(carol.sessions.handleHandshakeInit(forBob)).toBeNull();
    // Not counted as a rejection: it was never ours to consider.
    expect(carol.sessions.stats.handshakesRejected).toBe(0);
  });

  it('drops a replayed handshake instead of paying for it again', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);

    const init = alice.sessions.beginHandshake(contactFor(alice, bob));
    expect(bob.sessions.handleHandshakeInit(init)).not.toBeNull();
    expect(bob.sessions.handleHandshakeInit(init)).toBeNull();
    expect(bob.sessions.stats.handshakeReplaysDropped).toBe(1);
  });

  it('ignores a handshake response it is not waiting for', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    const carol = makePeer('Carol');
    scanQrCodes(alice, bob);
    scanQrCodes(carol, bob);

    const init = alice.sessions.beginHandshake(contactFor(alice, bob));
    const accepted = bob.sessions.handleHandshakeInit(init)!;
    expect(carol.sessions.handleHandshakeResponse(accepted.reply)).toBeNull();
  });

  it('abandons a handshake that was never answered', () => {
    let clock = NOW;
    const alice = makePeer('Alice', { now: () => clock });
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);

    alice.sessions.beginHandshake(contactFor(alice, bob));
    expect(alice.sessions.pendingHandshakes).toBe(1);

    clock = NOW + 120_000;
    alice.sessions.maintain();
    expect(alice.sessions.pendingHandshakes).toBe(0);
  });

  it('keeps both sessions readable when each side initiates at once', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);

    connect(alice, bob);
    connect(bob, alice);

    // Whichever session either side picks for sending, the other can read it.
    const fromAlice = alice.sessions.seal(contactFor(alice, bob), text('from alice'))!;
    const fromBob = bob.sessions.seal(contactFor(bob, alice), text('from bob'))!;
    expect(read(bob.sessions.open(fromAlice)!.plaintext)).toBe('from alice');
    expect(read(alice.sessions.open(fromBob)!.plaintext)).toBe('from bob');
  });

  it('rejects a garbage payload without throwing', () => {
    const alice = makePeer('Alice');
    expect(alice.sessions.handleHandshakeInit(new Uint8Array(4))).toBeNull();
    expect(alice.sessions.handleHandshakeResponse(new Uint8Array(200))).toBeNull();
  });
});

describe('direct messages', () => {
  function connected() {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);
    connect(alice, bob);
    return { alice, bob, toBob: contactFor(alice, bob), toAlice: contactFor(bob, alice) };
  }

  it('carries a message end to end', () => {
    const { alice, bob, toBob } = connected();
    const sealed = alice.sessions.seal(toBob, text('meet at the north gate'))!;
    const opened = bob.sessions.open(sealed)!;
    expect(read(opened.plaintext)).toBe('meet at the north gate');
    expect(opened.contact.name).toBe('Alice');
  });

  it('cannot be sealed before a session exists', () => {
    const alice = makePeer('Alice');
    const bob = makePeer('Bob');
    scanQrCodes(alice, bob);
    expect(alice.sessions.seal(contactFor(alice, bob), text('too early'))).toBeNull();
  });

  /**
   * The relay case, and by far the most common one on a flood mesh. It has to
   * cost a single map lookup — if a non-recipient attempted decryption, every
   * phone would burn battery on every conversation it happens to be near.
   */
  it('costs a non-recipient one map lookup and zero crypto', () => {
    const { alice, toBob } = connected();
    const carol = makePeer('Carol');

    const sealed = alice.sessions.seal(toBob, text('private'))!;
    expect(carol.sessions.open(sealed)).toBeNull();
    expect(carol.sessions.stats.messagesUndecryptable).toBe(0);
  });

  it('gives relays a fresh tag for every message', () => {
    const { alice, toBob } = connected();
    const tags = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const sealed = alice.sessions.seal(toBob, text('same text every time'))!;
      tags.add(Buffer.from(sealed.subarray(0, SESSION_TAG_BYTES)).toString('hex'));
    }
    expect(tags.size).toBe(20);
  });

  it('rejects a tag lifted from one message onto another', () => {
    const { alice, bob, toBob } = connected();
    const first = alice.sessions.seal(toBob, text('one'))!;
    const second = alice.sessions.seal(toBob, text('two'))!;

    second.set(first.subarray(0, SESSION_TAG_BYTES), 0);
    expect(bob.sessions.open(second)).toBeNull();
    expect(bob.sessions.stats.messagesUndecryptable).toBe(1);
  });

  it('rejects a replayed direct message', () => {
    const { alice, bob, toBob } = connected();
    const sealed = alice.sessions.seal(toBob, text('once only'))!;
    expect(bob.sessions.open(sealed)).not.toBeNull();
    expect(bob.sessions.open(sealed)).toBeNull();
  });

  it('rejects a tampered ciphertext', () => {
    const { alice, bob, toBob } = connected();
    const sealed = alice.sessions.seal(toBob, text('authentic'))!;
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0xff;
    expect(bob.sessions.open(sealed)).toBeNull();
  });

  it('accepts messages that arrive out of order', () => {
    const { alice, bob, toBob } = connected();
    const sealed = ['a', 'b', 'c'].map((s) => alice.sessions.seal(toBob, text(s))!);
    expect(read(bob.sessions.open(sealed[2]!)!.plaintext)).toBe('c');
    expect(read(bob.sessions.open(sealed[0]!)!.plaintext)).toBe('a');
    expect(read(bob.sessions.open(sealed[1]!)!.plaintext)).toBe('b');
  });

  it('keeps working past the tag window, which has to slide', () => {
    const { alice, bob, toBob } = connected();
    const count = DEFAULT_TAG_WINDOW * 3;
    for (let i = 0; i < count; i++) {
      const sealed = alice.sessions.seal(toBob, text(`m${i}`))!;
      expect(read(bob.sessions.open(sealed)!.plaintext)).toBe(`m${i}`);
    }
    // Bounded: tags are unregistered behind the window as it advances.
    expect(bob.sessions.registeredTags).toBeLessThan(DEFAULT_TAG_WINDOW * 4);
  });

  it('still opens a straggler from behind the window', () => {
    const { alice, bob, toBob } = connected();
    const straggler = alice.sessions.seal(toBob, text('slow path'))!;
    for (let i = 0; i < DEFAULT_TAG_WINDOW / 2; i++) {
      bob.sessions.open(alice.sessions.seal(toBob, text(`m${i}`))!);
    }
    expect(read(bob.sessions.open(straggler)!.plaintext)).toBe('slow path');
  });

  it('handles an empty plaintext', () => {
    const { alice, bob, toBob } = connected();
    const sealed = alice.sessions.seal(toBob, new Uint8Array(0))!;
    expect(bob.sessions.open(sealed)!.plaintext).toHaveLength(0);
  });

  it('ignores a payload too short to hold a tag', () => {
    const { bob } = connected();
    expect(bob.sessions.open(new Uint8Array(3))).toBeNull();
  });
});
