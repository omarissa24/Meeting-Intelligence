/**
 * Phase 4 / US-28 — the single source of truth for the app's keyboard
 * shortcuts. Both the keydown matcher (`use-keyboard-shortcuts.ts`) and
 * the discoverable help panel (`keyboard-shortcuts-dialog.tsx`) read this
 * registry, so the panel can never drift out of sync with what actually
 * fires.
 *
 * Every shortcut is a modifier-combo (⌘/Ctrl + key). That's deliberate:
 * a bare-key shortcut would collide with plain typing in the title and
 * search inputs, whereas a ⌘/Ctrl combo never inserts text — so the
 * handler can claim it (and `preventDefault` the webview default like
 * ⌘R reload / ⌘F find) without a "are we focused in an input?" dance.
 */

export type ShortcutId =
  | "start-recording"
  | "stop-recording"
  | "open-history"
  | "focus-search"
  | "show-shortcuts";

export type ShortcutGroup = "Recording" | "Navigation" | "Help";

export interface ShortcutDef {
  id: ShortcutId;
  /**
   * The non-modifier key, compared case-insensitively against
   * `KeyboardEvent.key`. `?` is special-cased in the matcher (it's
   * Shift+/ on most layouts) — see `matchShortcut`.
   */
  key: string;
  label: string;
  group: ShortcutGroup;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "start-recording", key: "r", label: "Start recording", group: "Recording" },
  { id: "stop-recording", key: ".", label: "Stop recording", group: "Recording" },
  { id: "open-history", key: "h", label: "Open history", group: "Navigation" },
  { id: "focus-search", key: "f", label: "Focus search", group: "Navigation" },
  { id: "show-shortcuts", key: "?", label: "Show keyboard shortcuts", group: "Help" },
] as const;

/** The ordered groups for the help panel; keeps render order stable. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "Recording",
  "Navigation",
  "Help",
] as const;

/** Minimal shape of the fields we read off a keydown event. */
export interface KeyChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * Resolve a keydown into a shortcut id, or null if it isn't one of ours.
 * `isMac` selects the primary modifier (⌘ on macOS, Ctrl elsewhere) so
 * the same registry drives both platforms.
 */
export function matchShortcut(e: KeyChord, isMac: boolean): ShortcutId | null {
  const primary = isMac ? e.metaKey : e.ctrlKey;
  if (!primary) return null;

  const key = e.key.toLowerCase();
  for (const def of SHORTCUTS) {
    if (def.key === "?") {
      // "?" arrives as key "?" on most layouts, but match Shift+/ too so
      // keyboards/layouts that report the physical key still trigger it.
      if (e.key === "?" || (key === "/" && e.shiftKey)) return def.id;
      continue;
    }
    if (key === def.key) return def.id;
  }
  return null;
}

/** Human-readable combo for the help panel, e.g. "⌘R" / "Ctrl+R". */
export function formatShortcut(def: ShortcutDef, isMac: boolean): string {
  const keyLabel = def.key === "?" ? "?" : def.key.toUpperCase();
  return isMac ? `⌘${keyLabel}` : `Ctrl+${keyLabel}`;
}
