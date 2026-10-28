/** Response bodies: compression for JSON and static assets, and an
 *  in-memory, revalidating cache for the dashboard's static files.
 *
 *  The dashboard is usually reached over a tailnet, where the payloads that
 *  matter — a long chat's history (megabytes of JSON), the vendored JS/CSS —
 *  compress 5-10x. Static files also carry an ETag so a reload revalidates
 *  with a 304 instead of downloading ~2 MB again. */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Below this, compressing costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

export type Encoding = "br" | "gzip" | null;

/** Pick the response encoding from Accept-Encoding: brotli, then gzip.
 *  Ignores q-values except an explicit `;q=0` refusal. */
export function chooseEncoding(acceptEncoding: string | string[] | undefined): Encoding {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? "");
  const accepted = new Set<string>();
  for (const part of header.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    if (params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))) continue;
    accepted.add(name.trim());
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

/** Compress `body`. `level` trades CPU for size: "fast" for per-request
 *  bodies (JSON), "max" for static files that are compressed once. */
export async function compress(body: Buffer, encoding: "br" | "gzip", level: "fast" | "max"): Promise<Buffer> {
  if (encoding === "br") {
    return brotli(body, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: level === "max" ? 9 : 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return gzip(body, { level: level === "max" ? 9 : 4 });
}

/** Send `body` with the given headers, compressed when the client accepts it
 *  and it's big enough to be worth it. Compression runs on libuv's thread
 *  pool, so a multi-megabyte history doesn't stall the event loop. */
export function sendCompressible(
  req: IncomingMessage | undefined,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): void {
  const encoding = body.length >= MIN_COMPRESS_BYTES ? chooseEncoding(req?.headers["accept-encoding"]) : null;
  if (!encoding) {
    res.writeHead(status, { ...headers, "content-length": String(body.length) });
    res.end(body);
    return;
  }
  compress(body, encoding, "fast").then(
    (out) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        ...headers,
        "content-encoding": encoding,
        vary: "accept-encoding",
        "content-length": String(out.length),
      });
      res.end(out);
    },
    () => {
      if (res.destroyed) return;
      res.writeHead(status, { ...headers, "content-length": String(body.length) });
      res.end(body);
    },
  );
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  etag: string;
  raw: Buffer;
  encoded: Partial<Record<"br" | "gzip", Promise<Buffer>>>;
}

/** Content types worth compressing. Fonts (woff/woff2) and images are
 *  already compressed. */
function isCompressible(contentType: string): boolean {
  return /^(text\/|application\/(javascript|json)|image\/svg)/.test(contentType);
}

/** Serves files from disk with an ETag and cached, pre-compressed bodies.
 *  Every request still stats the file, so an in-place upgrade (`pru sync`,
 *  self-update) is picked up immediately. */
export class StaticFileCache {
  private files = new Map<string, CachedFile>();

  /** Returns false if the file can't be read (caller 404s). */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    headers: Record<string, string>,
  ): Promise<boolean> {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      this.files.delete(filePath);
      return false;
    }
    if (!st.isFile()) return false;
    let entry = this.files.get(filePath);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      let raw: Buffer;
      try {
        raw = await readFile(filePath);
      } catch {
        return false;
      }
      const hash = createHash("sha1").update(raw).digest("base64url").slice(0, 16);
      entry = { mtimeMs: st.mtimeMs, size: st.size, etag: `"${hash}"`, raw, encoded: {} };
      this.files.set(filePath, entry);
    }

    const contentType = headers["content-type"] ?? "";
    const compressible = isCompressible(contentType) && entry.raw.length >= MIN_COMPRESS_BYTES;
    const common: Record<string, string> = { ...headers, etag: entry.etag };
    if (compressible) common.vary = "accept-encoding";

    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === entry.etag)) {
      res.writeHead(304, common);
      res.end();
      return true;
    }

    const encoding = compressible ? chooseEncoding(req.headers["accept-encoding"]) : null;
    if (encoding) {
      const pending = (entry.encoded[encoding] ??= compress(entry.raw, encoding, "max"));
      try {
        const body = await pending;
        res.writeHead(200, { ...common, "content-encoding": encoding, "content-length": String(body.length) });
        res.end(body);
        return true;
      } catch {
        delete entry.encoded[encoding];
      }
    }
    res.writeHead(200, { ...common, "content-length": String(entry.raw.length) });
    res.end(entry.raw);
    return true;
  }
}
