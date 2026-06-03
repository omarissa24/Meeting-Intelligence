import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateMeetingRequest,
  Meeting,
} from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * Mutation that POSTs `/meetings` to provision a new row before the
 * desktop opens the transcript WebSocket. The backend mints the
 * `meetings.id` (UUID) and the desktop uses that as the WS session
 * id — see the WS handler contract in
 * `backend/src/meeting_intelligence/api/transcript.py:transcript_ws`.
 *
 * On success the meetings list cache is invalidated so the new
 * meeting shows up the moment the user opens the History view.
 */
export function useCreateMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMeetingRequest = {}) =>
      apiJson<Meeting>({
        path: "/meetings",
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
