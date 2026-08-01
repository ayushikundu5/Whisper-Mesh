import {
  HandshakeInitiator,
  HandshakeResponder,
  MAX_SKIPPED_GENERATIONS,
  NoiseSession,
  REKEY_INTERVAL,
  REPLAY_WINDOW,
  ReplayWindow,
  generateStatic,
} from './noise';

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

/** Runs a full IK handshake and returns both sides' transport sessions. */
function handshake(prologue?: Uint8Array) {
  const alice = generateStatic();
  const bob = generateStatic();

  // Alice already holds Bob's static key — in the real app, from a QR scan.
  const initiator = new HandshakeInitiator(alice, bob.publicKey, prologue);
  const responder = new HandshakeResponder(bob, prologue);

  const messageA = initiator.writeMessageA(text('hello'));
  const { payload: payloadA, remoteStatic } = responder.readMessageA(messageA);
  const { message: messageB, session: bobSession } = responder.writeMessageB(text('hi back'));
  const { payload: payloadB, session: aliceSession } = initiator.readMessageB(messageB);

  return { alice, bob, aliceSession, bobSession, payloadA, payloadB, remoteStatic };
}

describe('IK handshake', () => {
  it('establishes matching sessions and carries handshake payloads', () => {
    const { payloadA, payloadB } = handshake();
    expect(read(payloadA)).toBe('hello');
    expect(read(payloadB)).toBe('hi back');
  });

  it('reveals the initiator static key only to the intended responder', () => {
    const { alice, remoteStatic } = handshake();
    expect(Array.from(remoteStatic)).toEqual(Array.from(alice.publicKey));
  });

  it('does not put the initiator static key on the wire in the clear', () => {
    const alice = generateStatic();
    const bob = generateStatic();
    const messageA = new HandshakeInitiator(alice, bob.publicKey).writeMessageA();

    // `s` is encrypted under `es`; only the ephemeral is visible.
    expect(indexOfBytes(messageA, alice.publicKey)).toBe(-1);
  });

  it('agrees on the same handshake hash, so it can be used as a channel binder', () => {
    const { aliceSession, bobSession } = handshake();
    expect(Array.from(aliceSession.handshakeHash)).toEqual(
      Array.from(bobSession.handshakeHash),
    );
  });

  it('derives different keys for different prologues', () => {
    const a = handshake(text('prologue-one'));
    const b = handshake(text('prologue-two'));
    expect(Array.from(a.aliceSession.handshakeHash)).not.toEqual(
      Array.from(b.aliceSession.handshakeHash),
    );
  });

  /**
   * The property IK exists for. XX would happily complete here and leave the
   * fingerprint check as the only defence; IK cannot even be started.
   */
  it('fails when the initiator has the wrong static key for the responder', () => {
    const alice = generateStatic();
    const bob = generateStatic();
    const impostor = generateStatic();

    const initiator = new HandshakeInitiator(alice, impostor.publicKey);
    const responder = new HandshakeResponder(bob);

    expect(() => responder.readMessageA(initiator.writeMessageA())).toThrow();
  });

  it('rejects a tampered message 1', () => {
    const alice = generateStatic();
    const bob = generateStatic();
    const initiator = new HandshakeInitiator(alice, bob.publicKey);
    const responder = new HandshakeResponder(bob);

    const messageA = initiator.writeMessageA();
    messageA[messageA.length - 1] = messageA[messageA.length - 1]! ^ 0xff;

    expect(() => responder.readMessageA(messageA)).toThrow();
  });

  it('rejects a message 2 forged by anyone but the responder', () => {
    const alice = generateStatic();
    const bob = generateStatic();
    const initiator = new HandshakeInitiator(alice, bob.publicKey);
    const responder = new HandshakeResponder(bob);

    responder.readMessageA(initiator.writeMessageA());
    const { message } = responder.writeMessageB();
    message[0] = message[0]! ^ 0xff; // swap the responder's ephemeral

    expect(() => initiator.readMessageB(message)).toThrow();
  });

  it('rejects degenerate public keys instead of negotiating with them', () => {
    const alice = generateStatic();
    const allZero = new Uint8Array(32);
    expect(() => new HandshakeInitiator(alice, allZero).writeMessageA()).toThrow();
  });

  it('rejects a truncated handshake message', () => {
    const alice = generateStatic();
    const bob = generateStatic();
    const responder = new HandshakeResponder(bob);
    const messageA = new HandshakeInitiator(alice, bob.publicKey).writeMessageA();

    expect(() => responder.readMessageA(messageA.subarray(0, 40))).toThrow();
  });
});

