/**
 * Compact Bloom filter for gossip digests.
 *
 * When two nodes establish a link they exchange a digest of the message ids
 * they already hold, then send only the difference. The alternative — blindly
 * reflooding the outbox on every connection — is what burns airtime and
 * battery in BLE meshes, where every byte is expensive.
 *
 * False positives mean "peer might already have this, skip it". A skipped
 * message is not lost: flooding is redundant by nature and the next link, or
 * the next digest round, will carry it. False negatives are impossible, so we
 * never wrongly believe a peer has something it doesn't.
 */
export class BloomFilter {
  readonly bits: Uint8Array;
  readonly numBits: number;
  readonly numHashes: number;

  constructor(numBits: number, numHashes: number, bits?: Uint8Array) {
    if (numBits % 8 !== 0) throw new Error('numBits must be a multiple of 8');
    this.numBits = numBits;
    this.numHashes = numHashes;
    this.bits = bits ?? new Uint8Array(numBits / 8);
    if (this.bits.length !== numBits / 8) throw new Error('bit array length mismatch');
  }

  /**
   * Size a filter for `n` expected items at a target false-positive rate.
   * m = -n·ln(p) / (ln2)²,  k = (m/n)·ln2
   */
  static sized(expectedItems: number, falsePositiveRate = 0.02): BloomFilter {
    const n = Math.max(1, expectedItems);
    const m = Math.ceil((-n * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
    const numBits = Math.max(64, Math.ceil(m / 8) * 8);
    const numHashes = Math.max(1, Math.round((numBits / n) * Math.LN2));
    return new BloomFilter(numBits, Math.min(numHashes, 16));
  }

  add(key: string): void {
    for (const idx of this.indices(key)) {
      this.bits[idx >>> 3]! |= 1 << (idx & 7);
    }
  }

  /** False positives possible; false negatives are not. */
  mightHave(key: string): boolean {
    for (const idx of this.indices(key)) {
      if ((this.bits[idx >>> 3]! & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  /** Serialised as: numBits (u32 BE) | numHashes (u8) | bits. */
  encode(): Uint8Array {
    const out = new Uint8Array(5 + this.bits.length);
    out[0] = (this.numBits >>> 24) & 0xff;
    out[1] = (this.numBits >>> 16) & 0xff;
    out[2] = (this.numBits >>> 8) & 0xff;
    out[3] = this.numBits & 0xff;
    out[4] = this.numHashes;
    out.set(this.bits, 5);
    return out;
  }

  static decode(bytes: Uint8Array): BloomFilter {
    if (bytes.length < 5) throw new Error('bloom digest too short');
    const numBits = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    const numHashes = bytes[4]!;
    if (numBits % 8 !== 0 || numBits === 0) throw new Error('invalid bloom bit count');
    if (bytes.length !== 5 + numBits / 8) throw new Error('bloom digest length mismatch');
    if (numHashes === 0 || numHashes > 16) throw new Error('invalid bloom hash count');
    return new BloomFilter(numBits, numHashes, bytes.slice(5));
  }

  /**
   * Kirsch-Mitzenmacher: derive k indices from two independent 32-bit hashes
   * rather than running k full hash functions.
   */
  private *indices(key: string): Generator<number> {
    const h1 = fnv1a32(key, 0x811c9dc5);
    const h2 = fnv1a32(key, 0x01000193) | 1; // odd, so it strides the whole range
    for (let i = 0; i < this.numHashes; i++) {
      yield ((h1 + Math.imul(i, h2)) >>> 0) % this.numBits;
    }
  }
}

function fnv1a32(str: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
