/** `pru archive` / `pru unarchive` are thin wrappers over one endpoint,
 *  so what's worth pinning down is the wiring: which agent they resolve,
 *  which flag they send, and that `--stop` stops only after the archive
 *  is safely saved. The HTTP layer is stubbed at `fetch`, which is where
 *  the CLI's api.ts talks to the server. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { archive, unarchive } from "../archive.js";

interface Call {
  url: string;
  body: unknown;
}

let calls: Call[];
let failing: (url: string) => boolean;

function stubFetch(): void {
  calls = [];
  failing = () => false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failing(url)) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    return new Response(JSON.stringify({ archived: true }), { status: 200 });
  });
}

beforeEach(() => {
  vi.stubEnv("PIROUETTE_URL", "http://127.0.0.1:7777");
  vi.stubEnv("PI_SESSION_FILE", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("archive", () => {
  it("sets the archive flag on the named agent and leaves it running", async () => {
    await archive("a1b2c3d4");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7777/api/agents/a1b2c3d4/archive",
        body: { archived: true },
      },
    ]);
  });

  it("accepts a name as well as an id, untouched", async () => {
    await archive("fix-login");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/agents/fix-login/archive");
  });

  it("stops the agent after archiving it, with --stop", async () => {
    await archive("a1b2c3d4", { stop: true });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:7777/api/agents/a1b2c3d4/archive",
      "http://127.0.0.1:7777/api/agents/a1b2c3d4/stop",
    ]);
  });

  it("doesn't stop an agent it failed to archive", async () => {
    failing = (url) => url.endsWith("/archive");
    await expect(archive("a1b2c3d4", { stop: true })).rejects.toThrow("exit 1");
    expect(calls).toHaveLength(1);
  });

  it("targets the agent running the command when none is given", async () => {
    vi.stubEnv("PI_SESSION_FILE", "/data/sessions/fix-login-a1b2c3d4/2026-01-01_x.jsonl");
    await archive(undefined);
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/agents/a1b2c3d4/archive");
  });

  it("treats `self` the same as no argument", async () => {
    vi.stubEnv("PI_SESSION_FILE", "/data/sessions/fix-login-a1b2c3d4/2026-01-01_x.jsonl");
    await archive("self");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/agents/a1b2c3d4/archive");
  });

  it("fails with a usage error outside an agent when none is given", async () => {
    await expect(archive(undefined)).rejects.toThrow("exit 1");
    expect(calls).toHaveLength(0);
  });
});

describe("unarchive", () => {
  it("clears the flag rather than setting it", async () => {
    await unarchive("a1b2c3d4");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7777/api/agents/a1b2c3d4/archive",
        body: { archived: false },
      },
    ]);
  });

  it("exits non-zero when the server rejects it", async () => {
    failing = () => true;
    await expect(unarchive("a1b2c3d4")).rejects.toThrow("exit 1");
  });
});
