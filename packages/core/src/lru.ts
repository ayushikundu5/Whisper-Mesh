/**
 * Bounded insertion-ordered set, used as the mesh dedup ("seen") set.
 *
 * Boundedness is a security property, not an optimisation: an unbounded seen
 * set is a remote memory-exhaustion vector, since any peer can mint unlimited
 * message ids. Capacity is enforced on every insert, and the suite asserts it.
 *
 * JS `Map` preserves insertion order, which gives eviction of the oldest entry
 * for free without a linked list.
 */
export class LruSet<T> {
  private readonly entries = new Map<T, number>();

  constructor(
    public readonly capacity: number,
    /** Entries older than this are dropped on `prune`. Infinity disables TTL. */
    public readonly maxAgeMs: number = Infinity,
  ) {
    if (capacity <= 0) throw new Error('capacity must be positive');
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: T): boolean {
    return this.entries.has(key);
  }

  /** Returns true if the key was newly added, false if it was already present. */
  add(key: T, now: number): boolean {
    if (this.entries.has(key)) return false;
    this.entries.set(key, now);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return true;
  }

  /** Drop entries past `maxAgeMs`. Cheap because iteration is age-ordered. */
  prune(now: number): number {
    if (this.maxAgeMs === Infinity) return 0;
    let removed = 0;
    for (const [key, addedAt] of this.entries) {
      if (now - addedAt < this.maxAgeMs) break; // insertion-ordered: rest are newer
      this.entries.delete(key);
      removed++;
    }
    return removed;
  }

  keys(): IterableIterator<T> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }
}
