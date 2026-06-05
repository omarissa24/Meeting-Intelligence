import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/stores/ui-store";

afterEach(() => {
  cleanup();
  useUiStore.setState({ shortcutsOpen: false }, false);
});

describe("KeyboardShortcutsDialog", () => {
  it("is not rendered while shortcutsOpen is false", () => {
    useUiStore.setState({ shortcutsOpen: false }, false);
    render(<KeyboardShortcutsDialog />);
    expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
  });

  it("lists every registered shortcut when open", () => {
    useUiStore.setState({ shortcutsOpen: true }, false);
    render(<KeyboardShortcutsDialog />);
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    for (const def of SHORTCUTS) {
      expect(screen.getByText(def.label)).toBeInTheDocument();
    }
  });
});
