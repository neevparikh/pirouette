/** pru compact [agent] — compact an agent's context in place.
 *
 *  The CLI twin of the dashboard's `/compact`, with one difference that
 *  makes it usable by an agent on *itself*: by default the compaction is
 *  queued until the agent's current turn ends instead of aborting it.
 *  An agent runs this from its own bash tool, so an immediate compaction
 *  would kill the very tool call that asked for it.
 *
 *  When an agent compacts itself it is usually mid-task, so once the
 *  compaction is done it gets a "carry on" message as a new turn (override
 *  with `--message`, suppress with `--no-continue`). Compacting another
 *  agent sends nothing afterwards unless `--message` is given.
 */
import { readFileSync } from "node:fs";

import { apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

/** Sent to an agent after the compaction it asked for, so it resumes work
 *  from the summary instead of sitting idle. */
export const DEFAULT_SELF_COMPACT_CONTINUE_MESSAGE =
  "[pirouette] Your context was compacted, as you asked with `pru compact`. " +
  "Pick the task up from the summary above and continue from where you left off.";

interface CompactResult {
  accepted: boolean;
  deferred?: boolean;
}

export async function compact(
  agentRef: string | undefined,
  opts: {
    instructions?: string;
    instructionsFile?: string;
    message?: string;
    continue?: boolean;
    now?: boolean;
  },
): Promise<void> {
  const self = selfAgentRef();
  const agent = agentRef && agentRef !== "self" ? agentRef : self;
  if (!agent) {
    console.error(
      "✗ no agent given, and this shell isn't inside a pirouette agent " +
        "(no PI_SESSION_FILE). Pass the agent id or name: pru compact <agent>",
    );
    process.exit(1);
  }
  const isSelf = agent === self;

  let instructions = opts.instructions;
  if (opts.instructionsFile) {
    try {
      instructions = readFileSync(opts.instructionsFile, "utf8");
    } catch (err) {
      console.error(`✗ could not read ${opts.instructionsFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // commander maps `--no-continue` to `continue: false`.
  let message: string | undefined;
  if (opts.continue !== false) {
    message = opts.message ?? (isSelf ? DEFAULT_SELF_COMPACT_CONTINUE_MESSAGE : undefined);
  }

  if (opts.now && isSelf) {
    console.error(
      "✗ --now would abort this very command along with your turn. Leave it off: " +
        "the compaction runs as soon as your turn ends.",
    );
    process.exit(1);
  }

  let result: CompactResult;
  try {
    result = await apiPost<CompactResult>(`/api/agents/${agent}/compact`, {
      instructions,
      afterTurn: !opts.now,
      message,
    });
  } catch (err) {
    console.error(`✗ failed to compact: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (!result.deferred) {
    console.log(`✓ compacting ${agent} now`);
  } else if (isSelf) {
    console.log("✓ compaction queued: it runs as soon as this turn ends.");
    console.log("  End your turn now (a one-line reply, no more tool calls).");
    if (message) console.log("  Afterwards you'll be woken with a message to continue.");
  } else {
    console.log(`✓ compaction of ${agent} queued behind its current turn`);
  }
}
