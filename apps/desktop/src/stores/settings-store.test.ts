import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock @tauri-apps/plugin-store as a tiny in-memory backing map. Each
 * test gets a fresh map by re-importing the store module after a
 * `vi.resetModules()`. The mock is shared across imports inside a
 * single test, so persistence-via-reload tests reuse the same map.
 */
const fakeStoreState: Record<string, unknown> = {};
const fakeStore = {
  get: vi.fn(async (key: string) => fakeStoreState[key]),
  set: vi.fn(async (key: string, value: unknown) => {
    fakeStoreState[key] = value;
  }),
  save: vi.fn(async () => undefined),
};

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => fakeStore),
}));

beforeEach(() => {
  for (const k of Object.keys(fakeStoreState)) delete fakeStoreState[k];
  fakeStore.get.mockClear();
  fakeStore.set.mockClear();
  fakeStore.save.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("settings-store", () => {
  it("starts with defaults before hydrate", async () => {
    const { useSettingsStore } = await import("./settings-store");
    const s = useSettingsStore.getState();
    expect(s.hydrated).toBe(false);
    expect(s.micDeviceLabel).toBeNull();
    expect(s.enableSystemAudio).toBe(true);
    expect(s.language).toBe("auto");
    expect(s.theme).toBe("system");
  });

  it("hydrates with defaults and seeds the store on a fresh install (no schema_version)", async () => {
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.micDeviceLabel).toBeNull();
    expect(s.enableSystemAudio).toBe(true);
    expect(s.language).toBe("auto");
    expect(s.theme).toBe("system");

    // First-run path writes the schema version + defaults so a later
    // load sees them rather than re-seeding.
    expect(fakeStoreState["schema_version"]).toBe(1);
    expect(fakeStoreState["mic_device_label"]).toBeNull();
    expect(fakeStoreState["enable_system_audio"]).toBe(true);
    expect(fakeStoreState["language"]).toBe("auto");
    expect(fakeStoreState["theme"]).toBe("system");
  });

  it("hydrates with persisted values when schema_version matches", async () => {
    fakeStoreState["schema_version"] = 1;
    fakeStoreState["mic_device_label"] = "AirPods Pro";
    fakeStoreState["enable_system_audio"] = false;
    fakeStoreState["language"] = "es";
    fakeStoreState["theme"] = "dark";

    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.micDeviceLabel).toBe("AirPods Pro");
    expect(s.enableSystemAudio).toBe(false);
    expect(s.language).toBe("es");
    expect(s.theme).toBe("dark");
  });

  it('theme falls back to "system" when a v1 file predates the theme key or holds a bogus value', async () => {
    fakeStoreState["schema_version"] = 1;
    fakeStoreState["language"] = "en";
    // no `theme` key at all (older v1 file)
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().theme).toBe("system");

    // and a garbage value is rejected the same way
    fakeStoreState["theme"] = "neon";
    _resetStoreForTests();
    useSettingsStore.setState({ hydrated: false });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().theme).toBe("system");
  });

  it("persists each setter to the underlying store", async () => {
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();

    await useSettingsStore.getState().setMicDeviceLabel("USB Mic");
    await useSettingsStore.getState().setEnableSystemAudio(false);
    await useSettingsStore.getState().setLanguage("ja");
    await useSettingsStore.getState().setTheme("light");

    expect(fakeStoreState["mic_device_label"]).toBe("USB Mic");
    expect(fakeStoreState["enable_system_audio"]).toBe(false);
    expect(fakeStoreState["language"]).toBe("ja");
    expect(fakeStoreState["theme"]).toBe("light");

    const s = useSettingsStore.getState();
    expect(s.micDeviceLabel).toBe("USB Mic");
    expect(s.enableSystemAudio).toBe(false);
    expect(s.language).toBe("ja");
    expect(s.theme).toBe("light");
  });

  it("getRecordingSnapshot returns a frozen-at-call-time object literal", async () => {
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();
    await useSettingsStore.getState().setLanguage("fr");
    await useSettingsStore.getState().setMicDeviceLabel("USB Mic");

    const snapshot = useSettingsStore.getState().getRecordingSnapshot();
    expect(snapshot).toEqual({
      micDeviceLabel: "USB Mic",
      enableSystem: true,
      language: "fr",
    });

    // Mutate the store after the snapshot is captured. The snapshot
    // must NOT change — the recording-start path treats it as the
    // frozen value for that session.
    await useSettingsStore.getState().setLanguage("de");
    expect(snapshot.language).toBe("fr");
  });

  it('getRecordingSnapshot collapses "auto" to null (older clients sent no language)', async () => {
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();
    // language defaults to "auto"
    const snapshot = useSettingsStore.getState().getRecordingSnapshot();
    expect(snapshot.language).toBeNull();
  });

  it("v0 → v1 migration: legacy file with no schema_version is upgraded with defaults", async () => {
    // No schema_version key — looks like a pre-v1 install.
    const { useSettingsStore, _resetStoreForTests } = await import("./settings-store");
    _resetStoreForTests();
    await useSettingsStore.getState().hydrate();

    expect(fakeStoreState["schema_version"]).toBe(1);
    // First-run defaults are written at v1.
    expect(fakeStoreState["enable_system_audio"]).toBe(true);
  });

  it("falls back to defaults when the store throws on load", async () => {
    // Make the next dynamic import see a load() that rejects.
    // Run last because doMock leaks across vi.resetModules in this file.
    vi.doMock("@tauri-apps/plugin-store", () => ({
      load: vi.fn(async () => {
        throw new Error("sandboxed CI");
      }),
    }));
    vi.resetModules();

    const { useSettingsStore } = await import("./settings-store");
    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.micDeviceLabel).toBeNull();
    expect(s.enableSystemAudio).toBe(true);
    expect(s.language).toBe("auto");

    vi.doUnmock("@tauri-apps/plugin-store");
  });
});
