import type { TranscriptLine } from "@meeting-intelligence/shared-types";
import { create } from "zustand";

/**
 * Reserved speakerId for non-speech lines the app inserts itself —
 * reconnect notices, auto-stop sentinels, etc. The transcript panel
 * can detect and style these distinctly without bleeding into normal
 * diarization label space.
 */
export const SYSTEM_SPEAKER_ID = "__system__";

/**
 * Kept separate from `recording-store` so high-frequency line appends don't
 * re-render the recording control or the elapsed timer. Components subscribe
 * with selectors to avoid pulling the whole array on each push.
 */
export interface TranscriptState {
  lines: TranscriptLine[];
  appendLine: (line: TranscriptLine) => void;
  appendSystemNote: (args: {
    sessionId: string;
    text: string;
    nowMs?: number;
  }) => void;
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
  appendSystemNote: ({ sessionId, text, nowMs }) =>
    set((s) => {
      // System notes are always-final and never interim — never merge
      // with the prior line.
      const at = nowMs ?? Date.now();
      const note: TranscriptLine = {
        sessionId,
        speakerId: SYSTEM_SPEAKER_ID,
        text,
        startMs: at,
        endMs: at,
        isFinal: true,
      };
      return { lines: [...s.lines, note] };
    }),
  clear: () => set({ lines: [] }),
}));
