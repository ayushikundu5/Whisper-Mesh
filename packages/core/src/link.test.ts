import { FRAG_HEADER_BYTES, FragmentationError, Reassembler, fragment } from './link';
import { LruSet } from './lru';
import { BloomFilter } from './bloom';

describe('fragmentation', () => {
  // BLE's floor: 23-byte ATT MTU, 20 usable. Everything must survive this.
  it('round-trips a frame at the 20-byte BLE minimum', () => {
    const payload = new Uint8Array(300).map((_, i) => i & 0xff);
    const frags = fragment(payload, 20, 1);
    expect(frags.length).toBe(Math.ceil(300 / (20 - FRAG_HEADER_BYTES)));
    expect(frags.every((f) => f.length <= 20)).toBe(true);

    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frags) out = r.accept('peer', f, 0) ?? out;
    expect(Buffer.from(out!)).toEqual(Buffer.from(payload));
  });

  it('produces a single fragment when the payload fits', () => {
    expect(fragment(new Uint8Array(4), 20, 1)).toHaveLength(1);
  });

  it('handles an empty payload', () => {
    const frags = fragment(new Uint8Array(0), 20, 1);
    expect(frags).toHaveLength(1);
    const r = new Reassembler();
    expect(r.accept('p', frags[0]!, 0)).toEqual(new Uint8Array(0));
  });

  it('reassembles out-of-order fragments', () => {
    const payload = new Uint8Array(200).map((_, i) => i & 0xff);
    const frags = fragment(payload, 24, 7).reverse();
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of frags) out = r.accept('peer', f, 0) ?? out;
    expect(Buffer.from(out!)).toEqual(Buffer.from(payload));
  });

  it('tolerates duplicate fragments', () => {
    const payload = new Uint8Array(100).map((_, i) => i & 0xff);
    const frags = fragment(payload, 24, 3);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const f of [...frags, ...frags]) out = r.accept('peer', f, 0) ?? out;
    expect(Buffer.from(out!)).toEqual(Buffer.from(payload));
  });

  it('keeps concurrent fragment sets from different peers separate', () => {
    const a = new Uint8Array(60).fill(0xaa);
    const b = new Uint8Array(60).fill(0xbb);
    const fa = fragment(a, 20, 1);
    const fb = fragment(b, 20, 1); // same fragId, different peer
    const r = new Reassembler();

    let outA: Uint8Array | null = null;
    let outB: Uint8Array | null = null;
    for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
      if (fa[i]) outA = r.accept('A', fa[i]!, 0) ?? outA;
      if (fb[i]) outB = r.accept('B', fb[i]!, 0) ?? outB;
    }
    expect(Buffer.from(outA!)).toEqual(Buffer.from(a));
    expect(Buffer.from(outB!)).toEqual(Buffer.from(b));
  });

  it('refuses payloads needing more than 255 fragments', () => {
    expect(() => fragment(new Uint8Array(10_000), 20, 1)).toThrow(FragmentationError);
  });

  it('expires stalled reassemblies', () => {
    const frags = fragment(new Uint8Array(100), 20, 1);
    const r = new Reassembler(1000);
    r.accept('peer', frags[0]!, 0);
    expect(r.pendingCount).toBe(1);
    expect(r.prune(5000)).toBe(1);
    expect(r.pendingCount).toBe(0);
  });

  // A neighbour that opens fragment sets and never finishes them must not be
  // able to pin unbounded memory.
  it('bounds concurrent reassemblies per peer', () => {
    const r = new Reassembler(60_000, 4);
    for (let i = 0; i < 50; i++) {
      const frags = fragment(new Uint8Array(100), 20, i);
      r.accept('hostile', frags[0]!, i);
    }
    expect(r.pendingCount).toBeLessThanOrEqual(4);
  });

  it('ignores a fragment claiming an index beyond its total', () => {
    const r = new Reassembler();
    expect(r.accept('p', new Uint8Array([0, 1, 9, 3, 0xff]), 0)).toBeNull();
  });
});

describe('LruSet', () => {
  it('reports first insertion and rejects repeats', () => {
    const s = new LruSet<string>(10);
    expect(s.add('a', 0)).toBe(true);
    expect(s.add('a', 0)).toBe(false);
  });

  it('stays within capacity under flood', () => {
    const s = new LruSet<string>(100);
    for (let i = 0; i < 10_000; i++) s.add(`id-${i}`, i);
    expect(s.size).toBe(100);
    expect(s.has('id-9999')).toBe(true);
    expect(s.has('id-0')).toBe(false);
  });

  it('prunes by age', () => {
    const s = new LruSet<string>(100, 1000);
    s.add('old', 0);
    s.add('new', 900);
    expect(s.prune(1500)).toBe(1);
    expect(s.has('old')).toBe(false);
    expect(s.has('new')).toBe(true);
  });
});

describe('BloomFilter', () => {
  it('never produces false negatives', () => {
    const f = BloomFilter.sized(500);
    const keys = Array.from({ length: 500 }, (_, i) => `msg-${i}`);
    for (const k of keys) f.add(k);
    for (const k of keys) expect(f.mightHave(k)).toBe(true);
  });

  it('keeps false positives near the target rate', () => {
    const f = BloomFilter.sized(1000, 0.02);
    for (let i = 0; i < 1000; i++) f.add(`in-${i}`);
    let fp = 0;
    for (let i = 0; i < 5000; i++) if (f.mightHave(`out-${i}`)) fp++;
    expect(fp / 5000).toBeLessThan(0.06);
  });

  it('survives an encode/decode round trip', () => {
    const f = BloomFilter.sized(100);
    for (let i = 0; i < 100; i++) f.add(`k${i}`);
    const g = BloomFilter.decode(f.encode());
    expect(g.numBits).toBe(f.numBits);
    expect(g.numHashes).toBe(f.numHashes);
    for (let i = 0; i < 100; i++) expect(g.mightHave(`k${i}`)).toBe(true);
  });

  it('rejects malformed digests rather than trusting them', () => {
    expect(() => BloomFilter.decode(new Uint8Array(3))).toThrow();
    expect(() => BloomFilter.decode(new Uint8Array([0, 0, 0, 64, 4, 1, 2]))).toThrow();
  });
});
