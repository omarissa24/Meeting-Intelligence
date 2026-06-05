import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";

/**
 * US-25: persisted user-recording settings.
 *
 * Backed by `tauri-plugin-store`, which writes a JSON file under the
 * OS app-data directory (Library/Application Support on macOS, AppData
 * on Windows). The bundle identifier is stable across versions, so the
 * file survives app updates.
 *
 * The store holds three settings:
 *   - mic device label  (null = system default, re-resolves at start)
 *   - system audio toggle (default ON)
 *   - transcription language (default "auto")
 *
 * Changes apply at the **next** recording, not retroactively. The
 * recording-start path captures `getRecordingSnapshot()` and treats
 * that frozen value as the source of truth for the live session.
 */

export const LANGUAGE_CODES = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "nl",
  "ja",
  "zh",
  "hi",
] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

/** US-27: theme preference. `"system"` follows the OS appearance. */
export type ThemePreference = "system" | "light" | "dark";

const SCHEMA_VERSION = 1;
const STORE_FILE = "settings.json";

const KEY_SCHEMA_VERSION = "schema_version";
const KEY_MIC_LABEL = "mic_device_label";
const KEY_SYSTEM_AUDIO = "enable_system_audio";
const KEY_LANGUAGE = "language";
const KEY_THEME = "theme";

const DEFAULT_MIC_LABEL: string | null = null;
const DEFAULT_SYSTEM_AUDIO = true;
const DEFAULT_LANGUAGE: LanguageCode = "auto";
const DEFAULT_THEME: ThemePreference = "system";

export interface RecordingSnapshot {
  /** null ⇒ "System default" (re-resolve at start). */
  micDeviceLabel: string | null;
  enableSystem: boolean;
  /** null/"auto" treated identically downstream. */
  language: string | null;
}

export interface SettingsStoreState {
  micDeviceLabel: string | null;
  enableSystemAudio: boolean;
  language: LanguageCode;
  theme: ThemePreference;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  setMicDeviceLabel: (label: string | null) => Promise<void>;
  setEnableSystemAudio: (enabled: boolean) => Promise<void>;
  setLanguage: (code: LanguageCode) => Promise<void>;
  setTheme: (preference: ThemePreference) => Promise<void>;

  /**
   * Read at recording-start to freeze the values used for this session.
   * The returned object is intentionally a fresh literal — mutating
   * the store afterwards does not affect the live session.
   */
  getRecordingSnapshot: () => RecordingSnapshot;
}

let storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, {
      autoSave: true,
      // The plugin requires `defaults` to be set; we manage seeding
      // explicitly inside `readAndMigrate` so this acts as a fallback
      // for keys we never read.
      defaults: {
        [KEY_SCHEMA_VERSION]: SCHEMA_VERSION,
        [KEY_MIC_LABEL]: DEFAULT_MIC_LABEL,
        [KEY_SYSTEM_AUDIO]: DEFAULT_SYSTEM_AUDIO,
        [KEY_LANGUAGE]: DEFAULT_LANGUAGE,
        [KEY_THEME]: DEFAULT_THEME,
      },
    });
  }
  return storePromise;
}

/** Test-only seam: reset the lazy store handle so a fresh mock takes effect. */
export function _resetStoreForTests(): void {
  storePromise = null;
}

