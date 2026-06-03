import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * DELETE /meetings/:id/audio — removes the MP3 archive without
 * touching the transcript. Backend is idempotent (204 even when the
 * key is already null), so a stale click while the user is offline
 * still resolves cleanly once we get back online.
 *
 * On success we invalidate both the detail and list caches so the
 * detail view re-reads `audioObjectKey: null` and the player
 * collapses back to its "no audio" state without us touching the
 * cache by hand.
 */
export function useDeleteMeetingAudio(meetingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const resp = await apiFetch({
        path: `/meetings/${meetingId}/audio`,
        method: "DELETE",
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new ApiError(resp.status, body);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meeting", meetingId] });
      void qc.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}
