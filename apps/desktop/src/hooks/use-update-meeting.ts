import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Meeting, PatchMeetingRequest } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * PATCH /meetings/:id — partial update of title and/or tags. Backend
 * dedupes/strips/validates (max 200 char title, max 10 tags, max 32
 * char per tag); see `backend/src/meeting_intelligence/api/meetings.py`
 * `_validate_tags`. Body fields are optional — omitted fields stay
 * untouched server-side.
 *
 * On success we invalidate both `["meetings"]` (list cache) and
 * `["meeting", id]` (detail cache) so the next read pulls fresh data.
 * Plain invalidate-on-success keeps the contract simple — if PATCH
 * latency ever becomes user-visible, layer onMutate/setQueryData here
 * for an optimistic path.
 */
export function useUpdateMeeting(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchMeetingRequest) =>
      apiJson<Meeting>({
        path: `/meetings/${meetingId}`,
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
    },
  });
}
