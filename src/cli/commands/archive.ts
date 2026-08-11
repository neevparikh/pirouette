/** pru archive [agent] / pru unarchive [agent] — tuck a chat away, or
 *  bring it back.
 *
 *  Archiving is the CLI twin of the dashboard's archive button, and just
 *  as cheap: it sets a display-only flag. The agent keeps its id,
 *  worktree, branch, session files and — if it was running — its process;
 *  the dashboard simply hides it from the chat list until "show archived"
 *  is on. Nothing is deleted, so `pru unarchive` puts it back exactly as
 *  it was. Use `pru rm` when you actually want the chat gone.
 *
 *  `--stop` archives *and* stops the agent, which is what "I'm finished
 *  with this chat" usually means: the transcript stays readable, but no
 *  session is left running behind the archive where nobody will think to
 *  look for it.
 *
 *  With no agent argument (or `self`) both commands target the agent
 *  running them, so an agent that has finished its task can file itself
 *  away without being told its own id.
 */
import { apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

/** Response shape of POST /api/agents/:id/archive. */
interface ArchiveResult {
  archived: boolean;
}

/** Resolve the agent a command targets: the argument, or whoever is
 *  running the command when the argument is missing or `self`. Exits
 *  with a usage error when neither is available. */
function resolveAgent(agentRef: string | undefined, verb: string): string {
  const agent = agentRef && agentRef !== "self" ? agentRef : selfAgentRef();
  if (!agent) {
    console.error(
      "✗ no agent given, and this shell isn't inside a pirouette agent " +
        `(no PI_SESSION_FILE). Pass the agent id or name: pru ${verb} <agent>`,
    );
    process.exit(1);
  }
  return agent;
}

export async function archive(
  agentRef: string | undefined,
  opts: { stop?: boolean } = {},
): Promise<void> {
  const agent = resolveAgent(agentRef, "archive");

  try {
    await apiPost<ArchiveResult>(`/api/agents/${agent}/archive`, { archived: true });
  } catch (err) {
    console.error(`✗ failed to archive agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`✓ agent ${agent} archived`);

  // Stop last, and only when asked. The archive flag is already saved by
  // this point, so a failed stop leaves the chat archived-but-running
  // rather than losing the archive. Stopping an agent that is archiving
  // *itself* also kills the shell this command runs in, so nothing after
  // the request is guaranteed to print.
  if (opts.stop) {
    try {
      await apiPost(`/api/agents/${agent}/stop`);
      console.log("  and stopped it.");
    } catch (err) {
      console.error(`✗ archived, but failed to stop: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    console.log(
      "  the agent is otherwise untouched (still running, if it was) — " +
        "add --stop to shut it down too.",
    );
  }
  console.log(`  bring it back with: pru unarchive ${agent}`);
}

export async function unarchive(agentRef: string | undefined): Promise<void> {
  const agent = resolveAgent(agentRef, "unarchive");
  try {
    await apiPost<ArchiveResult>(`/api/agents/${agent}/archive`, { archived: false });
    console.log(`✓ agent ${agent} unarchived`);
    console.log("  it's back in the dashboard's chat list.");
  } catch (err) {
    console.error(`✗ failed to unarchive agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
