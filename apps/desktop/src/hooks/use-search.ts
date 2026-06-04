import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  MeetingFilters,
  SearchRequest,
  SearchResponse,
} from "@meeting-intelligence/shared-types";

import { apiJson } from "@/lib/api-client";
import { normaliseFilters } from "./use-meetings-list";

/**
 * Phase 4 / US-22 semantic search. Disabled when `query` is empty so
 * the History view's default mode is the meetings list. Filters fold
 * into the React Query key alongside the query so changing either
 * triggers a fresh fetch automatically.
 */
export function useSearch(
  query: string,
  filters?: MeetingFilters,
): UseQueryResult<SearchResponse, Error> {
  const trimmed = query.trim();
  const normalised = normaliseFilters(filters);
  return useQuery<SearchResponse, Error>({
    queryKey: ["search", trimmed, normalised],
    enabled: trimmed.length > 0,
    // Search results are stable for a few minutes — the underlying
    // embeddings only change when a new meeting completes summarising.
    staleTime: 60_000,
    queryFn: async () => {
      const body: SearchRequest = {
        query: trimmed,
        ...normalised,
      };
      return apiJson<SearchResponse>({
        path: "/search",
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  });
}
