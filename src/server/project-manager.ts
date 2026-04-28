/** Project lifecycle: create / list / remove. Each project owns a single
 *  workspace (a cloned repo or a plain directory) plus a `worktrees/` dir
 *  where per-agent worktrees live.
 *
 *  A default `scratchpad` project is auto-created on first boot so users
 *  can spin up agents without setting up a repo first.
 */

import { mkdir, rm } from "node:fs/promises";
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

  /** Create the default scratchpad project if it doesn't exist. Idempotent.
   *  Called once at server startup so that bare agent creation always has a
   *  target project. */
  async ensureDefaultProject(): Promise<ProjectConfig> {
    const existing = this.getProject(DEFAULT_PROJECT_NAME);
    if (existing) return existing;
    return this.createProject({ name: DEFAULT_PROJECT_NAME });
  }

  /** Create a new project.
   *  - If `repoUrl` is provided: clone it into `<dataDir>/repos/<name>/`
   *  - Otherwise: `git init` an empty repo so worktrees still work
   *
   *  Throws on name collision, validation error, or clone failure. */
  async createProject(opts: {
    name: string;
    repoUrl?: string;
  }): Promise<ProjectConfig> {
    const name = slugifyProjectName(opts.name);
    if (!name) throw new Error("project name is required");
    if (this.getProject(name)) {
      throw new Error(`project "${name}" already exists`);
    }

    const repoPath = this.projectRepoPath(name);
    const worktreesDir = this.projectWorktreesDir(name);

    await mkdir(this.reposDir(), { recursive: true });
    await mkdir(worktreesDir, { recursive: true });

    // Ensure the target path is empty so clone/init doesn't trip over stale files.
    if (!(await isEmptyOrMissing(repoPath))) {
      throw new Error(
        `repo path ${repoPath} is not empty; refusing to clone/init into it`,
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
