/** `pru notify` is a thin wrapper over POST /api/agents/:id/notify; what
 *  matters is which agent it attributes the notification to and what it
 *  sends. HTTP is stubbed at `fetch`, where the CLI's api.ts talks to the
 *  server. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notify } from "../notify.js";

let calls: Array<{ url: string; body: unknown }>;
let delivered: number;

beforeEach(() => {
  calls = [];
  delivered = 1;
  vi.stubEnv("PIROUETTE_URL", "http://127.0.0.1:7777");
  vi.stubEnv("PI_SESSION_FILE", "/data/sessions/proj-a1b2c3d4/2026-01-01.jsonl");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ delivered }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("notify", () => {
  it("attributes the notification to the agent running the command", async () => {
    await notify("approve the login");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:7777/api/agents/a1b2c3d4/notify", body: { body: "approve the login" } },
    ]);
  });

  it("sends title and url, and honours --agent", async () => {
    await notify("code ABCD-EFGH", { agent: "backfill", title: "AWS login", url: "https://example.com/d" });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7777/api/agents/backfill/notify",
        body: { body: "code ABCD-EFGH", title: "AWS login", url: "https://example.com/d" },
      },
    ]);
  });

  it("reads the message from a file", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "notify-")), "msg.txt");
    writeFileSync(file, "from a file");
    await notify(undefined, { messageFile: file });
    expect(calls[0].body).toEqual({ body: "from a file" });
  });

  it("says so when no dashboard was open to receive it", async () => {
    delivered = 0;
    await notify("hello");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/no dashboard is open/);
  });

  it("refuses without an agent outside an agent shell", async () => {
    vi.stubEnv("PI_SESSION_FILE", "");
    await expect(notify("hello")).rejects.toThrow("exit 1");
    expect(calls).toEqual([]);
  });

  it("refuses an empty message", async () => {
    await expect(notify("  ")).rejects.toThrow("exit 1");
    expect(calls).toEqual([]);
  });
});
