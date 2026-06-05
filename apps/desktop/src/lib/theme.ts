import type { ThemePreference } from "@/stores/settings-store";

/**
 * Theme application + OS-preference helpers (US-27). Kept free of React
 * so the resolution logic is unit-testable and so the no-FOUC bootstrap
 * in `main.tsx` can call them synchronously before the first paint.
 *
 * The durable source of truth for the preference is the settings store
 * (`tauri-plugin-store`, survives updates). `localStorage` here is only
 * a synchronous **boot cache** so the very first render already has the
 * right `dark` class — the async store load would otherwise flash light
 * then flip.
 */

export type ResolvedTheme = "light" | "dark";

const THEME_CACHE_KEY = "mi-theme-preference";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Does the OS currently prefer dark? Safe when matchMedia is absent. */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

/** Resolve a preference to a concrete theme, consulting the OS for "system". */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return preference;
}

/** Toggle the `dark` class on `<html>` to match the resolved theme. */
export function applyThemeClass(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

/** Read the cached preference for the synchronous boot path. */
export function readCachedPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY);
    if (raw === "system" || raw === "light" || raw === "dark") return raw;
  } catch {
    // localStorage can throw in locked-down webviews — fall through.
  }
  return "system";
}

/** Mirror the preference into the boot cache. Best-effort. */
export function cachePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, preference);
  } catch {
    // Non-fatal: the store remains the durable source of truth.
  }
}

/**
 * Subscribe to OS appearance changes. The callback fires with the new
 * resolved theme whenever the system flips. Returns an unsubscribe fn.
 * No-op (returns a noop) when matchMedia is unavailable.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(DARK_QUERY);
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? "dark" : "light");
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
