import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  authGetSession,
  authLogout,
  authStartLogin,
  type AuthSession,
  type AuthUserJson,
} from "@/lib/tauri-commands";

/**
 * Phase-2 auth gate.
 *
 *   loading          - app just booted; we haven't read the keyring yet
 *   unauthenticated  - no cached session; show <LoginView/>
 *   authenticated    - keyring has a session; show <AppShell/>
 *
 * The Rust deep-link handler emits `auth://session-changed` after a
 * successful WorkOS callback exchange — this store subscribes and
 * flips to `authenticated` without polling.
 *
 * `auth://error` carries any failure surfaced from the deep-link
 * handler (state mismatch, backend down, malformed callback URL).
 * Listeners here surface it via Sonner so the user can re-attempt.
 */

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthStoreState {
  status: AuthStatus;
  user: AuthUserJson | null;
  /** Last error surfaced from the auth flow, for the LoginView toast. */
  errorMessage: string | null;
  /** True between `startLogin()` being called and the deep link landing. */
  pending: boolean;

  hydrate: () => Promise<void>;
  startLogin: () => Promise<void>;
  logout: () => Promise<void>;
  // Internal: called by listeners
  _setSession: (session: AuthSession | null) => void;
  _setError: (message: string) => void;
}

export const useAuthStore = create<AuthStoreState>()((set, get) => ({
  status: "loading",
  user: null,
  errorMessage: null,
  pending: false,

  hydrate: async () => {
    try {
      const session = await authGetSession();
      if (session) {
        set({ status: "authenticated", user: session.user, errorMessage: null });
      } else {
        set({ status: "unauthenticated", user: null });
      }
    } catch (err) {
      // Keyring read failures shouldn't trap us in `loading`. Treat as
      // signed-out so the user gets the LoginView and can retry.
      console.error("auth-store: hydrate failed", err);
      set({
        status: "unauthenticated",
        user: null,
        errorMessage:
          err instanceof Error ? err.message : "could not read saved session",
      });
    }
  },

  startLogin: async () => {
    if (get().pending) return;
    set({ pending: true, errorMessage: null });
    try {
      await authStartLogin();
    } catch (err) {
      set({
        pending: false,
        errorMessage:
          err instanceof Error ? err.message : "could not open the sign-in window",
      });
    }
    // pending stays true until session-changed or auth://error lands.
  },

  logout: async () => {
    try {
      const url = await authLogout();
      if (url) {
        // Open AuthKit's logout URL so the WorkOS session is ended in
        // the browser too. We use the standard `window.open` fallback
        // because the desktop already routes external opens through
        // the OS shell — Tauri's webview hands these off to the
        // default browser. Failing to open here doesn't undo the
        // local clear; the user is signed out either way.
        try {
          window.open(url, "_blank");
        } catch {
          // best effort
        }
      }
    } catch (err) {
      console.error("auth-store: logout RPC failed", err);
    }
    set({
      status: "unauthenticated",
      user: null,
      pending: false,
      errorMessage: null,
    });
  },

  _setSession: (session) => {
    if (session) {
      set({
        status: "authenticated",
        user: session.user,
        pending: false,
        errorMessage: null,
      });
    } else {
      set({ status: "unauthenticated", user: null, pending: false });
    }
  },

  _setError: (message) => {
    set({ pending: false, errorMessage: message });
  },
}));

/**
 * Subscribe to the Tauri auth events. Call once at the React root
 * (App.tsx) — returns an unsubscribe function. Two events:
 *
 *   auth://session-changed  - successful exchange, payload = {user}
 *   auth://error            - failure, payload = string
 *
 * Both are emitted by `lib.rs::handle_deep_link`.
 */
export async function subscribeAuthEvents(): Promise<UnlistenFn> {
  const unlistenSession = await listen<AuthSession>("auth://session-changed", (event) => {
    useAuthStore.getState()._setSession(event.payload);
  });
  const unlistenError = await listen<string>("auth://error", (event) => {
    useAuthStore.getState()._setError(event.payload);
  });
  return () => {
    unlistenSession();
    unlistenError();
  };
}
