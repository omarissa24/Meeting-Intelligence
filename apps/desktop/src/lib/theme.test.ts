import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyThemeClass,
  cachePreference,
  readCachedPreference,
  resolveTheme,
  systemPrefersDark,
  watchSystemTheme,
} from "./theme";

/**
 * Controllable matchMedia mock. `setMatches(true)` simulates the OS
 * preferring dark; `fireChange(true)` simulates the OS flipping while
 * the app is open.
 */
let mediaMatches = false;
let changeHandler: ((e: { matches: boolean }) => void) | null = null;

function installMatchMedia() {
  changeHandler = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? mediaMatches : false,
      media: query,
      addEventListener: (_: string, h: (e: { matches: boolean }) => void) => {
        changeHandler = h;
      },
      removeEventListener: () => {
        changeHandler = null;
      },
    })),
  });
}

beforeEach(() => {
  mediaMatches = false;
  installMatchMedia();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveTheme", () => {
  it("returns the literal for explicit light/dark regardless of OS", () => {
    mediaMatches = true;
    expect(resolveTheme("light")).toBe("light");
    mediaMatches = false;
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("follows the OS for 'system'", () => {
    mediaMatches = true;
    expect(resolveTheme("system")).toBe("dark");
    mediaMatches = false;
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("systemPrefersDark", () => {
  it("reflects the OS query", () => {
    mediaMatches = true;
    expect(systemPrefersDark()).toBe(true);
    mediaMatches = false;
    expect(systemPrefersDark()).toBe(false);
  });
});

describe("applyThemeClass", () => {
  it("adds and removes the dark class on <html>", () => {
    applyThemeClass("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyThemeClass("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("preference cache", () => {
  it("round-trips through localStorage", () => {
    cachePreference("dark");
    expect(readCachedPreference()).toBe("dark");
  });

  it("falls back to 'system' for empty or bogus cache values", () => {
    expect(readCachedPreference()).toBe("system");
    window.localStorage.setItem("mi-theme-preference", "neon");
    expect(readCachedPreference()).toBe("system");
  });
});

describe("watchSystemTheme", () => {
  it("invokes the callback with the new resolved theme on OS change", () => {
    const onChange = vi.fn();
    const unwatch = watchSystemTheme(onChange);

    changeHandler?.({ matches: true });
    expect(onChange).toHaveBeenLastCalledWith("dark");
    changeHandler?.({ matches: false });
    expect(onChange).toHaveBeenLastCalledWith("light");

    unwatch();
    expect(changeHandler).toBeNull();
  });
});
