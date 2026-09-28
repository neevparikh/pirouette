/** pru send <agent> [message] — send a message to an agent.
 *
 *  Run from inside a pirouette agent, the message is sent *as that agent*:
 *  the recipient sees a header naming the sender and how to reply, and the
 *  dashboard labels the row "from agent <name>" instead of drawing it as
 *  the user. From a human shell (no `PI_SESSION_FILE`) it is a plain user
 *  message, as before. `--as-user` forces the user form from anywhere.
 */
import { readFileSync } from "node:fs";

import { apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

export interface SendOptions {
  messageFile?: string;
  asUser?: boolean;
  followUp?: boolean;
}

/** Request body for POST /api/agents/:id/message. Split out for tests. */
export function buildSendBody(
  message: string,
  opts: SendOptions,
  env: NodeJS.ProcessEnv = process.env,
): { message: string; from?: string; mode?: "followUp" } {
  const from = opts.asUser ? null : selfAgentRef(env);
  return {
    message,
    ...(from ? { from } : {}),
    ...(opts.followUp ? { mode: "followUp" as const } : {}),
  };
}

export async function send(
  agent: string,
  message: string | undefined,
  opts: SendOptions = {},
): Promise<void> {
  let text = message;
  if (opts.messageFile) {
    if (message !== undefined) {
      console.error("✗ pass the message either inline or with --message-file, not both");
      process.exit(1);
    }
    try {
      text = readFileSync(opts.messageFile, "utf8");
    } catch (err) {
      console.error(`✗ could not read ${opts.messageFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  if (!text || !text.trim()) {
    console.error("✗ no message given: pru send <agent> <message> (or --message-file <path>)");
    process.exit(1);
  }

  const body = buildSendBody(text, opts);
  try {
    await apiPost(`/api/agents/${agent}/message`, body);
    const as = body.from ? ` as agent ${body.from}` : "";
    console.log(`✓ message sent to ${agent}${as}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`✗ failed to send message: ${reason}`);
    // This shell belongs to an agent the target server doesn't know —
    // usually because PIROUETTE_URL points at a different server.
    if (body.from && /sender/i.test(reason)) {
      console.error(
        `  (sent as agent ${body.from}, from PI_SESSION_FILE; pass --as-user to send as the user instead)`,
      );
    }
    process.exit(1);
  }
}
