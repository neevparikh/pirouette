import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chooseEncoding, sendCompressible, StaticFileCache } from "../http-body.js";

describe("chooseEncoding", () => {
  it("prefers brotli, then gzip", () => {
    expect(chooseEncoding("gzip, deflate, br")).toBe("br");
    expect(chooseEncoding("gzip, deflate")).toBe("gzip");
    expect(chooseEncoding("deflate")).toBeNull();
    expect(chooseEncoding(undefined)).toBeNull();
  });

  it("honours an explicit q=0 refusal", () => {
    expect(chooseEncoding("br;q=0, gzip")).toBe("gzip");
    expect(chooseEncoding("br;q=0.0, gzip;q=0")).toBeNull();
    expect(chooseEncoding("br;q=0.5")).toBe("br");
  });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const gunzip = promisify(zlib.gunzip);
const unbrotli = promisify(zlib.brotliDecompress);

describe("response compression and static caching", () => {
  let server: Server;
  let port: number;
  let dir: string;
  const big = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ i, text: "hello world" })) });
  const files = new StaticFileCache();

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pirouette-http-body-"));
    writeFileSync(path.join(dir, "app.js"), "console.log('x');\n".repeat(200));
    writeFileSync(path.join(dir, "tiny.js"), "1");
    writeFileSync(path.join(dir, "font.woff2"), Buffer.alloc(4096, 7));
    server = createServer((req, res) => {
      if (req.url === "/json") {
        sendCompressible(req, res, 200, { "content-type": "application/json" }, Buffer.from(big));
        return;
      }
      const name = (req.url ?? "/").slice(1);
      const type = name.endsWith(".js") ? "application/javascript; charset=utf-8" : "font/woff2";
      void files.serve(req, res, path.join(dir, name), { "content-type": type, "cache-control": "no-cache" }).then((ok) => {
        if (!ok) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("compresses JSON for clients that accept it, and not otherwise", async () => {
    const br = await get(port, "/json", { "accept-encoding": "gzip, br" });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers.vary).toBe("accept-encoding");
    expect((await unbrotli(br.body)).toString()).toBe(big);
    expect(Number(br.headers["content-length"])).toBe(br.body.length);

    const gz = await get(port, "/json", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect((await gunzip(gz.body)).toString()).toBe(big);

    const plain = await get(port, "/json");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(big);
  });

  it("serves static files with an ETag and answers a matching revalidation with 304", async () => {
    const first = await get(port, "/app.js", { "accept-encoding": "br" });
    expect(first.status).toBe(200);
    expect(first.headers["content-encoding"]).toBe("br");
    expect(first.headers["cache-control"]).toBe("no-cache");
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await get(port, "/app.js", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);

    const weak = await get(port, "/app.js", { "if-none-match": `W/${etag}` });
    expect(weak.status).toBe(304);
  });

  it("picks up a file changed on disk", async () => {
    const before = await get(port, "/app.js");
    writeFileSync(path.join(dir, "app.js"), "console.log('changed');\n".repeat(200));
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "app.js"), future, future);
    const after = await get(port, "/app.js", { "if-none-match": before.headers.etag as string });
    expect(after.status).toBe(200);
    expect(after.body.toString()).toContain("changed");
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it("leaves tiny and already-compressed files alone", async () => {
    const tiny = await get(port, "/tiny.js", { "accept-encoding": "br" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.body.toString()).toBe("1");
    const font = await get(port, "/font.woff2", { "accept-encoding": "br" });
    expect(font.headers["content-encoding"]).toBeUndefined();
    expect(font.body.length).toBe(4096);
  });

  it("reports a missing file to the caller", async () => {
    expect((await get(port, "/missing.js")).status).toBe(404);
  });
});
