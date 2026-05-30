import type { TranscriptLine } from "@meeting-intelligence/shared-types";
import { create } from "zustand";

/**
 * Kept separate from `recording-store` so high-frequency line appends don't
 * re-render the recording control or the elapsed timer. Components subscribe
 * with selectors to avoid pulling the whole array on each push.
 */
export interface TranscriptState {
  lines: TranscriptLine[];
  appendLine: (line: TranscriptLine) => void;
  clear: () => void;
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  lines: [],
  appendLine: (line) =>
    set((s) => {
      // Replace the in-flight interim line (same speaker, not yet final)
      // with this one so the panel grows smoothly toward each final.
      const last = s.lines[s.lines.length - 1];
      if (last && !last.isFinal && last.speakerId === line.speakerId) {
        return { lines: [...s.lines.slice(0, -1), line] };
      }
      return { lines: [...s.lines, line] };
    }),
  clear: () => set({ lines: [] }),
}));
