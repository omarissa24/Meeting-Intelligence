import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MeetingDetail, PutSpeakerAliasesRequest } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * PUT /meetings/:id/speaker_aliases — replace-all map from raw STT
 * label to display name (US-26 / FR-4.10). The backend trims whitespace,
 * drops empty values, and rejects display names over 32 chars or maps
 * over 32 entries; the desktop validates the same way before sending so
 * the user gets inline feedback.
 *
 * Response is a full `MeetingDetail` — we drop it straight into the
 * detail cache so the segment chips re-render without a follow-up
 * GET. The list cache doesn't show speaker labels so we don't need to
 * invalidate it.
 */
export function useUpdateSpeakerAliases(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutSpeakerAliasesRequest) =>
      apiJson<MeetingDetail>({
        path: `/meetings/${meetingId}/speaker_aliases`,
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (next) => {
      qc.setQueryData<MeetingDetail>(["meeting", meetingId], next);
    },
  });
}
