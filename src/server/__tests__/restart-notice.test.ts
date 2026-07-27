/**
 * Tests for the `pru self-update` -> next-server hand-off note.
 *
 * The note is what makes the agent that *triggered* an update wake back
 * up: by the time the installer restarts the service, that agent's turn
 * has long since ended, so the "interrupted turn" resume path doesn't
 * cover it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentSessionDirFromEnv,
  consumeRestartNotice,
  restartNoticePath,
  writeRestartNotice,
} from "../restart-notice.js";

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pirouette-notice-"));
}

describe("restart notice", () => {
  it("round-trips a notice and deletes it on read (fires exactly once)", async () => {
    const d = await dir();
    expect(
      writeRestartNotice(d, {
        requestedAt: new Date().toISOString(),
        sessionDir: "/data/sessions/agent-abc",
        plan: "npm install pkg@latest",
      }),
    ).toBe(true);

    const notice = consumeRestartNotice(d);
    expect(notice?.sessionDir).toBe("/data/sessions/agent-abc");
    expect(notice?.plan).toBe("npm install pkg@latest");
    expect(existsSync(restartNoticePath(d))).toBe(false);
    // Second read finds nothing — no repeat nudge on the next restart.
    expect(consumeRestartNotice(d)).toBeNull();
  });

  it("returns null when there is no notice", async () => {
    expect(consumeRestartNotice(await dir())).toBeNull();
  });

  it("ignores (and clears) a stale notice from an update that never landed", async () => {
    const d = await dir();
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeRestartNotice(d, { requestedAt: old });
    expect(consumeRestartNotice(d)).toBeNull();
    expect(existsSync(restartNoticePath(d))).toBe(false);
  });

  it("ignores garbage / undated files instead of throwing", async () => {
    const d = await dir();
    writeFileSync(restartNoticePath(d), "not json{");
    expect(consumeRestartNotice(d)).toBeNull();

    writeFileSync(restartNoticePath(d), JSON.stringify({ sessionDir: "/x" }));
    expect(consumeRestartNotice(d)).toBeNull();
  });

  it("derives the initiating agent's session dir from PI_SESSION_FILE", () => {
    expect(
      agentSessionDirFromEnv({
        PI_SESSION_FILE: "/data/sessions/self-update-5b8cd55c/2026-01-01T00-00-00Z_x.jsonl",
      } as NodeJS.ProcessEnv),
    ).toBe("/data/sessions/self-update-5b8cd55c");
    expect(agentSessionDirFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(agentSessionDirFromEnv({ PI_SESSION_FILE: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
