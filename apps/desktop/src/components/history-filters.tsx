import { useMemo, useState } from "react";
import { Filter, X } from "lucide-react";
import type {
  Meeting,
  MeetingFilters,
} from "@meeting-intelligence/shared-types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Phase 4 / US-23 history filter toolbar.
 *
 * Controlled component — parent owns the filter state and passes
 * `onChange` to receive committed filter values. The toolbar is a
 * single inline row of summary chips by default; clicking the filter
 * button opens a popover with the editable inputs (date range,
 * duration min/max in minutes, tag chip multi-select).
 *
 * Design system: only semantic tokens (`text-muted-foreground`,
 * `bg-muted/40`, `--ring`). Reuses the chip visual from the editable
 * tag list in `meeting-detail-view.tsx` — `Badge variant="secondary"`
 * with selected-state ring outline. Tags are sourced from the parent
 * (already-loaded meetings); we don't make an extra round trip just
 * to populate a tag picker.
 */
export interface HistoryFiltersProps {
  filters: MeetingFilters;
  onChange: (next: MeetingFilters) => void;
  meetings: Meeting[];
}

export function HistoryFilters({ filters, onChange, meetings }: HistoryFiltersProps) {
  const [open, setOpen] = useState(false);
  const tagOptions = useMemo(() => collectTags(meetings), [meetings]);
  const summary = describeFilters(filters);
  const isActive = !isEmpty(filters);

  return (
    <div className="flex items-center gap-2 px-6 py-3 border-b">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
          >
            <Filter className="size-3.5" aria-hidden />
            Filters
            {isActive ? (
              <Badge
                variant="secondary"
                className="ml-1 h-5 px-1.5 text-[10px] font-normal"
              >
                {summary.length}
              </Badge>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 gap-4 p-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-date-start" className="text-xs">
                From
              </Label>
              <Input
                id="filter-date-start"
                type="date"
                value={filters.dateStart ?? ""}
                onChange={(e) =>
                  onChange({ ...filters, dateStart: e.target.value || null })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-date-end" className="text-xs">
                To
              </Label>
              <Input
                id="filter-date-end"
                type="date"
                value={filters.dateEnd ?? ""}
                onChange={(e) =>
                  onChange({ ...filters, dateEnd: e.target.value || null })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-dur-min" className="text-xs">
                Min minutes
              </Label>
              <Input
                id="filter-dur-min"
                type="number"
                min={0}
                placeholder="0"
                value={
                  filters.durationMinSeconds != null
                    ? String(Math.round(filters.durationMinSeconds / 60))
                    : ""
                }
                onChange={(e) =>
                  onChange({
                    ...filters,
                    durationMinSeconds: parseMinutesToSeconds(e.target.value),
                  })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="filter-dur-max" className="text-xs">
                Max minutes
              </Label>
              <Input
                id="filter-dur-max"
                type="number"
                min={0}
                placeholder="∞"
                value={
                  filters.durationMaxSeconds != null
                    ? String(Math.round(filters.durationMaxSeconds / 60))
                    : ""
                }
                onChange={(e) =>
                  onChange({
                    ...filters,
                    durationMaxSeconds: parseMinutesToSeconds(e.target.value),
                  })
                }
              />
            </div>
          </div>

          {tagOptions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Tags</Label>
              <div className="flex flex-wrap gap-1.5">
                {tagOptions.map((tag) => {
                  const selected = (filters.tags ?? []).includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => onChange(toggleTag(filters, tag))}
                      className={cn(
                        "transition-shadow",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md",
                      )}
                      aria-pressed={selected}
                    >
                      <Badge
                        variant={selected ? "default" : "secondary"}
                        className={cn("font-normal", !selected && "opacity-70")}
                      >
                        {tag}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-2 border-t -mx-4 px-4 -mb-4 pb-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({})}
              disabled={!isActive}
            >
              Clear all
            </Button>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {isActive ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {summary.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onChange(chip.clear(filters))}
              className="group inline-flex items-center gap-1 rounded-md bg-muted/40 hover:bg-muted px-2 py-0.5 text-xs"
              aria-label={`Remove ${chip.label} filter`}
            >
              <span>{chip.label}</span>
              <X className="size-3 text-muted-foreground group-hover:text-foreground" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface FilterChip {
  key: string;
  label: string;
  /** Returns a copy of `filters` with this chip's filter cleared. */
  clear: (filters: MeetingFilters) => MeetingFilters;
}

function describeFilters(filters: MeetingFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.dateStart || filters.dateEnd) {
    const a = filters.dateStart ?? "…";
    const b = filters.dateEnd ?? "…";
    chips.push({
      key: "date",
      label: `${a} → ${b}`,
      clear: (f) => ({ ...f, dateStart: null, dateEnd: null }),
    });
  }
  if (
    filters.durationMinSeconds != null ||
    filters.durationMaxSeconds != null
  ) {
    const min =
      filters.durationMinSeconds != null
        ? `${Math.round(filters.durationMinSeconds / 60)}m`
        : "0m";
    const max =
      filters.durationMaxSeconds != null
        ? `${Math.round(filters.durationMaxSeconds / 60)}m`
        : "∞";
    chips.push({
      key: "duration",
      label: `${min} – ${max}`,
      clear: (f) => ({
        ...f,
        durationMinSeconds: null,
        durationMaxSeconds: null,
      }),
    });
  }
  for (const tag of filters.tags ?? []) {
    chips.push({
      key: `tag:${tag}`,
      label: tag,
      clear: (f) => ({
        ...f,
        tags: (f.tags ?? []).filter((t) => t !== tag),
      }),
    });
  }
  return chips;
}

function isEmpty(filters: MeetingFilters): boolean {
  return (
    !filters.dateStart &&
    !filters.dateEnd &&
    filters.durationMinSeconds == null &&
    filters.durationMaxSeconds == null &&
    (!filters.tags || filters.tags.length === 0)
  );
}

function collectTags(meetings: Meeting[]): string[] {
  const set = new Set<string>();
  for (const m of meetings) {
    for (const t of m.tags ?? []) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function toggleTag(filters: MeetingFilters, tag: string): MeetingFilters {
  const current = filters.tags ?? [];
  const next = current.includes(tag)
    ? current.filter((t) => t !== tag)
    : [...current, tag];
  return { ...filters, tags: next.length > 0 ? next : undefined };
}

function parseMinutesToSeconds(raw: string): number | null {
  if (!raw.trim()) return null;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.round(minutes * 60);
}
