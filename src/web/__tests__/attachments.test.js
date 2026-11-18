import { describe, expect, it, vi } from "vitest";

import {
  attachmentKind,
  attachmentNote,
  extractEmbeddedImages,
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

describe("extractEmbeddedImages", () => {
  const png = btoa("\x89PNG fake bytes");
  const jpeg = btoa("jpeg bytes");

  it("leaves text without embedded images alone", () => {
    const text = "see data:text/plain;base64,aGk= and ![a](https://x/y.png)";
    expect(extractEmbeddedImages(text)).toEqual({ text, files: [] });
  });

  it("replaces Google Docs reference definitions with file names", async () => {
    const text = `# Doc\n\n![][image1]\n\ntext\n\n![][image2]\n\n[image1]: <data:image/png;base64,${png}>\n\n[image2]: <data:image/jpeg;base64,${jpeg}>`;
    const out = extractEmbeddedImages(text);
    expect(out.text).toBe(
      "# Doc\n\n![][image1]\n\ntext\n\n![][image2]\n\n[image1]: <pasted-image-1.png>\n\n[image2]: <pasted-image-2.jpg>",
    );
    expect(out.files.map((f) => [f.name, f.type])).toEqual([
      ["pasted-image-1.png", "image/png"],
      ["pasted-image-2.jpg", "image/jpeg"],
    ]);
    expect([...new Uint8Array(await out.files[0].arrayBuffer())].slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("handles inline images and numbers from startIndex", () => {
    const out = extractEmbeddedImages(`a ![x](data:image/svg+xml;base64,${png}) b`, 4);
    expect(out.text).toBe("a ![x](pasted-image-4.svg) b");
    expect(out.files).toHaveLength(1);
  });

  it("uploads a repeated image once", () => {
    const url = `data:image/png;base64,${png}`;
    const out = extractEmbeddedImages(`${url} ${url}`);
    expect(out.text).toBe("pasted-image-1.png pasted-image-1.png");
    expect(out.files).toHaveLength(1);
  });

  it("still strips data that doesn't decode", () => {
    const out = extractEmbeddedImages("x data:image/png;base64,abcde y");
    expect(out).toEqual({ text: "x embedded-image-removed y", files: [] });
  });
});
