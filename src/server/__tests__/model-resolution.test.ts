/** Model resolution + credential pre-flight.
 *
 *  The bug these guard: an agent launched with `--model anthropic/claude-opus-5`
 *  on a host whose only authenticated provider is something else. The model
 *  is a real entry in pi's registry, so the session started, the agent went
 *  `running` on its first message, and the prompt died on "No API key found
 *  for anthropic" — leaving an agent that looked busy forever and never ran
 *  a single turn.
 */
import { describe, expect, it } from "vitest";

import {
  formatReachableModels,
  resolveAgentModel,
  splitQualifiedModel,
  type ModelLookup,
} from "../model-resolution.js";

interface FakeModel {
  provider: string;
  id: string;
}

/** Registry with `registered` models known to pi and `authed` providers we
 *  actually hold credentials for. */
function makeLookup(opts: {
  registered?: FakeModel[];
  available?: FakeModel[];
  authedProviders?: string[];
}): ModelLookup<FakeModel> & { authChecks: FakeModel[] } {
  const registered = opts.registered ?? [];
  const available = opts.available ?? [];
  const authed = new Set(opts.authedProviders ?? available.map((m) => m.provider));
  const authChecks: FakeModel[] = [];
  return {
    authChecks,
    find: (p, id) => registered.find((m) => m.provider === p && m.id === id),
    getAvailable: () => available,
    checkAuth: async (m) => {
      authChecks.push(m);
      return authed.has(m.provider)
        ? { ok: true }
        : { ok: false, error: `No API key found for "${m.provider}"` };
    },
  };
}

describe("splitQualifiedModel", () => {
  it("splits provider/id", () => {
    expect(splitQualifiedModel("hawk/claude-opus-5")).toEqual(["hawk", "claude-opus-5"]);
  });

  it("keeps slashes in the model id", () => {
    expect(splitQualifiedModel("openrouter/meta/llama-4")).toEqual([
      "openrouter",
      "meta/llama-4",
    ]);
  });

  it("assumes anthropic for a bare id, like pi does", () => {
    expect(splitQualifiedModel("claude-sonnet-4-5")).toEqual(["anthropic", "claude-sonnet-4-5"]);
  });
});

describe("formatReachableModels", () => {
  it("truncates a long list", () => {
    const models = Array.from({ length: 12 }, (_, i) => ({ provider: "hawk", id: `m${i}` }));
    expect(formatReachableModels(models, 3)).toBe("hawk/m0, hawk/m1, hawk/m2, … (9 more)");
  });

  it("says so when nothing is authenticated", () => {
    expect(formatReachableModels([])).toContain("none");
  });
});

describe("resolveAgentModel", () => {
  it("resolves a model whose provider is authenticated", async () => {
    const lookup = makeLookup({
      registered: [{ provider: "hawk", id: "claude-opus-5" }],
      available: [{ provider: "hawk", id: "claude-opus-5" }],
    });
    await expect(resolveAgentModel("hawk/claude-opus-5", lookup)).resolves.toEqual({
      provider: "hawk",
      id: "claude-opus-5",
    });
  });

  it("resolves custom-provider models that only appear in the available list", async () => {
    // Providers registered by an extension usually have `models: []` in
    // models.json, so find() misses them entirely.
    const lookup = makeLookup({
      registered: [],
      available: [{ provider: "hawk", id: "claude-opus-5" }],
    });
    await expect(resolveAgentModel("hawk/claude-opus-5", lookup)).resolves.toMatchObject({
      provider: "hawk",
    });
  });

  it("rejects a registered model whose provider has no credentials here", async () => {
    const lookup = makeLookup({
      registered: [{ provider: "anthropic", id: "claude-opus-5" }],
      available: [{ provider: "hawk", id: "claude-opus-5" }],
    });
    await expect(resolveAgentModel("anthropic/claude-opus-5", lookup)).rejects.toThrow(
      /not usable on this host/,
    );
    // The message has to be actionable: what failed, and what would work.
    await expect(resolveAgentModel("anthropic/claude-opus-5", lookup)).rejects.toThrow(
      /hawk\/claude-opus-5/,
    );
  });

  it("rejects an unknown model with the reachable list", async () => {
    const lookup = makeLookup({
      available: [{ provider: "hawk", id: "claude-opus-5" }],
    });
    await expect(resolveAgentModel("hawk/not-a-model", lookup)).rejects.toThrow(
      /not found.*hawk\/claude-opus-5/s,
    );
  });

  it("accepts a model the auth check approves even when nothing is enumerated", async () => {
    // A provider registered by an extension may authenticate fine while
    // publishing no catalog at all. Resolution defers to the injected auth
    // check rather than requiring membership of the available list.
    const lookup: ModelLookup<FakeModel> = {
      find: () => ({ provider: "local", id: "qwen" }),
      getAvailable: () => [],
      checkAuth: async () => ({ ok: true }),
    };
    await expect(resolveAgentModel("local/qwen", lookup)).resolves.toMatchObject({
      provider: "local",
    });
  });
});
