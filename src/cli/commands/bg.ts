/** pru bg <agent> — move an agent's running bash commands into the
 *  background.
 *
 *  The tool calls return straight away with the output so far, so the
 *  agent gets on with its turn (and reads any message waiting for it); the
 *  commands keep running, and the agent is messaged when each one exits.
 *  Unlike `pru interrupt`, nothing is killed. */
import { apiPost } from "../api.js";

/** Response of POST /api/agents/:id/bash. Declared locally, like the
 *  other commands. */
interface BackgroundResult {
  detached: number;
  scheduled: number;
  commands: Array<{ toolCallId: string; command: string; pid: number; startedAt: string }>;
}

export async function bg(agent: string): Promise<void> {
  try {
    const result = await apiPost<BackgroundResult>(`/api/agents/${agent}/bash`);
    if (result.detached === 0) {
      console.log(`· agent ${agent} has no bash command running`);
      return;
    }
    console.log(`✓ agent ${agent}: moved ${result.detached} bash command(s) to the background`);
    for (const c of result.commands) {
      const head = c.command.replace(/\s+/g, " ").trim();
      console.log(`    · pid ${c.pid}: ${head.length > 70 ? `${head.slice(0, 68)}…` : head}`);
    }
  } catch (err) {
    console.error(`✗ failed to background commands: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
