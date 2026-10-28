/**
 * Tests for prompt file uploads: the helpers in uploads.ts and the
 * `POST /api/uploads` route.
 */

import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runServer, type ServerHandle } from "../index.js";
import { attachmentNote, sanitizeUploadName, saveUpload, UploadError } from "../uploads.js";

describe("sanitizeUploadName", () => {
  it("keeps ordinary names", () => {
    expect(sanitizeUploadName("report-2024.final.pdf")).toBe("report-2024.final.pdf");
  });

  it("drops directory components (both separators)", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
  });

  it("replaces spaces, quotes and shell metacharacters", () => {
    expect(sanitizeUploadName("my file $(rm -rf).txt")).toBe("my_file_rm_-rf_.txt");
    expect(sanitizeUploadName("a\nb\x00c.md")).toBe("abc.md");
  });

  it("never yields an empty or hidden name", () => {
    expect(sanitizeUploadName("")).toBe("upload");
    expect(sanitizeUploadName("..")).toBe("upload");
    expect(sanitizeUploadName(".env")).toBe("env");
  });

  it("truncates long names but keeps the extension", () => {
    const name = sanitizeUploadName(`${"x".repeat(300)}.csv`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".csv")).toBe(true);
  });
});

describe("saveUpload", () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "pir-upload-unit-"));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("writes the body under uploads/<date>/ with a random prefix", async () => {
    const saved = await saveUpload(dataDir, "notes.txt", Readable.from([Buffer.from("hello")]), {
      now: new Date(2026, 4, 3),
    });
    expect(saved.name).toBe("notes.txt");
    expect(saved.size).toBe(5);
    expect(path.dirname(saved.path)).toBe(path.join(dataDir, "uploads", "2026-05-03"));
    expect(path.basename(saved.path)).toMatch(/^[0-9a-f]{8}-notes\.txt$/);
    expect(readFileSync(saved.path, "utf8")).toBe("hello");
  });

  it("does not clobber a second upload with the same name", async () => {
    const a = await saveUpload(dataDir, "same.txt", Readable.from([Buffer.from("a")]));
    const b = await saveUpload(dataDir, "same.txt", Readable.from([Buffer.from("b")]));
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("a");
    expect(readFileSync(b.path, "utf8")).toBe("b");
  });

  it("rejects oversize bodies with 413 and removes the partial file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pir-upload-big-"));
    const body = Readable.from([Buffer.alloc(10), Buffer.alloc(10)]);
    const err = await saveUpload(dir, "big.bin", body, { maxBytes: 15 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(413);
    const dayDirs = readdirSync(path.join(dir, "uploads"));
    for (const d of dayDirs) expect(readdirSync(path.join(dir, "uploads", d))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("attachmentNote", () => {
  it("is empty with no files", () => {
    expect(attachmentNote([])).toBe("");
  });

  it("lists each saved path with its name and size", () => {
    const note = attachmentNote([
      { path: "/d/uploads/2026-05-03/ab12cd34-a.txt", name: "a.txt", size: 12 },
      { path: "/d/uploads/2026-05-03/ef56ab78-b.pdf", name: "b.pdf", size: 3 * 1024 * 1024 },
    ]);
    expect(note).toContain("- /d/uploads/2026-05-03/ab12cd34-a.txt (a.txt, 12 B)");
    expect(note).toContain("- /d/uploads/2026-05-03/ef56ab78-b.pdf (b.pdf, 3.0 MB)");
  });
});

describe("POST /api/uploads", () => {
  let handle: ServerHandle;
  let port: number;
  let dataDir: string;
  let webDir: string;

  async function freePort(): Promise<number> {
    const net = await import("node:net");
    return await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const p = addr.port;
          srv.close(() => resolve(p));
        } else {
          srv.close();
          reject(new Error("could not pick a free port"));
        }
      });
    });
  }

  beforeAll(async () => {
    port = await freePort();
    dataDir = mkdtempSync(path.join(tmpdir(), "pir-upload-test-"));
    webDir = mkdtempSync(path.join(tmpdir(), "pir-upload-web-"));
    writeFileSync(path.join(webDir, "index.html"), "<html>x</html>");
    handle = await runServer({ port, host: "127.0.0.1", dataDir, webDir });
  });

  afterAll(async () => {
    await handle.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  function post(
    p: string,
    body: Buffer,
    contentType = "application/octet-stream",
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: p,
          method: "POST",
          headers: { "content-type": contentType, "content-length": body.length },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("saves the body and returns its path", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    const res = await post(`/api/uploads?name=${encodeURIComponent("data dump.bin")}`, bytes);
    expect(res.status).toBe(201);
    expect(res.json.name).toBe("data_dump.bin");
    expect(res.json.size).toBe(bytes.length);
    const saved = res.json.path as string;
    expect(saved.startsWith(path.join(dataDir, "uploads") + path.sep)).toBe(true);
    expect(readFileSync(saved)).toEqual(bytes);
    // Owner-only: uploads may hold anything.
    expect(statSync(saved).mode & 0o077).toBe(0);
  });

  it("can't be steered outside the uploads dir by the name", async () => {
    const res = await post(`/api/uploads?name=${encodeURIComponent("../../../evil.sh")}`, Buffer.from("x"));
    expect(res.status).toBe(201);
    expect((res.json.path as string).startsWith(path.join(dataDir, "uploads") + path.sep)).toBe(true);
    expect(existsSync(path.join(dataDir, "evil.sh"))).toBe(false);
  });

  it("requires a name", async () => {
    const res = await post("/api/uploads", Buffer.from("x"));
    expect(res.status).toBe(400);
  });

  it("refuses CORS-safelisted content types (cross-site form POSTs)", async () => {
    for (const ct of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded"]) {
      const res = await post("/api/uploads?name=a.txt", Buffer.from("x"), ct);
      expect(res.status).toBe(415);
    }
  });
});
