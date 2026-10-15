import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildWatchMessage,
  evaluatePr,
  parseDuration,
  parseWatchRequest,
  prBaseline,
  WatchManager,
  type CommandRunner,
  type PrSnapshot,
  type WatchMessage,
  type WatchRequest,
} from "../watches.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(10);
  }
}

function req(over: Partial<WatchRequest>): WatchRequest {
  return {
    kind: "timer",
    note: null,
    mode: "followUp",
    createdBy: "aaaa0001",
    durationMs: null,
    cwd: null,
    command: null,
    everyMs: null,
    pr: null,
    repo: null,
    prEvents: null,
    ...over,
  };
}

async function setup(opts: { run?: CommandRunner; deliverFails?: number; agents?: string[] } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "pru-watch-"));
  const delivered: Array<{ agentId: string; msg: WatchMessage }> = [];
  let failures = opts.deliverFails ?? 0;
  const agents = new Set(opts.agents ?? ["aaaa0001", "bbbb0002"]);
  const make = () =>
    new WatchManager({
      stateDir,
      run: opts.run,
      retryMs: 20,
      agentExists: (id) => agents.has(id),
      deliver: async (agentId, msg) => {
        if (failures > 0) {
          failures--;
          throw new Error("agent would not resume");
        }
        delivered.push({ agentId, msg });
      },
    });
  return { stateDir, delivered, agents, make };
}

describe("parseDuration", () => {
  it("parses units and combinations", () => {
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  it("rejects junk", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("5 parsecs")).toBeNull();
    expect(parseDuration("0s")).toBeNull();
  });
});

describe("parseWatchRequest", () => {
  it("accepts a PR watch and defaults events and mode", () => {
    const r = parseWatchRequest({ kind: "pr", pr: "#12", cwd: "/tmp" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pr).toBe("12");
    expect(r.value.mode).toBe("followUp");
    expect(r.value.prEvents).toEqual(["checks", "reviews", "merged", "conflict"]);
  });
  it("rejects missing or bad fields", () => {
    expect(parseWatchRequest({ kind: "nope" }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "timer" }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "cmd", command: "  " }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "pr", pr: "abc" }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "pr", pr: "1", prEvents: ["lunch"] }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "until", command: "true", everyMs: 1000 }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "until", command: "true", cwd: "relative" }).ok).toBe(false);
    expect(parseWatchRequest({ kind: "timer", durationMs: 100 * 86_400_000 }).ok).toBe(false);
  });
});

