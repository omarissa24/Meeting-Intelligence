import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeleteMeetingAudio } from "@/hooks/use-delete-meeting-audio";
import { useMeetingAudio } from "@/hooks/use-meeting-audio";

/**
 * Audio block lifecycle states. Resolved by the parent because only it
 * has the cross-render context (was the key ever non-null this mount?
 * how long ago did the meeting end?) needed to distinguish
 * "encode in flight" from "user just deleted" from "encode failed
 * permanently". The player is a pure renderer of these states.
 */
export type AudioState =
  | "loading" // detail query hasn't resolved yet
  | "hidden" // meeting still recording — block not rendered
  | "pending" // completed, no key yet, encode budget still running
  | "ready" // archived MP3 available
  | "deleted" // user just deleted in this mount (non-null → null observed)
  | "failed-encode" // encode budget elapsed in this mount without a key
  | "no-archive" // cold-start: completed long ago, no key, cause unknown
  | "unavailable"; // meeting status is "failed" — never going to have audio

interface MeetingAudioPlayerProps {
  meeting: MeetingDetail;
  state: AudioState;
}

/**
 * US-11 audio block in the meeting detail view. The state machine is
 * owned by the parent (`<MeetingDetailView/>`), which threads the
 * resolved state in here. See the `AudioState` doc above.
 */
export function MeetingAudioPlayer({ meeting, state }: MeetingAudioPlayerProps) {
  if (state === "hidden" || state === "loading") {
    return null;
  }

  return (
    <section aria-label="Meeting audio" className="flex flex-col gap-2 border-b px-6 py-4">
      <div className="text-eyebrow">Audio</div>
      <Body meeting={meeting} state={state} />
    </section>
  );
}

function Body({ meeting, state }: MeetingAudioPlayerProps) {
  switch (state) {
    case "ready":
      return <ReadyState meeting={meeting} />;
    case "pending":
      return <PreparingState />;
    case "deleted":
      return <StatusLine>Audio deleted.</StatusLine>;
    case "failed-encode":
      return <StatusLine>Audio archive failed. Try recording the meeting again.</StatusLine>;
    case "no-archive":
      // Cold-start with no key. Could be a previous-session delete,
      // a previous-session encode failure, or audio that was never
      // archived (worker offline). We can't tell from the row alone,
      // so copy is neutral.
      return <StatusLine>No audio archive for this meeting.</StatusLine>;
    case "unavailable":
      return <StatusLine>Audio unavailable for this meeting.</StatusLine>;
    default:
      // "hidden" / "loading" handled above; switch is exhaustive for the
      // rendered cases.
      return null;
  }
}

function PreparingState() {
  return (
    <div className="flex flex-col gap-2" data-testid="audio-preparing">
      <Skeleton className="h-9 w-full" />
      <p className="text-xs text-muted-foreground">Preparing audio…</p>
    </div>
  );
}

function StatusLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function ReadyState({ meeting }: { meeting: MeetingDetail }) {
  const audio = useMeetingAudio(meeting.id, meeting.audioObjectKey);

  if (audio.isPending) {
    return <PreparingState />;
  }

  if (audio.isError || !audio.data) {
    return (
      <div className="flex items-center justify-between gap-3">
        <StatusLine>Couldn&apos;t load the audio URL. Try again later.</StatusLine>
        <Button type="button" variant="outline" size="sm" onClick={() => void audio.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <audio controls preload="metadata" src={audio.data.audioUrl} className="h-10 w-full">
        <track kind="captions" />
      </audio>
      <div className="flex justify-end">
        <DeleteAudioButton meetingId={meeting.id} />
      </div>
    </div>
  );
}

function DeleteAudioButton({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteMeetingAudio(meetingId);

  const onConfirm = () => {
    del.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast.success("Audio deleted");
      },
      onError: () => {
        // Keep the dialog open so the user can retry without re-clicking
        // the trash icon. The toast tells them what happened.
        toast.error("Couldn't delete audio. Try again.");
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="size-4" aria-hidden />
        Delete audio
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete audio archive?</DialogTitle>
          <DialogDescription>
            The transcript stays. The MP3 is removed permanently and can&apos;t be re-generated for
            this meeting.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={del.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={del.isPending}>
            {del.isPending ? "Deleting…" : "Delete audio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
