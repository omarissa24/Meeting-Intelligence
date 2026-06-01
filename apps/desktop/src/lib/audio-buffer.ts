/**
 * Bounded FIFO ring buffer for audio chunks held while the WS is
 * disconnected. On overflow we evict the oldest entry — the goal is
 * to preserve the *most recent* ~30 s of audio. Storage is a
 * fixed-capacity circular array so push/drain are O(1) per element
 * (Array.shift would be O(n) on the eviction path).
 *
 * The buffer is type-parametric and knows nothing about WS or
 * sessions; the reconnecting client owns the policy of what to do
 * with chunks once drained.
 */
export class AudioRingBuffer<T> {
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private _size = 0;
  private _droppedCount = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`AudioRingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    if (this._size === this.capacity) {
      // Evict oldest: advance head, overwrite that slot at tail.
      this.head = (this.head + 1) % this.capacity;
      this._droppedCount += 1;
    } else {
      this._size += 1;
    }
    this.slots[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
  }

  /**
   * Pop and apply `send` to each item in FIFO order, draining the
   * buffer. Returns the number of items drained. The send callback
   * is invoked synchronously per item — the caller is responsible
   * for any yielding-to-event-loop concerns.
   */
  drain(send: (item: T) => void): number {
    const drained = this._size;
    while (this._size > 0) {
      const item = this.slots[this.head]!;
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this._size -= 1;
      send(item);
    }
    return drained;
  }

  /**
   * Pop the oldest item, or `undefined` if empty. Used by callers
   * that want to drain in batches (e.g. yield to the event loop
   * every N items so a 30-chunk burst doesn't block the UI thread).
   */
  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const item = this.slots[this.head]!;
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._size -= 1;
    return item;
  }

  size(): number {
    return this._size;
  }

  droppedCount(): number {
    return this._droppedCount;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
    this._droppedCount = 0;
  }
}