describe("evaluatePr", () => {
  const base: PrSnapshot = {
    number: 12,
    title: "Fix it",
    url: "https://github.com/o/r/pull/12",
    state: "OPEN",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    reviews: [{ id: "R1", author: { login: "old" }, state: "COMMENTED" }],
    comments: [],
  };
  const all = ["checks", "reviews", "merged", "conflict"] as const;
  const run = (name: string, status: string, conclusion: string | null = null) => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: `https://ci/${name}`,
  });

  it("keeps waiting while checks run and nothing new happened", () => {
    const snap = { ...base, statusCheckRollup: [run("test", "IN_PROGRESS"), run("lint", "COMPLETED", "SUCCESS")] };
    expect(evaluatePr(snap, prBaseline(base), all)).toBeNull();
  });

  it("keeps waiting when no checks have registered yet", () => {
    expect(evaluatePr(base, prBaseline(base), all)).toBeNull();
  });

  it("fires on the first failure, listing what's still running", () => {
    const snap = {
      ...base,
      statusCheckRollup: [run("test", "COMPLETED", "FAILURE"), run("e2e", "IN_PROGRESS")],
    };
    const hit = evaluatePr(snap, prBaseline(base), all)!;
    expect(hit.summary).toBe("PR #12 1 check failed (1 still running).");
    expect(hit.details).toContain("✗ test: FAILURE https://ci/test");
    expect(hit.details).toContain("… e2e: IN_PROGRESS");
  });

  it("fires when every check passed, counting skipped and status contexts", () => {
    const snap = {
      ...base,
      statusCheckRollup: [
        run("test", "COMPLETED", "SUCCESS"),
        run("deploy", "COMPLETED", "SKIPPED"),
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
      ],
    };
    expect(evaluatePr(snap, prBaseline(base), all)!.summary).toBe("PR #12 all 3 checks passed.");
  });

  it("ignores checks when not asked for them", () => {
    const snap = { ...base, statusCheckRollup: [run("test", "COMPLETED", "FAILURE")] };
    expect(evaluatePr(snap, prBaseline(base), ["reviews"])).toBeNull();
  });

  it("fires on reviews and comments that weren't there at the start", () => {
    const snap = {
      ...base,
      reviews: [...base.reviews!, { id: "R2", author: { login: "copilot" }, state: "CHANGES_REQUESTED", body: "nit" }],
      comments: [{ id: "C1", author: { login: "sam" }, body: "lgtm?" }],
    };
    const hit = evaluatePr(snap, prBaseline(base), all)!;
    expect(hit.summary).toBe("PR #12 got 2 new reviews/comments.");
    expect(hit.details).toContain("review by copilot (CHANGES_REQUESTED): nit");
    expect(hit.details).toContain("comment by sam: lgtm?");
    expect(hit.details).not.toContain("old");
  });

  it("fires on merge, close and a new conflict", () => {
    expect(evaluatePr({ ...base, state: "MERGED" }, prBaseline(base), all)!.summary).toBe("PR #12 was merged.");
    expect(evaluatePr({ ...base, state: "CLOSED" }, prBaseline(base), all)!.summary).toContain("closed");
    expect(evaluatePr({ ...base, mergeable: "CONFLICTING" }, prBaseline(base), all)!.summary).toContain(
      "merge conflict",
    );
    // A conflict that was already there when the watch was set isn't news.
    const conflicted = { ...base, mergeable: "CONFLICTING" };
    expect(evaluatePr(conflicted, prBaseline(conflicted), all)).toBeNull();
  });
});

