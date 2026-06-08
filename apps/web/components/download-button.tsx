"use client";

import { useSyncExternalStore } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ReleaseInfo } from "@/lib/releases";

type OS = "mac" | "windows" | "other";
type Platform = "mac" | "windows";

const PLATFORM_LABEL: Record<Platform, string> = {
  mac: "macOS",
  windows: "Windows",
};

function detectOS(): OS {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "other";
}

// Read the OS via an external store so server and first client render agree
// (both null), then the client snapshot swaps the detected OS in. Avoids both a
// hydration mismatch and a synchronous setState-in-effect.
const subscribe = () => () => {};
const getClientSnapshot = (): OS | null => detectOS();
const getServerSnapshot = (): OS | null => null;

export function DownloadButton({ release }: { release: ReleaseInfo }) {
  const os = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  if (!release.available) {
    return (
      <div className="flex flex-col items-center gap-4">
        <Button size="lg" disabled className="h-11 px-6">
          <Download data-icon="inline-start" />
          Downloads coming soon
        </Button>
        <a
          href={release.releasesUrl}
          target="_blank"
          rel="noreferrer"
          className="text-caption underline-offset-4 transition-fast hover:text-foreground hover:underline"
        >
          Watch releases on GitHub →
        </a>
      </div>
    );
  }

  const urls: Record<Platform, string | null> = {
    mac: release.macUrl,
    windows: release.winUrl,
  };

  const detected: Platform = os === "windows" ? "windows" : "mac";
  const primaryOS: Platform = urls[detected] ? detected : detected === "mac" ? "windows" : "mac";
  const primaryUrl = urls[primaryOS];
  const otherOS: Platform = primaryOS === "mac" ? "windows" : "mac";
  const otherUrl = urls[otherOS];

  // `available` guarantees at least one asset; this guards the type only.
  if (!primaryUrl) return null;

  const primaryLabel = os === null ? "Download" : `Download for ${PLATFORM_LABEL[primaryOS]}`;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg" className="h-11 px-6">
          <a href={primaryUrl}>
            <Download data-icon="inline-start" />
            {primaryLabel}
          </a>
        </Button>
        {otherUrl ? (
          <Button asChild variant="outline" size="lg" className="h-11 px-5">
            <a href={otherUrl}>{PLATFORM_LABEL[otherOS]}</a>
          </Button>
        ) : null}
      </div>

      <p className="text-caption flex flex-wrap items-center gap-x-2 gap-y-1">
        {release.version ? <span className="font-mono">{release.version}</span> : null}
        <span aria-hidden>·</span>
        <span>macOS 13+ &amp; Windows 10+</span>
      </p>
    </div>
  );
}
