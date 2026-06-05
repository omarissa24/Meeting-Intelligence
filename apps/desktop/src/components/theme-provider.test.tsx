import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { ThemeProvider } from "./theme-provider";
import { useSettingsStore, type ThemePreference } from "@/stores/settings-store";

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

function setPreference(theme: ThemePreference) {
  act(() => {
    useSettingsStore.setState({ theme, hydrated: true });
  });
}

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  mediaMatches = false;
  installMatchMedia();
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
  useSettingsStore.setState({ theme: "system", hydrated: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThemeProvider", () => {
  it("applies the dark class for an explicit dark preference", () => {
    setPreference("dark");
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(true);
  });

  it("removes the dark class for an explicit light preference", () => {
    mediaMatches = true; // OS dark, but the explicit choice wins
    setPreference("light");
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(false);
  });

  it("follows the OS when preference is 'system'", () => {
    mediaMatches = true;
    setPreference("system");
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(true);
  });

  it("flips live on an OS change while on 'system'", () => {
    mediaMatches = false;
    setPreference("system");
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(false);

    act(() => changeHandler?.({ matches: true }));
    expect(isDark()).toBe(true);
  });

  it("ignores OS changes when an explicit preference is set", () => {
    setPreference("dark");
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(true);

    act(() => changeHandler?.({ matches: false }));
    expect(isDark()).toBe(true); // still dark — OS is ignored
  });

  it("does not apply until the store has hydrated", () => {
    // hydrated stays false; the boot cache (not the provider) governs.
    act(() => {
      useSettingsStore.setState({ theme: "dark", hydrated: false });
    });
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>,
    );
    expect(isDark()).toBe(false);
  });
});
