import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * Thin seam over the Tauri updater + process plugins so the update flow
 * is testable: vitest mocks this module (same pattern as audio-bridge)
 * and the Zustand update-store stays free of Tauri imports.
 *
 * The staged `Update` handle lives here as module state rather than in
 * the store — it's a plugin resource (Rust-side handle), not UI state,
 * and keeping it out of Zustand means store snapshots stay plain data.
 */

let stagedUpdate: Update | null = null;

/**
 * Ask the backend's self-hosted manifest endpoint (configured in
 * tauri.conf.json `plugins.updater.endpoints`) whether a newer signed
 * build exists. Returns `null` when already current (HTTP 204).
 */
export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** Download the update's artifact in the background and stage it for install. */
export async function downloadUpdate(update: Update): Promise<void> {
  await update.download();
  stagedUpdate = update;
}

export function hasStagedUpdate(): boolean {
  return stagedUpdate !== null;
}

/**
 * Apply the staged update and relaunch. On Windows the installer exits
 * the app itself, so `relaunch()` may never run — that's expected; the
 * installer brings the app back up.
 */
export async function installStagedUpdate(): Promise<void> {
  if (!stagedUpdate) {
    throw new Error("no staged update to install");
  }
  await stagedUpdate.install();
  await relaunch();
}

/** Test helper / logout hygiene: drop any staged update. */
export function clearStagedUpdate(): void {
  stagedUpdate = null;
}
