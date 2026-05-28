/**
 * Unit tests for the pirouette ExtensionUIContext bridge.
 *
 * Validates the prompt-the-user round-trip (select / confirm / input):
 * the UI context emits an `extension_ui_request` envelope via its
 * UIContextHost, returns a Promise, and resolves when the host calls
 * `entry.resolve(value)`. Cancellation paths (AbortSignal, double
 * resolve) should be idempotent so a hostile / racing caller can't
 * crash the host.
 */

import { describe, expect, it } from "vitest";

import {
  createPirouetteUIContext,
  type PendingUIRequest,
  type UIContextHost,
} from "../pirouette-ui-context.js";
import type { WsEnvelope } from "../types.js";

/** Build a fake UIContextHost that records broadcasts and stashes the
 *  pending entry so the test can resolve / reject manually. */
function makeHost() {
  const broadcasts: WsEnvelope[] = [];
  const pending: PendingUIRequest[] = [];
  let idCounter = 0;
  const host: UIContextHost = {
    registerRequest(entry) {
      pending.push(entry);
      broadcasts.push({
        kind: "extension_ui_request",
        agentId: entry.agentId,
        request: entry.request,
      });
    },
    broadcast(envelope) {
      broadcasts.push(envelope);
    },
    newRequestId() {
      idCounter++;
      return `req-${idCounter}`;
    },
  };
  return { host, broadcasts, pending };
}

describe("createPirouetteUIContext.select", () => {
  it("resolves with the user's chosen label", async () => {
    const { host, broadcasts, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const p = ui.select("color?", ["red", "blue"]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: "extension_ui_request",
      agentId: "agent-1",
      request: {
        method: "select",
        title: "color?",
        options: [{ label: "red" }, { label: "blue" }],
      },
    });
    pending[0].resolve("red");
    await expect(p).resolves.toBe("red");
  });

  it("resolves to undefined when AbortSignal fires and broadcasts a cancel", async () => {
    const { host, broadcasts, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const ac = new AbortController();
    const p = ui.select("color?", ["red"], { signal: ac.signal });
    expect(pending).toHaveLength(1);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    // Initial broadcast + a cancel broadcast from the abort path.
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]).toMatchObject({
      kind: "extension_ui_cancel",
      agentId: "agent-1",
      requestId: pending[0].request.requestId,
    });
  });

  it("short-circuits when the signal is already aborted", async () => {
    const { host, broadcasts, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const ac = new AbortController();
    ac.abort();
    const p = ui.select("color?", ["red"], { signal: ac.signal });
    await expect(p).resolves.toBeUndefined();
    // No registerRequest call because we short-circuited; we DO broadcast
    // a cancel so any racing client modal closes.
    expect(pending).toHaveLength(0);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].kind).toBe("extension_ui_cancel");
  });

  it("respects opts.timeout — resolves to undefined after the timer", async () => {
    const { host, broadcasts, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const p = ui.select("color?", ["red"], { timeout: 25 });
    expect(pending).toHaveLength(1);
    const result = await p;
    expect(result).toBeUndefined();
    expect(broadcasts.some((b) => b.kind === "extension_ui_cancel")).toBe(true);
  });

  it("is idempotent against double resolve (cleanup runs once)", async () => {
    const { host, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const p = ui.select("color?", ["red"]);
    pending[0].resolve("red");
    pending[0].resolve("blue"); // ignored — already settled
    await expect(p).resolves.toBe("red");
  });
});

describe("createPirouetteUIContext.confirm", () => {
  it("resolves to true when the user confirms", async () => {
    const { host, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const p = ui.confirm("delete?", "are you sure?");
    pending[0].resolve(true);
    await expect(p).resolves.toBe(true);
  });

  it("degrades to false on cancel (matches RPC mode contract)", async () => {
    const { host } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const ac = new AbortController();
    const p = ui.confirm("delete?", "are you sure?", { signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toBe(false);
  });
});

describe("createPirouetteUIContext.input", () => {
  it("resolves with the user's typed string", async () => {
    const { host, pending } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const p = ui.input("your name?", "e.g. Alice");
    pending[0].resolve("Alice");
    await expect(p).resolves.toBe("Alice");
  });
});

describe("createPirouetteUIContext.notify / setStatus", () => {
  it("notify is fire-and-forget — emits an envelope, returns void synchronously", () => {
    const { host, broadcasts } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    const ret = ui.notify("done!", "info");
    expect(ret).toBeUndefined();
    expect(broadcasts).toEqual([
      {
        kind: "extension_ui_notify",
        agentId: "agent-1",
        message: "done!",
        notifyType: "info",
      },
    ]);
  });

  it("setStatus null-coalesces undefined text → null (cleared slot)", () => {
    const { host, broadcasts } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    ui.setStatus("build", undefined);
    expect(broadcasts).toEqual([
      {
        kind: "extension_ui_status",
        agentId: "agent-1",
        statusKey: "build",
        statusText: null,
      },
    ]);
  });
});

describe("createPirouetteUIContext.custom (TUI fallback signal)", () => {
  it("returns undefined synchronously so pi-cas falls back to ui.select", async () => {
    const { host } = makeHost();
    const ui = createPirouetteUIContext("agent-1", host);
    // The factory should NEVER be invoked — pi-cas detects the no-op
    // host by checking whether its factoryInvoked flag flipped.
    let factoryRan = false;
    const result = await ui.custom(() => {
      factoryRan = true;
      throw new Error("factory should not be invoked on pirouette host");
    });
    expect(result).toBeUndefined();
    expect(factoryRan).toBe(false);
  });
});
