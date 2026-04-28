/** pru list — list all agents, grouped by project. */
import { apiGet } from "../api.js";

interface Agent {
  id: string;
  name: string;
  projectName: string;
  state: string;
  running: boolean;
  model: string | null;
  branchName: string | null;
  usage?: {
    costUsd: number;
    totalTokens: number;
    turns: number;
  };
}

function formatCost(c: number): string {
  if (!c) return "$0.00";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

function formatTokens(t: number): string {
  if (t < 1_000) return `${t}`;
  if (t < 1_000_000) return `${(t / 1_000).toFixed(1)}k`;
  return `${(t / 1_000_000).toFixed(2)}M`;
}

export async function list(opts: { project?: string }): Promise<void> {
  try {
    const data = await apiGet<{ agents: Agent[] }>("/api/agents");
    let agents = data.agents;
    if (opts.project) {
      agents = agents.filter((a) => a.projectName === opts.project);
    }
    if (agents.length === 0) {
      console.log(opts.project ? `no agents in project "${opts.project}"` : "no agents");
      return;
    }

    // Group by project, then sort agents alphabetically within each group.
    const byProject = new Map<string, Agent[]>();
    for (const a of agents) {
      const bucket = byProject.get(a.projectName) ?? [];
      bucket.push(a);
      byProject.set(a.projectName, bucket);
    }
    const projectNames = [...byProject.keys()].sort();

    for (let i = 0; i < projectNames.length; i++) {
      const pname = projectNames[i];
      if (i > 0) console.log("");
      console.log(`${pname}/`);
      const group = byProject.get(pname)!.sort((a, b) => a.name.localeCompare(b.name));
      for (const a of group) {
        const icon = a.running ? "●" : "○";
        const state = a.state.padEnd(14);
        const cost = (a.usage?.costUsd ?? 0) > 0 ? `  ${formatCost(a.usage!.costUsd)}` : "";
        const toks =
          (a.usage?.totalTokens ?? 0) > 0 ? `  ${formatTokens(a.usage!.totalTokens)}tok` : "";
        const model = a.model ? `  ${a.model}` : "";
        console.log(`  ${icon} ${a.id}  ${state} ${a.name}${model}${cost}${toks}`);
      }
    }
  } catch (err) {
    console.error(`✗ failed to list agents: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
