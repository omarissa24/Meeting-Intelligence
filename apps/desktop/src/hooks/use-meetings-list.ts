import { useInfiniteQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import type {
  MeetingFilters,
  MeetingListResponse,
} from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";

/**
 * Paginated meetings list keyed off the cursor returned by the
 * backend. The first page omits `cursor`; subsequent pages pass the
 * previous page's `nextCursor`. The backend default `limit=25`
 * matches FR-4.14, so we don't override it.
 *
 * Phase 4: optional `filters` argument is serialised into query
 * params on every page request and folded into the React Query key,
 * so changing a filter naturally invalidates the cached infinite
 * list and refetches from page 1.
 *
 * `pageParam` flows through React Query's queue; `getNextPageParam`
 * derives the next param from the last page's `nextCursor` and stops
 * automatically when it's `null`.
 */
export function useMeetingsList(
  filters?: MeetingFilters,
): UseInfiniteQueryResult<
  { pages: MeetingListResponse[]; pageParams: (string | null)[] },
  Error
> {
  const normalised = normaliseFilters(filters);
  return useInfiniteQuery({
    // Folding the normalised filters into the key means React Query
    // serves a fresh paginated cache per filter combination — and the
    // old cache is dropped when the user changes a filter.
    queryKey: ["meetings", normalised],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      appendFilterParams(params, normalised);
      const qs = params.toString();
      const path = qs ? `/meetings?${qs}` : "/meetings";
      return apiJson<MeetingListResponse>({ path });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/** Drop empty/null fields so the query key is stable across UI re-renders. */
export function normaliseFilters(
  filters: MeetingFilters | undefined,
): MeetingFilters {
  if (!filters) return {};
  const out: MeetingFilters = {};
  if (filters.dateStart) out.dateStart = filters.dateStart;
  if (filters.dateEnd) out.dateEnd = filters.dateEnd;
  if (
    filters.durationMinSeconds != null &&
    Number.isFinite(filters.durationMinSeconds)
  ) {
    out.durationMinSeconds = filters.durationMinSeconds;
  }
  if (
    filters.durationMaxSeconds != null &&
    Number.isFinite(filters.durationMaxSeconds)
  ) {
    out.durationMaxSeconds = filters.durationMaxSeconds;
  }
  if (filters.tags && filters.tags.length > 0) {
    // Sorting + dedup makes the query key order-insensitive.
    out.tags = [...new Set(filters.tags)].sort();
  }
  return out;
}

export function appendFilterParams(
  params: URLSearchParams,
  filters: MeetingFilters,
): void {
  if (filters.dateStart) params.set("date_start", filters.dateStart);
  if (filters.dateEnd) params.set("date_end", filters.dateEnd);
  if (filters.durationMinSeconds != null) {
    params.set("duration_min_seconds", String(filters.durationMinSeconds));
  }
  if (filters.durationMaxSeconds != null) {
    params.set("duration_max_seconds", String(filters.durationMaxSeconds));
  }
  for (const tag of filters.tags ?? []) {
    params.append("tags", tag);
  }
}
