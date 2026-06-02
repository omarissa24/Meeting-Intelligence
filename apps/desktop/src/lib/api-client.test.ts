import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthGetAccessToken = vi.fn();

vi.mock("./tauri-commands", () => ({
  authGetAccessToken: () => mockAuthGetAccessToken(),
}));

vi.mock("./config", () => ({
  BACKEND_HTTP_URL: "http://api.test",
  BACKEND_WS_URL: "ws://api.test",
  CLIENT_VERSION: "test",
}));

const fetchMock = vi.fn();
beforeEach(() => {
  mockAuthGetAccessToken.mockReset();
  fetchMock.mockReset();
  // Inject a fetch mock for the duration of the test.
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("attaches Authorization: Bearer <token> when a token is available", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce("tok-abc");
    fetchMock.mockResolvedValueOnce(new Response("ok"));

    const { apiFetch } = await import("./api-client");
    await apiFetch({ path: "/meetings" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/meetings");
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok-abc");
  });

  it("omits Authorization when the user is signed out (token = null)", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(new Response("ok"));

    const { apiFetch } = await import("./api-client");
    await apiFetch({ path: "/meetings" });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("auto-sets application/json content-type when body is a string and caller didn't", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce("tok-abc");
    fetchMock.mockResolvedValueOnce(new Response("{}"));

    const { apiFetch } = await import("./api-client");
    await apiFetch({
      path: "/meetings",
      method: "POST",
      body: JSON.stringify({ title: "t" }),
    });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("respects an explicit Content-Type set by the caller", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce("tok-abc");
    fetchMock.mockResolvedValueOnce(new Response(""));

    const { apiFetch } = await import("./api-client");
    await apiFetch({
      path: "/meetings",
      method: "POST",
      body: "raw",
      headers: { "Content-Type": "text/plain" },
    });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get("Content-Type")).toBe("text/plain");
  });

  it("normalises a path missing a leading slash", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(new Response(""));

    const { apiFetch } = await import("./api-client");
    await apiFetch({ path: "meetings" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/meetings");
  });
});

describe("apiJson", () => {
  it("returns parsed body on 2xx", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce("tok");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));

    const { apiJson } = await import("./api-client");
    const body = await apiJson<{ id: string }>({ path: "/meetings/m1" });
    expect(body).toEqual({ id: "m1" });
  });

  it("throws ApiError with the status + body on non-2xx", async () => {
    mockAuthGetAccessToken.mockResolvedValueOnce("tok");
    fetchMock.mockResolvedValueOnce(new Response("not allowed", { status: 401 }));

    const { apiJson, ApiError } = await import("./api-client");
    let caught: unknown;
    try {
      await apiJson({ path: "/meetings" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(401);
    expect((caught as { body: string }).body).toBe("not allowed");
  });
});
