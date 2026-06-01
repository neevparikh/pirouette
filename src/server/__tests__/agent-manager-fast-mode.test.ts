/**
 * Tests for the global fast-mode badge bridge.
 *
 * pi-cas-provider broadcasts a `pi:fast-mode` event on the shared extension
 * event bus (`pi.events`) whenever fast-mode intent/actual changes. The
 * AgentManager subscribes to that bus, normalizes the payload into a
 * `FastModeState`, stores it as global state (one shared provider across all
 * agents), and re-broadcasts it to dashboard clients via a `fast_mode`
 * WS envelope. New clients are primed via `getFastMode()`.
 *
 * The bus wiring itself (createEventBus + DefaultResourceLoader) only runs
 * inside ensureResourceLoader(), which loads real extensions — too heavy for
 * a unit test. Here we exercise the normalization + broadcast + getter
 * contract directly via the private handler, which is the part most likely
 * to regress.
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

describe("AgentManager fast-mode badge", () => {
  it("starts with no fast-mode state", async () => {
    const manager = await makeManager();
    expect(manager.getFastMode()).toBeNull();
  });

  it("normalizes a payload, stores it, and broadcasts a fast_mode envelope", async () => {
    const manager = await makeManager();
    const sent: WsEnvelope[] = [];
    manager.onWsBroadcast((e) => sent.push(e));

    emitFastMode(manager, { intent: true, actual: "on", model: "claude-opus-4-7" });

    const expected = { intent: true, actual: "on", model: "claude-opus-4-7" };
    expect(manager.getFastMode()).toEqual(expected);
    const fm = sent.filter((e) => e.kind === "fast_mode");
    expect(fm).toHaveLength(1);
    expect(fm[0]).toEqual({ kind: "fast_mode", state: expected });
  });

  it("drops an unknown `actual` value and coerces intent to a boolean", async () => {
    const manager = await makeManager();
    emitFastMode(manager, { intent: 1, actual: "bogus", model: 42 });
    // actual "bogus" is rejected; non-string model dropped; intent → true.
    expect(manager.getFastMode()).toEqual({ intent: true });
  });

  it("accepts each valid `actual` state", async () => {
    const manager = await makeManager();
    for (const actual of ["on", "off", "cooldown"] as const) {
      emitFastMode(manager, { intent: true, actual });
      expect(manager.getFastMode()).toEqual({ intent: true, actual });
    }
  });

  it("represents intent-off (badge hidden) without an actual", async () => {
    const manager = await makeManager();
    emitFastMode(manager, { intent: false });
    expect(manager.getFastMode()).toEqual({ intent: false });
  });

  it("ignores non-object payloads", async () => {
    const manager = await makeManager();
    emitFastMode(manager, "nope");
    emitFastMode(manager, null);
    emitFastMode(manager, undefined);
    expect(manager.getFastMode()).toBeNull();
  });
});
