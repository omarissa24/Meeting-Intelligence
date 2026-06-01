import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Phase-1 DoD line 85 names three modules. We measure coverage on
      // the lib utilities that back the WS reconnect story; the audit's
      // gap was reconnecting-ws-client.ts, with audio-buffer.ts and
      // backoff.ts already well-covered. Including the whole lib/ keeps
      // future additions visible without per-file allowlisting.
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/*.test.ts",
        "src/lib/**/*.d.ts",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
