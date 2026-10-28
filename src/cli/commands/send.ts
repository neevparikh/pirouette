/** pru send <agent> [message] — send a message to an agent.
 *
 *  Run from inside a pirouette agent, the message is sent *as that agent*:
 *  the recipient sees a header naming the sender and how to reply, and the
 *  dashboard labels the row "from agent <name>" instead of drawing it as
 *  the user. From a human shell (no `PI_SESSION_FILE`) it is a plain user
 *  message, as before. `--as-user` forces the user form from anywhere.
 *
 *  `--attach <path>` (repeatable) uploads local files to the server host
 *  and appends their saved paths to the message, the same way the
 *  dashboard's "attach" button does.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { apiPost, apiUpload } from "../api.js";
import { attachmentNote, MAX_UPLOAD_BYTES, type SavedUpload } from "../../server/uploads.js";
import { selfAgentRef } from "./handoff.js";

export interface SendOptions {
  messageFile?: string;
  asUser?: boolean;
  followUp?: boolean;
  attach?: string[];
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
  const attach = opts.attach ?? [];
  if ((!text || !text.trim()) && attach.length === 0) {
    console.error("✗ no message given: pru send <agent> <message> (or --message-file <path>)");
    process.exit(1);
  }

  // Check every attachment before uploading any, so a typo in the last
  // path doesn't leave the first ones orphaned on the host.
  for (const file of attach) {
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error("not a regular file");
      size = st.size;
    } catch (err) {
      console.error(`✗ cannot attach ${file}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    if (size > MAX_UPLOAD_BYTES) {
      console.error(`✗ cannot attach ${file}: larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
      process.exit(1);
    }
  }
  const uploads: SavedUpload[] = [];
  for (const file of attach) {
    try {
      uploads.push(await apiUpload<SavedUpload>(path.basename(file), readFileSync(file)));
    } catch (err) {
      console.error(`✗ failed to upload ${file}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  const note = attachmentNote(uploads);
  const fullText = [text?.trim() ? text : "", note].filter(Boolean).join("\n\n");

  const body = buildSendBody(fullText, opts);
  try {
    await apiPost(`/api/agents/${agent}/message`, body);
    const as = body.from ? ` as agent ${body.from}` : "";
    const files = uploads.length > 0 ? ` with ${uploads.length} attached file(s)` : "";
    console.log(`✓ message sent to ${agent}${as}${files}`);
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
