import { useInfiniteQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import type { MeetingListResponse } from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * Paginated meetings list keyed off the cursor returned by the
 * backend. The first page omits `cursor`; subsequent pages pass the
 * previous page's `nextCursor`. The backend default `limit=25`
 * matches FR-4.14, so we don't override it.
 *
 * `pageParam` flows through React Query's queue; `getNextPageParam`
 * derives the next param from the last page's `nextCursor` and stops
 * automatically when it's `null`.
 */
export function useMeetingsList(): UseInfiniteQueryResult<
  { pages: MeetingListResponse[]; pageParams: (string | null)[] },
  Error
> {
  return useInfiniteQuery({
    queryKey: ["meetings"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const path = pageParam ? `/meetings?cursor=${encodeURIComponent(pageParam)}` : "/meetings";
      return apiJson<MeetingListResponse>({ path });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
