/** File uploads attached to a prompt.
 *
 *  The dashboard (and `pru send --file`) can attach arbitrary files to a
 *  message. Images small enough to inline still travel as pi image content
 *  (see the `images` field of POST /api/agents/:id/message); everything else
 *  is written to disk here and the message text gets a note listing the
 *  saved paths, so the agent can open them with its normal tools (`read`,
 *  `bash`, ...).
 *
 *  Files land under `<dataDir>/uploads/<YYYY-MM-DD>/<random>-<name>`:
 *    - outside every worktree, so an upload never shows up in `git status`
 *      or gets committed by accident;
 *    - not keyed on an agent, because the dashboard uploads at attach time,
 *      before an `@name` send has resolved (or created) its target chat;
 *    - prefixed with a random token so two uploads of `notes.txt` don't
 *      clobber each other and paths aren't guessable.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

/** Largest single upload we accept. Generous — these are files for the
 *  agent to read off disk, not bytes sent to the model. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MAX_NAME_LEN = 120;

export interface SavedUpload {
  /** Absolute path of the saved file on the server host. */
  path: string;
  /** The (sanitized) original file name. */
  name: string;
  /** Size in bytes. */
  size: number;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reduce a client-supplied file name to a safe single path component.
 *  Drops any directory part, control characters and characters that are
 *  awkward in shells; keeps the extension. Never returns an empty string
 *  or a dot-only name. */
export function sanitizeUploadName(raw: string): string {
  // Last path component only (handles both / and \ separators).
  let name = raw.split(/[/\\]/).pop() ?? "";
  name = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^A-Za-z0-9._+@=,-]+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/_+/g, "_");
  if (name.length > MAX_NAME_LEN) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LEN - ext.length) + ext;
  }
  return name || "upload";
}

function today(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Stream `body` to a fresh file under `<dataDir>/uploads/`. Rejects with
 *  an `UploadError` (413) and removes the partial file if the body grows
 *  past `maxBytes`. */
export async function saveUpload(
  dataDir: string,
  rawName: string,
  body: Readable,
  opts: { maxBytes?: number; now?: Date } = {},
): Promise<SavedUpload> {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const name = sanitizeUploadName(rawName);
  const dir = path.join(dataDir, "uploads", today(opts.now ?? new Date()));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomBytes(4).toString("hex")}-${name}`);

  // `wx`: never overwrite (the random prefix makes a clash vanishingly
  // unlikely, but if it happens we'd rather fail than clobber).
  const out = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        body.unpipe(out);
        out.destroy();
        reject(err);
      };
      body.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          body.pause();
          fail(new UploadError(413, `file too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`));
        }
      });
      body.on("error", fail);
      body.on("aborted", () => fail(new UploadError(400, "upload aborted")));
      out.on("error", fail);
      out.on("finish", () => resolve());
      body.pipe(out);
    });
  } catch (err) {
    await rm(filePath, { force: true });
    throw err;
  }
  return { path: filePath, name, size };
}

/** Human-readable byte count, e.g. `1.2 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The note appended to a message that has file attachments. Lists the
 *  absolute paths so the agent can read them. Shared by the server-side
 *  helpers and mirrored in the dashboard / CLI. */
export function attachmentNote(files: Array<{ path: string; name: string; size: number }>): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => `- ${f.path} (${f.name}, ${formatBytes(f.size)})`);
  return `[Attached files — saved on this host; read them from these paths]\n${lines.join("\n")}`;
}
