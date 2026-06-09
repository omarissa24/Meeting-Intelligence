/**
 * Centralised backend URL resolution. Override per environment via
 * `VITE_BACKEND_URL` — e.g. `VITE_BACKEND_URL=https://api.example.com` to
 * point a packaged build at production.
 */

const RAW = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim();

export const BACKEND_HTTP_URL = RAW && RAW.length > 0 ? RAW : "http://localhost:8000";

export const BACKEND_WS_URL = BACKEND_HTTP_URL.replace(/^http/, "ws");

/** True in production bundles (`tauri:build`); false under `tauri:dev`. */
export const IS_PRODUCTION = import.meta.env.PROD;

export const CLIENT_VERSION = "0.0.0-foundation";
