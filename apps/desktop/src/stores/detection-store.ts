import { create } from "zustand";

import type { MeetingDetectedPayload } from "@/lib/detection-bridge";
import { useRecordingStore } from "@/stores/recording-store";

/**
 * Phase 6: the single source of truth for "is a meeting-detection prompt
 * showing". The Rust monitor emits `meeting://detected` / `meeting://ended`;
 * `detection-bridge` forwards them here. The banner component renders off
 * `active`.
 *
 * Delivery is context-aware but split cleanly: the Rust side fires the OS
 * notification when the window is backgrounded, and this store always holds the
 * `active` prompt so the in-app banner is already mounted when the user focuses
 * the window (clicking the notification activates the app). That means exactly
 * one prompt regardless of focus.
 *
 * `onDetected` ignores events unless the recording surface is idle — belt and
 * suspenders, since the Rust FSM already gates on `recording_active`.
 */
export interface DetectionStoreState {
  /** The currently-detected meeting, or null when nothing is prompting. */
  active: MeetingDetectedPayload | null;

  /** Forwarded from `meeting://detected`. No-op unless recording phase is idle. */
  onDetected: (payload: MeetingDetectedPayload) => void;
  /** Forwarded from `meeting://ended`. Clears the prompt only on a matching id. */
  onEnded: (detectionId: number) => void;
  /** User dismissed (or accepted) the prompt — clear it. */
  dismiss: () => void;
}

export const useDetectionStore = create<DetectionStoreState>((set, get) => ({
  active: null,

  onDetected: (payload) => {
    // Only surface when the recorder is idle. The Rust side already suppresses
    // while recording; this guards the brief window between a manual Record
    // click and the flag flipping.
    if (useRecordingStore.getState().phase !== "idle") return;
    set({ active: payload });
  },

  onEnded: (detectionId) => {
    // A stale `ended` for a previous detection must not close a newer prompt.
    if (get().active?.detectionId !== detectionId) return;
    set({ active: null });
  },

  dismiss: () => set({ active: null }),
}));
