/**
 * Tests for the default deadline on agent `bash` calls.
 *
 * Three things have to hold, and each of them breaks silently:
 *   - the policy resolves sensibly from config/env (a typo must not take the
 *     server down, and a cap below the default must not shorten every call),
 *   - the extension pi actually loads registers `tool_call` / `tool_result`
 *     handlers and mutates `input.timeout` in place, which is pi's documented
 *     contract for patching tool arguments,
 *   - the recovery hint is attached to a *real* timed-out result. That last
 *     one is a drift guard: we recognise timeouts by pi's own message text,
 *     so the test runs pi's bash tool and lets it time out for real.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createBashTool,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  appendTimeoutHint,
  bashTimeoutGuidance,
  bashTimeoutSeconds,
  createBashTimeoutExtension,
  decideBashTimeout,
  DEFAULT_BASH_MAX_TIMEOUT_SECONDS,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  INERT_BASH_TIMEOUT_POLICY,
  isInertBashTimeoutPolicy,
  resolveBashTimeoutPolicy,
  type BashTimeoutPolicy,
} from "../bash-timeout.js";

const POLICY: BashTimeoutPolicy = { defaultSeconds: 30, maxSeconds: 600 };

describe("resolveBashTimeoutPolicy", () => {
  it("defaults to 30s with a 600s cap", () => {
    const { policy, warnings } = resolveBashTimeoutPolicy(undefined, {});
    expect(policy).toEqual({
      defaultSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
      maxSeconds: DEFAULT_BASH_MAX_TIMEOUT_SECONDS,
    });
    expect(warnings).toEqual([]);
  });

  it("reads config values, including strings from TOML-ish sources", () => {
    const { policy } = resolveBashTimeoutPolicy({ default_seconds: 10, max_seconds: "120" }, {});
    expect(policy).toEqual({ defaultSeconds: 10, maxSeconds: 120 });
  });

  it("lets the environment override config", () => {
    const { policy } = resolveBashTimeoutPolicy(
      { default_seconds: 10, max_seconds: 120 },
      { PIROUETTE_BASH_TIMEOUT_SECONDS: "45", PIROUETTE_BASH_MAX_TIMEOUT_SECONDS: "90" },
    );
    expect(policy).toEqual({ defaultSeconds: 45, maxSeconds: 90 });
  });

  it("keeps pi's unbounded behaviour when both knobs are zero", () => {
    const { policy } = resolveBashTimeoutPolicy({ default_seconds: 0, max_seconds: 0 }, {});
    expect(policy).toEqual(INERT_BASH_TIMEOUT_POLICY);
    expect(isInertBashTimeoutPolicy(policy)).toBe(true);
  });

  it("warns and falls back on garbage instead of failing startup", () => {
    const { policy, warnings } = resolveBashTimeoutPolicy(
      { default_seconds: "soon", max_seconds: -5 },
      {},
    );
    expect(policy).toEqual({
      defaultSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
      maxSeconds: DEFAULT_BASH_MAX_TIMEOUT_SECONDS,
    });
    expect(warnings).toHaveLength(2);
  });

  it("raises a cap that sits below the default rather than shortening every call", () => {
    const { policy, warnings } = resolveBashTimeoutPolicy(
      { default_seconds: 120, max_seconds: 60 },
      {},
    );
    expect(policy).toEqual({ defaultSeconds: 120, maxSeconds: 120 });
    expect(warnings.join(" ")).toContain("raising the cap");
  });
});

describe("decideBashTimeout", () => {
  it("gives an unspecified call the default deadline", () => {
    expect(decideBashTimeout(POLICY, undefined)).toEqual({ timeout: 30, change: "defaulted" });
  });

  it("leaves a reasonable explicit timeout alone", () => {
    expect(decideBashTimeout(POLICY, 120)).toEqual({ timeout: 120, change: null });
  });

  it("clamps an explicit timeout to the cap", () => {
    expect(decideBashTimeout(POLICY, 7200)).toEqual({ timeout: 600, change: "clamped" });
  });

  it("treats unusable values as unspecified", () => {
    for (const bad of [0, -1, Number.NaN, "60", null]) {
      expect(decideBashTimeout(POLICY, bad)).toEqual({ timeout: 30, change: "defaulted" });
    }
  });

  it("changes nothing under an inert policy", () => {
    expect(decideBashTimeout(INERT_BASH_TIMEOUT_POLICY, undefined)).toEqual({
      timeout: undefined,
      change: null,
    });
    expect(decideBashTimeout(INERT_BASH_TIMEOUT_POLICY, 7200)).toEqual({
      timeout: 7200,
      change: null,
    });
  });
});

describe("bashTimeoutGuidance", () => {
  it("tells the agent the deadline, the cap, and how to background work", () => {
    const text = bashTimeoutGuidance(POLICY)!;
    expect(text).toContain("30s");
    expect(text).toContain("600s");
    expect(text).toContain("setsid");
  });

  it("says nothing when the policy is inert", () => {
    expect(bashTimeoutGuidance(INERT_BASH_TIMEOUT_POLICY)).toBeNull();
  });
});

describe("appendTimeoutHint", () => {
  it("appends recovery advice to a timed-out result", () => {
    const patched = appendTimeoutHint(POLICY, [
      { type: "text", text: "partial output\n\nCommand timed out after 30 seconds" },
    ]);
    const text = (patched!.content[0] as { text: string }).text;
    expect(text).toContain("partial output");
    expect(text).toContain("setsid");
    expect(text).toContain("30s");
  });

  it("quotes the deadline that actually fired, not the default", () => {
    const patched = appendTimeoutHint(POLICY, [
      { type: "text", text: "Command timed out after 600 seconds" },
    ]);
    expect((patched!.content[0] as { text: string }).text).toContain("600s");
  });

  it("leaves other errors untouched", () => {
    expect(appendTimeoutHint(POLICY, [{ type: "text", text: "Command exited with code 1" }])).toBeUndefined();
  });
});

describe("the extension pi loads", () => {
  async function loadHandlers(policy: BashTimeoutPolicy) {
    const cwd = await mkdtemp(path.join(tmpdir(), "pirouette-bash-timeout-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      eventBus: createEventBus(),
      // Only our inline extension; the user's real ~/.pi extensions must not
      // leak into the test.
      noExtensions: false,
      extensionFactories: [createBashTimeoutExtension(policy)],
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((e) => e.path.includes("bash-timeout")),
      }),
    });
    await loader.reload();
    const { extensions } = loader.getExtensions();
    expect(extensions).toHaveLength(1);
    return extensions[0].handlers;
  }

  it("registers tool_call and tool_result handlers", async () => {
    const handlers = await loadHandlers(POLICY);
    expect(handlers.get("tool_call")).toHaveLength(1);
    expect(handlers.get("tool_result")).toHaveLength(1);
  });

  it("patches the timeout in place, as pi's tool_call contract requires", async () => {
    const handlers = await loadHandlers(POLICY);
    const onToolCall = handlers.get("tool_call")![0];

    const event = { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "find /" } };
    await onToolCall(event as never, {} as never);
    expect(event.input).toEqual({ command: "find /", timeout: 30 });

    // Other tools are none of our business.
    const readEvent = { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "/etc/hosts" } };
    await onToolCall(readEvent as never, {} as never);
    expect(readEvent.input).toEqual({ path: "/etc/hosts" });
  });
});

describe("pi's timeout message", () => {
  // Drift guard: we detect timeouts by matching pi's wording. If a future pi
  // changes it, the recovery hint would silently stop being attached.
  it("is recognised on a real killed command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pirouette-bash-real-"));
    const tool = createBashTool(cwd);
    const controller = new AbortController();
    const err = await tool
      .execute("call-1", { command: "sleep 30", timeout: 1 }, controller.signal)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(bashTimeoutSeconds(err!.message)).toBe(1);
    expect(appendTimeoutHint(POLICY, [{ type: "text", text: err!.message }])).toBeDefined();
  }, 20_000);
});
