import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../agent-manager.js";
import { ImageStore } from "../image-store.js";

describe("ImageStore", () => {
  it("keys images by content and returns them", () => {
    const store = new ImageStore();
    const a = store.put("image/png", "AAAA");
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(store.put("image/png", "AAAA")).toBe(a);
    expect(store.put("image/jpeg", "AAAA")).not.toBe(a);
    expect(store.get(a)).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(store.get("0".repeat(32))).toBeUndefined();
  });

  it("evicts least recently used images past its byte budget", () => {
    const store = new ImageStore(10);
    const a = store.put("image/png", "aaaa");
    const b = store.put("image/png", "bbbb");
    store.get(a); // a is now more recent than b
    const c = store.put("image/png", "cccc");
    expect(store.get(b)).toBeUndefined();
    expect(store.get(a)).toBeDefined();
    expect(store.get(c)).toBeDefined();
  });

  it("only takes raster types the dashboard renders", () => {
    expect(ImageStore.canStore("image/png")).toBe(true);
    expect(ImageStore.canStore("image/webp")).toBe(true);
    expect(ImageStore.canStore("image/svg+xml")).toBe(false);
    expect(ImageStore.canStore("text/html")).toBe(false);
  });
});

describe("history images", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  function manager(messages: unknown[]) {
    const store = new ImageStore();
    const m = Object.assign(Object.create(AgentManager.prototype), {
      handles: new Map([["agent-1", { session: { messages }, activeToolCalls: new Set<string>() }]]),
      imageStore: store,
      stateManager: { getAgent: () => ({ id: "agent-1" }) },
      diskMessagesCache: new Map(),
    }) as AgentManager;
    return { m, store, history: () => AgentManager.prototype.getMessages.call(m, "agent-1") };
  }

  it("links raster images by URL instead of inlining them", () => {
    const { m, history } = manager([
      { role: "user", timestamp: 1, content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
      { role: "toolResult", toolName: "screenshot", toolCallId: "t", timestamp: 2, content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }] },
    ]);
    const [user, result] = history();
    const url = user.images?.[0].url ?? "";
    expect(user.images?.[0].dataUrl).toBeUndefined();
    expect(url).toMatch(/^\/api\/agents\/agent-1\/images\/[a-f0-9]{32}$/);
    const key = url.split("/").at(-1)!;
    expect(AgentManager.prototype.getHistoryImage.call(m, "agent-1", key)).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    // Not a type the store serves: left inline for the client's own checks.
    expect(result.images?.[0]).toEqual({ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=", mimeType: "image/svg+xml" });
  });

  it("rebuilds history to find an image the store no longer has", () => {
    const { m, store, history } = manager([
      { role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "QUJD" }] },
    ]);
    const key = history()[0].images![0].url!.split("/").at(-1)!;
    // Simulate a restart: a fresh, empty store.
    (m as unknown as { imageStore: ImageStore }).imageStore = new ImageStore();
    expect(store.get(key)).toBeDefined();
    expect(AgentManager.prototype.getHistoryImage.call(m, "agent-1", key)?.data).toBe("QUJD");
  });
});

describe("stopped agents' history cache", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("parses the session once until its files change", async () => {
    const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const dir = mkdtempSync(path.join(tmpdir(), "pirouette-history-cache-"));
    try {
      writeFileSync(path.join(dir, "s.jsonl"), "{}\n");
      const parse = vi.spyOn(SessionManager, "continueRecent").mockImplementation(
        () =>
          ({
            buildSessionContext: () => ({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
          }) as unknown as ReturnType<typeof SessionManager.continueRecent>,
      );
      const m = Object.assign(Object.create(AgentManager.prototype), {
        handles: new Map(),
        imageStore: new ImageStore(),
        stateManager: { getAgent: () => ({ id: "a", worktreePath: dir, sessionDir: dir }) },
        diskMessagesCache: new Map(),
      }) as AgentManager;
      const first = m.getMessages("a");
      expect(m.getMessages("a")).toBe(first);
      expect(parse).toHaveBeenCalledTimes(1);
      appendFileSync(path.join(dir, "s.jsonl"), "{}\n");
      expect(m.getMessages("a")).toEqual(first);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
