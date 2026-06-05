/** Shared HTTP client for talking to the pirouette server.
 *
 *  Base URL precedence (highest to lowest):
 *    1. `PIROUETTE_URL` env var — always wins; useful for local-dev
 *       (`http://127.0.0.1:7777`) or an emergency override.
 *    2. `public_url` of the selected host (`--host` / `default_host`) — the
 *       canonical dashboard address (typically a Tailscale HTTPS URL).
 *    3. Refuse — throw a clear error directing the user to set one of these.
 */

import { resolveSelectedHost } from "../config.js";

function baseUrl(): string {
  const fromEnv = process.env.PIROUETTE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  let host;
  try {
    host = resolveSelectedHost();
  } catch (err) {
    throw new Error(
      "No pirouette server URL. Export PIROUETTE_URL, or configure " +
        "hosts.<name>.public_url and select it with --host.\n" +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (host.public_url) return host.public_url.replace(/\/+$/, "");
  throw new Error(
    `No dashboard URL for host "${host.name}". Set hosts.${host.name}.public_url ` +
      `in ~/.pirouette/config.toml (e.g. "https://pirouette-<you>.<tailnet>.ts.net"), ` +
      `or export PIROUETTE_URL for this shell.`,
  );
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getWebUrl(): string {
  return baseUrl();
}
