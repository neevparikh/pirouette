import { describe, expect, it } from "vitest";

import { buildWatchBody, parseDurationArg, resolveTarget } from "../watch.js";

const INSIDE = { PI_SESSION_FILE: "/d/sessions/crew-a1b2c3d4/s.jsonl" } as NodeJS.ProcessEnv;

describe("resolveTarget", () => {
  it("wakes the calling agent by default", () => {
    expect(resolveTarget({}, INSIDE)).toEqual({ target: "a1b2c3d4", createdBy: "a1b2c3d4" });
  });

  it("--agent wakes someone else, still recording who set it", () => {
    expect(resolveTarget({ agent: "captain" }, INSIDE)).toEqual({ target: "captain", createdBy: "a1b2c3d4" });
  });

  it("has no target from a human shell without --agent", () => {
    expect(resolveTarget({}, {} as NodeJS.ProcessEnv)).toEqual({ target: null, createdBy: null });
  });
});

describe("buildWatchBody", () => {
  it("queues behind the current turn unless --steer", () => {
    expect(buildWatchBody("timer", { durationMs: 1000 }, {}, "a1b2c3d4", "/w")).toEqual({
      kind: "timer",
      cwd: "/w",
      mode: "followUp",
      createdBy: "a1b2c3d4",
      durationMs: 1000,
    });
    expect(buildWatchBody("timer", { durationMs: 1000 }, { steer: true }, null, "/w").mode).toBe("steer");
  });

  it("turns --timeout and --every into milliseconds", () => {
    expect(
      buildWatchBody("pr", { pr: "12", repo: "o/r", prEvents: ["checks"] }, { timeout: "2h", every: "30s", note: "rebase" }, null, "/w"),
    ).toEqual({
      kind: "pr",
      cwd: "/w",
      mode: "followUp",
      note: "rebase",
      everyMs: 30_000,
      durationMs: 7_200_000,
      pr: "12",
      repo: "o/r",
      prEvents: ["checks"],
    });
  });
});

describe("parseDurationArg", () => {
  it("matches the server's grammar", () => {
    expect(parseDurationArg("1h30m")).toBe(5_400_000);
    expect(parseDurationArg("45")).toBe(45_000);
    expect(parseDurationArg("tomorrow")).toBeNull();
  });
});
