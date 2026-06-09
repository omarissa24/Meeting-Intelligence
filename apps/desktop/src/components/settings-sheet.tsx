import { useEffect, useState } from "react";
import { Keyboard, LogOut, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { BACKEND_HTTP_URL, CLIENT_VERSION, IS_PRODUCTION } from "@/lib/config";
import { listAudioInputs } from "@/lib/tauri-commands";
import { useAuthStore } from "@/stores/auth-store";
import {
  LANGUAGE_CODES,
  type LanguageCode,
  type ThemePreference,
  useSettingsStore,
} from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

const SYSTEM_DEFAULT_VALUE = "__system_default__";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  auto: "Auto-detect",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
  zh: "Chinese",
  hi: "Hindi",
};

export function SettingsSheet() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const micDeviceLabel = useSettingsStore((s) => s.micDeviceLabel);
  const enableSystemAudio = useSettingsStore((s) => s.enableSystemAudio);
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const autoDetectMeetings = useSettingsStore((s) => s.autoDetectMeetings);
  const setMicDeviceLabel = useSettingsStore((s) => s.setMicDeviceLabel);
  const setEnableSystemAudio = useSettingsStore((s) => s.setEnableSystemAudio);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAutoDetectMeetings = useSettingsStore((s) => s.setAutoDetectMeetings);

  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);

  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  // Refresh the device list whenever the sheet opens. cpal device
  // enumeration is cheap and devices change while the app is running
  // (USB plug/unplug, Bluetooth pairing) — re-reading on open is
  // simpler than wiring a hot-plug subscription.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDevicesError(null);
    listAudioInputs()
      .then((list) => {
        if (cancelled) return;
        setDevices(list.map((d) => d.label));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDevicesError(err instanceof Error ? err.message : String(err));
        setDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Selected mic that is no longer in the list (e.g. unplugged USB
  // mic). Surface it as "<name> — unavailable" rather than silently
  // dropping it; the user picked it for a reason.
  const selectedMicMissing = micDeviceLabel !== null && !devices.includes(micDeviceLabel);

  // The user blob is opaque WorkOS JSON. `email` is the field we
  // surface; everything else is a no-op for the settings panel today.
  const email = typeof user?.email === "string" ? (user.email as string) : null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Open settings">
          <Settings className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="font-display text-2xl font-normal">Settings</SheetTitle>
          <SheetDescription>Recording defaults apply to your next session.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
          {email ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-eyebrow">Signed in as</h3>
              <p className="text-sm text-foreground break-all">{email}</p>
            </section>
          ) : null}

          {!IS_PRODUCTION ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-eyebrow">Backend</h3>
              <div className="rounded-md border border-border bg-card px-3 py-2">
                <p className="font-mono text-xs text-foreground break-all">{BACKEND_HTTP_URL}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Override via the <code>VITE_BACKEND_URL</code> env var.
              </p>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow">Microphone</h3>
            <Select
              value={micDeviceLabel ?? SYSTEM_DEFAULT_VALUE}
              onValueChange={(value) => {
                void setMicDeviceLabel(value === SYSTEM_DEFAULT_VALUE ? null : value);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Microphone device">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_DEFAULT_VALUE}>System default</SelectItem>
                {devices.map((label) => (
                  <SelectItem key={label} value={label}>
                    {label}
                  </SelectItem>
                ))}
                {selectedMicMissing && micDeviceLabel ? (
                  <SelectItem key={micDeviceLabel} value={micDeviceLabel}>
                    {micDeviceLabel} — unavailable
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {devicesError ? (
              <p className="text-xs text-muted-foreground">
                Could not enumerate input devices: {devicesError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                System default re-resolves at every recording start.
              </p>
            )}
          </section>

          <section className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Capture system audio</span>
              <span className="text-xs text-muted-foreground">
                Record audio from other apps (the meeting). When off, no screen-recording prompt
                appears.
              </span>
            </div>
            <Switch
              aria-label="Capture system audio"
              checked={enableSystemAudio}
              onCheckedChange={(checked) => {
                void setEnableSystemAudio(checked);
              }}
            />
          </section>

          <section className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Auto-detect meetings</span>
              <span className="text-xs text-muted-foreground">
                Prompt me to record when a call starts (Zoom, Teams, Google Meet…). Runs locally and
                always asks first — it never records on its own.
              </span>
            </div>
            <Switch
              aria-label="Auto-detect meetings"
              checked={autoDetectMeetings}
              onCheckedChange={(checked) => {
                void setAutoDetectMeetings(checked);
              }}
            />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow">Transcription language</h3>
            <Select
              value={language}
              onValueChange={(value) => {
                void setLanguage(value as LanguageCode);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Transcription language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_CODES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {LANGUAGE_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Auto-detect lets the model pick. Choose a language to lock it and skip detection.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow">Appearance</h3>
            <Select
              value={theme}
              onValueChange={(value) => {
                void setTheme(value as ThemePreference);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              System follows your OS appearance. Light or Dark overrides it.
            </p>
          </section>

          <section className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Use local STT</span>
              <span className="text-xs text-muted-foreground">
                Faster-Whisper on device. Coming in a later slice.
              </span>
            </div>
            <Switch aria-label="Use local STT" disabled />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow">Help</h3>
            <Button
              type="button"
              variant="outline"
              className="justify-start gap-2"
              onClick={() => {
                // Close the sheet first so the panel isn't stacked behind
                // it; the dialog lives at the AppShell level.
                setOpen(false);
                setShortcutsOpen(true);
              }}
            >
              <Keyboard className="size-4" />
              Keyboard shortcuts
            </Button>
          </section>

          <section className="mt-auto flex flex-col gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              className="justify-start gap-2"
              onClick={() => {
                void logout();
              }}
            >
              <LogOut className="size-4" />
              Log out
            </Button>
            <span className="text-xs text-muted-foreground">Client version</span>
            <span className="font-mono text-xs text-foreground">{CLIENT_VERSION}</span>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