describe('transport sessions', () => {
  it('carries messages in both directions', () => {
    const { aliceSession, bobSession } = handshake();

    const toBob = aliceSession.encrypt(text('ping'));
    expect(read(bobSession.decrypt(toBob)!)).toBe('ping');

    const toAlice = bobSession.encrypt(text('pong'));
    expect(read(aliceSession.decrypt(toAlice)!)).toBe('pong');
  });

  it('does not leak the plaintext into the ciphertext', () => {
    const { aliceSession } = handshake();
    const secret = text('meet at the north gate');
    expect(indexOfBytes(aliceSession.encrypt(secret), secret)).toBe(-1);
  });

  it('produces a different ciphertext every time for the same plaintext', () => {
    const { aliceSession } = handshake();
    const first = aliceSession.encrypt(text('same'));
    const second = aliceSession.encrypt(text('same'));
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it('rejects a replayed message', () => {
    const { aliceSession, bobSession } = handshake();
    const message = aliceSession.encrypt(text('once'));

    expect(bobSession.decrypt(message)).not.toBeNull();
    expect(bobSession.decrypt(message)).toBeNull();
  });

  it('accepts messages that arrive out of order', () => {
    const { aliceSession, bobSession } = handshake();
    const messages = ['one', 'two', 'three', 'four'].map((s) => aliceSession.encrypt(text(s)));

    // The mesh floods over multiple paths; arrival order means nothing.
    expect(read(bobSession.decrypt(messages[3]!)!)).toBe('four');
    expect(read(bobSession.decrypt(messages[0]!)!)).toBe('one');
    expect(read(bobSession.decrypt(messages[2]!)!)).toBe('three');
    expect(read(bobSession.decrypt(messages[1]!)!)).toBe('two');
  });

  it('rejects a tampered ciphertext', () => {
    const { aliceSession, bobSession } = handshake();
    const message = aliceSession.encrypt(text('authentic'));
    message[message.length - 1] = message[message.length - 1]! ^ 0x01;
    expect(bobSession.decrypt(message)).toBeNull();
  });

  it('rejects a message re-pointed at a different counter', () => {
    const { aliceSession, bobSession } = handshake();
    const message = aliceSession.encrypt(text('authentic'));
    message[7] = 9; // rewrite the explicit counter; the nonce no longer matches
    expect(bobSession.decrypt(message)).toBeNull();
  });

  it('rejects a message from a different session', () => {
    const a = handshake();
    const b = handshake();
    expect(b.bobSession.decrypt(a.aliceSession.encrypt(text('crossed')))).toBeNull();
  });

  it('rejects a message shorter than a counter plus a tag', () => {
    const { bobSession } = handshake();
    expect(bobSession.decrypt(new Uint8Array(8))).toBeNull();
  });

  it('binds additional data', () => {
    const { aliceSession, bobSession } = handshake();
    const message = aliceSession.encrypt(text('bound'), text('context-a'));
    expect(bobSession.decrypt(message, text('context-b'))).toBeNull();
  });
});

describe('rekeying', () => {
  it('keeps working across a generation boundary', () => {
    const { aliceSession, bobSession } = handshake();
    for (let i = 0; i < REKEY_INTERVAL + 5; i++) {
      const message = aliceSession.encrypt(text(`m${i}`));
      expect(read(bobSession.decrypt(message)!)).toBe(`m${i}`);
    }
  });

  it('catches up when every message of a generation was lost', () => {
    const { aliceSession, bobSession } = handshake();
    let last: Uint8Array | null = null;
    for (let i = 0; i < REKEY_INTERVAL * 2 + 1; i++) last = aliceSession.encrypt(text(`m${i}`));

    // Bob never saw messages 0..511; he has to ratchet forward two generations.
    expect(read(bobSession.decrypt(last!)!)).toBe(`m${REKEY_INTERVAL * 2}`);
  });

  it('still accepts a straggler from the previous generation', () => {
    const { aliceSession, bobSession } = handshake();
    const early = aliceSession.encrypt(text('early'));
    let late: Uint8Array | null = null;
    for (let i = 1; i <= REKEY_INTERVAL; i++) late = aliceSession.encrypt(text(`m${i}`));

    expect(read(bobSession.decrypt(late!)!)).toBe(`m${REKEY_INTERVAL}`);
    // One generation of lag is retained precisely for this.
    expect(read(bobSession.decrypt(early)!)).toBe('early');
  });

  it('refuses to skip further ahead than the ratchet bound allows', () => {
    const { aliceSession, bobSession } = handshake();
    let far: Uint8Array | null = null;
    const count = REKEY_INTERVAL * (MAX_SKIPPED_GENERATIONS + 2);
    for (let i = 0; i < count; i++) far = aliceSession.encrypt(text('far'));
    expect(bobSession.decrypt(far!)).toBeNull();
  });

  /**
   * A forged frame must not be able to move the receiver's ratchet. If it
   * could, one spoofed packet with a huge counter would permanently break a
   * conversation — a denial of service costing the attacker nothing.
   */
  it('does not let a forged far-future counter destroy the session', () => {
    const { aliceSession, bobSession } = handshake();

    const forged = new Uint8Array(8 + 32);
    new DataView(forged.buffer).setBigUint64(0, BigInt(REKEY_INTERVAL * 4), false);
    expect(bobSession.decrypt(forged)).toBeNull();

    expect(read(bobSession.decrypt(aliceSession.encrypt(text('still fine')))!)).toBe('still fine');
  });
});

describe('ReplayWindow', () => {
  it('accepts each counter exactly once', () => {
    const window = new ReplayWindow();
    expect(window.accept(0)).toBe(true);
    expect(window.accept(0)).toBe(false);
    expect(window.accept(1)).toBe(true);
    expect(window.accept(1)).toBe(false);
  });

  it('accepts out-of-order counters inside the window', () => {
    const window = new ReplayWindow();
    expect(window.accept(100)).toBe(true);
    expect(window.accept(5)).toBe(true);
    expect(window.accept(50)).toBe(true);
    expect(window.accept(50)).toBe(false);
  });

  it('rejects counters that fell out of the window', () => {
    const window = new ReplayWindow();
    expect(window.accept(REPLAY_WINDOW * 2)).toBe(true);
    expect(window.accept(REPLAY_WINDOW * 2 - REPLAY_WINDOW)).toBe(false);
    expect(window.accept(REPLAY_WINDOW * 2 - 1)).toBe(true);
  });

  /**
   * Jumping forward must clear the bits the window slid over, or a stale bit
   * from a long-gone counter would reject a genuine message that happens to
   * land on the same slot.
   */
  it('clears slots it slides past rather than leaving stale bits', () => {
    const window = new ReplayWindow();
    expect(window.accept(3)).toBe(true);
    expect(window.accept(REPLAY_WINDOW + 3)).toBe(true);
    // Same slot as counter 3, one full window later, and never seen before.
    expect(window.accept(REPLAY_WINDOW + 2)).toBe(true);
  });

  it('rejects nonsense counters', () => {
    const window = new ReplayWindow();
    expect(window.accept(-1)).toBe(false);
    expect(window.accept(1.5)).toBe(false);
  });
});

/** Substring search over bytes, to assert a secret is genuinely absent. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Guards the assumption the wire format depends on. */
it('uses a 32-byte X25519 static key', () => {
  expect(generateStatic().publicKey.length).toBe(32);
});

/** Exercised indirectly everywhere, asserted once here. */
it('exposes the number of messages sent, for session rotation policy', () => {
  const { aliceSession } = handshake();
  const session: NoiseSession = aliceSession;
  expect(session.messagesSent).toBe(0);
  session.encrypt(text('x'));
  expect(session.messagesSent).toBe(1);
});