describe("buildWatchMessage", () => {
  it("says who set it, what it watched and the note", () => {
    const m = buildWatchMessage(
      {
        id: "w3",
        kind: "cmd",
        agentId: "aaaa0001",
        createdBy: "bbbb0002",
        note: "then deploy",
        createdAt: new Date(0).toISOString(),
        command: "make test",
        pr: null,
        repo: null,
        prEvents: null,
        deadline: null,
        mode: "followUp",
      },
      "Command exited with code 0",
      "output here",
      65_000,
    );
    expect(m.text).toMatch(/^\[Watch w3 fired via pirouette, not typed by the user: a watch agent bbbb0002 set for you 1m 5s ago on command: make test\./);
    expect(m.body).toBe("Command exited with code 0\n\nNote left with the watch: then deploy\n\noutput here");
    expect(m.text.endsWith(m.body)).toBe(true);
  });
});

describe("WatchManager", () => {
  it("fires a timer and delivers it to the agent", async () => {
    const { delivered, make } = await setup();
    const wm = make();
    await wm.start();
    const w = await wm.create("aaaa0001", req({ kind: "timer", durationMs: 30, note: "check the deploy" }));
    expect(w.id).toBe("w1");
    expect(wm.list()).toHaveLength(1);
    await until(() => delivered.length === 1);
    expect(delivered[0].agentId).toBe("aaaa0001");
    expect(delivered[0].msg.body).toContain("Timer finished");
    expect(delivered[0].msg.body).toContain("check the deploy");
    expect(delivered[0].msg.mode).toBe("followUp");
    expect(wm.list()).toHaveLength(0);
    await wm.stop();
  });

  it("polls an until-command until it exits 0", async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls++;
      return calls < 3
        ? { code: 1, signal: null, output: "not yet", timedOut: false }
        : { code: 0, signal: null, output: "ready!\n", timedOut: false };
    };
    const { delivered, make } = await setup({ run });
    const wm = make();
    await wm.create("aaaa0001", req({ kind: "until", command: "test -f done", everyMs: 10, durationMs: 60_000 }));
    await until(() => delivered.length === 1);
    expect(calls).toBe(3);
    expect(delivered[0].msg.body).toContain("Condition met: `test -f done` exited 0.");
    expect(delivered[0].msg.body).toContain("ready!");
    await wm.stop();
  });

  it("gives up on an until-command at its deadline", async () => {
    const run: CommandRunner = async () => ({ code: 1, signal: null, output: "", timedOut: false });
    const { delivered, make } = await setup({ run });
    const wm = make();
    await wm.create("aaaa0001", req({ kind: "until", command: "false", everyMs: 10, durationMs: 50 }));
    await until(() => delivered.length === 1);
    expect(delivered[0].msg.watch.summary).toMatch(/^Gave up: until: false didn't happen within/);
    await wm.stop();
  });

  it("reads a PR up front, so existing reviews don't count, and fires on a new one", async () => {
    let snap: PrSnapshot = {
      number: 7,
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
      reviews: [{ id: "R1", author: { login: "a" }, state: "APPROVED" }],
      comments: [],
    };
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...(args ?? [])]);
      return { code: 0, signal: null, output: JSON.stringify(snap), timedOut: false };
    };
    const { delivered, make } = await setup({ run });
    const wm = make();
    const w = await wm.create("aaaa0001", req({ kind: "pr", pr: "7", repo: "o/r", everyMs: 10, durationMs: 60_000, prEvents: ["reviews"] }));
    expect(w.firedSummary).toBeNull();
    expect(calls[0]).toEqual(["gh", "pr", "view", "7", "--json", expect.any(String), "--repo", "o/r"]);
    await sleep(40);
    expect(delivered).toHaveLength(0);
    snap = { ...snap, comments: [{ id: "C9", author: { login: "b" }, body: "please rename" }] };
    await until(() => delivered.length === 1);
    expect(delivered[0].msg.body).toContain("comment by b: please rename");
    await wm.stop();
  });

  it("fires immediately when the PR's checks are already done", async () => {
    const snap: PrSnapshot = {
      number: 8,
      state: "OPEN",
      statusCheckRollup: [{ __typename: "CheckRun", name: "t", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
    const run: CommandRunner = async () => ({ code: 0, signal: null, output: JSON.stringify(snap), timedOut: false });
    const { delivered, make } = await setup({ run });
    const wm = make();
    const w = await wm.create("aaaa0001", req({ kind: "pr", pr: "8", everyMs: 10_000 }));
    expect(w.firedSummary).toBe("PR #8 all 1 check passed.");
    await until(() => delivered.length === 1);
    await wm.stop();
  });

  it("rejects a PR gh can't read", async () => {
    const run: CommandRunner = async () => ({ code: 1, signal: null, output: "no pull requests found", timedOut: false });
    const { make } = await setup({ run });
    const wm = make();
    await expect(wm.create("aaaa0001", req({ kind: "pr", pr: "999" }))).rejects.toThrow(/no pull requests found/);
    expect(wm.list()).toHaveLength(0);
    await wm.stop();
  });

  it("runs a background command and reports its exit code and output", async () => {
    const { delivered, make, stateDir } = await setup();
    const wm = make();
    await wm.create("aaaa0001", req({ kind: "cmd", command: "echo hello; echo oops >&2; exit 3", cwd: stateDir }));
    await until(() => delivered.length === 1);
    const body = delivered[0].msg.body;
    expect(body).toContain("Command exited with code 3");
    expect(body).toContain("hello");
    expect(body).toContain("oops");
    await wm.stop();
  });

  it("kills a background command that outlives its timeout", async () => {
    const { delivered, make, stateDir } = await setup();
    const wm = make();
    await wm.create("aaaa0001", req({ kind: "cmd", command: "echo started; sleep 30", cwd: stateDir, durationMs: 200 }));
    await until(() => delivered.length === 1);
    expect(delivered[0].msg.body).toMatch(/timed out after .* and was killed/);
    expect(delivered[0].msg.body).toContain("started");
    await sleep(50);
    expect(delivered).toHaveLength(1);
    await wm.stop();
  });

  it("cancels a watch, killing its command", async () => {
    const { delivered, make, stateDir } = await setup();
    const wm = make();
    const w = await wm.create("aaaa0001", req({ kind: "cmd", command: "sleep 30", cwd: stateDir }));
    expect(wm.cancel(w.id)).toBe(true);
    expect(wm.cancel(w.id)).toBe(false);
    await sleep(100);
    expect(delivered).toHaveLength(0);
    await wm.stop();
  });

  it("persists across a restart and carries on polling", async () => {
    let ready = false;
    const run: CommandRunner = async () => ({ code: ready ? 0 : 1, signal: null, output: "", timedOut: false });
    const { delivered, make } = await setup({ run });
    const first = make();
    await first.create("aaaa0001", req({ kind: "until", command: "check", everyMs: 10, durationMs: 60_000 }));
    await first.stop();
    await first.flush();

    const second = make();
    await second.start();
    expect(second.list().map((w) => w.id)).toEqual(["w1"]);
    ready = true;
    await until(() => delivered.length === 1);
    // Ids keep counting up after a restart.
    const next = await second.create("aaaa0001", req({ kind: "timer", durationMs: 60_000 }));
    expect(next.id).toBe("w2");
    await second.stop();
  });

  it("tells the agent when a restart killed its command", async () => {
    const { delivered, make, stateDir } = await setup();
    // A cmd watch left behind by a previous server whose process is gone.
    await mkdir(path.join(stateDir, "watch-logs"), { recursive: true });
    await writeFile(path.join(stateDir, "watch-logs", "w4.log"), "step 1\nstep 2\n");
    const wm0 = make();
    await wm0.start();
    await wm0.stop();
    const file = {
      nextId: 5,
      watches: [
        {
          id: "w4", agentId: "aaaa0001", createdBy: "aaaa0001", kind: "cmd", note: null, mode: "followUp",
          createdAt: new Date().toISOString(), deadline: null, cwd: stateDir, command: "make build",
          everyMs: null, pr: null, repo: null, prEvents: null, prBaseline: null, pid: 2 ** 22 + 12345,
          pollFailures: 0, firedText: null, firedBody: null, firedSummary: null, deliveryAttempts: 0,
        },
      ],
    };
    await writeFile(path.join(stateDir, "watches.json"), JSON.stringify(file));
    const wm = make();
    await wm.start();
    await until(() => delivered.length === 1);
    expect(delivered[0].msg.body).toContain("killed when the pirouette server restarted");
    expect(delivered[0].msg.body).toContain("step 2");
    await wm.stop();
  });

  it("retries delivery until the agent takes the message", async () => {
    const { delivered, make, stateDir } = await setup({ deliverFails: 2 });
    const wm = make();
    await wm.create("aaaa0001", req({ kind: "timer", durationMs: 10 }));
    await until(() => delivered.length === 1);
    await wm.flush();
    const saved = JSON.parse(await readFile(path.join(stateDir, "watches.json"), "utf8"));
    expect(saved.watches).toEqual([]);
    await wm.stop();
  });

  it("drops watches whose agent is gone, and moves them on handoff", async () => {
    const { delivered, make, agents } = await setup();
    const wm = make();
    const a = await wm.create("aaaa0001", req({ kind: "timer", durationMs: 40 }));
    await wm.create("bbbb0002", req({ kind: "timer", durationMs: 40, createdBy: "bbbb0002" }));
    agents.add("cccc0003");
    expect(wm.reassign("aaaa0001", "cccc0003")).toBe(1);
    expect(wm.get(a.id)!.agentId).toBe("cccc0003");
    expect(wm.get(a.id)!.createdBy).toBe("cccc0003");
    agents.delete("bbbb0002");
    await sleep(120);
    expect(delivered.map((d) => d.agentId)).toEqual(["cccc0003"]);
    expect(wm.list()).toHaveLength(0);
    await wm.stop();
  });
});
