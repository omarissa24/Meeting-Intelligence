import "@testing-library/jest-dom/vitest";

// jsdom ships no ResizeObserver. Radix primitives (e.g. ScrollArea with
// type="auto"/"scroll") register one during commit, which would otherwise
// throw `ResizeObserver is not defined` and tear down the whole render
// tree. A no-op mock is enough for component tests — we never assert on
// observed sizes.
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}
