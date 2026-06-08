import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A keycap. Used by the Keyboard Shortcuts panel (US-28) to render a
 * combo like ⌘R. Semantic-token styled so it adapts to dark mode with
 * the rest of the app — no hardcoded colors.
 */
const Kbd = React.forwardRef<HTMLElement, React.ComponentProps<"kbd">>(function Kbd(
  { className, ...props },
  ref,
) {
  return (
    <kbd
      ref={ref}
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
});
Kbd.displayName = "Kbd";

export { Kbd };
