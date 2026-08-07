/**
 * AgentManager-level tests for the extension widget store.
 *
 * Widgets are set through the same UIContextHost the per-agent
 * ExtensionUIContext holds, so these exercise the path a real extension
 * takes: store, broadcast, clear, and the snapshot a newly-connected
 * browser is primed with.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { UIContextHost } from "../pirouette-ui-context.js";
import type { AgentWidget, WsEnvelope } from "../types.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-widget-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  const broadcasts: WsEnvelope[] = [];
  manager.onWsBroadcast((env) => broadcasts.push(env));
  return { manager, broadcasts };
}

function hostFor(manager: AgentManager, agentId: string): UIContextHost {
  return (
    manager as unknown as { uiContextHostFor: (id: string) => UIContextHost }
  ).uiContextHostFor(agentId);
}

function widget(key: string, text: string): AgentWidget {
  return { key, placement: "aboveEditor", lines: [[{ text }]] };
}

describe("AgentManager extension widget store", () => {
  it("broadcasts and remembers a widget", async () => {
    const { manager, broadcasts } = await makeManager();
    hostFor(manager, "agent-1").setWidget("todo-list", widget("todo-list", "1/2"));

    expect(broadcasts).toEqual([
      {
        kind: "extension_ui_widget",
        agentId: "agent-1",
        widgetKey: "todo-list",
        widget: widget("todo-list", "1/2"),
      },
    ]);
    expect(manager.snapshotAllWidgets()).toEqual([
      { agentId: "agent-1", widget: widget("todo-list", "1/2") },
    ]);
  });

  it("replaces a widget under the same key", async () => {
    const { manager } = await makeManager();
    const host = hostFor(manager, "agent-1");
    host.setWidget("todo-list", widget("todo-list", "1/2"));
    host.setWidget("todo-list", widget("todo-list", "2/2"));

    const snapshot = manager.snapshotAllWidgets();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].widget.lines[0][0].text).toBe("2/2");
  });

  it("keeps widgets from different extensions and agents apart", async () => {
    const { manager } = await makeManager();
    hostFor(manager, "agent-1").setWidget("todo-list", widget("todo-list", "a"));
    hostFor(manager, "agent-1").setWidget("weather", widget("weather", "b"));
    hostFor(manager, "agent-2").setWidget("todo-list", widget("todo-list", "c"));

    expect(manager.snapshotAllWidgets()).toHaveLength(3);
    expect(
      manager.snapshotAllWidgets().filter((w) => w.agentId === "agent-1"),
    ).toHaveLength(2);
  });

  it("clears a widget when the extension passes null", async () => {
    const { manager, broadcasts } = await makeManager();
    const host = hostFor(manager, "agent-1");
    host.setWidget("todo-list", widget("todo-list", "1/2"));
    host.setWidget("todo-list", null);

    expect(broadcasts[1]).toEqual({
      kind: "extension_ui_widget",
      agentId: "agent-1",
      widgetKey: "todo-list",
      widget: null,
    });
    expect(manager.snapshotAllWidgets()).toEqual([]);
  });

  it("drops every widget for an agent when its session goes away", async () => {
    const { manager, broadcasts } = await makeManager();
    const host = hostFor(manager, "agent-1");
    host.setWidget("todo-list", widget("todo-list", "a"));
    host.setWidget("weather", widget("weather", "b"));
    hostFor(manager, "agent-2").setWidget("todo-list", widget("todo-list", "c"));
    broadcasts.length = 0;

    (
      manager as unknown as { clearWidgetsForAgent: (id: string) => void }
    ).clearWidgetsForAgent("agent-1");

    // One clear per key, so each client drops exactly what it's showing.
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts.every((b) => b.kind === "extension_ui_widget")).toBe(true);
    expect(broadcasts.map((b) => (b as { widget: unknown }).widget)).toEqual([null, null]);
    // The other agent's widget is untouched.
    expect(manager.snapshotAllWidgets()).toEqual([
      { agentId: "agent-2", widget: widget("todo-list", "c") },
    ]);
  });

  it("clearing an agent with no widgets broadcasts nothing", async () => {
    const { manager, broadcasts } = await makeManager();
    (
      manager as unknown as { clearWidgetsForAgent: (id: string) => void }
    ).clearWidgetsForAgent("agent-1");
    expect(broadcasts).toEqual([]);
  });
});
