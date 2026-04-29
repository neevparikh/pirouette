/**
 * Regression test for the silent-no-op bug in `pru rm <name>`.
 *
 * Before the fix:
 *   - `DELETE /api/agents/smoketest` (where "smoketest" is a name, not id)
 *     returned 200 OK and broadcast `agent_removed`, but the underlying
 *     state-manager calls (keyed by id) silently no-oped, so the agent
 *     remained.
 *
 * After the fix:
 *   - The route handler resolves id-or-name to a canonical agent before
 *     dispatching. Unknown refs now 404 instead of pretending success.
 *   - Resolution by exact name works when there's a unique match.
 *   - Ambiguous names (multi-project collision) return 409 with a
 *     useful list of candidate ids.
 *
 * We test the unknown-ref path here, because that's the actual bug the
 * user hit and it doesn't require booting a working git repo / project
 * to set up agents. Resolution-by-name and ambiguity paths are exercised
 * end-to-end whenever you `pru rm <name>` against a real instance.
 */

import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function rawRequest(opts: {
  path: string;
  method?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: { host: `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  port = await freePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "pir-ref-test-"));
  webDir = mkdtempSync(path.join(tmpdir(), "pir-ref-web-"));
  writeFileSync(path.join(webDir, "index.html"), "<html>test</html>");
  mkdirSync(path.join(webDir, "vendor"), { recursive: true });
  handle = await runServer({ port, host: "127.0.0.1", dataDir, webDir });
});

afterAll(async () => {
  await handle.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(webDir, { recursive: true, force: true });
});

describe("agent-ref resolution at the HTTP route layer", () => {
  it("DELETE on an unknown ref returns 404 (was silently 200 before fix)", async () => {
    const res = await rawRequest({
      path: "/api/agents/does-not-exist",
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(res.body).toContain("not found");
  });

  it("GET on an unknown ref returns 404", async () => {
    const res = await rawRequest({ path: "/api/agents/nope" });
    expect(res.status).toBe(404);
  });

  it("POST /stop on an unknown ref returns 404", async () => {
    const res = await rawRequest({
      path: "/api/agents/missing/stop",
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("rejects refs with control characters (0x00-0x1f, 0x7f)", async () => {
    // \x07 = BEL. URL-safe enough for http.request to send.
    const res = await rawRequest({
      path: `/api/agents/${encodeURIComponent("ev\x07il")}`,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty ref (matches existing AGENT_ID_RE behavior)", async () => {
    // Trailing slash-then-empty doesn't match the route regex, so this
    // would fall through to 404 anyway; included for documentation.
    const res = await rawRequest({ path: "/api/agents/" });
    expect(res.status).toBe(404);
  });

  it("rejects absurdly long ref (>200 chars)", async () => {
    const longRef = "a".repeat(201);
    const res = await rawRequest({
      path: `/api/agents/${longRef}`,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
