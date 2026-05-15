/** Tests for setupWorktreeDataTools.
 *
 *  The contract:
 *    - Detects pivot / dvc from the source repo.
 *    - Symlinks shared dirs/files into the worktree.
 *    - Creates per-worktree state.lmdb as an empty directory.
 *    - Idempotent: rerunning produces the same final state.
 *    - Won't clobber pre-existing non-symlink files at the destination.
 */

import { mkdir, mkdtemp, readlink, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupWorktreeDataTools } from "../worktree-setup.js";

let root: string;
let repo: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pir-wt-setup-"));
  repo = path.join(root, "repo");
  worktree = path.join(root, "worktree");
  await mkdir(repo, { recursive: true });
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  // Best-effort cleanup; jsdom + vitest tmp dirs are auto-purged anyway.
  await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

async function isSymlinkTo(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    const t = await readlink(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), t);
    return resolved === path.resolve(expectedTarget);
  } catch {
    return false;
  }
}

describe("setupWorktreeDataTools", () => {
  it("is a no-op when neither .pivot nor .dvc exist in the source repo", async () => {
    const r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.pivot).toBe(false);
    expect(r.dvc).toBe(false);
    expect(r.skipped).toEqual([]);
    // The worktree should be untouched.
    const exists = await stat(path.join(worktree, ".pivot")).catch(() => null);
    expect(exists).toBeNull();
  });

  it("symlinks pivot cache, locks, and state.lmdb to the source repo", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    const r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.pivot).toBe(true);
    expect(r.dvc).toBe(false);

    // All three shared dirs: symlinks to the source repo. state.lmdb is
    // shared (and not per-worktree) because pivot opens it readonly per
    // stage, which on an empty dir fails with "No such file or directory"
    // — sharing the source's already-initialised LMDB env sidesteps that.
    expect(await isSymlinkTo(path.join(worktree, ".pivot", "cache"), path.join(repo, ".pivot", "cache"))).toBe(true);
    expect(await isSymlinkTo(path.join(worktree, ".pivot", "locks"), path.join(repo, ".pivot", "locks"))).toBe(true);
    expect(
      await isSymlinkTo(path.join(worktree, ".pivot", "state.lmdb"), path.join(repo, ".pivot", "state.lmdb")),
    ).toBe(true);

    // The source dirs were created on demand (mkdir -p semantic).
    const cacheStat = await stat(path.join(repo, ".pivot", "cache"));
    expect(cacheStat.isDirectory()).toBe(true);
    const stateStat = await stat(path.join(repo, ".pivot", "state.lmdb"));
    expect(stateStat.isDirectory()).toBe(true);
  });

  it("symlinks config.yaml only when present in the source repo", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    // No config.yaml yet.
    let r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.pivot).toBe(true);
    const noConfig = await stat(path.join(worktree, ".pivot", "config.yaml")).catch(() => null);
    expect(noConfig).toBeNull();

    // Add it; rerun; now it should be symlinked.
    await writeFile(path.join(repo, ".pivot", "config.yaml"), "remotes:\n  origin: s3://x\n");
    r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(
      await isSymlinkTo(path.join(worktree, ".pivot", "config.yaml"), path.join(repo, ".pivot", "config.yaml")),
    ).toBe(true);
  });

  it("symlinks .dvc/cache and ignores .dvc/config (tracked in git)", async () => {
    await mkdir(path.join(repo, ".dvc"), { recursive: true });
    await writeFile(path.join(repo, ".dvc", "config"), "[core]\n  remote = origin\n");
    // Mimic a checked-out worktree: .dvc/config copied from git.
    await mkdir(path.join(worktree, ".dvc"), { recursive: true });
    await writeFile(path.join(worktree, ".dvc", "config"), "[core]\n  remote = origin\n");

    const r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.dvc).toBe(true);
    expect(await isSymlinkTo(path.join(worktree, ".dvc", "cache"), path.join(repo, ".dvc", "cache"))).toBe(true);
    // .dvc/config stays as a real file, not symlinked.
    const cfgStat = await stat(path.join(worktree, ".dvc", "config"));
    expect(cfgStat.isFile()).toBe(true);
    const cfgLink = await readlink(path.join(worktree, ".dvc", "config")).catch(() => null);
    expect(cfgLink).toBeNull();
  });

  it("handles both pivot and dvc when the repo uses both", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    await mkdir(path.join(repo, ".dvc"), { recursive: true });
    const r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.pivot).toBe(true);
    expect(r.dvc).toBe(true);
  });

  it("is idempotent on a second run (no errors, same final state)", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    await writeFile(path.join(repo, ".pivot", "config.yaml"), "x: 1\n");

    const a = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    const b = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(a).toEqual(b);
    expect(
      await isSymlinkTo(path.join(worktree, ".pivot", "cache"), path.join(repo, ".pivot", "cache")),
    ).toBe(true);
  });

  it("replaces a stale symlink that points at the wrong target", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    // Pre-create a wrong-target symlink in the worktree, as if a previous
    // setup pointed elsewhere.
    await mkdir(path.join(worktree, ".pivot"), { recursive: true });
    const wrongTarget = path.join(root, "elsewhere");
    await mkdir(wrongTarget, { recursive: true });
    await symlink(wrongTarget, path.join(worktree, ".pivot", "cache"));

    await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(
      await isSymlinkTo(path.join(worktree, ".pivot", "cache"), path.join(repo, ".pivot", "cache")),
    ).toBe(true);
  });

  it("refuses to clobber a pre-existing real file/dir at the link destination", async () => {
    await mkdir(path.join(repo, ".pivot"), { recursive: true });
    // Worktree has a real `cache` directory with content \u2014 e.g. user ran
    // pivot in-place before. We must not delete it.
    await mkdir(path.join(worktree, ".pivot", "cache"), { recursive: true });
    await writeFile(path.join(worktree, ".pivot", "cache", "important.bin"), "DO NOT DELETE");

    const r = await setupWorktreeDataTools({ repoPath: repo, worktreePath: worktree });
    expect(r.pivot).toBe(true);
    expect(r.skipped).toContain(path.join(worktree, ".pivot", "cache"));

    // File is still there.
    const survived = await stat(path.join(worktree, ".pivot", "cache", "important.bin"));
    expect(survived.isFile()).toBe(true);
  });
});
