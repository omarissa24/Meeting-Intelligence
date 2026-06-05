import { useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ActionItem,
  // Aliased to avoid colliding with the exported `MeetingSummary`
  // component below (eslint no-redeclare).
  MeetingSummary as MeetingSummaryData,
  PatchActionItemRequest,
  SummaryStatus,
  Topic,
} from "@meeting-intelligence/shared-types";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface MeetingSummaryProps {
  meetingId: string;
  summary: MeetingSummaryData | null;
  status: SummaryStatus;
  onRegenerate: () => void;
  isRegenerating: boolean;
  onPatchActionItem: (itemId: string, body: PatchActionItemRequest) => void;
}

/**
 * Phase-3 meeting summary card. Slots into both meeting-detail-view
 * and session-ended-view. The five rendered states correspond exactly
 * to the SummaryStatus literal:
 *
 *   pending    → "Generating summary…" loader (the Celery task hasn't
 *                upserted the row yet, but the WS finalize dispatched
 *                it; treated indistinguishably from "processing" by
 *                the user — it's all "we're working on it").
 *   processing → same loader; just one tick later.
 *   completed  → prose summary + decisions + action items + topics.
 *   too_short  → "Recording too short to summarise."
 *   failed     → error card with Retry button.
 *
 * The action-item list is the only mutating surface — completion
 * toggle and per-field inline edit. Buttons (Copy / Export /
 * Regenerate) are chrome.
 */
