import { useEffect } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Phase-2 login gate. Single primary action — `Sign in` opens the
 * AuthKit hosted flow in the system browser. The deep-link handler
 * does the rest; this view just shows the entry point and any error
 * surfaced from the round-trip.
 *
 * Aesthetic stays in the design-system pocket: warm-paper canvas,
 * Geist throughout. No raw colors — `bg-card`,
 * `text-muted-foreground`, etc. so a future dark-mode flip works
 * without per-screen overrides.
 */
export function LoginView() {
  const startLogin = useAuthStore((s) => s.startLogin);
  const pending = useAuthStore((s) => s.pending);
  const errorMessage = useAuthStore((s) => s.errorMessage);

  // Surface backend / deep-link errors via the shared toaster so the
  // user sees what happened without us re-implementing the toast UI
  // inside this view.
  useEffect(() => {
    if (errorMessage) toast.error(errorMessage);
  }, [errorMessage]);

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background app-atmosphere px-8 text-foreground">
      <div className="flex w-full max-w-sm animate-rise-in flex-col items-stretch gap-8 text-center">
        <div className="flex flex-col gap-3">
          <span className="inline-flex items-center justify-center gap-2 text-eyebrow">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            Meeting Intelligence
          </span>
          <h1 className="font-display text-4xl font-normal leading-tight tracking-tight">
            Sign in to continue
          </h1>
          <p className="text-sm text-muted-foreground">
            We&rsquo;ll open your browser to authenticate. Once signed in, you&rsquo;ll come right
            back here.
          </p>
        </div>

        <Button
          type="button"
          size="lg"
          onClick={() => {
            void startLogin();
          }}
          disabled={pending}
          className="h-11 w-full"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Waiting for the browser…
            </>
          ) : (
            "Sign in"
          )}
        </Button>

        {pending ? (
          <p className="text-xs text-muted-foreground">
            Complete the sign-in in your browser. This window will pick up the session as soon as
            the redirect lands.
          </p>
        ) : null}
      </div>
    </div>
  );
}
