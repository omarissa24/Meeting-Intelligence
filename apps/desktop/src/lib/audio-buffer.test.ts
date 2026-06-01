import { describe, expect, it } from "vitest";

import { AudioRingBuffer } from "./audio-buffer";

describe("AudioRingBuffer", () => {
  it("rejects non-positive capacities", () => {
    expect(() => new AudioRingBuffer<number>(0)).toThrow();
    expect(() => new AudioRingBuffer<number>(-3)).toThrow();
    expect(() => new AudioRingBuffer<number>(1.5)).toThrow();
  });

  it("starts empty with no drops", () => {
    const buf = new AudioRingBuffer<number>(30);
    expect(buf.size()).toBe(0);
    expect(buf.droppedCount()).toBe(0);
  });

  it("preserves FIFO order up to capacity", () => {
    const buf = new AudioRingBuffer<number>(30);
    for (let i = 0; i < 30; i++) buf.push(i);
    expect(buf.size()).toBe(30);
    expect(buf.droppedCount()).toBe(0);

    const out: number[] = [];
    buf.drain((x) => out.push(x));
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(buf.size()).toBe(0);
  });

  it("evicts oldest on overflow and tracks dropped count", () => {
    const buf = new AudioRingBuffer<number>(30);
    for (let i = 0; i < 35; i++) buf.push(i);
    expect(buf.size()).toBe(30);
    expect(buf.droppedCount()).toBe(5);

    const out: number[] = [];
    buf.drain((x) => out.push(x));
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i + 5));
  });

  it("drain on empty is a no-op", () => {
    const buf = new AudioRingBuffer<number>(5);
    let calls = 0;
    const drained = buf.drain(() => {
      calls += 1;
    });
    expect(drained).toBe(0);
    expect(calls).toBe(0);
  });

  it("clear resets size, dropped count, and order", () => {
    const buf = new AudioRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.droppedCount()).toBe(1);

    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.droppedCount()).toBe(0);

    buf.push(99);
    const out: number[] = [];
    buf.drain((x) => out.push(x));
    expect(out).toEqual([99]);
  });

  it("supports interleaved push/drain across the wrap-around boundary", () => {
    const buf = new AudioRingBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    const first: string[] = [];
    buf.drain((x) => first.push(x));
    expect(first).toEqual(["a", "b"]);

    buf.push("c");
    buf.push("d");
    buf.push("e");
    buf.push("f"); // evicts "c"
    const second: string[] = [];
    buf.drain((x) => second.push(x));
    expect(second).toEqual(["d", "e", "f"]);
    expect(buf.droppedCount()).toBe(1);
  });
});
