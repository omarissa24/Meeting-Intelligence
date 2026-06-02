import { authGetAccessToken } from "./tauri-commands";
import { BACKEND_HTTP_URL } from "./config";

/**
 * Phase-2 HTTP client. Pulls a fresh bearer from the OS credential
 * store on every call (refresh-on-near-expiry happens inside the Rust
 * `auth_get_access_token` command), injects `Authorization: Bearer
 * <token>`, and lets callers handle the response.
 *
 * Two design notes:
 *
 * 1. We always add the bearer if one is available, even if the caller
 *    passed their own `Authorization` header — this slice has a single
 *    auth surface, so an explicit caller-provided header is almost
 *    certainly a mistake. If we ever need an unauthenticated call
 *    (e.g. `/health`), use plain `fetch` directly.
 *
 * 2. 401s here are NOT auto-translated into a logout. The auth-store's
 *    `auth://session-changed` listener and the explicit logout flow
 *    are the only paths that flip the UI back to `<LoginView/>`. A
 *    transient 401 on a stale token shouldn't blow the user out — the
 *    refresh-on-near-expiry inside `authGetAccessToken` already covers
 *    the common case. Callers that want to force logout on 401 should
 *    do it explicitly (`logout()` from the store).
 */

export interface ApiFetchOptions extends RequestInit {
  /** Path relative to `BACKEND_HTTP_URL`, e.g. `/meetings`. */
  path: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`api ${status}: ${body || "(no body)"}`);
  }
}

/**
 * Fire a request to `BACKEND_HTTP_URL` with a bearer attached if the
 * user is signed in. The path argument is mandatory and gets joined
 * to the configured base URL — pass leading `/`.
 */
export async function apiFetch({ path, headers, ...init }: ApiFetchOptions): Promise<Response> {
  const url = `${BACKEND_HTTP_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const token = await authGetAccessToken();
  const merged = new Headers(headers);
  if (token) merged.set("Authorization", `Bearer ${token}`);
  // Explicit JSON content-type if the caller passed a JSON-shaped
  // body and didn't already set it. Saves boilerplate in callers.
  if (init.body && !merged.has("Content-Type")) {
    if (typeof init.body === "string") {
      merged.set("Content-Type", "application/json");
    }
  }
  return fetch(url, { ...init, headers: merged });
}

/**
 * Convenience helper for the JSON-in / JSON-out case. Throws ApiError
 * on non-2xx responses; returns the parsed body otherwise. Use this
 * for the typical authed endpoint that returns JSON; reach for
 * `apiFetch` directly when you need to inspect headers, stream, etc.
 */
export async function apiJson<T>(opts: ApiFetchOptions): Promise<T> {
  const resp = await apiFetch(opts);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ApiError(resp.status, body);
  }
  return (await resp.json()) as T;
}
