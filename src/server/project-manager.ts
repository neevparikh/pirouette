/** Project lifecycle: create / list / remove. Each project owns a single
 *  workspace (a cloned repo or a plain directory) plus a `worktrees/` dir
 *  where per-agent worktrees live.
 *
 *  A default `scratchpad` project is auto-created on first boot so users
 *  can spin up agents without setting up a repo first.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { StateManager } from "./state.js";
import {
  DEFAULT_PROJECT_NAME,
  type ProjectConfig,
} from "./types.js";
import {
  cloneRepo,
  getDefaultBranch,
  initRepo,
  isEmptyOrMissing,
} from "./git.js";

/** Slugify a user-provided project name. Same rules as agent slugs. */
function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "project";
}

export class ProjectManager {
  constructor(
    private readonly stateManager: StateManager,
    private readonly dataDir: string,
  ) {}

  private reposDir(): string {
    return path.join(this.dataDir, "repos");
  }

  private worktreesBase(): string {
    return path.join(this.dataDir, "worktrees");
  }

  private projectRepoPath(name: string): string {
    return path.join(this.reposDir(), name);
  }

  private projectWorktreesDir(name: string): string {
    return path.join(this.worktreesBase(), name);
  }

  getProject(name: string): ProjectConfig | undefined {
    return this.stateManager.getProject(name);
  }

  getAllProjects(): ProjectConfig[] {
    return this.stateManager.getProjects();
  }

  /** Names currently being created. Prevents two concurrent POSTs for the
   *  same project name from racing each other into the clone step —
   *  whichever loses the race trips the "not empty" check and leaves the
   *  user staring at a cryptic error. With this set, the second caller
   *  gets a clean 409 right away. */
  private creatingNames = new Set<string>();

  /** Create the default scratchpad project if it doesn't exist. Idempotent.
   *  Called once at server startup so that bare agent creation always has a
   *  target project. */
  async ensureDefaultProject(): Promise<ProjectConfig> {
    const existing = this.getProject(DEFAULT_PROJECT_NAME);
    if (existing) return existing;
    return this.createProject({ name: DEFAULT_PROJECT_NAME });
  }

  /** Log a warning for any subdirectory under `repos/` that doesn't have a
   *  matching project entry in state. Most likely cause: a failed
   *  `createProject` that errored AFTER the on-disk clone started but
   *  BEFORE `putProject` ran (e.g. server crash). Doesn't auto-clean —
   *  the user might want to inspect / recover the contents. Called once
   *  at server boot from runServer(). */
  async warnAboutOrphanedRepos(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.reposDir());
    } catch {
      return; // repos/ doesn't exist yet, fine.
    }
    const knownNames = new Set(this.getAllProjects().map((p) => p.name));
    const orphans = entries.filter((e) => !knownNames.has(e));
    if (orphans.length === 0) return;
    console.warn(
      `[project-manager] orphaned repo dir(s) detected (no matching project in state): ` +
        orphans.map((o) => `${this.reposDir()}/${o}`).join(", "),
    );
    console.warn(
      `  Likely from a failed createProject that didn't roll back cleanly.` +
        ` Either rm -rf to free the name, or move aside if you want to recover the contents.`,
    );
  }

  /** Create a new project.
   *  - If `repoUrl` is provided: clone it into `<dataDir>/repos/<name>/`
   *  - Otherwise: `git init` an empty repo so worktrees still work
   *
   *  Throws on name collision, validation error, or clone failure.
   *  Throws `PROJECT_IN_FLIGHT` (a tagged Error) if a concurrent POST is
   *  already creating the same name — callers should map that to 409. */
  async createProject(opts: {
    name: string;
    repoUrl?: string;
  }): Promise<ProjectConfig> {
    const name = slugifyProjectName(opts.name);
    if (!name) throw new Error("project name is required");
    if (this.getProject(name)) {
      throw new Error(`project "${name}" already exists`);
    }

    // Race guard. A clone takes 1-30s; the UI used to allow a second
    // click during that window, which raced into the empty-dir check on
    // the half-cloned target dir and produced a cryptic error. With this
    // set, the second concurrent call returns immediately with a clean
    // signal that the request is already in flight.
    if (this.creatingNames.has(name)) {
      const err = new Error(
        `project "${name}" creation is already in progress — wait for it to finish (or fail)`,
      ) as Error & { code?: string };
      err.code = "PROJECT_IN_FLIGHT";
      throw err;
    }
    this.creatingNames.add(name);

    try {
      const repoPath = this.projectRepoPath(name);
      const worktreesDir = this.projectWorktreesDir(name);

      await mkdir(this.reposDir(), { recursive: true });
      await mkdir(worktreesDir, { recursive: true });

      // Ensure the target path is empty so clone/init doesn't trip over stale files.
      if (!(await isEmptyOrMissing(repoPath))) {
        throw new Error(
          `repo path ${repoPath} is not empty; refusing to clone/init into it. ` +
            `If this is leftover from a failed previous attempt, remove it first: ` +
            `\`rm -rf ${repoPath}\` (or pick a different project name).`,
        );
      }

      let defaultBranch: string | null = null;
      try {
        if (opts.repoUrl) {
          console.log(`[project-manager] cloning ${opts.repoUrl} \u2192 ${repoPath}`);
          await cloneRepo({ url: opts.repoUrl, dest: repoPath });
          defaultBranch = await getDefaultBranch(repoPath);
        } else {
          // Always init a repo so worktrees work. Scratchpad falls into this
          // branch: bare directory + empty initial commit.
          console.log(`[project-manager] init new repo at ${repoPath}`);
          defaultBranch = await initRepo(repoPath);
        }
      } catch (err) {
        // Clean up partial state on failure.
        try {
          await rm(repoPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        throw err;
      }

      const config: ProjectConfig = {
        name,
        repoUrl: opts.repoUrl ?? null,
        repoPath,
        worktreesDir,
        defaultBranch,
        createdAt: new Date().toISOString(),
      };
      this.stateManager.putProject(config);
      return config;
    } finally {
      this.creatingNames.delete(name);
    }
  }

  /** Remove a project. Optionally delete its repo + worktrees on disk.
   *  By default, refuses to remove a project that still has agents. */
  async removeProject(opts: {
    name: string;
    deleteRepo?: boolean;
    requireEmpty?: boolean;
  }): Promise<void> {
    const { name, deleteRepo = false, requireEmpty = true } = opts;
    const project = this.getProject(name);
    if (!project) throw new Error(`project "${name}" not found`);
    if (name === DEFAULT_PROJECT_NAME) {
      throw new Error(`the ${DEFAULT_PROJECT_NAME} project cannot be removed`);
    }
    if (requireEmpty) {
      const agents = this.stateManager
        .getAgents()
        .filter((a) => a.projectName === name);
      if (agents.length > 0) {
        throw new Error(
          `project "${name}" still has ${agents.length} agent(s); ` +
            `remove them first or pass requireEmpty=false`,
        );
      }
    }

    if (deleteRepo) {
      try {
        await rm(project.repoPath, { recursive: true, force: true });
        await rm(project.worktreesDir, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `[project-manager] failed to delete on-disk data for ${name}: ${err}`,
        );
      }
    }
    this.stateManager.removeProject(name);
  }
}
