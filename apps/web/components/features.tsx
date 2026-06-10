import type { CSSProperties } from "react";
import {
  AudioLines,
  Captions,
  ListChecks,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const FEATURES: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: AudioLines,
    title: "Native audio capture",
    description:
      "Records system and microphone audio together at 16kHz using ScreenCaptureKit on macOS and WASAPI on Windows — no virtual cables.",
  },
  {
    icon: Captions,
    title: "Live transcription",
    description:
      "Streaming speech-to-text turns the conversation into a speaker-labelled transcript as the meeting happens.",
  },
  {
    icon: Sparkles,
    title: "AI summaries",
    description:
      "A map-reduce pipeline distills the full transcript into a tight summary you can skim in seconds.",
  },
  {
    icon: ListChecks,
    title: "Decisions & action items",
    description:
      "Owners, decisions, and follow-ups are pulled out automatically, so nothing falls through the cracks.",
  },
  {
    icon: Search,
    title: "Semantic search",
    description:
      "Find any moment across every meeting by meaning, not just keywords, backed by vector search.",
  },
  {
    icon: ShieldCheck,
    title: "Private by design",
    description:
      "Swap the cloud transcriber for an on-prem Whisper model to keep meeting audio inside your own infrastructure.",
  },
];

function FeatureCard({
  icon: Icon,
  title,
  description,
  index,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  index: number;
}) {
  return (
    <Card
      className="animate-rise-in stagger-item transition-base h-full ring-foreground/10 hover:-translate-y-0.5 hover:ring-foreground/20"
      style={{ "--stagger-index": index } as CSSProperties}
    >
      <CardHeader>
        <div className="flex size-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon className="size-5" />
        </div>
        <CardTitle className="mt-3">{title}</CardTitle>
        <CardDescription className="leading-relaxed">{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-5xl scroll-mt-20 px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-2xl text-center">
        <span className="text-eyebrow">What it does</span>
        <h2 className="mt-4 font-display text-3xl font-normal tracking-tight sm:text-4xl">
          From raw audio to decisions you can act on
        </h2>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          One capture pipeline, orchestrated end to end — every external service swappable behind a
          clean interface.
        </p>
      </div>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <FeatureCard key={feature.title} index={index} {...feature} />
        ))}
      </div>
    </section>
  );
}
