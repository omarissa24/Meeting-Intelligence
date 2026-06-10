import type { CSSProperties } from "react";
import { ArrowRight, History as HistoryIcon } from "lucide-react";
import type { Meeting } from "@meeting-intelligence/shared-types";

import { ListSkeleton, MeetingRow } from "@/components/meeting-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMeetingsList } from "@/hooks/use-meetings-list";
import { useUiStore } from "@/stores/ui-store";

const RECENT_COUNT = 5;

/**
 * The home screen's "Recent meetings" section — the idle state used to
 * be a giant empty transcript card; this puts the user's actual work
 * there instead. Reuses the unfiltered `useMeetingsList` cache (same
 * query key as HistoryView's default list, and `use-recording.ts`
 * invalidates `["meetings"]` after a session, so the list self-refreshes
 * when a recording ends).
 */
export function RecentMeetings() {
  const goHistory = useUiStore((s) => s.goHistory);
  const openMeeting = useUiStore((s) => s.openMeeting);

  const listQuery = useMeetingsList();
  const meetings: Meeting[] = listQuery.data?.pages[0]?.items.slice(0, RECENT_COUNT) ?? [];

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <h2 className="text-title">Recent meetings</h2>
        <Button type="button" variant="ghost" size="sm" onClick={goHistory}>
          View all
          <ArrowRight data-icon="inline-end" />
        </Button>
      </header>

      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        {listQuery.isPending ? (
          <ListSkeleton rows={3} />
        ) : listQuery.isError ? (
          <Empty className="m-6 flex-1 border">
            <EmptyHeader>
              <EmptyTitle className="text-title">Couldn&apos;t load meetings</EmptyTitle>
              <EmptyDescription>
                The backend didn&apos;t respond. Check your connection and try again.
              </EmptyDescription>
            </EmptyHeader>
            <Button type="button" variant="outline" onClick={() => void listQuery.refetch()}>
              Retry
            </Button>
          </Empty>
        ) : meetings.length === 0 ? (
          <Empty className="m-6 flex-1 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle className="text-title">Your meetings will live here</EmptyTitle>
              <EmptyDescription>
                Record your first meeting and its transcript and summary land in this list.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea type="auto" className="min-h-0 flex-1">
            <ol className="flex flex-col">
              {meetings.map((m, i) => (
                <li
                  key={m.id}
                  className="stagger-item animate-line-in"
                  style={{ "--stagger-index": i } as CSSProperties}
                >
                  <MeetingRow meeting={m} onOpen={() => openMeeting(m.id)} />
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
