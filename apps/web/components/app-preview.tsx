import type { CSSProperties } from "react";

const TRANSCRIPT: { speaker: string; time: string; text: string }[] = [
  { speaker: "Sarah", time: "12:41", text: "Can we lock the launch date before we wrap?" },
  { speaker: "Marcus", time: "12:41", text: "March 14 works if design hands off by Friday." },
  { speaker: "Priya", time: "12:42", text: "I'll own the migration script and the rollback plan." },
];

const ACTIONS = [
  "Confirm March 14 launch date with the wider team",
  "Design handoff due Friday — Marcus following up",
  "Priya owns the migration script + rollback plan",
];

export function AppPreview() {
  return (
    <div className="animate-rise-in elevation-overlay overflow-hidden rounded-xl border bg-card text-left">
      {/* Window chrome + live status */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        <div className="ml-3 flex items-center gap-2">
          <span className="animate-breathe size-1.5 rounded-full bg-recording shadow-[0_0_0_4px_var(--recording-glow)]" />
          <span className="text-caption">Recording</span>
        </div>
        <span className="text-caption ml-auto font-mono tabular-nums">00:12:48</span>
      </div>

      {/* Transcript + summary */}
      <div className="grid gap-px bg-border sm:grid-cols-[1.5fr_1fr]">
        <div className="bg-card p-5">
          <p className="text-eyebrow mb-4">Live transcript</p>
          <div className="flex flex-col gap-4">
            {TRANSCRIPT.map((line, i) => (
              <div
                key={line.speaker + line.text}
                className="animate-line-in stagger-item"
                style={{ "--stagger-index": i } as CSSProperties}
              >
                <p className="text-caption mb-1">
                  <span className="font-medium text-foreground/80">{line.speaker}</span>
                  <span className="mx-1.5">·</span>
                  <span className="font-mono">{line.time}</span>
                </p>
                <p className="text-sm leading-relaxed text-foreground/90">{line.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-card p-5">
          <p className="text-eyebrow mb-4">Summary</p>
          <p className="mb-5 text-sm leading-relaxed text-foreground/90">
            The team aligned on a March 14 launch and assigned owners for the remaining blockers.
          </p>
          <p className="text-eyebrow mb-3">Action items</p>
          <ul className="flex flex-col gap-2.5">
            {ACTIONS.map((action) => (
              <li
                key={action}
                className="flex items-start gap-2.5 text-sm leading-snug text-foreground/85"
              >
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                {action}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
