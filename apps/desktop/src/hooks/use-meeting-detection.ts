import { useEffect } from "react";

import { subscribeMeetingDetected, subscribeMeetingEnded } from "@/lib/detection-bridge";
import { startDetection, stopDetection } from "@/lib/tauri-commands";
import { useDetectionStore } from "@/stores/detection-store";

/**
 * Phase 6 glue: forwards the Rust monitor's `meeting://detected` /
 * `meeting://ended` events into the detection store, and starts/stops the
 * native monitor as the `enabled` flag (authenticated AND auto-detect on)
 * changes.
 *
 * Mounted on the authenticated surface (AppShell), so logout unmounts it and
 * the cleanup tears the monitor down. `startDetection` rejects on platforms
 * without a detector (Linux) — swallowed.
 */
export function useMeetingDetection(enabled: boolean) {
  // Subscribe once. The monitor only emits while running, so a live listener
  // is inert when detection is off.
  useEffect(() => {
    let unlistenDetected: (() => void) | null = null;
    let unlistenEnded: (() => void) | null = null;
    void subscribeMeetingDetected((payload) => {
      useDetectionStore.getState().onDetected(payload);
    }).then((u) => {
      unlistenDetected = u;
    });
    void subscribeMeetingEnded((payload) => {
      useDetectionStore.getState().onEnded(payload.detectionId);
    }).then((u) => {
      unlistenEnded = u;
    });
    return () => {
      unlistenDetected?.();
      unlistenEnded?.();
    };
  }, []);

  // Start/stop the native monitor with the setting. The cleanup also stops it,
  // so an AppShell unmount (logout) leaves no orphaned poll thread.
  useEffect(() => {
    if (enabled) {
      void startDetection().catch(() => {});
    } else {
      void stopDetection().catch(() => {});
    }
    return () => {
      void stopDetection().catch(() => {});
    };
  }, [enabled]);
}
