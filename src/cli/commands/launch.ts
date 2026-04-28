/** pru launch <name> — create a new agent via the server API.
 *
 *  Agents always belong to a project. `--project <name>` picks an existing
 *  project; if omitted the default `scratchpad` project is used. To work
 *  against a specific repo, create a project first with `pru project add`.
 */
import { apiPost } from "../api.js";

export async function launch(
  name: string,
  opts: { project?: string; model?: string; thinking?: string },
): Promise<void> {
  try {
    const agent = await apiPost("/api/agents", {
      name,
      projectName: opts.project,
      model: opts.model,
      thinkingLevel: opts.thinking,
    });
    const a = agent as Record<string, unknown>;
    console.log(`✓ agent created: ${a.name} (${a.id})`);
    console.log(`  project: ${a.projectName}`);
    if (a.branchName) console.log(`  branch:  ${a.branchName}`);
    console.log(`  workdir: ${a.worktreePath}`);
    console.log(`  state:   ${a.state}`);
  } catch (err) {
    console.error(`✗ failed to create agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
