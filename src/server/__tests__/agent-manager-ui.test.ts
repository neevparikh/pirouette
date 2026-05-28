/**
 * AgentManager-level tests for the extension UI request bridge.
 *
 * Validates the host surface that pirouette-ui-context.ts depends on:
 *   - registerRequest enqueues + broadcasts an extension_ui_request
 *   - resolveUIResponse settles the pending Promise and broadcasts a
 *     cancel so other clients close their modals (first-response-wins)
 *   - cancelUIRequest degrades to undefined (the SDK cancel sentinel)
 *   - snapshotAllPending / snapshotPendingForAgent return in-flight
 *     requests so a (re)joining WS client can replay
 *   - agentId-mismatch is rejected defensively (no settle, no
 *     broadcast)
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { PendingUIRequest } from "../pirouette-ui-context.js";
import type { WsEnvelope } from "../types.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-ui-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  const broadcasts: WsEnvelope[] = [];
  manager.onWsBroadcast((env) => broadcasts.push(env));
  return { manager, broadcasts };
}

/** Reach into AgentManager to register a pending request directly,
 *  bypassing the per-agent UI context. This mirrors what the UI
 *  context's `registerRequest` callback does, isolated for testing. */
function pushPending(
  manager: AgentManager,
  agentId: string,
  requestId: string,
  resolve: (v: unknown) => void = () => {},
): PendingUIRequest {
  const entry: PendingUIRequest = {
    agentId,
    request: {
      requestId,
      method: "select",
      title: "pick one",
      options: [{ label: "a" }, { label: "b" }],
    },
    resolve,
    reject: () => {},
    cleanup: () => {},
  };
  // Use the public host adapter so the broadcast path is also exercised.
  const host = (
    manager as unknown as { uiContextHostFor: (id: string) => { registerRequest: (e: PendingUIRequest) => void } }
  ).uiContextHostFor(agentId);
  host.registerRequest(entry);
  return entry;
}

describe("AgentManager extension UI request bridge", () => {
  it("registerRequest broadcasts extension_ui_request to all clients", async () => {
    const { manager, broadcasts } = await makeManager();
    pushPending(manager, "agent-1", "req-1");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: "extension_ui_request",
      agentId: "agent-1",
      request: { requestId: "req-1", method: "select" },
    });
  });

  it("resolveUIResponse settles the Promise and broadcasts a cancel", async () => {
    const { manager, broadcasts } = await makeManager();
    let resolved: unknown = "pending";
    pushPending(manager, "agent-1", "req-1", (v) => {
      resolved = v;
    });
    broadcasts.length = 0; // ignore the initial register broadcast
    manager.resolveUIResponse("agent-1", "req-1", "a");
    expect(resolved).toBe("a");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      kind: "extension_ui_cancel",
      agentId: "agent-1",
      requestId: "req-1",
    });
  });

  it("resolveUIResponse for an unknown requestId is a silent no-op", async () => {
    const { manager, broadcasts } = await makeManager();
    manager.resolveUIResponse("agent-1", "does-not-exist", true);
    expect(broadcasts).toHaveLength(0);
  });

  it("rejects an agentId mismatch (defense against forged client envelope)", async () => {
    const { manager, broadcasts } = await makeManager();
    let resolved: unknown = "pending";
    pushPending(manager, "agent-1", "req-1", (v) => {
      resolved = v;
    });
    broadcasts.length = 0;
    // Wrong agentId on the response — should be dropped, not resolved.
    manager.resolveUIResponse("agent-OTHER", "req-1", "a");
    expect(resolved).toBe("pending");
    expect(broadcasts).toHaveLength(0);
  });

  it("cancelUIRequest resolves to undefined (the cancel sentinel)", async () => {
    const { manager, broadcasts } = await makeManager();
    let resolved: unknown = "pending";
    pushPending(manager, "agent-1", "req-1", (v) => {
      resolved = v;
    });
    broadcasts.length = 0;
    manager.cancelUIRequest("agent-1", "req-1");
    expect(resolved).toBeUndefined();
    expect(broadcasts[0]?.kind).toBe("extension_ui_cancel");
  });

  it("snapshotAllPending / snapshotPendingForAgent return live in-flight requests", async () => {
    const { manager } = await makeManager();
    pushPending(manager, "agent-1", "req-1");
    pushPending(manager, "agent-1", "req-2");
    pushPending(manager, "agent-2", "req-3");

    const all = manager.snapshotAllPending();
    expect(all.map((e) => e.request.requestId).sort()).toEqual(["req-1", "req-2", "req-3"]);

    const agent1 = manager.snapshotPendingForAgent("agent-1");
    expect(agent1.map((r) => r.requestId).sort()).toEqual(["req-1", "req-2"]);

    const agent3 = manager.snapshotPendingForAgent("agent-3");
    expect(agent3).toEqual([]);
  });

  it("snapshot reflects removals after resolve / cancel", async () => {
    const { manager } = await makeManager();
    pushPending(manager, "agent-1", "req-1");
    pushPending(manager, "agent-1", "req-2");

    manager.resolveUIResponse("agent-1", "req-1", "a");
    expect(manager.snapshotPendingForAgent("agent-1").map((r) => r.requestId)).toEqual(["req-2"]);

    manager.cancelUIRequest("agent-1", "req-2");
    expect(manager.snapshotPendingForAgent("agent-1")).toEqual([]);
  });

  it("double resolve is idempotent (second call no-ops, no extra broadcast)", async () => {
    const { manager, broadcasts } = await makeManager();
    let count = 0;
    pushPending(manager, "agent-1", "req-1", () => {
      count++;
    });
    broadcasts.length = 0;
    manager.resolveUIResponse("agent-1", "req-1", "a");
    manager.resolveUIResponse("agent-1", "req-1", "b"); // entry is gone — no-op
    expect(count).toBe(1);
    expect(broadcasts).toHaveLength(1);
  });
});
