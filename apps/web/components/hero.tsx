import { ChevronDown } from "lucide-react";

import { AnimatedHeadline } from "@/components/animated-headline";
import { DownloadButton } from "@/components/download-button";
import type { ReleaseInfo } from "@/lib/releases";

export function Hero({ release }: { release: ReleaseInfo }) {
  return (
    <section className="relative mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center justify-center px-6 pt-28 pb-28 text-center">
      <span className="text-eyebrow animate-rise-in">Meeting intelligence</span>

      <AnimatedHeadline />

      <p className="animate-rise-in mt-6 max-w-xl text-balance leading-relaxed text-muted-foreground sm:text-lg">
        A native desktop app that records system and microphone audio, transcribes it live, and
        turns the conversation into summaries, decisions, and action items.
      </p>

      <div className="animate-rise-in mt-9">
        <DownloadButton release={release} />
      </div>

      {/* Scroll affordance — an arrow nudging toward the reveal section below. */}
      <div
        className="animate-rise-in pointer-events-none absolute inset-x-0 bottom-8 mx-auto flex w-fit justify-center"
        aria-hidden="true"
      >
        <ChevronDown className="animate-scroll-hint size-6 text-muted-foreground" />
      </div>
    </section>
  );
}
