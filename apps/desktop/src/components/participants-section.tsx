import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { User } from "lucide-react";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useUpdateSpeakerAliases } from "@/hooks/use-update-speaker-aliases";
import { speakerLabel } from "@/lib/speaker-label";
import { cn } from "@/lib/utils";

// Mirrored from the backend `_validate_speaker_aliases` in
// `api/meetings.py`. Validating client-side gives the user inline
// feedback before a round-trip; the server is still authoritative.
const MAX_DISPLAY_NAME_LENGTH = 32;

interface ParticipantsSectionProps {
  meeting: MeetingDetail;
}

/**
 * US-26: per-meeting Participants strip. Lists the distinct speaker
 * labels that actually appear in the persisted final segments and lets
 * the user rename each one. Renaming is a render-time overlay — the
 * `transcript_segments.speaker_id` column stays pinned to the raw STT
 * label.
 *
 * Renders nothing when there are no detected speakers. We commit on
 * blur or Enter (matching `<EditableTitle/>`); empty input clears the
 * alias for that speaker.
 */
export function ParticipantsSection({ meeting }: ParticipantsSectionProps) {
  const update = useUpdateSpeakerAliases(meeting.id);

  // Distinct speaker IDs in order of first appearance in the
  // transcript. This is stable so the row order doesn't shuffle on
  // every refetch.
  const speakerIds = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const seg of meeting.segments) {
      if (!seg.speakerId) continue;
      if (seen.has(seg.speakerId)) continue;
      seen.add(seg.speakerId);
      ordered.push(seg.speakerId);
    }
    return ordered;
  }, [meeting.segments]);

  if (speakerIds.length === 0) return null;

  const aliases = meeting.speakerAliases ?? {};

  const commit = (speakerId: string, nextValue: string | null) => {
    const trimmed = nextValue?.trim() ?? "";
    const current = aliases[speakerId] ?? "";
    if (trimmed === current.trim()) return;
    // Replace-all: build the next map, set or clear this one key.
    const next: Record<string, string> = { ...aliases };
    if (trimmed.length === 0) {
      delete next[speakerId];
    } else {
      next[speakerId] = trimmed;
    }
    update.mutate({ aliases: next });
  };

  return (
    <section
      aria-label="Participants"
      className="border-b px-6 py-3"
      data-testid="participants-section"
    >
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Participants
      </h3>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {speakerIds.map((speakerId) => (
          <li key={speakerId} className="flex min-w-0 items-center gap-2">
            <SpeakerAvatar speakerId={speakerId} alias={aliases[speakerId]} />
            <ParticipantInput
              speakerId={speakerId}
              alias={aliases[speakerId] ?? ""}
              onCommit={(next) => commit(speakerId, next)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpeakerAvatar({ speakerId, alias }: { speakerId: string; alias: string | undefined }) {
  const initial = (alias?.trim() || speakerLabel(speakerId)).charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center",
        "rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground",
      )}
    >
      {initial || <User className="size-3" />}
    </span>
  );
}

function ParticipantInput({
  speakerId,
  alias,
  onCommit,
}: {
  speakerId: string;
  alias: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(alias);
  const [error, setError] = useState<string | null>(null);

  // Keep the draft in sync if the underlying value changes (e.g. a
  // refetch after another tab edited the alias). Same pattern as
  // `<EditableTitle/>`.
  useEffect(() => {
    setDraft(alias);
  }, [alias]);

  const placeholder = speakerLabel(speakerId);
  const tooLong = draft.length > MAX_DISPLAY_NAME_LENGTH;

  const commit = () => {
    if (tooLong) {
      setError(
        `Names must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer (currently ${draft.length}).`,
      );
      return;
    }
    setError(null);
    onCommit(draft);
  };

  const cancel = () => {
    setDraft(alias);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      e.currentTarget.blur();
    } else if (error) {
      setError(null);
    }
  };

  return (
    <Field className="min-w-0">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={`Rename ${placeholder}`}
        aria-invalid={tooLong || undefined}
        className="h-7 w-32 text-sm"
        maxLength={MAX_DISPLAY_NAME_LENGTH + 16}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
