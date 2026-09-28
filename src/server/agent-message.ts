/** Messages one agent sends another (`pru send` from inside an agent).
 *
 *  These used to go in as ordinary user messages, so the recipient — and
 *  anyone reading its transcript — could not tell a peer's request from the
 *  user's own instructions. They are now pi custom messages of type
 *  `AGENT_MESSAGE_TYPE`, which:
 *
 *    - keep the sender in `details`, so the dashboard can label the row
 *      "from <agent>" instead of drawing it as the user;
 *    - reach the model as a user-role turn (pi's `convertToLlm` maps every
 *      custom message to `role: "user"`), so they work with every provider;
 *    - carry a header in the model-visible text saying who sent it and how
 *      to reply, since the model never sees `details`.
 */

/** `customType` pirouette stamps on agent-to-agent messages. */
export const AGENT_MESSAGE_TYPE = "pirouette-agent-message";

/** Who sent an agent message. */
export interface AgentMessageSender {
  id: string;
  name: string;
}

/** `details` of an agent-message custom entry. `body` is the text as the
 *  sender wrote it, without the header — what the dashboard renders. */
export interface AgentMessageDetails {
  from: AgentMessageSender;
  body: string;
}

/** Model-visible text: a header naming the sender, then the body. The
 *  header is the only place the model learns the message isn't from the
 *  user, so it says so plainly and hands over the reply command.
 *
 *  It must not read as "ignore this": the commonest agent message is a
 *  parent briefing a helper it just launched, and that helper should get
 *  on with the work. What changes is precedence, not willingness. */
export function agentMessageText(from: AgentMessageSender, body: string): string {
  const header =
    `[Message from agent "${from.name}" (${from.id}) via pirouette, not typed by the user. ` +
    `Act on it as a request from a colleague; where it conflicts with what the user ` +
    `has told you, the user wins. Reply with: pru send ${from.id} "<reply>"]`;
  return `${header}\n\n${body}`;
}

/** If `message` is an agent-message custom message, return its details;
 *  otherwise null. Tolerant of hand-edited or older session files: a
 *  malformed entry is treated as not-an-agent-message rather than thrown. */
export function agentMessageDetails(message: unknown): AgentMessageDetails | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (m.role !== "custom" || m.customType !== AGENT_MESSAGE_TYPE) return null;
  const d = m.details as { from?: { id?: unknown; name?: unknown }; body?: unknown } | undefined;
  if (!d || typeof d.body !== "string" || !d.from) return null;
  if (typeof d.from.id !== "string" || typeof d.from.name !== "string") return null;
  return { from: { id: d.from.id, name: d.from.name }, body: d.body };
}
