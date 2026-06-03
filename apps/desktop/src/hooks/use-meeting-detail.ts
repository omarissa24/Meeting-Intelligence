import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * Fetch a single meeting with its persisted (final) transcript
 * segments. `id` is gated by `enabled` so the hook is safe to mount
 * before the user has selected a meeting.
 */
export function useMeetingDetail(id: string | null): UseQueryResult<MeetingDetail, Error> {
  return useQuery({
    queryKey: ["meeting", id],
    enabled: id !== null,
    queryFn: () => apiJson<MeetingDetail>({ path: `/meetings/${id}` }),
  });
}
