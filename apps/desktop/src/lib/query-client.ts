import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api-client";

/**
 * Single QueryClient for the desktop. Mounted once at the React root
 * by `main.tsx`. Defaults are conservative for a desktop-shell:
 *
 *   staleTime: 30 s — meeting metadata doesn't change second-to-second;
 *   the user typically navigates back to history minutes apart, so a
 *   30 s stale window cuts the chatter without making "I just renamed
 *   it" feel stale.
 *
 *   retry: 1 — `apiJson` already throws `ApiError` on non-2xx; giving
 *   it one auto-retry hides transient network blips without masking a
 *   real backend failure. 401s and 4xxs short-circuit (no retry) so a
 *   stale token doesn't burn three round-trips before the user sees
 *   the error.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});
