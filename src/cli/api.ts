/** Shared HTTP client for talking to the pirouette server. */

const DEFAULT_BASE = "http://127.0.0.1:7777";

function baseUrl(): string {
  return process.env.PIROUETTE_URL ?? DEFAULT_BASE;
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
