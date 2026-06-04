import { useEffect } from "react";

import { AppShell } from "@/components/app-shell";
import { LoginView } from "@/components/login-view";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeAuthEvents, useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";

export default function App() {
  const status = useAuthStore((s) => s.status);
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);

  // Read the keyring on mount and subscribe to deep-link auth events.
  // Both must happen exactly once; effect cleanup tears down the
  // event subscription on hot-reload. The actual OAuth code exchange
  // happens in the Rust process (either via the deep-link plugin for
  // bundled builds or the loopback HTTP server for `tauri:dev`); both
  // paths emit `auth://session-changed` which `subscribeAuthEvents`
  // wires into the store.
  //
  // Settings hydrate is independent of auth — load the persisted
  // mic/system-audio/language defaults from disk so the Settings
  // sheet renders with the user's last choices and the recording
  // start path can read them via `getRecordingSnapshot()`.
  useEffect(() => {
    void hydrate();
    void hydrateSettings();
    let unlisten: (() => void) | null = null;
    void subscribeAuthEvents().then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [hydrate, hydrateSettings]);

  return (
    <TooltipProvider>
      {status === "authenticated" ? (
        <AppShell />
      ) : status === "unauthenticated" ? (
        <LoginView />
      ) : (
        // `loading` — keyring read in flight. A blank background is
        // sufficient on the perceptual budget we have (keyring reads
        // are ~ms on macOS); the LoginView mounts as soon as we know.
        <div className="h-screen bg-background" />
      )}
      <Toaster position="bottom-right" richColors />
    </TooltipProvider>
  );
}
