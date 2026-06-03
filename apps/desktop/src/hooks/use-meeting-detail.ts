import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

interface UseMeetingDetailOptions {
  /**
   * Refetch interval in milliseconds, or `false` to disable polling
   * (the default). The audio player drives this while the encode is
   * still in flight (`status === "completed" && audioObjectKey === null`)
   * so the detail row eventually re-renders with the archived key
   * without the user reopening the meeting. See US-11 / FR-2.06.
   */
  refetchIntervalMs?: number | false;
}

/**
 * Fetch a single meeting with its persisted (final) transcript
 * segments. `id` is gated by `enabled` so the hook is safe to mount
 * before the user has selected a meeting.
 */
export function useMeetingDetail(
  id: string | null,
  { refetchIntervalMs = false }: UseMeetingDetailOptions = {},
): UseQueryResult<MeetingDetail, Error> {
  return useQuery({
    queryKey: ["meeting", id],
    enabled: id !== null,
    queryFn: () => apiJson<MeetingDetail>({ path: `/meetings/${id}` }),
    refetchInterval: refetchIntervalMs,
  });
}
