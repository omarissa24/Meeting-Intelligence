import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import {
  applyThemeClass,
  cachePreference,
  readCachedPreference,
  resolveTheme,
  watchSystemTheme,
  type ResolvedTheme,
} from "@/lib/theme";
import { useSettingsStore, type ThemePreference } from "@/stores/settings-store";

interface ThemeContextValue {
  /** The user's stored choice. */
  preference: ThemePreference;
  /** The concrete theme in effect (system resolved against the OS). */
  resolved: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the active theme. Throws if used outside `<ThemeProvider>`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}

/**
 * Owns the `dark` class on `<html>` (US-27). Reads the persisted theme
 * preference from the settings store, resolves "system" against the OS,
 * and re-applies whenever the preference changes or — while on "system"
 * — the OS appearance flips.
 *
 * The class is applied only after the store has hydrated; before that
 * the synchronous boot cache (`main.tsx`) governs, so there's no flash
 * from a default to the user's real choice.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSettingsStore((s) => s.theme);
  const hydrated = useSettingsStore((s) => s.hydrated);
  // Seed from the boot cache so the Toaster etc. start on the right
  // theme even before the async store load completes.
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readCachedPreference()),
  );

  // Apply the durable preference once the store is authoritative.
  useEffect(() => {
    if (!hydrated) return;
    const next = resolveTheme(preference);
    setResolved(next);
    applyThemeClass(next);
    cachePreference(preference);
  }, [preference, hydrated]);

  // Follow live OS changes, but only while the preference is "system".
  // Reads the current preference at fire-time so the listener never
  // needs re-subscribing.
  useEffect(() => {
    return watchSystemTheme((osResolved) => {
      if (useSettingsStore.getState().theme !== "system") return;
      setResolved(osResolved);
      applyThemeClass(osResolved);
    });
  }, []);

  return <ThemeContext.Provider value={{ preference, resolved }}>{children}</ThemeContext.Provider>;
}