export function MeetingSummary({
  meetingId,
  summary,
  status,
  onRegenerate,
  isRegenerating,
  onPatchActionItem,
}: MeetingSummaryProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (status === "pending" || status === "processing") {
    return <LoadingCard />;
  }

  if (status === "too_short") {
    return (
      <Card>
        <Header icon={<Sparkles className="size-4" aria-hidden />} title="Summary" />
        <p className="px-5 pb-5 text-sm text-muted-foreground">Recording too short to summarise.</p>
      </Card>
    );
  }

  if (status === "failed" || !summary) {
    return (
      <Card>
        <Header
          icon={<AlertCircle className="size-4 text-destructive" aria-hidden />}
          title="Summary"
        />
        <div className="flex flex-col gap-3 px-5 pb-5">
          <p className="text-sm text-muted-foreground">
            {summary?.error ?? "We couldn't generate a summary for this meeting."}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRegenerate}
              disabled={isRegenerating}
            >
              <RefreshCw
                data-icon="inline-start"
                className={cn("size-4", isRegenerating && "animate-spin")}
              />
              {isRegenerating ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // status === "completed"
  return (
    <Card>
      <Header
        icon={<Sparkles className="size-4" aria-hidden />}
        title="Summary"
        right={
          <ButtonRow
            summary={summary}
            meetingId={meetingId}
            onRegenerateRequested={() => setConfirmOpen(true)}
            isRegenerating={isRegenerating}
          />
        }
      />
      <div className="flex flex-col gap-5 px-5 pb-5">
        {summary.summary ? (
          <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
            {summary.summary}
          </p>
        ) : null}

        {summary.confidenceLow ? (
          <p className="text-xs italic text-muted-foreground">
            Speaker diarisation was uncertain on this recording — fewer than two distinct speakers
            detected. Decisions and action items may be less reliable.
          </p>
        ) : null}

        <Section title="Decisions">
          {summary.decisions.length === 0 ? (
            <EmptyLine>No decisions recorded.</EmptyLine>
          ) : (
            <ol className="ml-5 list-decimal text-sm text-foreground [&>li]:py-0.5">
              {summary.decisions.map((d, idx) => (
                <li key={idx}>{d}</li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Action items">
          {summary.actionItems.length === 0 ? (
            <EmptyLine>No action items recorded.</EmptyLine>
          ) : (
            <ul className="flex flex-col gap-2">
              {summary.actionItems.map((item) => (
                <ActionItemRow
                  key={item.id}
                  item={item}
                  onPatch={(body) => onPatchActionItem(item.id, body)}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Topics">
          {summary.topics.length === 0 ? (
            <EmptyLine>No topics recorded.</EmptyLine>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-foreground">
              {summary.topics.map((t, idx) => (
                <li key={idx} className="flex items-baseline gap-2">
                  <span>{t.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatTopicDuration(t)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <ConfirmRegenerateDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          onRegenerate();
        }}
      />
    </Card>
  );
}

// ---- subcomponents -------------------------------------------------------

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card text-card-foreground elevation-card">
      {children}
    </section>
  );
}

function Header({
  icon,
  title,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b px-5 py-3">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-title">{title}</h3>
      </div>
      {right}
    </header>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-eyebrow">{title}</h4>
      {children}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm italic text-muted-foreground">{children}</p>;
}

function LoadingCard() {
  return (
    <Card>
      <Header icon={<Sparkles className="size-4" aria-hidden />} title="Summary" />
      <div className="flex flex-col gap-3 px-5 pb-5">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Generating summary…
        </p>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>
    </Card>
  );
}

function ButtonRow({
  summary,
  meetingId,
  onRegenerateRequested,
  isRegenerating,
}: {
  summary: MeetingSummaryData;
  meetingId: string;
  onRegenerateRequested: () => void;
  isRegenerating: boolean;
}) {
  const handleCopySummary = async () => {
    const text = renderSummaryMarkdown(summary);
    if (!text.trim()) {
      toast.message("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Summary copied");
    } catch (err) {
      console.error("clipboard write failed", err);
      toast.error("Couldn't copy summary");
    }
  };

  const handleCopyActionItems = async () => {
    if (summary.actionItems.length === 0) {
      toast.message("No action items to copy");
      return;
    }
    const text = renderActionItemsMarkdown(summary.actionItems);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Action items copied");
    } catch (err) {
      console.error("clipboard write failed", err);
      toast.error("Couldn't copy action items");
    }
  };

  const handleExport = async () => {
    try {
      const res = await apiFetch({ path: `/meetings/${meetingId}/export` });
      if (!res.ok) {
        toast.error("Export failed");
        return;
      }
      const text = await res.text();
      // Tauri 2's webview doesn't honor the blob+anchor `<a download>`
      // trick — it silently no-ops. Go through the dialog + fs plugins
      // instead. `save()` returns null when the user cancels the
      // picker; we treat that as a clean abort, no toast.
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: `meeting-${meetingId}.txt`,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, text);
      toast.success("Summary exported");
    } catch (err) {
      console.error("export failed", err);
      toast.error("Export failed");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopySummary}
        aria-label="Copy summary"
      >
        <Copy data-icon="inline-start" className="size-4" />
        Copy
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleCopyActionItems}
        aria-label="Copy action items"
      >
        <Copy data-icon="inline-start" className="size-4" />
        Action items
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleExport}
        aria-label="Export as text"
      >
        <ArrowDownToLine data-icon="inline-start" className="size-4" />
        Export
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRegenerateRequested}
        disabled={isRegenerating}
        aria-label="Regenerate summary"
      >
        <RefreshCw
          data-icon="inline-start"
          className={cn("size-4", isRegenerating && "animate-spin")}
        />
        Regenerate
      </Button>
    </div>
  );
}

function ConfirmRegenerateDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate this summary?</DialogTitle>
          <DialogDescription>
            The current summary, decisions, action items, and topics will be replaced with a fresh
            pass over the transcript. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={onConfirm}>
            Regenerate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionItemRow({
  item,
  onPatch,
}: {
  item: ActionItem;
  onPatch: (body: PatchActionItemRequest) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftDescription, setDraftDescription] = useState(item.description);
  const [draftOwner, setDraftOwner] = useState(item.owner ?? "");
  const [draftDeadline, setDraftDeadline] = useState(item.deadline ?? "");

  // Keep the drafts in sync if the underlying item changes (e.g. a
  // refetch landed mid-edit). Editing state stays open so the user
  // doesn't lose their cursor; the visible inputs just update.
  const itemKey = useMemo(
    () => `${item.id}:${item.description}:${item.owner}:${item.deadline}`,
    [item.id, item.description, item.owner, item.deadline],
  );

  const beginEdit = () => {
    setDraftDescription(item.description);
    setDraftOwner(item.owner ?? "");
    setDraftDeadline(item.deadline ?? "");
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const body: PatchActionItemRequest = {};
    const trimmedDesc = draftDescription.trim();
    if (trimmedDesc && trimmedDesc !== item.description) {
      body.description = trimmedDesc;
    }
    const trimmedOwner = draftOwner.trim();
    const nextOwner = trimmedOwner || null;
    if (nextOwner !== item.owner) {
      body.owner = nextOwner;
    }
    const nextDeadline = draftDeadline || null;
    if (nextDeadline !== item.deadline) {
      body.deadline = nextDeadline;
    }
    if (Object.keys(body).length > 0) {
      onPatch(body);
    }
  };

  return (
    <li
      key={itemKey}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 transition-fast",
        item.completed && "opacity-70",
      )}
    >
      <Switch
        checked={item.completed}
        onCheckedChange={(next) => onPatch({ completed: next })}
        aria-label={`Mark "${item.description}" ${item.completed ? "incomplete" : "complete"}`}
        className="mt-0.5"
      />
      <div className="flex flex-1 flex-col gap-1.5">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Input
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              aria-label="Action item description"
              className="h-8"
              autoFocus
            />
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`owner-${item.id}`} className="text-xs">
                  Owner
                </Label>
                <Input
                  id={`owner-${item.id}`}
                  value={draftOwner}
                  onChange={(e) => setDraftOwner(e.target.value)}
                  onBlur={commit}
                  placeholder="Unassigned"
                  className="h-8 w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`deadline-${item.id}`} className="text-xs">
                  Deadline
                </Label>
                <Input
                  id={`deadline-${item.id}`}
                  type="date"
                  value={draftDeadline}
                  onChange={(e) => setDraftDeadline(e.target.value)}
                  onBlur={commit}
                  className="h-8 w-40"
                />
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <p
                className={cn(
                  "text-sm text-foreground",
                  item.completed && "line-through text-muted-foreground",
                )}
              >
                {item.description}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={beginEdit}
                aria-label={`Edit "${item.description}"`}
                className="-mr-1 -mt-1"
              >
                <Pencil className="size-3.5" aria-hidden />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <span>{item.owner ?? "Unassigned"}</span>
              <span className="px-1">·</span>
              <span>{item.deadline ?? "No deadline set"}</span>
            </p>
          </>
        )}
      </div>
    </li>
  );
}

// ---- formatters ----------------------------------------------------------

function formatTopicDuration(t: Topic): string {
  const total = Math.max(0, Math.floor(t.durationSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function renderSummaryMarkdown(summary: MeetingSummaryData): string {
  const parts: string[] = [];
  if (summary.summary) {
    parts.push("# Summary", "", summary.summary, "");
  }
  parts.push("# Decisions");
  if (summary.decisions.length === 0) {
    parts.push("- _No decisions recorded._");
  } else {
    summary.decisions.forEach((d, i) => parts.push(`${i + 1}. ${d}`));
  }
  parts.push("");
  parts.push("# Action items");
  if (summary.actionItems.length === 0) {
    parts.push("- _No action items recorded._");
  } else {
    for (const item of summary.actionItems) {
      const check = item.completed ? "[x]" : "[ ]";
      const owner = item.owner ?? "Unassigned";
      const deadline = item.deadline ?? "No deadline";
      parts.push(`- ${check} ${item.description} — ${owner} — ${deadline}`);
    }
  }
  parts.push("");
  parts.push("# Topics");
  if (summary.topics.length === 0) {
    parts.push("- _No topics recorded._");
  } else {
    for (const t of summary.topics) {
      parts.push(`- ${t.name} (${formatTopicDuration(t)})`);
    }
  }
  return parts.join("\n");
}

export function renderActionItemsMarkdown(items: ActionItem[]): string {
  return items
    .map((item) => {
      const check = item.completed ? "[x]" : "[ ]";
      const owner = item.owner ?? "Unassigned";
      const deadline = item.deadline ?? "No deadline";
      return `- ${check} ${item.description} — ${owner} — ${deadline}`;
    })
    .join("\n");
}
