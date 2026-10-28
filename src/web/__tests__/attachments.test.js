import { describe, expect, it, vi } from "vitest";

import {
  attachmentKind,
  attachmentNote,
  MAX_INLINE_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  uploadFile,
  withAttachmentNote,
} from "../attachments.js";
import * as server from "../../server/uploads.ts";

describe("attachmentKind", () => {
  it("inlines small model-supported images", () => {
    expect(attachmentKind({ type: "image/png", size: 1000 })).toBe("image");
    expect(attachmentKind({ type: "image/webp", size: MAX_INLINE_IMAGE_BYTES })).toBe("image");
  });

  it("uploads big images and other image types as files", () => {
    expect(attachmentKind({ type: "image/png", size: MAX_INLINE_IMAGE_BYTES + 1 })).toBe("file");
    expect(attachmentKind({ type: "image/svg+xml", size: 10 })).toBe("file");
  });

  it("uploads everything else", () => {
    expect(attachmentKind({ type: "application/pdf", size: 10 })).toBe("file");
    expect(attachmentKind({ type: "", size: 10 })).toBe("file");
  });
});

describe("withAttachmentNote", () => {
  const files = [{ path: "/d/uploads/x/ab-a.txt", name: "a.txt", size: 2048 }];

  it("leaves the body alone with no files", () => {
    expect(withAttachmentNote("hi", [])).toBe("hi");
  });

  it("appends the note after the body", () => {
    expect(withAttachmentNote("hi", files)).toBe(`hi\n\n${attachmentNote(files)}`);
    expect(attachmentNote(files)).toContain("- /d/uploads/x/ab-a.txt (a.txt, 2.0 KB)");
  });

  it("is just the note when there's no text", () => {
    expect(withAttachmentNote("", files)).toBe(attachmentNote(files));
  });

  it("matches the server copy used by `pru send --attach`", () => {
    expect(attachmentNote(files)).toBe(server.attachmentNote(files));
    expect(MAX_UPLOAD_BYTES).toBe(server.MAX_UPLOAD_BYTES);
  });
});

describe("uploadFile", () => {
  it("POSTs the raw bytes as octet-stream with the name in the query", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ path: "/p", name: "a b.txt", size: 3 }),
    }));
    const file = new File(["abc"], "a b.txt", { type: "text/plain" });
    await expect(uploadFile(file, fetchImpl)).resolves.toEqual({ path: "/p", name: "a b.txt", size: 3 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/uploads?name=a%20b.txt");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/octet-stream");
    expect(init.body).toBe(file);
  });

  it("surfaces the server's error message", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 413,
      json: async () => ({ error: "file too large (max 100 MB)" }),
    }));
    await expect(uploadFile(new File(["x"], "x"), fetchImpl)).rejects.toThrow("file too large");
  });
});
