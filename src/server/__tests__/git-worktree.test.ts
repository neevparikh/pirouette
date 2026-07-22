/**
 * Tests for createWorktree(), focused on the `--no-track` regression:
 *
 * Agent worktrees are created off `origin/<base>`. Without `--no-track`,
 * `git worktree add -b <branch> <path> origin/<base>` sets up upstream
 * tracking, writing `branch.<name>.{remote,merge}` into the repo's
 * SHARED `.git/config`. Concurrent creates then contend on the single
 * config lock, and an interrupted write leaves a stale `.git/config.lock`
 * that fails every later create. Agent branches never pull from the base,
 * so tracking is pure downside — createWorktree must not write it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorktree } from "../git.js";

const run = promisify(execFile);

async function sh(cwd: string, cmd: string, args: string[]) {
  await run(cmd, args, { cwd });
}

/** Build an "origin" repo with one commit and a local clone of it, so
 *  `origin/<base>` exists as a remote-tracking ref in the clone. */
async function makeClonedRepo(): Promise<{ repoPath: string; worktreesDir: string; base: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-wt-"));
  const origin = path.join(dir, "origin");
  const clone = path.join(dir, "clone");
  await sh(dir, "git", ["init", "-q", "-b", "main", origin]);
  await sh(origin, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  await sh(dir, "git", ["clone", "-q", origin, clone]);
  return { repoPath: clone, worktreesDir: path.join(dir, "worktrees"), base: "main" };
}

describe("createWorktree", () => {
  let repoPath: string;
  let worktreesDir: string;
  let base: string;

  beforeEach(async () => {
    ({ repoPath, worktreesDir, base } = await makeClonedRepo());
  });

  it("creates a worktree on a new agent/<slug> branch off origin/<base>", async () => {
    const wt = await createWorktree({ repoPath, worktreesDir, slug: "my-agent", baseBranch: base });
    expect(wt.branch).toBe("agent/my-agent");
    expect(wt.path).toBe(path.join(worktreesDir, "my-agent"));
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path });
    expect(stdout.trim()).toBe("agent/my-agent");
  });

  it("does not write upstream tracking into the shared .git/config (--no-track)", async () => {
    const wt = await createWorktree({ repoPath, worktreesDir, slug: "my-agent", baseBranch: base });
    // No branch.<name>.remote/merge stanza may appear: it would be written
    // to the shared .git/config under the config lock (the race/stale-lock
    // failure mode this guards against).
    const config = await readFile(path.join(repoPath, ".git", "config"), "utf8");
    expect(config).not.toContain(`branch "${wt.branch}"`);
    const upstream = await run(
      "git",
      ["config", "--get", `branch.${wt.branch}.remote`],
      { cwd: repoPath },
    ).catch((err) => err);
    expect(upstream).toBeInstanceOf(Error); // unset -> git config exits 1
  });

  it("suffixes the branch and path on collision", async () => {
    const first = await createWorktree({ repoPath, worktreesDir, slug: "dup", baseBranch: base });
    const second = await createWorktree({ repoPath, worktreesDir, slug: "dup", baseBranch: base });
    expect(first.branch).toBe("agent/dup");
    expect(second.branch).toBe("agent/dup-2");
    expect(second.path).toBe(path.join(worktreesDir, "dup-2"));
  });

  it("falls back to HEAD when origin/<base> does not exist", async () => {
    const wt = await createWorktree({
      repoPath,
      worktreesDir,
      slug: "no-remote-base",
      baseBranch: "does-not-exist",
    });
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: wt.path });
    const { stdout: mainHead } = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    expect(stdout.trim()).toBe(mainHead.trim());
  });
});
