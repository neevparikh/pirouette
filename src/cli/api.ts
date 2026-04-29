/** Shared HTTP client for talking to the pirouette server.
 *
 *  Base URL precedence (highest to lowest):
 *    1. `PIROUETTE_URL` env var \u2014 always wins; useful for local-dev (`npm
 *       run dev` → `http://127.0.0.1:7777`) or for an emergency override.
 *    2. `server.public_url` from the merged TOML config \u2014 the canonical
 *       address you reach the dashboard at (typically a Tailscale HTTPS
 *       URL set up via `tailscale serve`).
 *    3. Refuse \u2014 throw a clear error directing the user to set one of
 *       the above. There used to be a "fall back to localhost via an
 *       SSH tunnel" default; we removed it because it relied on a
 *       background `pru open` step that's easy to forget about and
 *       silently produces "connection refused" when stale.
 */

import { getConfig } from "../config.js";

function baseUrl(): string {
  const fromEnv = process.env.PIROUETTE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const cfg = getConfig();
  const fromConfig = cfg.server?.public_url ?? "";
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  throw new Error(
    "No pirouette server URL configured. Set `server.public_url` in " +
      "~/.pirouette/config.toml (e.g. \"https://pirouette-<you>.<tailnet>.ts.net\") " +
      "or export PIROUETTE_URL for this shell.",
  );
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getWebUrl(): string {
  return baseUrl();
}
