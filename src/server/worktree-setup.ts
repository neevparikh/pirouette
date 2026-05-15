/** Per-worktree data-pipeline setup (pivot, DVC).
 *
 *  Some of our repos use `pivot` (the METR data pipeline tool, similar to
 *  DVC) or `dvc` itself. Both keep per-repo state under `.pivot/` /
 *  `.dvc/`: a content-addressed cache, a config file pointing at a remote
 *  (typically S3), locks, and a small per-checkout state DB.
 *
 *  Without help, a fresh git worktree only has the git-tracked subset:
 *    - `.pivot/stages/`, `.dvc/config` — tracked, present on checkout.
 *    - `.pivot/{cache,config.yaml,locks,state.lmdb}`, `.dvc/{cache,tmp}` —
 *      gitignored, absent.
 *
 *  So an agent in the worktree can't run pivot/dvc commands until someone
 *  re-configures them and re-downloads the cache from S3. That's slow,
 *  uses bandwidth, and is the kind of paper-cut that makes spawning a new
 *  agent feel heavyweight.
 *
 *  This module fixes it by, after `git worktree add`, populating the
 *  worktree's `.pivot` / `.dvc` so every agent shares the source-repo's
 *  cache and config:
 *
 *    Shared across all worktrees (symlink → source repo):
 *      `.pivot/cache`        content-addressed, append-only, safe to share
 *      `.pivot/config.yaml`  remote setup; identical across worktrees
 *      `.pivot/config.lock`  tiny lockfile next to config
 *      `.pivot/locks`        cross-process locking; correctness requires
 *                            worktrees use the SAME lock dir
 *      `.pivot/state.lmdb`   LMDB env mapping stage+params hash → output
 *                            hash. Content-addressed (same key everywhere
 *                            → same value), so sharing is correct: each
 *                            worktree is a strict superset reader. Also
 *                            avoids "No such file or directory" readonly-
 *                            open failures on fresh worktrees (pivot opens
 *                            it readonly per stage; an empty dir is not
 *                            yet an LMDB env). LMDB's own multi-process
 *                            locking + pivot's `.pivot/locks` together
 *                            serialise concurrent writers.
 *      `.dvc/cache`          content-addressed, same logic as pivot's
 *
 *    Per-worktree:
 *      (We don't create `.dvc/tmp`; DVC creates it on demand.)
 *
 *    Left alone (git-tracked):
 *      `.pivot/stages/`, `.dvc/config`
 *
 *  Auto-detected from the presence of `.pivot/` / `.dvc/` in the source
 *  repo. Idempotent: safe to call on every startSession, since each
 *  symlink/mkdir is no-op if already in place. Source dirs that don't
 *  exist yet are mkdir'd so the symlink resolves (pivot/dvc will populate
 *  them on first `pull`).
 */

import { mkdir, readlink, stat, symlink, lstat, unlink } from "node:fs/promises";
import path from "node:path";

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Ensure `dst` is a symlink pointing at `target`.
 *
 *  Idempotent:
 *    - missing: create the symlink.
 *    - already a symlink to `target`: no-op.
 *    - already a symlink to something else: replace.
 *    - exists as a non-symlink (file or real dir): leave alone (caller is
 *      responsible) and surface via the return value.
 *
 *  Returns `true` if a symlink now points at `target` (created or already
 *  correct), `false` if we couldn't get there without destroying data. */
async function ensureSymlink(target: string, dst: string): Promise<boolean> {
  let existing: { isSymbolicLink: boolean; isDir: boolean } | null = null;
  try {
    const s = await lstat(dst);
    existing = { isSymbolicLink: s.isSymbolicLink(), isDir: s.isDirectory() };
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink) {
    try {
      const current = await readlink(dst);
      if (path.resolve(path.dirname(dst), current) === path.resolve(target)) {
        return true; // already correct
      }
    } catch {
      // unreadable symlink — fall through and try to replace
    }
    // Different target: drop the old link, re-link.
    await unlink(dst);
    await symlink(target, dst);
    return true;
  }
  if (existing) {
    // Pre-existing real file or directory. Don't touch — they might have
    // hand-edited it. Caller can detect via the return value.
    return false;
  }
  await symlink(target, dst);
  return true;
}

export interface WorktreeSetupResult {
  pivot: boolean;
  dvc: boolean;
  /** Paths that were already present as real files/dirs (not symlinks) and
   *  we therefore left alone. Useful for the caller to log a one-line
   *  warning. */
  skipped: string[];
}

/** Set up pivot / DVC layout in a freshly-created (or resumed) worktree.
 *  Auto-detects which tools the project uses from the source repo. */
export async function setupWorktreeDataTools(opts: {
  repoPath: string;
  worktreePath: string;
}): Promise<WorktreeSetupResult> {
  const result: WorktreeSetupResult = { pivot: false, dvc: false, skipped: [] };

  // ---- pivot ----
  const pivotSrc = path.join(opts.repoPath, ".pivot");
  if (await isDirectory(pivotSrc)) {
    const pivotDst = path.join(opts.worktreePath, ".pivot");
    await mkdir(pivotDst, { recursive: true });

    // Items to share with the source repo. Directories must exist so the
    // symlink isn't dangling — mkdir -p them in the source first. Files
    // (config.yaml / config.lock) get symlinked only if they exist in the
    // source; we don't fabricate them.
    //
    // state.lmdb is also shared: pivot opens it READONLY per stage during
    // `status`, which on an empty dir fails with "No such file or
    // directory" because lmdb hasn't been initialised. Sharing the source
    // repo's already-initialised LMDB env (data.mdb + lock.mdb) skips
    // that bootstrap and lets `pivot status` work immediately. It's also
    // semantically a hash-keyed superset — the same trade-off as the
    // content-addressed `cache` dir.
    const sharedDirs = ["cache", "locks", "state.lmdb"];
    const sharedFiles = ["config.yaml", "config.lock"];

    for (const item of sharedDirs) {
      const src = path.join(pivotSrc, item);
      const dst = path.join(pivotDst, item);
      await mkdir(src, { recursive: true });
      const ok = await ensureSymlink(src, dst);
      if (!ok) result.skipped.push(dst);
    }
    for (const item of sharedFiles) {
      const src = path.join(pivotSrc, item);
      const dst = path.join(pivotDst, item);
      if (await pathExists(src)) {
        const ok = await ensureSymlink(src, dst);
        if (!ok) result.skipped.push(dst);
      }
    }

    result.pivot = true;
  }

  // ---- dvc ----
  const dvcSrc = path.join(opts.repoPath, ".dvc");
  if (await isDirectory(dvcSrc)) {
    const dvcDst = path.join(opts.worktreePath, ".dvc");
    await mkdir(dvcDst, { recursive: true });

    // Only `cache` is shared. `config` is git-tracked; `tmp` is per-checkout
    // and DVC creates it on demand.
    const src = path.join(dvcSrc, "cache");
    const dst = path.join(dvcDst, "cache");
    await mkdir(src, { recursive: true });
    const ok = await ensureSymlink(src, dst);
    if (!ok) result.skipped.push(dst);

    result.dvc = true;
  }

  return result;
}
