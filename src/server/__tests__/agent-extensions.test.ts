import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import { loadAgentExtensions, type AgentExtensions } from "../agent-extensions.js";
import { guardExtensionsResult } from "../extension-runtime.js";

const server = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const TOOL = "mcp__echo__echo";

interface Agent {
  session: AgentSession;
  own: AgentExtensions;
}

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "pru-agent-ext-"));
  dirs.push(d);
  return d;
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A server-like setup: one shared loader, and agents created the way
 *  AgentManager creates them. */
async function setup() {
  const agentDir = await tempDir();
  const pidFile = path.join(agentDir, "pids");
  await writeFile(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        echo: { command: process.execPath, args: [server], env: { MCP_ECHO_PIDS: pidFile }, exposure: "direct" },
      },
    }),
  );
  const shared = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await shared.reload();
  const sharedExtensions = () => guardExtensionsResult(shared.getExtensions());

  const startAgent = async (cwd: string): Promise<Agent> => {
    const own = await loadAgentExtensions({ cwd, agentDir, shared: sharedExtensions() });
    const resourceLoader: ResourceLoader = {
      getExtensions: () => own.merge(sharedExtensions()),
      getSkills: () => shared.getSkills(),
      getPrompts: () => shared.getPrompts(),
      getThemes: () => shared.getThemes(),
      getAgentsFiles: () => shared.getAgentsFiles(),
      getSystemPrompt: () => shared.getSystemPrompt(),
      getSystemPromptSource: () => shared.getSystemPromptSource(),
      getAppendSystemPrompt: () => shared.getAppendSystemPrompt(),
      getAppendSystemPromptSources: () => shared.getAppendSystemPromptSources(),
      extendResources: (paths) => shared.extendResources(paths),
      reload: () => shared.reload(),
    };
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });
    sessions.push(session);
    await session.bindExtensions({});
    return { session, own };
  };
  const pids = () =>
    existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
  return { agentDir, startAgent, pids };
}

const hasTool = ({ session }: Agent) => session.getActiveToolNames().includes(TOOL);

describe("per-agent MCP extensions", () => {
  it("gives every agent its own connection and its own tools", async () => {
    const { startAgent, pids } = await setup();
    const a = await startAgent(await tempDir());
    await waitFor(() => hasTool(a), "agent A's MCP tool");
    // B binds after A. On a shared runtime, that would repoint the `pi.*`
    // actions A's MCP extension uses at B, and B's start would drop A's
    // connection.
    const b = await startAgent(await tempDir());
    await waitFor(() => hasTool(b), "agent B's MCP tool");

    expect(hasTool(a)).toBe(true);
    expect(pids()).toHaveLength(2);
    expect(pids().every(alive)).toBe(true);
  });

  it("keeps one agent's connection when another agent stops", async () => {
    const { startAgent, pids } = await setup();
    const a = await startAgent(await tempDir());
    await waitFor(() => hasTool(a), "agent A's MCP tool");
    const b = await startAgent(await tempDir());
    await waitFor(() => hasTool(b), "agent B's MCP tool");
    const [pidA, pidB] = pids();

    // What AgentManager does when an agent stops.
    await a.own.shutdown(a.session.extensionRunner.createContext());
    a.session.dispose();
    await waitFor(() => !alive(pidA), "agent A's server to exit");

    expect(alive(pidB)).toBe(true);
    expect(hasTool(b)).toBe(true);
  });

  it("ignores an mcp.json in the agent's worktree", async () => {
    const { startAgent, pids } = await setup();
    const cwd = await tempDir();
    const marker = path.join(cwd, "started");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          project: { command: process.execPath, args: [server], env: { MCP_ECHO_PIDS: marker }, exposure: "direct" },
        },
      }),
    );

    const a = await startAgent(cwd);
    await waitFor(() => hasTool(a), "the user-level MCP tool");

    expect(pids()).toHaveLength(1);
    expect(a.session.getActiveToolNames().filter((name) => name.startsWith("mcp__"))).toEqual([TOOL]);
    expect(existsSync(marker)).toBe(false);
  });
});
