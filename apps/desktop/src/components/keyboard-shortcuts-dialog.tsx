import { useMemo } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isMacPlatform } from "@/lib/platform";
import { formatShortcut, SHORTCUT_GROUPS, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/stores/ui-store";

/**
 * Phase 4 / US-28 — the discoverable Keyboard Shortcuts panel. Opened by
 * ⌘/Ctrl+? (handled in `use-keyboard-shortcuts.ts`) or from the Settings
 * sheet. Renders the same `SHORTCUTS` registry the matcher reads, so the
 * list is guaranteed to match what actually fires.
 *
 * Rendered once at the AppShell level; visibility is driven by
 * `ui-store.shortcutsOpen`.
 */
export function KeyboardShortcutsDialog() {
  const open = useUiStore((s) => s.shortcutsOpen);
  const setOpen = useUiStore((s) => s.setShortcutsOpen);

  // Platform is stable for the app's lifetime; compute once.
  const isMac = useMemo(() => isMacPlatform(), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-normal">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Work hands-on-keyboard. Shortcuts fire while the app window is focused.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {SHORTCUT_GROUPS.map((group) => {
            const items = SHORTCUTS.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {group}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {items.map((def) => (
                    <li
                      key={def.id}
                      className="flex items-center justify-between gap-4 text-sm text-foreground"
                    >
                      <span>{def.label}</span>
                      <Kbd>{formatShortcut(def, isMac)}</Kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
