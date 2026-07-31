/** pru rename <agent> <new-name> — give a chat a name you'll recognise.
 *
 *  Renaming is display-only: the agent keeps its id, git worktree, branch
 *  and session files, all of which were slugged from the name it was
 *  created with. So a chat that started life as `flaky-test-hunt` can become
 *  `pr-42` without disturbing the work in its worktree.
 *
 *  `self` (or no agent at all) targets the agent running the command, so
 *  an agent can rename its own chat once it knows what it's working on.
 */
import { apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

interface RenamedAgent {
  id: string;
  name: string;
  projectName: string;
}

export async function rename(agentRef: string, newName?: string): Promise<void> {
  // `pru rename pr-42` (one arg) means "rename me to pr-42" when we can
  // work out who "me" is from PI_SESSION_FILE.
  let agent: string | null = agentRef;
  let name: string = newName ?? "";
  if (newName === undefined) {
    name = agentRef;
    agent = selfAgentRef();
  } else if (agent === "self") {
    agent = selfAgentRef();
  }
  if (!agent) {
    console.error(
      "✗ no agent given, and this shell isn't inside a pirouette agent " +
        "(no PI_SESSION_FILE). Pass the agent id or name: pru rename <agent> <new-name>",
    );
    process.exit(1);
  }

  try {
    const updated = await apiPost<RenamedAgent>(`/api/agents/${agent}/rename`, { name });
    console.log(`✓ ${agent} renamed to ${updated.name} (${updated.id})`);
    console.log(`  project: ${updated.projectName}`);
    console.log(`  worktree, branch and session files are unchanged.`);
  } catch (err) {
    console.error(`✗ failed to rename: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
