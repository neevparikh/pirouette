/** pru handoff <agent> — hand an agent's work over to a fresh successor.
 *
 *  The successor takes over the same worktree, branch, model and thinking
 *  level with an empty context; the outgoing agent is archived and then
 *  stopped. Use it when a chat has grown long, expensive, or muddled but
 *  the work in the worktree is fine.
 *
 *  `--message` is the briefing the successor wakes up to. Without one it
 *  starts idle, waiting for you (or the outgoing agent's handoff notes).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { apiPost } from "../api.js";

/** Work out which agent is running *this* command, so an agent can hand
 *  itself off without being told its own id. Pi exports `PI_SESSION_FILE`
 *  into every bash call, and pirouette names each agent's session
 *  directory `<slug>-<id>` — the id is the last path component's suffix. */
export function selfAgentRef(env: NodeJS.ProcessEnv = process.env): string | null {
  const sessionFile = env.PI_SESSION_FILE;
  if (!sessionFile) return null;
  const match = path.basename(path.dirname(sessionFile)).match(/-([0-9a-f]{8})$/);
  return match ? match[1] : null;
}

interface HandoffResult {
  id: string;
  name: string;
  projectName: string;
  worktreePath: string;
  branchName: string | null;
}

export async function handoff(
  agentRef: string | undefined,
  opts: { name?: string; message?: string; messageFile?: string },
): Promise<void> {
  const agent = agentRef && agentRef !== "self" ? agentRef : selfAgentRef();
  if (!agent) {
    console.error(
      "✗ no agent given, and this shell isn't inside a pirouette agent " +
        "(no PI_SESSION_FILE). Pass the agent id or name: pru handoff <agent>",
    );
    process.exit(1);
  }

  let message = opts.message;
  if (opts.messageFile) {
    try {
      message = readFileSync(opts.messageFile, "utf8");
    } catch (err) {
      console.error(`✗ could not read ${opts.messageFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  try {
    const successor = await apiPost<HandoffResult>(`/api/agents/${agent}/handoff`, {
      name: opts.name,
      message,
    });
    console.log(`✓ ${agent} handed off to ${successor.name} (${successor.id})`);
    console.log(`  project: ${successor.projectName}`);
    if (successor.branchName) console.log(`  branch:  ${successor.branchName}`);
    console.log(`  workdir: ${successor.worktreePath}`);
    console.log(`  ${agent} is archived and will stop shortly.`);
  } catch (err) {
    console.error(`✗ failed to hand off: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
