/** Extensions each agent gets its own copy of: pi's MCP client and the two
 *  tools that reach MCP tools (`codemode`, `tool_search`).
 *
 *  Everything else pirouette loads once, behind one `DefaultResourceLoader`,
 *  and shares between agents (see extension-runtime.ts). Pi's MCP extension
 *  cannot be shared that way. It keeps the state of exactly one session: on
 *  `session_start` it forgets the servers it had and connects again, and on
 *  `session_shutdown` it closes every connection. With one instance for the
 *  whole server, an agent starting would orphan every other agent's
 *  connections, and an agent stopping would close them.
 *
 *  It also leans on the `pi.*` actions (`getAllTools`, `setActiveTools`,
 *  `registerTool` → `refreshTools`), which live on the extension runtime the
 *  extension was loaded with. Pi's runner copies a session's actions onto the
 *  runtime when the session binds, so on the shared runtime they belong to
 *  whichever agent bound last.
 *
 *  So these extensions are loaded once per agent, each set with a runtime of
 *  its own, and handed to the agent's session alongside the shared ones.
 *  The merged result makes the session's runner bind both runtimes. The MCP
 *  extension connects on the agent's first prompt, not when its session is
 *  created ({@link connectOnFirstPrompt}). */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SettingsManager,
  type Extension,
  type ExtensionContext,
  type LoadedMcpConfig,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

type ExtensionRuntime = LoadExtensionsResult["runtime"];
type LoadMcpConfig = (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => LoadedMcpConfig;

/** Pi's own `mcp.json` reader. Pi exports the types but not the function, so
 *  it is imported by path from the installed package. */
async function importLoadMcpConfig(): Promise<LoadMcpConfig> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      readdirSync(pkg);
      const mod = (await import(
        pathToFileURL(path.join(pkg, "dist", "extensions", "mcp", "config.js")).href
      )) as { loadMcpConfig?: LoadMcpConfig };
      if (typeof mod.loadMcpConfig !== "function") {
        throw new Error("pi's MCP config module no longer exports loadMcpConfig");
      }
      return mod.loadMcpConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not find @earendil-works/pi-coding-agent");
    dir = parent;
  }
}

/** Names the shared extensions already claim. An extension that registers
 *  `/mcp`, `codemode` or `tool_search` replaces pi's built-in of that name in
 *  the CLI; it does here too. */
function claimed(shared: LoadExtensionsResult): { mcp: boolean; codemode: boolean; toolSearch: boolean } {
  const exts = shared.extensions;
  return {
    mcp: exts.some((e) => e.commands.has("mcp")),
    codemode: exts.some((e) => e.tools.has("codemode")),
    toolSearch: exts.some((e) => e.tools.has("tool_search")),
  };
}

export interface AgentExtensionsOptions {
  /** The agent's working directory. */
  cwd: string;
  agentDir: string;
  /** The extensions every agent shares, to avoid registering a name twice. */
  shared: LoadExtensionsResult;
}

/** Load one agent's own MCP, codemode and tool_search extensions.
 *
 *  Only the servers in `<agentDir>/mcp.json` are used. A `.pi/mcp.json` in the
 *  agent's worktree is ignored: a stdio server is a command pi starts by
 *  itself, and a repository an agent has checked out should not get to name
 *  one. */
async function load(opts: AgentExtensionsOptions): Promise<LoadExtensionsResult> {
  const taken = claimed(opts.shared);
  const loadMcpConfig = taken.mcp ? null : await importLoadMcpConfig();
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    // Nothing on disk is read for this loader: it exists to run the factories.
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      // Without the model catalog: an agent's model is chosen by pirouette
      // (and possibly restricted by an extension), not by a script.
      ...(taken.codemode ? [] : [createCodemodeExtension({ models: false })]),
      ...(taken.toolSearch ? [] : [createToolSearchExtension()]),
      ...(loadMcpConfig
        ? [
            createMcpExtension({
              loadConfig: (ctx: ExtensionContext) =>
                loadMcpConfig({ agentDir: opts.agentDir, cwd: ctx.cwd, projectTrusted: false }),
            }),
          ]
        : []),
    ],
  });
  await loader.reload();
  const result = loader.getExtensions();
  for (const extension of result.extensions) {
    if (extension.commands.has("mcp")) connectOnFirstPrompt(extension);
  }
  return result;
}

