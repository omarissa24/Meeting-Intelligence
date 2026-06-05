import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SearchInput, type SearchInputHandle } from "./search-input";

afterEach(() => cleanup());

describe("SearchInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces submission until the user stops typing for 300ms", () => {
    const onSubmit = vi.fn();
    render(<SearchInput value="" onSubmit={onSubmit} />);
    const input = screen.getByRole("searchbox", { name: "Search meetings" });

    fireEvent.change(input, { target: { value: "b" } });
    fireEvent.change(input, { target: { value: "bu" } });
    fireEvent.change(input, { target: { value: "budget" } });

    // Still mid-typing — no submission yet.
    expect(onSubmit).not.toHaveBeenCalled();

    // Just below the debounce threshold.
    act(() => {
      vi.advanceTimersByTime(290);
    });
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("budget");
  });

  it("submits immediately on Enter without waiting for the debounce", () => {
    const onSubmit = vi.fn();
    render(<SearchInput value="" onSubmit={onSubmit} />);
    const input = screen.getByRole("searchbox", { name: "Search meetings" });

    fireEvent.change(input, { target: { value: "budget" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("budget");
  });

  it("clears immediately when the input is emptied", () => {
    const onSubmit = vi.fn();
    render(<SearchInput value="budget" onSubmit={onSubmit} />);
    const input = screen.getByRole("searchbox", { name: "Search meetings" });

    fireEvent.change(input, { target: { value: "" } });
    // No timer needed — the empty-value branch fires synchronously.
    expect(onSubmit).toHaveBeenCalledWith("");
  });

  it("exposes an imperative focus() that reaches the DOM input (US-28 ⌘F)", () => {
    const ref = createRef<SearchInputHandle>();
    render(<SearchInput ref={ref} value="" onSubmit={() => undefined} />);
    const input = screen.getByRole("searchbox", { name: "Search meetings" });

    expect(document.activeElement).not.toBe(input);
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(input);
  });
});