function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === "string" && (LANGUAGE_CODES as readonly string[]).includes(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

interface LoadedSettings {
  micDeviceLabel: string | null;
  enableSystemAudio: boolean;
  language: LanguageCode;
  theme: ThemePreference;
}

async function readAndMigrate(store: Store): Promise<LoadedSettings> {
  const rawVersion = await store.get(KEY_SCHEMA_VERSION);
  const version = typeof rawVersion === "number" ? rawVersion : 0;

  // Forward-compat: if a future build wrote a schema we don't know,
  // ignore it and use defaults. (Don't overwrite — a downgrade
  // shouldn't blow away the newer build's settings.)
  if (version > SCHEMA_VERSION) {
    console.warn(`settings-store: unknown schema_version=${version}; using defaults this session`);
    return {
      micDeviceLabel: DEFAULT_MIC_LABEL,
      enableSystemAudio: DEFAULT_SYSTEM_AUDIO,
      language: DEFAULT_LANGUAGE,
      theme: DEFAULT_THEME,
    };
  }

  // First run / pre-v1 file → seed defaults at the current schema.
  if (version < SCHEMA_VERSION) {
    await store.set(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
    await store.set(KEY_MIC_LABEL, DEFAULT_MIC_LABEL);
    await store.set(KEY_SYSTEM_AUDIO, DEFAULT_SYSTEM_AUDIO);
    await store.set(KEY_LANGUAGE, DEFAULT_LANGUAGE);
    await store.set(KEY_THEME, DEFAULT_THEME);
    return {
      micDeviceLabel: DEFAULT_MIC_LABEL,
      enableSystemAudio: DEFAULT_SYSTEM_AUDIO,
      language: DEFAULT_LANGUAGE,
      theme: DEFAULT_THEME,
    };
  }

  const micRaw = await store.get(KEY_MIC_LABEL);
  const sysRaw = await store.get(KEY_SYSTEM_AUDIO);
  const langRaw = await store.get(KEY_LANGUAGE);
  // `theme` (US-27) was added without a schema bump: an existing v1
  // file simply lacks the key, so the tolerant fallback yields "system".
  const themeRaw = await store.get(KEY_THEME);

  return {
    micDeviceLabel: isNullableString(micRaw) ? micRaw : DEFAULT_MIC_LABEL,
    enableSystemAudio: isBoolean(sysRaw) ? sysRaw : DEFAULT_SYSTEM_AUDIO,
    language: isLanguageCode(langRaw) ? langRaw : DEFAULT_LANGUAGE,
    theme: isThemePreference(themeRaw) ? themeRaw : DEFAULT_THEME,
  };
}

export const useSettingsStore = create<SettingsStoreState>()((set, get) => ({
  micDeviceLabel: DEFAULT_MIC_LABEL,
  enableSystemAudio: DEFAULT_SYSTEM_AUDIO,
  language: DEFAULT_LANGUAGE,
  theme: DEFAULT_THEME,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const store = await getStore();
      const loaded = await readAndMigrate(store);
      set({ ...loaded, hydrated: true });
    } catch (err) {
      // If the store fails to load (sandboxed CI, disk full, plugin
      // not registered in test harness), fall back to defaults so the
      // UI still functions — a recording with sensible defaults is
      // better than a stuck app.
      console.error("settings-store: hydrate failed", err);
      set({
        micDeviceLabel: DEFAULT_MIC_LABEL,
        enableSystemAudio: DEFAULT_SYSTEM_AUDIO,
        language: DEFAULT_LANGUAGE,
        theme: DEFAULT_THEME,
        hydrated: true,
      });
    }
  },

  setMicDeviceLabel: async (label) => {
    set({ micDeviceLabel: label });
    try {
      const store = await getStore();
      await store.set(KEY_MIC_LABEL, label);
    } catch (err) {
      console.error("settings-store: setMicDeviceLabel persist failed", err);
    }
  },

  setEnableSystemAudio: async (enabled) => {
    set({ enableSystemAudio: enabled });
    try {
      const store = await getStore();
      await store.set(KEY_SYSTEM_AUDIO, enabled);
    } catch (err) {
      console.error("settings-store: setEnableSystemAudio persist failed", err);
    }
  },

  setLanguage: async (code) => {
    set({ language: code });
    try {
      const store = await getStore();
      await store.set(KEY_LANGUAGE, code);
    } catch (err) {
      console.error("settings-store: setLanguage persist failed", err);
    }
  },

  setTheme: async (preference) => {
    set({ theme: preference });
    try {
      const store = await getStore();
      await store.set(KEY_THEME, preference);
    } catch (err) {
      console.error("settings-store: setTheme persist failed", err);
    }
  },

  getRecordingSnapshot: () => {
    const s = get();
    return {
      micDeviceLabel: s.micDeviceLabel,
      enableSystem: s.enableSystemAudio,
      // null and "auto" are equivalent downstream; collapse to null so
      // the WS payload omits the field for older backend builds.
      language: s.language === "auto" ? null : s.language,
    };
  },
}));
