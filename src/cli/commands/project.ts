/** `pru project add|list|rm` — manage projects.
 *
 *  A project groups 0..N agents that share a filesystem workspace. The
 *  default `scratchpad` project is auto-created by the server for agents
 *  that don't need a dedicated repo; use these commands to add your own
 *  named projects (each with a cloned repo or a bare workspace).
 */

import { apiDelete, apiGet, apiPost } from "../api.js";

interface ProjectSummary {
  name: string;
  repoUrl: string | null;
  repoPath: string;
  defaultBranch: string | null;
  createdAt: string;
}

export async function projectList(): Promise<void> {
  try {
    const { projects } = await apiGet<{ projects: ProjectSummary[] }>("/api/projects");
    if (projects.length === 0) {
      console.log("no projects");
      return;
    }
    const nameWidth = Math.max(...projects.map((p) => p.name.length));
    for (const p of projects) {
      const branch = p.defaultBranch ? ` (${p.defaultBranch})` : "";
      const repo = p.repoUrl ? `  ${p.repoUrl}${branch}` : "  (bare)";
      console.log(`  ${p.name.padEnd(nameWidth)}${repo}`);
    }
  } catch (err) {
    console.error(`✗ failed to list projects: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function projectAdd(
  name: string,
  opts: { repo?: string },
): Promise<void> {
  try {
    const p = await apiPost<ProjectSummary>("/api/projects", {
      name,
      repoUrl: opts.repo,
    });
    console.log(`✓ project created: ${p.name}`);
    if (p.repoUrl) console.log(`  repo:    ${p.repoUrl}`);
    console.log(`  path:    ${p.repoPath}`);
    if (p.defaultBranch) console.log(`  branch:  ${p.defaultBranch}`);
  } catch (err) {
    console.error(`✗ failed to create project: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function projectRm(
  name: string,
  opts: { deleteRepo?: boolean; force?: boolean },
): Promise<void> {
  const qs = new URLSearchParams();
  if (opts.deleteRepo) qs.set("deleteRepo", "true");
  if (opts.force) qs.set("requireEmpty", "false");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  try {
    await apiDelete(`/api/projects/${encodeURIComponent(name)}${suffix}`);
    const extras: string[] = [];
    if (opts.force) extras.push("forced");
    if (opts.deleteRepo) extras.push("repo deleted");
    const suffixLog = extras.length ? ` (${extras.join(", ")})` : "";
    console.log(`✓ removed project ${name}${suffixLog}`);
  } catch (err) {
    console.error(`✗ failed to remove project: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
