import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the Tauri command surface. Each test resets these.
const mockAuthGetSession = vi.fn();
const mockAuthStartLogin = vi.fn();
const mockAuthLogout = vi.fn();

vi.mock("@/lib/tauri-commands", () => ({
  authGetSession: () => mockAuthGetSession(),
  authStartLogin: () => mockAuthStartLogin(),
  authLogout: () => mockAuthLogout(),
  authGetAccessToken: vi.fn(async () => null),
}));

// Listener mock — each test grabs this and triggers handlers manually
// to simulate the deep-link plugin emitting events.
type Handler<T> = (event: { payload: T }) => void;
const listenCalls: Array<{ event: string; handler: Handler<unknown> }> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async <T>(event: string, handler: Handler<T>) => {
    listenCalls.push({ event, handler: handler as Handler<unknown> });
    return vi.fn();
  }),
}));

beforeEach(() => {
  listenCalls.length = 0;
  mockAuthGetSession.mockReset();
  mockAuthStartLogin.mockReset();
  mockAuthLogout.mockReset();
  // Reset the Zustand store between tests by re-importing.
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("auth-store", () => {
  it("starts in `loading` and flips to `authenticated` when the keyring has a session", async () => {
    mockAuthGetSession.mockResolvedValueOnce({ user: { email: "alice@example.com" } });
    const { useAuthStore } = await import("./auth-store");

    const initial = useAuthStore.getState();
    expect(initial.status).toBe("loading");

    await useAuthStore.getState().hydrate();

    const next = useAuthStore.getState();
    expect(next.status).toBe("authenticated");
    expect(next.user).toEqual({ email: "alice@example.com" });
  });

  it("flips to `unauthenticated` when the keyring is empty", async () => {
    mockAuthGetSession.mockResolvedValueOnce(null);
    const { useAuthStore } = await import("./auth-store");

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("treats keyring errors as signed-out and surfaces the message", async () => {
    mockAuthGetSession.mockRejectedValueOnce(new Error("keyring locked"));
    const { useAuthStore } = await import("./auth-store");

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.status).toBe("unauthenticated");
    expect(state.errorMessage).toBe("keyring locked");
  });

  it("startLogin sets `pending` and invokes the Tauri command", async () => {
    mockAuthStartLogin.mockResolvedValueOnce(undefined);
    const { useAuthStore } = await import("./auth-store");

    await useAuthStore.getState().startLogin();

    expect(mockAuthStartLogin).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().pending).toBe(true);
  });

  it("subscribeAuthEvents wires session-changed → authenticated", async () => {
    mockAuthGetSession.mockResolvedValueOnce(null);
    const mod = await import("./auth-store");

    await mod.subscribeAuthEvents();

    const session = listenCalls.find((c) => c.event === "auth://session-changed");
    expect(session).toBeDefined();
    session!.handler({ payload: { user: { email: "bob@example.com" } } });

    const next = mod.useAuthStore.getState();
    expect(next.status).toBe("authenticated");
    expect(next.user).toEqual({ email: "bob@example.com" });
  });

  it("subscribeAuthEvents wires auth://error → errorMessage + clears pending", async () => {
    const mod = await import("./auth-store");
    // Put the store in `pending` to confirm the error handler clears it.
    mockAuthStartLogin.mockResolvedValueOnce(undefined);
    await mod.useAuthStore.getState().startLogin();
    expect(mod.useAuthStore.getState().pending).toBe(true);

    await mod.subscribeAuthEvents();
    const errCall = listenCalls.find((c) => c.event === "auth://error");
    expect(errCall).toBeDefined();
    errCall!.handler({ payload: "state mismatch" });

    const next = mod.useAuthStore.getState();
    expect(next.pending).toBe(false);
    expect(next.errorMessage).toBe("state mismatch");
  });

  it("logout clears local state regardless of whether the backend call succeeded", async () => {
    mockAuthGetSession.mockResolvedValueOnce({ user: { email: "alice@example.com" } });
    mockAuthLogout.mockRejectedValueOnce(new Error("backend down"));
    const { useAuthStore } = await import("./auth-store");
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().status).toBe("authenticated");

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().status).toBe("unauthenticated");
    expect(useAuthStore.getState().user).toBeNull();
  });
});
