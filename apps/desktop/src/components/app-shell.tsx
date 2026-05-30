import { ConnectionStatus } from "@/components/connection-status";
import { RecordControl } from "@/components/record-control";
import { SettingsSheet } from "@/components/settings-sheet";
import { TranscriptPanel } from "@/components/transcript-panel";
import { useRecording } from "@/hooks/use-recording";

export function AppShell() {
  const { phase, elapsedMs, wsState, start, stop } = useRecording();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-8 py-5">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-normal leading-none tracking-tight">
            Meeting Intelligence
          </h1>
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Foundation
          </span>
        </div>
        <SettingsSheet />
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-hidden px-8 pb-6">
        <section className="flex justify-center py-6">
          <RecordControl
            phase={phase}
            elapsedMs={elapsedMs}
            onStart={() => {
              void start();
            }}
            onStop={() => {
              void stop();
            }}
          />
        </section>
        <section className="min-h-0 flex-1">
          <TranscriptPanel />
        </section>
      </main>

      <footer className="flex items-center justify-between gap-4 border-t border-border px-8 py-3 text-xs">
        <span className="text-muted-foreground">
          16 kHz mono PCM · 1 s payloads · in-memory echo
        </span>
        <ConnectionStatus state={wsState} />
      </footer>
    </div>
  );
}
