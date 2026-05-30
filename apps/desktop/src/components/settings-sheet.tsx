import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { BACKEND_HTTP_URL, CLIENT_VERSION } from "@/lib/config";

export function SettingsSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open settings"
        >
          <Settings className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="font-display text-2xl font-normal">
            Settings
          </SheetTitle>
          <SheetDescription>
            Foundation slice — most controls land in subsequent phases.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Backend
            </h3>
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <p className="font-mono text-xs text-foreground break-all">
                {BACKEND_HTTP_URL}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Override via the <code>VITE_BACKEND_URL</code> env var.
            </p>
          </section>

          <section className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                Use local STT
              </span>
              <span className="text-xs text-muted-foreground">
                Faster-Whisper on device. Coming in a later slice.
              </span>
            </div>
            <Switch aria-label="Use local STT" disabled />
          </section>

          <section className="mt-auto flex flex-col gap-1 pt-4">
            <span className="text-xs text-muted-foreground">
              Client version
            </span>
            <span className="font-mono text-xs text-foreground">
              {CLIENT_VERSION}
            </span>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
