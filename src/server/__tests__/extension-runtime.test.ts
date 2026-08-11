/**
 * Tests for the shared-extension-runtime guard.
 *
 * The bug this prevents took a whole server down: one `/new` in one chat
 * disposed one session, pi marked the *process-shared* extension runtime
 * stale, and from then on every newly launched agent failed its first tool
 * call with "This extension ctx is stale after session replacement or
 * reload." Only a server restart cleared it.
 *
 * So the first test here is a drift guard against pi itself: it reproduces
 * the poisoning through pi's real runtime and a real extension's captured
 * `pi` handle. If a future pi stops invalidating the shared runtime, that
 * test fails and the guard can go away.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createEventBus, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  guardExtensionsResult,
  keepSharedExtensionRuntimeActive,
  type SharedExtensionRuntime,
} from "../extension-runtime.js";

/** Load one inline extension and hand back both the runtime pirouette shares
 *  between agents and the `pi` handle the extension captured at load time —
 *  which is exactly what auto-mode et al. call from their hooks. */
async function loadProbeExtension() {
  const cwd = await mkdtemp(path.join(tmpdir(), "pirouette-extension-runtime-"));
  let captured: { getFlag: (name: string) => unknown } | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    eventBus: createEventBus(),
    extensionFactories: [
      {
        name: "probe",
        factory: (pi) => {
          pi.registerFlag("probe-flag", { description: "probe", type: "boolean", default: false });
          captured = pi;
        },
      },
    ],
    // The developer's real ~/.pi extensions must not leak into the test.
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((e) => e.path.includes("probe")),
    }),
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  expect(captured).toBeDefined();
  return {
    extensions,
    runtime: (extensions as { runtime: SharedExtensionRuntime }).runtime,
    pi: captured!,
  };
}

describe("pi's shared extension runtime", () => {
  it("is poisoned for every extension when one session invalidates it", async () => {
    const { runtime, pi } = await loadProbeExtension();
    expect(pi.getFlag("probe-flag")).toBe(false);

    // What AgentSession.dispose() does — stopping one agent, not all of them.
    runtime.invalidate();

    expect(() => pi.getFlag("probe-flag")).toThrow(/stale/i);
  });
});

describe("keepSharedExtensionRuntimeActive", () => {
  it("lets other agents keep using their extensions after one session is disposed", async () => {
    const { runtime, pi } = await loadProbeExtension();

    expect(keepSharedExtensionRuntimeActive(runtime)).toBe(true);
    runtime.invalidate();

    expect(pi.getFlag("probe-flag")).toBe(false);
    expect(() => runtime.assertActive()).not.toThrow();
  });

  it("survives repeated disposals and repeated guarding", async () => {
    const { runtime, pi } = await loadProbeExtension();

    keepSharedExtensionRuntimeActive(runtime);
    keepSharedExtensionRuntimeActive(runtime);
    runtime.invalidate();
    runtime.invalidate("some other reason");

    expect(pi.getFlag("probe-flag")).toBe(false);
  });

  it("reports an already-stale runtime instead of pretending to fix it", async () => {
    const { runtime } = await loadProbeExtension();
    runtime.invalidate();

    const logs: string[] = [];
    expect(keepSharedExtensionRuntimeActive(runtime, (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("already stale");
  });

  it("ignores a runtime-less extensions result", () => {
    expect(keepSharedExtensionRuntimeActive(undefined)).toBe(false);
  });
});

describe("guardExtensionsResult", () => {
  it("guards the runtime and returns the same result object", async () => {
    const { extensions, runtime, pi } = await loadProbeExtension();

    expect(guardExtensionsResult(extensions)).toBe(extensions);
    runtime.invalidate();

    expect(pi.getFlag("probe-flag")).toBe(false);
  });

  it("guards a fresh runtime handed out after a reload", async () => {
    const { extensions } = await loadProbeExtension();
    // A reload swaps in a new runtime object; guarding must not be one-shot.
    const replacement = {
      runtime: { ...(extensions as { runtime: SharedExtensionRuntime }).runtime },
    };
    let stale: string | undefined;
    replacement.runtime.invalidate = (message?: string) => {
      stale = message ?? "stale";
    };
    replacement.runtime.assertActive = () => {
      if (stale) throw new Error(stale);
    };

    guardExtensionsResult(replacement);
    replacement.runtime.invalidate("disposed");

    expect(() => replacement.runtime.assertActive()).not.toThrow();
  });
});
