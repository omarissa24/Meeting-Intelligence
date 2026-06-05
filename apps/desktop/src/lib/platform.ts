/**
 * Synchronous platform probe. We avoid `@tauri-apps/plugin-os` here on
 * purpose: keyboard-shortcut wiring only needs "is this a Mac?" to pick
 * the primary modifier (⌘ vs Ctrl), and that answer is available from
 * the webview's `navigator` without an async IPC round-trip.
 *
 * `navigator.platform` is deprecated but still the most reliable Mac
 * signal inside a WebKit/WebView2 host; we fall back to `userAgent`.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac os x/i.test(ua);
}
