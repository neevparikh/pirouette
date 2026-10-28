/** Shared HTTP client for talking to the pirouette server.
 *
 *  Base URL precedence (highest to lowest):
 *    1. `PIROUETTE_URL` env var — always wins; useful for local-dev
 *       (`http://127.0.0.1:7777`) or an emergency override.
 *    2. `public_url` of the selected host (`--host` / `default_host`) — the
 *       canonical dashboard address (typically a Tailscale HTTPS URL).
 *    3. Refuse — throw a clear error directing the user to set one of these.
 */

async function baseUrl(): Promise<string> {
  const fromEnv = process.env.PIROUETTE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  // Loaded only when needed: inside an agent PIROUETTE_URL is always set,
  // and parsing config is a measurable share of a quick command's runtime.
  const { resolveSelectedHost } = await import("../config.js");
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

/** Fetch `path` from the server. Talking to a server on this machine (as
 *  every agent does), ask for an uncompressed response: compressing it
 *  would cost the server more time than it saves on a loopback socket. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await baseUrl();
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) {
    init = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "accept-encoding": "identity" } };
  }
  return fetch(`${base}${path}`, init);
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
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

/** Upload raw bytes to POST /api/uploads; resolves to the saved file's
 *  `{ path, name, size }` on the server host. */
export async function apiUpload<T = unknown>(name: string, data: Uint8Array<ArrayBuffer>): Promise<T> {
  const res = await request(`/api/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: data,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await request(path, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getWebUrl(): Promise<string> {
  return baseUrl();
}
