import { useEffect, useState } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { subscribeMicLevel, type MicLevelPayload } from "@/lib/audio-bridge";
import {
  dbfsToWidthPct,
  levelBand,
  levelHint,
  NEAR_FLOOR_DBFS,
  type LevelBand,
} from "@/lib/mic-level";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";

/**
 * Live microphone level meter (US-25a). Self-contained: reads the
 * recording phase + session id from the store and renders only while a
 * session is actively recording.
 *
 * The user-facing surface is ONE bar — the raw device level, since
 * that's the thing the low-input hint tells them to adjust in System
 * Settings. The pipeline-side resampled level (what the STT actually
 * consumes) stays available for debugging via the info popover, along
 * with both raw dBFS readouts. `levelHint` still weighs both signals.
 */

/** Resting state between sessions / before the first tick lands. */
const SILENT: MicLevelPayload = {
  sessionId: "",
  micRawDbfs: NEAR_FLOOR_DBFS,
  micResampledDbfs: NEAR_FLOOR_DBFS,
};

const BAND_FILL: Record<LevelBand, string> = {
  good: "bg-meter-good",
  warn: "bg-meter-warn",
  bad: "bg-meter-bad",
};

function LevelBar({ label, dbfs }: { label: string; dbfs: number }) {
  const band = levelBand(dbfs);
  const width = dbfsToWidthPct(dbfs);
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div
        role="meter"
        aria-label={`${label} input level`}
        aria-valuenow={Math.round(dbfs)}
        aria-valuemin={-60}
        aria-valuemax={0}
        className="relative h-1.5 w-40 overflow-hidden rounded-full bg-input"
      >
        <div
          data-band={band}
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-100 ease-out",
            BAND_FILL[band],
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function formatDbfs(dbfs: number): string {
  return dbfs <= NEAR_FLOOR_DBFS ? "—" : `${Math.round(dbfs)} dBFS`;
}

export function MicLevelMeter() {
  const phase = useRecordingStore((s) => s.phase);
  const sessionId = useRecordingStore((s) => s.sessionId);
  const live = phase === "recording" && sessionId !== null;

  const [level, setLevel] = useState<MicLevelPayload>(SILENT);

  useEffect(() => {
    if (!live || !sessionId) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const off = await subscribeMicLevel(sessionId, (payload) => {
        if (mounted) setLevel(payload);
      });
      // The async gap may have outlived the effect — tear down immediately
      // if so, otherwise hand the unlisten to cleanup.
      if (!mounted) off();
      else unlisten = off;
    })();

    return () => {
      mounted = false;
      unlisten?.();
      setLevel(SILENT); // next session starts from silence, not a stale peak
    };
  }, [live, sessionId]);

  if (!live) return null;

  const hint = levelHint(level.micRawDbfs, level.micResampledDbfs);

  return (
    <div className="flex flex-col gap-1" aria-label="Microphone level">
      <div className="flex items-center gap-1">
        <LevelBar label="Mic" dbfs={level.micRawDbfs} />
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Input level details">
              <Info />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto">
            <dl className="flex flex-col gap-1.5 font-mono text-xs tabular-nums">
              <div className="flex items-center justify-between gap-6">
                <dt className="text-muted-foreground">Mic (raw)</dt>
                <dd>{formatDbfs(level.micRawDbfs)}</dd>
              </div>
              <div className="flex items-center justify-between gap-6">
                <dt className="text-muted-foreground">To STT (resampled)</dt>
                <dd>{formatDbfs(level.micResampledDbfs)}</dd>
              </div>
            </dl>
          </PopoverContent>
        </Popover>
      </div>
      {/* Reserved in-flow slot — the hint appearing/disappearing must not
          shift the recording header (it used to be absolutely positioned
          and overlapped the content below). */}
      <p className="min-h-8 max-w-[18rem] text-xs leading-tight text-meter-warn">{hint ?? ""}</p>
    </div>
  );
}
