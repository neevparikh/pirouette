/** pru notify <message> — raise a desktop notification in the dashboard.
 *
 *  For things that need the user's attention now, from an agent or from a
 *  long-running script it started: "the AWS login expired, approve this
 *  code", "the deploy is blocked on you". Every open dashboard with
 *  notifications turned on (the sidebar's `notify` toggle) shows it as a
 *  browser notification with this text, rather than the generic "your
 *  turn" that turn-end notifications carry.
 *
 *  `--url` makes clicking the notification open that page (a login or PR
 *  link); without it, clicking jumps to the agent. The notification is
 *  attributed to the agent running the command, or `--agent` when given,
 *  and titled with that agent's name unless `--title` is set.
 *
 *  Nothing is queued: if no dashboard is open, the notification is lost.
 *  The command prints how many dashboards received it.
 */
import { readFileSync } from "node:fs";

import { apiPost } from "../api.js";
import { selfAgentRef } from "./handoff.js";

/** Response shape of POST /api/agents/:id/notify. */
interface NotifyResult {
  delivered: number;
}

export async function notify(
  message: string | undefined,
  opts: { agent?: string; title?: string; url?: string; messageFile?: string } = {},
): Promise<void> {
  const agent = opts.agent && opts.agent !== "self" ? opts.agent : selfAgentRef();
  if (!agent) {
    console.error(
      "✗ this shell isn't inside a pirouette agent (no PI_SESSION_FILE), so there's " +
        "no agent to attribute the notification to. Pass one: pru notify --agent <agent> <message>",
    );
    process.exit(1);
  }
  if (message !== undefined && opts.messageFile) {
    console.error("✗ pass the message as an argument or with --message-file, not both");
    process.exit(1);
  }
  let body = message;
  if (opts.messageFile) {
    try {
      body = readFileSync(opts.messageFile, "utf8");
    } catch (err) {
      console.error(`✗ could not read ${opts.messageFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  if (!body || body.trim() === "") {
    console.error("✗ no message given: pru notify <message>");
    process.exit(1);
  }

  let result: NotifyResult;
  try {
    result = await apiPost<NotifyResult>(`/api/agents/${agent}/notify`, {
      body,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.url ? { url: opts.url } : {}),
    });
  } catch (err) {
    console.error(`✗ failed to send notification: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (result.delivered === 0) {
    console.log(
      "✓ notification sent, but no dashboard is open to show it " +
        "(it isn't queued; it only reaches dashboards open right now)",
    );
  } else {
    console.log(`✓ notification sent to ${result.delivered} open dashboard(s)`);
    console.log("  it appears only where the dashboard's `notify` toggle is on");
  }
}