/** Hold the MCP extension's `session_start` back until the agent's first
 *  prompt.
 *
 *  Pi's MCP extension connects to every server when the session starts. In
 *  the CLI that is one session a person is about to use. A pirouette server
 *  creates a session for each agent it resumes when it boots, most of which
 *  will sit idle, and each would open its own connections and start its own
 *  stdio servers. Starting on the first prompt instead means only agents
 *  that are doing something hold connections.
 *
 *  `before_agent_start` runs before the prompt's request is built, and the
 *  extension's own handler for it comes next, so the first prompt still
 *  lists the servers and waits for the ones with `direct` tools. */
function connectOnFirstPrompt(extension: Extension): void {
  const onStart = extension.handlers.get("session_start") ?? [];
  if (onStart.length === 0) return;
  extension.handlers.delete("session_start");
  let started = false;
  // Pi's handler type is erased to `(...args: unknown[])`.
  const start = async (...args: unknown[]) => {
    if (started) return;
    started = true;
    for (const handler of onStart) await handler({ type: "session_start", reason: "startup" }, args[1]);
  };
  extension.handlers.set("before_agent_start", [start, ...(extension.handlers.get("before_agent_start") ?? [])]);
}

/** The runtime a session's runner should bind when its extensions come from
 *  two runtimes. It is the shared runtime, except that every action the
 *  runner assigns is also assigned on the agent's own runtime, and
 *  invalidating it invalidates the agent's own runtime too. */
function bindBoth(shared: ExtensionRuntime, own: ExtensionRuntime): ExtensionRuntime {
  return new Proxy(shared, {
    set(target, prop, value) {
      Reflect.set(own, prop, value);
      return Reflect.set(target, prop, value);
    },
    get(target, prop) {
      if (prop === "invalidate") {
        return (message?: string) => {
          own.invalidate(message);
          target.invalidate(message);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

/** One agent's own extensions. */
export interface AgentExtensions {
  /** The shared extensions plus the agent's own, for the agent's
   *  `ResourceLoader.getExtensions()`. Rebuilt only when `shared` is a new
   *  object (after a reload), so a session that asks twice binds the same
   *  runtime. */
  merge(shared: LoadExtensionsResult): LoadExtensionsResult;
  /** Tell the agent's own extensions the session is over, which is what
   *  closes its MCP connections and stops its stdio servers. Call before
   *  `session.dispose()`: pi sends `session_shutdown` when its own CLI quits,
   *  but disposing a session does not, and sending it through the session's
   *  runner would also reach the extensions every other agent still uses. */
  shutdown(ctx: ExtensionContext): Promise<void>;
}

export async function loadAgentExtensions(opts: AgentExtensionsOptions): Promise<AgentExtensions> {
  const own = await load(opts);
  let last: { shared: LoadExtensionsResult; merged: LoadExtensionsResult } | null = null;
  return {
    merge(shared) {
      if (last?.shared === shared) return last.merged;
      const merged: LoadExtensionsResult = {
        ...shared,
        extensions: [...shared.extensions, ...own.extensions],
        errors: [...shared.errors, ...own.errors],
        runtime: bindBoth(shared.runtime, own.runtime),
      };
      last = { shared, merged };
      return merged;
    },
    async shutdown(ctx) {
      const event = { type: "session_shutdown", reason: "quit" } as const;
      for (const extension of own.extensions) {
        for (const handler of extension.handlers.get("session_shutdown") ?? []) {
          try {
            await handler(event, ctx);
          } catch (err) {
            console.error(
              `[agent-extensions] session_shutdown failed in ${extension.path}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    },
  };
}
