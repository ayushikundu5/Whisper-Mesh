import { decode, encode, msgIdToHex, setTtl, signedRegion, FrameDecodeError } from './frame';
import { generateIdentity, newMessageId, signFrame, verifyFrame } from './crypto/identity';
import { FrameType, PROTOCOL_VERSION } from './types';

const keys = generateIdentity();

function makeFrame(payload = new TextEncoder().encode('hello mesh'), ttl = 7) {
  return signFrame(
    { ttl, type: FrameType.ChannelMessage, flags: 0, msgId: newMessageId(), timestamp: 1_700_000_000_000, payload },
    keys,
  );
}

describe('frame codec', () => {
  it('round-trips every field', () => {
    const payload = new TextEncoder().encode('hello mesh');
    const encoded = makeFrame(payload);
    const frame = decode(encoded);

    expect(frame.version).toBe(PROTOCOL_VERSION);
    expect(frame.ttl).toBe(7);
    expect(frame.type).toBe(FrameType.ChannelMessage);
    expect(frame.timestamp).toBe(1_700_000_000_000);
    expect(Buffer.from(frame.payload)).toEqual(Buffer.from(payload));
    expect(Buffer.from(frame.sender)).toEqual(Buffer.from(keys.publicKey));
    expect(encode(frame)).toEqual(encoded);
  });

  it('handles an empty payload', () => {
    const frame = decode(makeFrame(new Uint8Array(0)));
    expect(frame.payload.length).toBe(0);
    expect(verifyFrame(makeFrame(new Uint8Array(0)))).not.toBeNull();
  });

  it('rejects a truncated frame', () => {
    const encoded = makeFrame();
    expect(() => decode(encoded.subarray(0, encoded.length - 1))).toThrow(FrameDecodeError);
  });

  it('rejects a frame whose declared length disagrees with its size', () => {
    const encoded = makeFrame();
    encoded[60] = 0xff; // payloadLen high byte
    expect(() => decode(encoded)).toThrow(FrameDecodeError);
  });
});

describe('signature coverage', () => {
  it('accepts an untampered frame', () => {
    expect(verifyFrame(makeFrame())).not.toBeNull();
  });

  it('rejects a tampered payload', () => {
    const encoded = makeFrame();
    const last = encoded.length - 65; // last payload byte
    encoded[last] = encoded[last]! ^ 0xff;
    expect(verifyFrame(encoded)).toBeNull();
  });

  // The BitChat impersonation bug: the sender field was outside the signed
  // region, so anyone could put someone else's identity on their own message.
  it('rejects a forged sender', () => {
    const encoded = makeFrame();
    const impostor = generateIdentity();
    encoded.set(impostor.publicKey, 20);
    expect(verifyFrame(encoded)).toBeNull();
  });

  it('rejects a tampered type or flags', () => {
    const typeTampered = makeFrame();
    typeTampered[2] = FrameType.DirectMessage;
    expect(verifyFrame(typeTampered)).toBeNull();

    const flagTampered = makeFrame();
    flagTampered[3] = 0x7f;
    expect(verifyFrame(flagTampered)).toBeNull();
  });

  it('rejects a tampered timestamp', () => {
    const encoded = makeFrame();
    encoded[52] = encoded[52]! ^ 0x01;
    expect(verifyFrame(encoded)).toBeNull();
  });

  it('rejects a tampered message id', () => {
    const encoded = makeFrame();
    encoded[4] = encoded[4]! ^ 0xff;
    expect(verifyFrame(encoded)).toBeNull();
  });

  // TTL is deliberately outside the signed region because relays must rewrite
  // it. This test pins that intent so nobody "fixes" it into the signature.
  it('survives TTL rewriting, which relays must be able to do', () => {
    const encoded = makeFrame(undefined, 7);
    setTtl(encoded, 3);
    const frame = verifyFrame(encoded);
    expect(frame).not.toBeNull();
    expect(frame!.ttl).toBe(3);
  });

  it('excludes only version and ttl from the signed region', () => {
    const encoded = makeFrame();
    const region = signedRegion(encoded);
    expect(region.length).toBe(encoded.length - 2 - 64);
  });
});

describe('msgIdToHex', () => {
  it('is stable and 32 chars for a 16-byte id', () => {
    const id = newMessageId();
    expect(msgIdToHex(id)).toHaveLength(32);
    expect(msgIdToHex(id)).toBe(msgIdToHex(id));
  });
});
