import { useEffect, useState } from "react";

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
 * session is actively recording. Subscribes to `audio://level` (~10 Hz)
 * and shows two bars — the post-gain level the STT actually consumes
 * and the raw device-side level — so the user can judge input health
 * independent of the pipeline's static gain compensation.
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
      <span className="w-10 shrink-0 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <div
        role="meter"
        aria-label={`${label} input level`}
        aria-valuenow={Math.round(dbfs)}
        aria-valuemin={-60}
        aria-valuemax={0}
        className="relative h-1.5 w-28 overflow-hidden rounded-full bg-input"
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
      <span className="w-9 shrink-0 text-right text-[0.625rem] tabular-nums text-muted-foreground">
        {dbfs <= NEAR_FLOOR_DBFS ? "—" : Math.round(dbfs)}
      </span>
    </div>
  );
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
    <div className="flex flex-col gap-1.5" aria-label="Microphone level">
      <LevelBar label="To STT" dbfs={level.micResampledDbfs} />
      <LevelBar label="Mic" dbfs={level.micRawDbfs} />
      {hint ? (
        <p className="max-w-[14rem] text-[0.625rem] leading-tight text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
