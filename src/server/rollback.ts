/**
 * Rolling a chat back to an earlier message.
 *
 * A turn the provider refuses (Anthropic's `refusal` stop reason, an OpenAI
 * `content_filter`, ...) leaves whatever triggered the refusal in the
 * agent's context, so every later message tends to be refused too. The way
 * out is to drop that turn: move the session's leaf back to just before the
 * message that started it, and let the user send something else.
 *
 * Pi sessions are trees, so nothing is deleted — the abandoned turn stays in
 * the JSONL as a branch nobody is on. This module only picks *where* to move
 * to; `AgentManager.rollbackAgent` does the moving.
 */
import { AGENT_MESSAGE_TYPE, WATCH_MESSAGE_TYPE } from "./agent-message.js";

/** `customType` of the entry appended after a rollback. Pi keeps the leaf in
 *  memory only (on load it is simply the file's last entry), so without an
 *  entry hanging off the new leaf a restart would undo the rollback. */
export const ROLLBACK_ENTRY_TYPE = "pirouette-rollback";

/** The slice of a pi session entry this module reads. */
export interface RollbackEntry {
  id: string;
  type: string;
  /** ISO time the entry was written. */
  timestamp?: string;
  customType?: string;
  message?: {
    role?: string;
    timestamp?: number;
    content?: unknown;
  };
}

export interface RollbackTarget {
  /** Entry to roll back to; the new leaf is its parent. */
  entryId: string;
  /** Who sent it. Only a user's own message goes back into the composer. */
  kind: "user" | "agent" | "watch";
  /** Entries on the current branch from the target onwards, i.e. how many
   *  the rollback takes out of the agent's context. */
  dropped: number;
}

/** Raw provider stop reasons that mean "refused", as opposed to a transient
 *  API error. Pi maps all of them to `stopReason: "error"`. */
const BLOCKED_STOP_REASONS = new Set(["refusal", "sensitive", "content_filter"]);

/** Fallback for providers (or pi versions) that don't pass the raw stop
 *  reason through: the wording pi and the providers use for a refusal. */
const BLOCKED_ERROR_RE = /usage policy|content_filter|refused to complete|stopped with: sensitive/i;

/** Whether an assistant message is a provider refusal rather than an
 *  ordinary API error (overloaded, rate limited, ...), which a retry fixes
 *  and a rollback doesn't. */
export function isBlockedResponse(message: {
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
}): boolean {
  if (message.stopReason !== "error") return false;
  if (message.rawStopReason && BLOCKED_STOP_REASONS.has(message.rawStopReason)) return true;
  return !!message.errorMessage && BLOCKED_ERROR_RE.test(message.errorMessage);
}

/** What kind of turn-starting message an entry is, or null if it isn't one.
 *  These are exactly the rows the dashboard draws as user messages. */
function turnStartKind(entry: RollbackEntry): RollbackTarget["kind"] | null {
  if (entry.type === "message" && entry.message?.role === "user") return "user";
  if (entry.type === "custom_message") {
    if (entry.customType === AGENT_MESSAGE_TYPE) return "agent";
    if (entry.customType === WATCH_MESSAGE_TYPE) return "watch";
  }
  return null;
}

/** A custom message has no timestamp of its own: a live session stamps it
 *  when it is sent, a reloaded one with the time its entry was written,
 *  moments later. Allow for the gap. */
const CUSTOM_MESSAGE_TS_SLACK_MS = 2000;

/** Whether `entry` is the message the dashboard shows with timestamp `ts`. */
function hasTimestamp(entry: RollbackEntry, ts: number): boolean {
  if (entry.type === "message") return entry.message?.timestamp === ts;
  if (entry.type === "custom_message" && entry.timestamp) {
    return Math.abs(Date.parse(entry.timestamp) - ts) <= CUSTOM_MESSAGE_TS_SLACK_MS;
  }
  return false;
}

/** Pick the message to roll back to on `branch` (root first, leaf last, as
 *  `SessionManager.getBranch()` returns it).
 *
 *  With `beforeTs`, that is the last turn-starting message at or before the
 *  message with that timestamp — pass a refused reply's timestamp to get the
 *  message that led to it. Without, it is the last one on the branch.
 *
 *  Null when there is nothing to roll back to (no such message, or no
 *  message carries that timestamp on this branch any more). */
export function findRollbackTarget(
  branch: ReadonlyArray<RollbackEntry>,
  beforeTs?: number,
): RollbackTarget | null {
  let from = branch.length - 1;
  if (beforeTs !== undefined) {
    from = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (hasTimestamp(branch[i]!, beforeTs)) {
        from = i;
        break;
      }
    }
  }
  for (let i = from; i >= 0; i--) {
    const entry = branch[i]!;
    const kind = turnStartKind(entry);
    if (kind) return { entryId: entry.id, kind, dropped: branch.length - i };
  }
  return null;
}
