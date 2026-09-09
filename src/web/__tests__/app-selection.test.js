// @vitest-environment jsdom
// Exercise the real dashboard: WebSocket envelopes in, DOM and message POSTs out.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const projects = [{ name: "scratchpad" }, { name: "other-project" }];
const original = makeAgent("original", "scratchpad");
let socket;
let responseAgent;
let broadcastBeforeResponse;
let sentMessages;

function makeAgent(id, projectName = "other-project") {
  return {
    id, name: id, projectName, state: "waiting_input", model: "demo-model",
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

function broadcast(envelope) {
  socket.onmessage({ data: JSON.stringify(envelope) });
}

const input = () => document.getElementById("message-input");
const title = () => document.getElementById("agent-title").textContent;
const chatRows = (id) => document.querySelectorAll(`[data-agent-id="${id}"]`);

async function send(text) {
  input().value = text;
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(input().value).toBe(""));
}

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  document.documentElement.innerHTML = readFileSync(resolve(here, "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("WebSocket", class {
    constructor() { socket = this; }
  });
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    let data = {};
    if (opts.method === "POST") {
      if (url === "/api/agents" || /\/(fork|handoff)$/.test(url)) {
        if (broadcastBeforeResponse) broadcast({ kind: "agent_created", agent: responseAgent });
        data = responseAgent;
      } else if (url.endsWith("/message")) {
        sentMessages.push({ url, body: JSON.parse(opts.body) });
      }
    } else if (url.endsWith("/messages")) data = { messages: [] };
    else if (url.endsWith("/stats")) data = { stats: null };
    else if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  await import("../app.js");
});

beforeEach(() => {
  sentMessages = [];
  responseAgent = makeAgent("created-in-this-tab", "scratchpad");
  broadcastBeforeResponse = true;
  broadcast({ kind: "projects_list", projects });
  broadcast({ kind: "agents_list", agents: [original] });
  chatRows(original.id)[0].click();
  input().value = "";
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agent creation does not navigate other clients", () => {
  it("keeps the chat, project, draft and caret when a background agent is created", async () => {
    const placeholder = input().placeholder;
    const tabTitle = document.title;
    input().value = "a draft for the original agent";
    input().focus();
    input().setSelectionRange(7, 12);

    const background = makeAgent("background-child");
    broadcast({ kind: "agent_created", agent: background });

    expect(chatRows(background.id)).toHaveLength(1);
    expect(title()).toBe(original.name);
    expect(document.title).toBe(tabTitle);
    expect(input().placeholder).toBe(placeholder);
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("a draft for the original agent");
    expect([input().selectionStart, input().selectionEnd]).toEqual([7, 12]);

    document.getElementById("send-btn").click();
    await vi.waitFor(() => expect(sentMessages).toHaveLength(1));
    expect(sentMessages[0].url).toBe(`/api/agents/${original.id}/message`);
    expect(sentMessages[0].body.message).toBe("a draft for the original agent");
  });

  it("does not steal focus from another control", () => {
    const control = document.getElementById("theme-btn");
    control.focus();
    broadcast({ kind: "agent_created", agent: makeAgent("another-tab-chat") });
    expect(title()).toBe(original.name);
    expect(document.activeElement).toBe(control);
  });

  it("leaves an unselected dashboard unselected", () => {
    broadcast({ kind: "agent_removed", agentId: original.id });
    const emptyTitle = title();
    broadcast({ kind: "agent_created", agent: makeAgent("first-background-chat") });
    expect(title()).toBe(emptyTitle);
    expect(chatRows("first-background-chat")).toHaveLength(1);
  });

  it("still lets the user explicitly select a newly announced agent", () => {
    const background = makeAgent("clickable-child");
    broadcast({ kind: "agent_created", agent: background });
    chatRows(background.id)[0].click();
    expect(title()).toBe(background.name);
  });
});

for (const order of ["broadcast first", "response first"]) {
  describe(`explicit creation (${order})`, () => {
    beforeEach(() => { broadcastBeforeResponse = order === "broadcast first"; });

    function checkSelectionAndLateBroadcast() {
      expect(title()).toBe(responseAgent.name);
      expect(document.title).toBe(`pirouette—scratchpad—${responseAgent.name}`);
      expect(chatRows(responseAgent.id)).toHaveLength(1);
      // A delayed broadcast (or a duplicate one) is just a list update, not
      // permission to navigate away from whatever the user is now doing.
      chatRows(original.id)[0].click();
      broadcast({ kind: "agent_created", agent: responseAgent });
      expect(chatRows(responseAgent.id)).toHaveLength(1);
      expect(title()).toBe(original.name);
    }

    it("selects an @newname chat in the sending tab", async () => {
      await send(`@${responseAgent.name} hello`);
      await vi.waitFor(() => expect(sentMessages).toHaveLength(1));
      expect(sentMessages[0].url).toBe(`/api/agents/${responseAgent.id}/message`);
      expect(sentMessages[0].body.message).toBe("hello");
      checkSelectionAndLateBroadcast();
    });

    it("selects a fork created by this tab", async () => {
      vi.spyOn(window, "prompt").mockReturnValue(responseAgent.name);
      document.getElementById("agent-fork-btn").click();
      await vi.waitFor(() => expect(title()).toBe(responseAgent.name));
      checkSelectionAndLateBroadcast();
    });

    it("selects a handoff requested by this tab", async () => {
      await send("/handoff continue the work");
      await vi.waitFor(() => expect(title()).toBe(responseAgent.name));
      checkSelectionAndLateBroadcast();
    });
  });
}
