import { create } from "zustand";

/**
 * App auto-update state (US-24). `use-update-checker` is the sole
 * writer; the update banner reads. Deliberately Tauri-free — the
 * plugin handle stays in `lib/updater-bridge.ts` — so this store is
 * unit-testable without the IPC layer.
 *
 * `dismissed` is per-staged-version: dismissing hides the banner until
 * the next check finds a (possibly different) update, at which point
 * the flow resets it.
 */
export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** Version of the update being downloaded / staged, e.g. "1.2.0". */
  version: string | null;
  error: string | null;
  dismissed: boolean;

  setChecking: () => void;
  setIdle: () => void;
  setDownloading: (version: string) => void;
  setReady: (version: string) => void;
  setError: (message: string) => void;
  dismiss: () => void;
  reset: () => void;
}

const initial = {
  status: "idle" as UpdateStatus,
  version: null,
  error: null,
  dismissed: false,
};

export const useUpdateStore = create<UpdateState>((set) => ({
  ...initial,

  setChecking: () => set({ status: "checking", error: null }),
  setIdle: () => set({ status: "idle" }),
  setDownloading: (version) =>
    set({ status: "downloading", version, error: null, dismissed: false }),
  setReady: (version) => set({ status: "ready", version }),
  setError: (message) => set({ status: "error", error: message }),
  dismiss: () => set({ dismissed: true }),
  reset: () => set({ ...initial }),
}));
