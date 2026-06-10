import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatClock } from "@/lib/format-clock";

const SKIP_SECONDS = 15;
const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

interface AudioPlayerProps {
  /** Source URL — a short-lived presigned URL for the archived MP3. */
  src: string;
  /**
   * Server-known duration in seconds, used as a fallback when the media
   * element can't report one. Streamed MP3s served without a
   * `Content-Length` report `duration` as `Infinity`/`NaN`, so we fall
   * back to `meeting.durationSeconds` for the readout and seek range.
   */
  fallbackDurationSeconds?: number | null;
  /**
   * Optional slot rendered at the end of the transport row — e.g. the
   * quiet delete-audio action — so callers don't need a second row of
   * chrome under the player.
   */
  trailing?: React.ReactNode;
}

/**
 * Custom audio player for archived meeting recordings. Renders our own
 * transport built from shadcn primitives and drives a headless `<audio>`
 * element via the HTMLMediaElement API — the native `<audio controls>`
 * chrome is un-themeable in WebKit and clashed with the design system in
 * both light and dark mode.
 *
 * Stateless across `src` changes by design: the caller keys this on the
 * presigned URL, so a URL refresh or meeting switch remounts the player
 * and resets all playback state.
 */
export function AudioPlayer({ src, fallbackDurationSeconds, trailing }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Read inside the timeupdate listener, which is attached once on mount —
  // a ref avoids the stale-closure trap a state value would hit there.
  const isSeekingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Prefer the media element's own duration; fall back to the server value
  // when it's missing or non-finite (streamed MP3 without Content-Length).
  const effectiveDuration =
    Number.isFinite(duration) && duration > 0 ? duration : (fallbackDurationSeconds ?? 0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      setIsReady(true);
    };
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onTimeUpdate = () => {
      if (!isSeekingRef.current) setCurrentTime(audio.currentTime);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };
    const onError = () => {
      setHasError(true);
      setIsReady(false);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // play() rejects on autoplay policy / aborted load — surface as an error
      // rather than an unhandled rejection.
      void audio.play().catch(() => setHasError(true));
    } else {
      audio.pause();
    }
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const upper =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : effectiveDuration || audio.currentTime + delta;
    const next = Math.min(Math.max(audio.currentTime + delta, 0), upper);
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const onSeekChange = ([value]: number[]) => {
    isSeekingRef.current = true;
    setCurrentTime(value);
  };

  const onSeekCommit = ([value]: number[]) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = value;
    isSeekingRef.current = false;
    setCurrentTime(value);
  };

  const onSpeedChange = (value: string) => {
    const rate = Number(value);
    const audio = audioRef.current;
    if (audio) audio.playbackRate = rate;
    setPlaybackRate(rate);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" className="sr-only" aria-hidden>
        <track kind="captions" />
      </audio>

      {hasError ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t play this audio.</p>
      ) : (
        // One transport row — play, skip, scrub, time, speed, trailing
        // actions. The old three-row stack fragmented a single mental
        // unit ("the player") across the section.
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="icon"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-4" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => skip(-SKIP_SECONDS)}
                disabled={!isReady}
                aria-label="Skip back 15 seconds"
              >
                <RotateCcw className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back 15s</TooltipContent>
          </Tooltip>

          <Slider
            className="flex-1"
            min={0}
            max={effectiveDuration || 1}
            step={1}
            value={[Math.min(currentTime, effectiveDuration || currentTime)]}
            onValueChange={onSeekChange}
            onValueCommit={onSeekCommit}
            disabled={!isReady && effectiveDuration === 0}
            aria-label="Seek"
            aria-valuetext={formatClock(currentTime)}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => skip(SKIP_SECONDS)}
                disabled={!isReady}
                aria-label="Skip forward 15 seconds"
              >
                <RotateCw className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forward 15s</TooltipContent>
          </Tooltip>

          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {formatClock(currentTime)} / {formatClock(effectiveDuration)}
          </span>

          <Select value={String(playbackRate)} onValueChange={onSpeedChange}>
            <SelectTrigger size="sm" aria-label="Playback speed" className="w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PLAYBACK_RATES.map((rate) => (
                  <SelectItem key={rate} value={String(rate)}>
                    {rate}x
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {trailing}
        </div>
      )}
    </div>
  );
}
