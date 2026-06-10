import { useEffect } from "react";

import { checkForUpdate, downloadUpdate, hasStagedUpdate } from "@/lib/updater-bridge";
import { useUpdateStore } from "@/stores/update-store";

/**
 * US-24 / FR-4.06: check for updates on launch and once per day while
 * the app is running. When a newer signed build exists, download it in
 * the background immediately — the download never touches the audio
 * pipeline, so an active recording is unaffected — and mark it `ready`.
 * Installing is never automatic: only the banner's "Restart to update"
 * button applies the staged update.
 *
 * Mounted once in AppShell. Failures degrade to a console warning and
 * an `error` status; the next daily tick retries.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function useUpdateChecker(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const run = async () => {
      const store = useUpdateStore.getState();
      // An update is already staged (or mid-download) — installing is
      // the user's move now; re-checking would just churn state.
      if (store.status === "downloading" || (store.status === "ready" && hasStagedUpdate())) {
        return;
      }
      store.setChecking();
      try {
        const update = await checkForUpdate();
        if (cancelled) return;
        if (!update) {
          useUpdateStore.getState().setIdle();
          return;
        }
        useUpdateStore.getState().setDownloading(update.version);
        await downloadUpdate(update);
        if (cancelled) return;
        useUpdateStore.getState().setReady(update.version);
      } catch (err) {
        if (cancelled) return;
        console.warn("update check failed", err);
        useUpdateStore.getState().setError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    const id = window.setInterval(() => void run(), UPDATE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);
}
