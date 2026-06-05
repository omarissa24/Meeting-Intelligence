import { describe, expect, it } from "vitest";

import {
  formatShortcut,
  matchShortcut,
  SHORTCUTS,
  type KeyChord,
  type ShortcutId,
} from "./shortcuts";

function chord(over: Partial<KeyChord>): KeyChord {
  return { key: "", metaKey: false, ctrlKey: false, shiftKey: false, ...over };
}

function defFor(id: ShortcutId) {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) throw new Error(`no shortcut ${id}`);
  return def;
}

describe("matchShortcut", () => {
  it("matches the primary-modifier combos on macOS (⌘)", () => {
    expect(matchShortcut(chord({ key: "r", metaKey: true }), true)).toBe("start-recording");
    expect(matchShortcut(chord({ key: ".", metaKey: true }), true)).toBe("stop-recording");
    expect(matchShortcut(chord({ key: "h", metaKey: true }), true)).toBe("open-history");
    expect(matchShortcut(chord({ key: "f", metaKey: true }), true)).toBe("focus-search");
  });

  it("matches the primary-modifier combos on Windows/Linux (Ctrl)", () => {
    expect(matchShortcut(chord({ key: "r", ctrlKey: true }), false)).toBe("start-recording");
    expect(matchShortcut(chord({ key: "h", ctrlKey: true }), false)).toBe("open-history");
  });

  it("is case-insensitive on letter keys (Shift held still matches)", () => {
    expect(matchShortcut(chord({ key: "R", metaKey: true, shiftKey: true }), true)).toBe(
      "start-recording",
    );
  });

  it("matches the help panel on ⌘? and on ⌘Shift+/", () => {
    expect(matchShortcut(chord({ key: "?", metaKey: true, shiftKey: true }), true)).toBe(
      "show-shortcuts",
    );
    expect(matchShortcut(chord({ key: "/", metaKey: true, shiftKey: true }), true)).toBe(
      "show-shortcuts",
    );
  });

  it("ignores the wrong modifier for the platform", () => {
    // Ctrl+R on macOS is not a match (macOS wants ⌘).
    expect(matchShortcut(chord({ key: "r", ctrlKey: true }), true)).toBeNull();
    // ⌘R on Windows is not a match (Windows wants Ctrl).
    expect(matchShortcut(chord({ key: "r", metaKey: true }), false)).toBeNull();
  });

  it("does not match a bare key without the primary modifier", () => {
    expect(matchShortcut(chord({ key: "r" }), true)).toBeNull();
    expect(matchShortcut(chord({ key: "f" }), false)).toBeNull();
  });

  it("returns null for an unmapped combo", () => {
    expect(matchShortcut(chord({ key: "k", metaKey: true }), true)).toBeNull();
  });
});

describe("formatShortcut", () => {
  it("renders ⌘ combos on macOS", () => {
    expect(formatShortcut(defFor("start-recording"), true)).toBe("⌘R");
    expect(formatShortcut(defFor("stop-recording"), true)).toBe("⌘.");
    expect(formatShortcut(defFor("show-shortcuts"), true)).toBe("⌘?");
  });

  it("renders Ctrl combos elsewhere", () => {
    expect(formatShortcut(defFor("start-recording"), false)).toBe("Ctrl+R");
    expect(formatShortcut(defFor("open-history"), false)).toBe("Ctrl+H");
  });
});
