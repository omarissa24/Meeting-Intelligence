import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import App from "@/App";
import { ThemeProvider } from "@/components/theme-provider";
import { resolveClientVersion } from "@/lib/config";
import { applyThemeClass, readCachedPreference, resolveTheme } from "@/lib/theme";
import { queryClient } from "@/lib/query-client";
import "@/styles/globals.css";

// Apply the cached theme synchronously, before the first paint, so the
// window never flashes light and then flips to a chosen dark theme. The
// ThemeProvider takes over with the durable preference once the settings
// store hydrates (US-27).
applyThemeClass(resolveTheme(readCachedPreference()));

// Resolve the real bundle version (one IPC round-trip) before first
// render so the footer / Settings / WS hello never show the fallback.
void resolveClientVersion().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});
