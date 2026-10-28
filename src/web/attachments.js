// Helpers for prompt attachments (see the "attachments" section of app.js).
//
// Two kinds of attachment travel with a message:
//   - inline images: small PNG/JPEG/WebP/GIF files, sent to the model as
//     pi image content (the `images` field of POST /api/agents/:id/message);
//   - files: anything else. Uploaded to the host via POST /api/uploads,
//     and the saved paths are listed in the message text so the agent can
//     read them with its tools.

/** Image types the model accepts inline. Mirrors the server's allowlist. */
export const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Largest image we inline. The server caps base64 at 16M chars (~12MB);
 *  model providers are stricter still (Anthropic: 5MB), so anything bigger
 *  is uploaded as a file instead of being rejected. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Largest file we'll try to upload. Mirrors MAX_UPLOAD_BYTES on the server
 *  so we fail fast instead of streaming 100MB just to get a 413. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** @param {{ type: string, size: number }} file
 *  @returns {"image" | "file"} */
export function attachmentKind(file) {
  return INLINE_IMAGE_MIME.has(file.type) && file.size <= MAX_INLINE_IMAGE_BYTES ? "image" : "file";
}

/** Human-readable byte count, e.g. `1.2 MB`. Matches formatBytes in
 *  src/server/uploads.ts. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Note appended to the message text listing uploaded files. Matches
 *  attachmentNote in src/server/uploads.ts (used by `pru send --file`).
 *  @param {{ path: string, name: string, size: number }[]} files */
export function attachmentNote(files) {
  if (files.length === 0) return "";
  const lines = files.map((f) => `- ${f.path} (${f.name}, ${formatBytes(f.size)})`);
  return `[Attached files — saved on this host; read them from these paths]\n${lines.join("\n")}`;
}

/** Append the attachment note to a message body. */
export function withAttachmentNote(body, files) {
  const note = attachmentNote(files);
  if (!note) return body;
  return body ? `${body}\n\n${note}` : note;
}

/** Upload one file to the server. Resolves to `{ path, name, size }`.
 *  @param {Blob & { name?: string }} file
 *  @param {typeof fetch} [fetchImpl] */
export async function uploadFile(file, fetchImpl = fetch) {
  const name = file.name || "pasted-file";
  const res = await fetchImpl(`/api/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `upload failed: ${res.status}`);
  return data;
}
