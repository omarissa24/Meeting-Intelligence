import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MeetingAudioResponse } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * Fetch a pre-signed URL for an archived meeting's MP3. Gated on
 * `audioObjectKey` being non-null so we never call `/audio` while the
 * encode is in flight (the backend would 404). Including the key in
 * the query key means a delete-then-re-archive cleanly invalidates
 * without manual cache surgery.
 *
 * The backend mints URLs with a 1 h TTL by default
 * (`audio_presigned_url_ttl_seconds`); we mark the cached value stale
 * 5 min before expiry so the next play attempt grabs a fresh URL
 * instead of failing on a just-expired token.
 */
export function useMeetingAudio(
  meetingId: string,
  audioObjectKey: string | null,
): UseQueryResult<MeetingAudioResponse, Error> {
  return useQuery({
    queryKey: ["meeting-audio", meetingId, audioObjectKey],
    enabled: audioObjectKey !== null,
    queryFn: () => apiJson<MeetingAudioResponse>({ path: `/meetings/${meetingId}/audio` }),
    staleTime: 1000 * 60 * 55,
  });
}
