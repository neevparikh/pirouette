/**
 * Server security middleware tests.
 *
 * Boots the real `runServer` against a tmp dataDir on a random port and
 * exercises the network-layer guards we added in 0.2.1:
 *   - Host header allowlist (rejects DNS-rebinding and arbitrary Host)
 *   - CORS removal (no Access-Control-Allow-* in any response)
 *   - OPTIONS preflight refusal (405, no allow headers)
 *   - WS upgrade Origin validation (rejects mismatched Origin)
 *   - Static path-traversal guard (no escaping webDir)
 *   - agentId / agent name input validation
 *
 * These don't depend on any pi extensions, agents, or external services
 * \u2014 they live in the request-routing layer that runs before agent
 * resolution. We use a shadow webDir so the static-file checks have a
 * known directory layout without depending on `dist/web/`.
 */

import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { runServer, type ServerHandle } from "../index.js";

let handle: ServerHandle;
let port: number;
let dataDir: string;
let webDir: string;

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "pir-sec-test-"));
  webDir = mkdtempSync(path.join(tmpdir(), "pir-sec-web-"));
  // Minimal index.html so requests to / return 200 instead of 404
  // (which would mask the host-validation failures with the same status).
  writeFileSync(path.join(webDir, "index.html"), "<html>test</html>");
  // A subdir so we can verify nested fetches work.
  mkdirSync(path.join(webDir, "vendor"), { recursive: true });
  writeFileSync(path.join(webDir, "vendor", "lib.js"), "// vendored");

  handle = await runServer({ port, host: "127.0.0.1", dataDir, webDir });
});

afterAll(async () => {
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(webDir, { recursive: true, force: true });
});

/** Send an HTTP request with a custom Host header.
 *
 *  Node's `fetch` (undici) strips any user-set `Host` and synthesizes one
 *  from the URL, so it's useless for testing Host validation. We use the
 *  raw `http.request` API which allows arbitrary header values — exactly
 *  what a malicious DNS-rebinding scenario would produce. */
async function rawRequest(opts: {
  path: string;
  host: string;
  method?: string;
  body?: string;
  origin?: string;
  contentType?: string;
}): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers.host = opts.host;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.contentType) headers["content-type"] = opts.contentType;
    if (opts.body) headers["content-length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("server security middleware", () => {
  describe("Host header allowlist", () => {
    it("accepts requests with the configured Host", async () => {
      const res = await rawRequest({ path: "/api/health", host: `127.0.0.1:${port}` });
      expect(res.status).toBe(200);
    });

    it("accepts localhost variant of the bind", async () => {
      const res = await rawRequest({ path: "/api/health", host: `localhost:${port}` });
      expect(res.status).toBe(200);
    });

    it("rejects arbitrary Host (DNS-rebinding defense)", async () => {
      const res = await rawRequest({ path: "/api/health", host: "evil.com" });
      expect(res.status).toBe(421);
    });

    it("rejects Host with the wrong port", async () => {
      const res = await rawRequest({ path: "/api/health", host: `127.0.0.1:${port + 1}` });
      expect(res.status).toBe(421);
    });

    // (We don't test "empty Host" because Node's http.request normalizes
    //  it back to the URL host before sending. Real attackers can't send
    //  an empty Host either; browsers always populate it.)
  });

  describe("CORS surface", () => {
    it("response has no Access-Control-Allow-* headers", async () => {
      const res = await rawRequest({ path: "/api/health", host: `127.0.0.1:${port}` });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
      expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    });

    it("OPTIONS preflight is refused with 405 (no CORS allow)", async () => {
      const res = await rawRequest({
        path: "/api/agents",
        host: `127.0.0.1:${port}`,
        method: "OPTIONS",
        origin: "https://attacker.example",
      });
      expect(res.status).toBe(405);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("static file serving", () => {
    it("serves vendored files under /vendor/", async () => {
      const res = await rawRequest({ path: "/vendor/lib.js", host: `127.0.0.1:${port}` });
      expect(res.status).toBe(200);
      const ct = res.headers["content-type"];
      expect(typeof ct === "string" ? ct : ct?.[0] ?? "").toMatch(/javascript/);
    });

    it("rejects path-traversal attempts (..)", async () => {
      // Even if the resolved path escapes webDir, we should fail closed.
      // path.resolve collapses .. so this becomes /etc/passwd which then
      // doesn't exist under webDir. Either way: not 200, not leaking.
      const res = await rawRequest({ path: "/../../etc/passwd", host: `127.0.0.1:${port}` });
      expect(res.status).not.toBe(200);
    });

    it("rejects sibling-prefix attacks (webDir + '2')", async () => {
      // Construct a request that, with the BUGGY old startsWith check,
      // would have matched a sibling directory. With the fixed check
      // it falls through to 404.
      const res = await rawRequest({
        path: "/../" + path.basename(webDir) + "2/secret",
        host: `127.0.0.1:${port}`,
      });
      expect(res.status).not.toBe(200);
    });
  });

  describe("input validation", () => {
    it("agentId with control characters returns 404", async () => {
      const res = await rawRequest({
        path: "/api/agents/" + encodeURIComponent("bad\nid") + "/messages",
        host: `127.0.0.1:${port}`,
      });
      expect(res.status).toBe(404);
    });

    it("agentId with shell metacharacters returns 404", async () => {
      const res = await rawRequest({
        path: "/api/agents/" + encodeURIComponent("id;rm -rf /") + "/messages",
        host: `127.0.0.1:${port}`,
      });
      expect(res.status).toBe(404);
    });

    it("agent name with control characters is rejected (400)", async () => {
      const res = await rawRequest({
        path: "/api/agents",
        host: `127.0.0.1:${port}`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ name: "evil\nname" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/control characters/i);
    });

    it("empty agent name is rejected (400)", async () => {
      const res = await rawRequest({
        path: "/api/agents",
        host: `127.0.0.1:${port}`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ name: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("oversized agent name is rejected (400)", async () => {
      const res = await rawRequest({
        path: "/api/agents",
        host: `127.0.0.1:${port}`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ name: "a".repeat(500) }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("WebSocket upgrade", () => {
    function wsConnect(opts: {
      host?: string;
      origin?: string;
    }): Promise<{ event: "open" | "error"; code?: number; message?: string }> {
      return new Promise((resolve) => {
        const headers: Record<string, string> = {};
        if (opts.host) headers.host = opts.host;
        if (opts.origin) headers.origin = opts.origin;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        ws.on("open", () => {
          ws.close();
          resolve({ event: "open" });
        });
        ws.on("unexpected-response", (_req, res) => {
          ws.terminate();
          resolve({ event: "error", code: res.statusCode });
        });
        ws.on("error", (err) => resolve({ event: "error", message: err.message }));
      });
    }

    it("accepts upgrades with the right Host + matching Origin", async () => {
      const r = await wsConnect({
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
      });
      expect(r.event).toBe("open");
    });

    it("accepts upgrades with no Origin (curl / native client)", async () => {
      const r = await wsConnect({ host: `127.0.0.1:${port}` });
      expect(r.event).toBe("open");
    });

    it("rejects upgrades with mismatched Origin", async () => {
      const r = await wsConnect({
        host: `127.0.0.1:${port}`,
        origin: "https://attacker.example",
      });
      expect(r.event).toBe("error");
      expect(r.code).toBe(403);
    });

    it("rejects upgrades with bad Host", async () => {
      const r = await wsConnect({
        host: "evil.com",
        origin: `http://127.0.0.1:${port}`,
      });
      expect(r.event).toBe("error");
      expect(r.code).toBe(421);
    });
  });
});
