import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * POST /meetings/:id/summarise — trigger (re-)summarisation.
 *
 * The backend synchronously sets `meetingSummaries.status='processing'`
 * before returning, then dispatches the Celery task. The response shape
 * matches GET /meetings/:id, so we feed it directly into the detail
 * cache to avoid a flicker between mutation success and the next
 * polled refetch picking up the `processing` status.
 *
 * On settle we still invalidate `["meeting", id]` so any divergence
 * between the optimistic snapshot and the eventual DB state heals on
 * the next refetch.
 */
export function useSummariseMeeting(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiJson<MeetingDetail>({
        path: `/meetings/${meetingId}/summarise`,
        method: "POST",
      }),
    onSuccess: (data) => {
      qc.setQueryData(["meeting", meetingId], data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
    },
  });
}
