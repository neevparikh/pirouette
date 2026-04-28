/** Git helpers for projects and per-agent worktrees.
 *
 *  Design:
 *    - A project is either a real git repo or a bare directory (no .git).
 *    - Each agent gets its own git worktree on branch `agent/<slug>`.
 *    - Worktrees live *outside* the project's repo directory (in a sibling
 *      `worktrees/` tree) so tooling in the main repo (pip, pytest, npm)
 *      doesn't accidentally scan agent branches as submodules.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/** Run a git command in the given cwd and return its stdout.
 *  Does not throw on non-zero exit \u2014 returns `{ code, stdout, stderr }`
 *  so callers can branch on specific failure modes. */
async function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await pExecFile("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 20 * 1024 * 1024,
      // Defense against malformed remote URLs hanging on credential
      // prompts: tell git to fail fast rather than open a TTY for input.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: (e.stderr ?? e.message ?? "").toString(),
    };
  }
}

/** URL prefixes we accept for `git clone`. Rejects flag-like URLs
 *  (`-c protocol.…`, `--upload-pack=…`, etc.) and bare paths that
 *  could trigger surprising git behavior. Same set git itself supports
 *  in modern versions; making it explicit here surfaces typos earlier. */
const ALLOWED_REPO_URL_RE = /^(https?:\/\/|git@|ssh:\/\/)/;

// ---- directory utilities -------------------------------------------------

export async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ["rev-parse", "--git-dir"], { timeoutMs: 5000 });
  return r.code === 0;
}

// ---- project-level operations -------------------------------------------

export interface CloneOptions {
  url: string;
  dest: string;
  branch?: string;
  timeoutMs?: number;
}

export async function cloneRepo(opts: CloneOptions): Promise<void> {
  const { url, dest, branch, timeoutMs = 120_000 } = opts;

  // Guard against attacker-supplied URLs that could be parsed as git
  // flags. Modern git rejects `-`-leading positional URLs but several
  // historical exploit chains used `--upload-pack=` or similar. We do
  // both: a positive prefix check AND the `--` separator below.
  if (!ALLOWED_REPO_URL_RE.test(url)) {
    throw new Error(
      `repoUrl must start with https://, git@, or ssh:// (got: ${url.slice(0, 60)})`,
    );
  }

  await mkdir(path.dirname(dest), { recursive: true });

  // `--` separator stops git from interpreting `url` or `dest` as flags
  // even if our prefix check above were bypassed somehow. Defense in
  // depth, ~free.
  const args = ["clone"];
  if (branch) args.push("--branch", branch);
  args.push("--", url, dest);

  const r = await git(path.dirname(dest), args, { timeoutMs });
  if (r.code !== 0) {
    throw new Error(`git clone failed: ${r.stderr.trim() || "unknown error"}`);
  }
}

/** Figure out the default branch of a repo. Tries symbolic-ref HEAD first,
 *  then falls back to the first branch we find. Returns null if the dir
 *  isn't a git repo at all. */
export async function getDefaultBranch(repoPath: string): Promise<string | null> {
  if (!(await isGitRepo(repoPath))) return null;
  // Preferred: remote HEAD (points to origin/main or similar)
  const remote = await git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    timeoutMs: 5000,
  });
  if (remote.code === 0) {
    const match = remote.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }
  // Fallback: current HEAD
  const local = await git(repoPath, ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 5000 });
  if (local.code === 0) return local.stdout.trim();
  return null;
}

/** Initialize a new git repo at `repoPath` with an empty initial commit.
 *  Used when a project is created without a remote URL so we still have a
 *  HEAD to branch worktrees off.
 *
 *  Sets `user.name` / `user.email` *locally* (per-repo) so the initial
 *  commit doesn't depend on the host's global git config. Pirouette's
 *  container has no global identity and the upstream `git commit` would
 *  otherwise fail with `unable to auto-detect email address`.
 */
export async function initRepo(repoPath: string): Promise<string> {
  await mkdir(repoPath, { recursive: true });
  let r = await git(repoPath, ["init", "-b", "main"], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr}`);
  // Configure a stable identity *for this repo* so the initial commit
  // works regardless of host config. Errors here are non-fatal — the
  // downstream commit will fail loudly if either is unset.
  await git(repoPath, ["config", "--local", "user.email", "pirouette@local"], { timeoutMs: 5000 });
  await git(repoPath, ["config", "--local", "user.name", "pirouette"], { timeoutMs: 5000 });
  r = await git(repoPath, ["commit", "--allow-empty", "-m", "initial commit (pirouette)"], {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) throw new Error(`initial commit failed: ${r.stderr}`);
  return "main";
}

// ---- worktree operations ------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Create a git worktree on a new branch (or reuse the existing branch of
 *  that name). Returns the final path + branch name, which may differ from
 *  the requested one if a collision was encountered.
 *
 *  Collision handling: if `agent/<slug>` or the worktree path already exist,
 *  we append `-2`, `-3`, ... until a free slot is found \u2014 same as Orchestra. */
export async function createWorktree(opts: {
  repoPath: string;
  worktreesDir: string;
  slug: string;
  baseBranch: string;
}): Promise<WorktreeInfo> {
  await mkdir(opts.worktreesDir, { recursive: true });

  let branch = `agent/${opts.slug}`;
  let worktreePath = path.join(opts.worktreesDir, opts.slug);
  let suffix = 1;

  while (true) {
    const branchExists =
      (await git(opts.repoPath, ["rev-parse", "--verify", branch], { timeoutMs: 5000 })).code === 0;
    const pathExists = await dirExists(worktreePath);
    if (!branchExists && !pathExists) break;
    suffix += 1;
    branch = `agent/${opts.slug}-${suffix}`;
    worktreePath = path.join(opts.worktreesDir, `${opts.slug}-${suffix}`);
  }

  // Base ref preference: remote branch if it exists, else local HEAD.
  let baseRef = `origin/${opts.baseBranch}`;
  const hasRemote = await git(opts.repoPath, ["rev-parse", "--verify", baseRef], { timeoutMs: 5000 });
  if (hasRemote.code !== 0) baseRef = "HEAD";

  const r = await git(opts.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef], {
    timeoutMs: 30_000,
  });
  if (r.code !== 0) {
    throw new Error(`git worktree add failed: ${r.stderr.trim() || "unknown error"}`);
  }

  return { path: worktreePath, branch };
}

/** Remove a worktree and optionally delete its branch.
 *  Safe to call on a path that isn't actually a worktree \u2014 we'll fall back
 *  to `rm -rf` so the directory disappears either way. */
export async function removeWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch?: string | null;
  deleteBranch?: boolean;
}): Promise<void> {
  // Prune first so stale entries from prior `rm -rf`s don't block us.
  await git(opts.repoPath, ["worktree", "prune"], { timeoutMs: 5000 });

  const r = await git(
    opts.repoPath,
    ["worktree", "remove", "--force", opts.worktreePath],
    { timeoutMs: 10_000 },
  );
  // If `worktree remove` said the path isn't a registered worktree, just rm.
  if (r.code !== 0) {
    await rm(opts.worktreePath, { recursive: true, force: true });
  }

  if (opts.deleteBranch && opts.branch) {
    await git(opts.repoPath, ["branch", "-D", opts.branch], { timeoutMs: 5000 });
  }
}
