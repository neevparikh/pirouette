import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BashJobRegistry,
  bashBackgroundGuidance,
  detachNote,
  resolveBashBackgroundPolicy,
  type BashJob,
} from "../bash-background.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "pru-bash-bg-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

async function setup() {
  const jobDir = path.join(await tempDir(), "jobs");
  const cwd = await tempDir();
  const adopted: BashJob[] = [];
  const registry = new BashJobRegistry({
    jobDir,
    adopt: (job) => {
      adopted.push(job);
      return { watchId: `w${adopted.length}` };
    },
  });
  const tool = registry.createTool("agent-1", cwd)!;
  expect(tool).not.toBeNull();
  let n = 0;
  const run = (command: string, opts: { timeout?: number; signal?: AbortSignal; onText?: (t: string) => void } = {}) =>
    tool.execute(
      `call-${++n}`,
      { command, timeout: opts.timeout },
      opts.signal,
      opts.onText
        ? (u) => opts.onText!(u.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
        : undefined,
      undefined as never,
    );
  return { registry, run, adopted, jobDir, cwd };
}

describe("resolveBashBackgroundPolicy", () => {
  it("defaults to on, with a grace period", () => {
    expect(resolveBashBackgroundPolicy(undefined, {}).policy).toEqual({ autoOnMessage: true, graceSeconds: 5 });
  });

  it("reads config, with env winning", () => {
    expect(
      resolveBashBackgroundPolicy({ auto_on_message: false, grace_seconds: 2 }, {}).policy,
    ).toEqual({ autoOnMessage: false, graceSeconds: 2 });
    expect(
      resolveBashBackgroundPolicy(
        { auto_on_message: false },
        { PIROUETTE_BASH_AUTO_BACKGROUND: "1", PIROUETTE_BASH_BACKGROUND_GRACE_SECONDS: "0" },
      ).policy,
    ).toEqual({ autoOnMessage: true, graceSeconds: 0 });
  });

  it("ignores bad values with a warning", () => {
    const { policy, warnings } = resolveBashBackgroundPolicy({ auto_on_message: "maybe", grace_seconds: -1 }, {});
    expect(policy).toEqual({ autoOnMessage: true, graceSeconds: 5 });
    expect(warnings).toHaveLength(2);
  });
});

describe("bashBackgroundGuidance / detachNote", () => {
  it("mentions the grace period only when auto-detach is on", () => {
    expect(bashBackgroundGuidance({ autoOnMessage: true, graceSeconds: 5 })).toContain("more than 5s");
    expect(bashBackgroundGuidance({ autoOnMessage: false, graceSeconds: 5 })).not.toContain("more than");
  });

  it("names the watch, or says nothing will report the exit", () => {
    const job = { pid: 42, logPath: "/x.log" };
    expect(detachNote(job, { reason: "the user sent you a message", ranForMs: 61_000, watchId: "w3" })).toMatch(
      /after 1m 1s because the user sent you a message[\s\S]*pid 42[\s\S]*\/x\.log[\s\S]*pru watch rm w3/,
    );
    expect(detachNote(job, { reason: "r", ranForMs: 0, watchId: null })).toContain("Nothing will tell you");
  });
});

describe("BashJobRegistry tool", () => {
  it("runs a command like pi's bash tool, and cleans up its files", async () => {
    const { run, jobDir, registry } = await setup();
    const result = await run("echo hello; echo err >&2");
    expect(textOf(result)).toContain("hello");
    expect(textOf(result)).toContain("err");
    expect(readdirSync(jobDir)).toEqual([]);
    expect(registry.running("agent-1")).toEqual([]);
  });

  it("runs in the agent's cwd", async () => {
    const { run, cwd } = await setup();
    expect(textOf(await run("pwd")).trim()).toBe(cwd);
  });

  it("reports a non-zero exit as an error", async () => {
    const { run } = await setup();
    await expect(run("echo out; exit 3")).rejects.toThrow(/out[\s\S]*Command exited with code 3/);
  });

  it("kills the command at its timeout, with pi's message", async () => {
    const { run } = await setup();
    const started = Date.now();
    await expect(run("echo before; sleep 30", { timeout: 0.5 })).rejects.toThrow(
      /before[\s\S]*Command timed out after 0.5 seconds/,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the command when the tool call is aborted", async () => {
    const { run } = await setup();
    const ac = new AbortController();
    const p = run("sleep 30", { signal: ac.signal });
    await sleep(200);
    ac.abort();
    await expect(p).rejects.toThrow(/Command aborted/);
  });

  it("detaches: returns the output so far, and the command keeps running", async () => {
    const { run, registry, adopted } = await setup();
    let streamed = "";
    const ac = new AbortController();
    const p = run("echo first; sleep 1; echo second", {
      timeout: 0.6, // would kill it, if it were still attached
      signal: ac.signal,
      onText: (t) => (streamed = t),
    });
    await waitFor(() => streamed.includes("first"));
    expect(registry.running("agent-1")).toHaveLength(1);

    const r = registry.detach("agent-1", { reason: "the user sent you a message" });
    expect(r).toEqual({ detached: 1, scheduled: 0 });
    const result = await p;
    const text = textOf(result);
    expect(text).toContain("first");
    expect(text).not.toContain("second");
    expect(text).toContain("because the user sent you a message");
    expect(text).toContain("Watch w1");
    expect(registry.running("agent-1")).toEqual([]);

    // Aborting the turn now must not touch it, nor the (cleared) timeout.
    ac.abort();
    expect(adopted).toHaveLength(1);
    const job = adopted[0];
    const code = await new Promise<number | null>((resolve) => {
      if (job.child.exitCode !== null) resolve(job.child.exitCode);
      else job.child.once("exit", (c) => resolve(c));
    });
    expect(code).toBe(0);
    expect(readFileSync(job.logPath, "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(job.exitPath, "utf8").trim()).toBe("0");
  });

  it("records a detached command's exit code", async () => {
    const { run, registry, adopted } = await setup();
    let streamed = "";
    const p = run("echo go; sleep 0.3; exit 7", { onText: (t) => (streamed = t) });
    await waitFor(() => streamed.includes("go"));
    registry.detach("agent-1", { reason: "r" });
    await p; // detached: not an error
    const job = adopted[0];
    await waitFor(() => existsSync(job.exitPath) && readFileSync(job.exitPath, "utf8").trim() !== "");
    expect(readFileSync(job.exitPath, "utf8").trim()).toBe("7");
  });

  it("waits out the grace period, and leaves a command that finishes first alone", async () => {
    const { run, registry, adopted } = await setup();
    const quick = run("sleep 0.2; echo quick");
    await sleep(50);
    expect(registry.detach("agent-1", { reason: "r", graceMs: 1000 })).toEqual({ detached: 0, scheduled: 1 });
    expect(textOf(await quick)).toContain("quick");
    expect(adopted).toHaveLength(0);

    const slow = run("sleep 5");
    await sleep(50);
    expect(registry.detach("agent-1", { reason: "r", graceMs: 300 })).toEqual({ detached: 0, scheduled: 1 });
    const started = Date.now();
    const text = textOf(await slow);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(text).toContain("Moved to the background");
    expect(adopted).toHaveLength(1);
    adopted[0].child.kill("SIGKILL");
    process.kill(-adopted[0].pid, "SIGKILL");
  });

  it("only touches the given agent's commands", async () => {
    const { run, registry, adopted } = await setup();
    const p = run("sleep 0.3");
    await sleep(50);
    expect(registry.detach("someone-else", { reason: "r" })).toEqual({ detached: 0, scheduled: 0 });
    await p;
    expect(adopted).toHaveLength(0);
  });

  it("still detaches when nobody can adopt the job, and says so", async () => {
    const jobDir = path.join(await tempDir(), "jobs");
    const registry = new BashJobRegistry({
      jobDir,
      adopt: () => {
        throw new Error("no watch manager");
      },
    });
    const tool = registry.createTool("a", await tempDir())!;
    const p = tool.execute("c", { command: "sleep 2" }, undefined, undefined, undefined as never);
    await sleep(100);
    const pid = registry.running("a")[0].pid;
    registry.detach("a", { reason: "r" });
    const text = textOf(await p);
    expect(text).toContain("Nothing will tell you when it exits");
    process.kill(-pid, "SIGKILL");
  });
});
