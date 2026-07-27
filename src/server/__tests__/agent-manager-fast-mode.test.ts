/**
 * Tests for the fast-mode badge bridge.
 *
 * A fast-mode-capable provider (pi-cas-provider, pi-hawk-provider) broadcasts
 * a `pi:fast-mode` event on the shared extension event bus (`pi.events`) for
 * every request it routes. The AgentManager subscribes to that bus, folds the
 * payload into a per-model `FastModeTracker`, and re-broadcasts the resulting
 * snapshot to dashboard clients via a `fast_mode` WS envelope. New clients are
 * primed via `getFastModeSnapshot()`.
 *
 * Normalization itself is covered in fast-mode.test.ts; what's checked here is
 * the manager's contract: fold, broadcast, prime — and that one model's
 * request can't blank another model's badge, which is the bug that made the
 * badge flicker off after every tool call.
 *
 * The bus wiring (createEventBus + DefaultResourceLoader) only runs inside
 * ensureResourceLoader(), which loads real extensions — too heavy for a unit
 * test. Here we call the private handler the bus would call.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { WsEnvelope } from "../types.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-fast-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  return manager;
}

/** Invoke the private fast-mode handler the event bus would call. */
function emitFastMode(manager: AgentManager, data: unknown): void {
  (manager as unknown as { handleFastModeEvent(d: unknown): void }).handleFastModeEvent(data);
}

function fastModeEnvelopes(sent: WsEnvelope[]) {
  return sent.filter((e) => e.kind === "fast_mode");
}

describe("AgentManager fast-mode badge", () => {
  it("starts with an empty snapshot", async () => {
    const manager = await makeManager();
    expect(manager.getFastModeSnapshot()).toEqual({ global: null, byModel: {} });
  });

  it("stores a per-model reading and broadcasts a fast_mode envelope", async () => {
    const manager = await makeManager();
    const sent: WsEnvelope[] = [];
    manager.onWsBroadcast((e) => sent.push(e));

    emitFastMode(manager, { intent: true, actual: "on", model: "claude-opus-5" });

    const expected = {
      global: null,
      byModel: { "claude-opus-5": { intent: true, actual: "on", model: "claude-opus-5" } },
    };
    expect(manager.getFastModeSnapshot()).toEqual(expected);
    const fm = fastModeEnvelopes(sent);
    expect(fm).toHaveLength(1);
    expect(fm[0]).toEqual({ kind: "fast_mode", snapshot: expected });
  });

  it("keeps an Opus badge lit when auto-mode's Sonnet classifier reports in", async () => {
    const manager = await makeManager();
    emitFastMode(manager, { intent: true, actual: "on", model: "claude-opus-5" });
    // Fires on every mutating tool call of every agent, on a model that can't
    // do fast tier. Must not touch the Opus entry.
    emitFastMode(manager, { intent: false, model: "claude-sonnet-5" });

    const { byModel } = manager.getFastModeSnapshot();
    expect(byModel["claude-opus-5"]).toEqual({
      intent: true,
      actual: "on",
      model: "claude-opus-5",
    });
    expect(byModel["claude-sonnet-5"]).toEqual({ intent: false, model: "claude-sonnet-5" });
  });

  it("lets a model-less toggle event reset every per-model reading", async () => {
    const manager = await makeManager();
    emitFastMode(manager, { intent: true, actual: "on", model: "claude-opus-5" });
    emitFastMode(manager, { intent: false });

    expect(manager.getFastModeSnapshot()).toEqual({ global: { intent: false }, byModel: {} });
  });

  it("ignores non-object payloads without broadcasting", async () => {
    const manager = await makeManager();
    const sent: WsEnvelope[] = [];
    manager.onWsBroadcast((e) => sent.push(e));

    emitFastMode(manager, "nope");
    emitFastMode(manager, null);
    emitFastMode(manager, undefined);

    expect(manager.getFastModeSnapshot()).toEqual({ global: null, byModel: {} });
    expect(fastModeEnvelopes(sent)).toHaveLength(0);
  });
});
