import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Phase 4 / US-22 search input.
 *
 * The displayed value is local to the input so typing feels
 * responsive; we surface the *committed* query upward via
 * `onSubmit` after a 300ms idle pause OR when the user hits Enter.
 * That gives quick searches without flooding the backend during
 * mid-typing.
 *
 * Clearing the input commits an empty string immediately so the
 * History view can revert to the list mode without waiting for the
 * debounce.
 */
export interface SearchInputProps {
  value: string;
  onSubmit: (query: string) => void;
  placeholder?: string;
  className?: string;
}

const DEBOUNCE_MS = 300;

export function SearchInput({
  value,
  onSubmit,
  placeholder = "Search transcripts…",
  className,
}: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const lastSubmittedRef = useRef(value);

  // Keep draft in sync if parent forces a value reset (e.g. user
  // navigates away and back).
  useEffect(() => {
    setDraft(value);
    lastSubmittedRef.current = value;
  }, [value]);

  // Debounced commit. Clear-input is special — fire immediately so
  // the parent flips back to list mode without waiting.
  useEffect(() => {
    if (draft === lastSubmittedRef.current) return;
    if (draft === "") {
      lastSubmittedRef.current = "";
      onSubmit("");
      return;
    }
    const id = setTimeout(() => {
      if (draft === lastSubmittedRef.current) return;
      lastSubmittedRef.current = draft;
      onSubmit(draft);
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft, onSubmit]);

  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={draft}
        placeholder={placeholder}
        aria-label="Search meetings"
        className="pl-8 pr-8"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            lastSubmittedRef.current = draft;
            onSubmit(draft);
          }
          if (e.key === "Escape" && draft !== "") {
            e.preventDefault();
            setDraft("");
          }
        }}
      />
      {draft.length > 0 ? (
        <button
          type="button"
          onClick={() => setDraft("")}
          className="absolute right-2 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
