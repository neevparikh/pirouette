/** Pirouette server — HTTP API + WebSocket event streaming.
 *
 *  Two entry points:
 *    - `runServer()` — called by the CLI (`pirouette server`) in-process.
 *    - Executing this file directly still works (`npm run dev` → tsx).
 *
 *  The server reads configuration from env vars so it behaves identically
 *  whether it's started by the CLI, by `npm run dev`, or inside the Docker
 *  container where the entrypoint script sets the env before launch.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { getConfig } from "../config.js";
import { AgentManager } from "./agent-manager.js";
import { ProjectManager } from "./project-manager.js";
import { StateManager } from "./state.js";
import type {
  CreateAgentRequest,
  CreateProjectRequest,
  DeleteAgentOptions,
  DeleteProjectOptions,
  SendMessageRequest,
  WsEnvelope,
} from "./types.js";

export interface RunServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  webDir?: string;
}

export interface ServerHandle {
  server: Server;
  shutdown: () => Promise<void>;
}

/** Resolve the default web directory:
 *    - dev    (src/server/index.ts)  -> ../web   = src/web
 *    - built  (dist/server/index.js) -> ../web   = dist/web
 *  The post-build step copies src/web/ into dist/web/ so both paths resolve
 *  to real files on disk. */
function defaultWebDir(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "web");
}

export async function runServer(opts: RunServerOptions = {}): Promise<ServerHandle> {
  // Config resolution precedence (highest to lowest):
  //   1. Explicit `opts` from the caller (e.g. CLI --port flag)
  //   2. Environment variables (set by `docker run -e` or a parent shell)
  //   3. pirouette.toml (repo) + ~/.pirouette/config.toml (user)
  //   4. Built-in defaults inside getConfig / code below
  // The CLI is no longer responsible for bridging config → env; the server
  // reads the TOML directly so `npm run dev` and `pirouette server` inside
  // the container behave identically given the same config file.
  const cfg = getConfig();

  const host = opts.host ?? process.env.PIROUETTE_HOST ?? "0.0.0.0";
  const port =
    opts.port ??
    (process.env.PIROUETTE_PORT ? Number(process.env.PIROUETTE_PORT) : cfg.container.pirouette_port);
  const dataDir =
    opts.dataDir ??
    process.env.PIROUETTE_DATA_DIR ??
    path.join(process.cwd(), ".pirouette", "data");
  const stateDir = path.join(dataDir, "state");
  const webDir = opts.webDir ?? process.env.PIROUETTE_WEB_DIR ?? defaultWebDir();

  // Make config-derived defaults visible to AgentManager via env vars.
  // Explicit env vars always win over config.
  if (cfg.container.default_model && !process.env.PIROUETTE_DEFAULT_MODEL) {
    process.env.PIROUETTE_DEFAULT_MODEL = cfg.container.default_model;
  }
  if (
    cfg.container.default_thinking_level &&
    !process.env.PIROUETTE_DEFAULT_THINKING_LEVEL
  ) {
    process.env.PIROUETTE_DEFAULT_THINKING_LEVEL = cfg.container.default_thinking_level;
  }

  // ---- state + managers ----
  const stateManager = new StateManager(stateDir);
  const projectManager = new ProjectManager(stateManager, dataDir);
  const agentManager = new AgentManager(stateManager, projectManager, dataDir);
  const wsClients = new Set<WebSocket>();

  // Wire agent events → WebSocket broadcast
  agentManager.onEvent((agentId, event) => {
    const envelope: WsEnvelope = { kind: "agent_event", agentId, event };
    console.log(
      `[ws] broadcast event: ${event.type}${event.updateType ? `:${event.updateType}` : ""} for ${agentId} → ${wsClients.size} client(s)`,
    );
    broadcast(envelope);
  });

  agentManager.onStateChange((agentId, state) => {
    console.log(`[ws] broadcast state_change: ${agentId} → ${state}`);
    broadcast({ kind: "agent_state_change", agentId, state });
  });

  function broadcast(envelope: WsEnvelope): void {
    const payload = JSON.stringify(envelope);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // ---- helpers ----
  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(JSON.stringify(body));
  }

  function error(res: ServerResponse, status: number, message: string): void {
    json(res, status, { error: message });
  }

  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(webDir, safePath === "/" ? "index.html" : safePath);
    if (!filePath.startsWith(webDir)) return false;
    try {
      const content = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  // ---- request routing ----
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      json(res, 200, { ok: true, agents: agentManager.getAllAgents().length });
      return;
    }

    if (method === "GET" && pathname === "/api/agents") {
      const agents = agentManager.getAllAgents().map((a) => ({
        ...a,
        running: agentManager.isRunning(a.id),
      }));
      json(res, 200, { agents });
      return;
    }

    if (method === "POST" && pathname === "/api/agents") {
      try {
        const body = JSON.parse(await readBody(req)) as CreateAgentRequest;
        if (!body.name || typeof body.name !== "string") {
          error(res, 400, "name is required");
          return;
        }
        const config = await agentManager.createAgent({
          name: body.name.trim(),
          projectName: body.projectName,
          model: body.model,
          thinkingLevel: body.thinkingLevel,
        });
        broadcast({ kind: "agent_created", agent: config });
        json(res, 201, config);
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // ---- projects ----
    if (method === "GET" && pathname === "/api/projects") {
      json(res, 200, { projects: projectManager.getAllProjects() });
      return;
    }

    if (method === "POST" && pathname === "/api/projects") {
      try {
        const body = JSON.parse(await readBody(req)) as CreateProjectRequest;
        if (!body.name || typeof body.name !== "string") {
          error(res, 400, "name is required");
          return;
        }
        const project = await projectManager.createProject({
          name: body.name.trim(),
          repoUrl: body.repoUrl,
        });
        broadcast({ kind: "project_created", project });
        json(res, 201, project);
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const name = decodeURIComponent(projectMatch[1]);
      if (method === "GET") {
        const project = projectManager.getProject(name);
        if (!project) {
          error(res, 404, "project not found");
          return;
        }
        json(res, 200, project);
        return;
      }
      if (method === "DELETE") {
        try {
          const qp = url.searchParams;
          const opts: DeleteProjectOptions = {
            deleteRepo: qp.get("deleteRepo") === "true",
            requireEmpty: qp.get("requireEmpty") !== "false",
          };
          await projectManager.removeProject({ name, ...opts });
          broadcast({ kind: "project_removed", projectName: name });
          json(res, 200, { removed: true });
        } catch (err) {
          error(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const sub = agentMatch[2] ?? "";

      if (method === "GET" && sub === "") {
        const agent = agentManager.getAgent(agentId);
        if (!agent) {
          error(res, 404, "Agent not found");
          return;
        }
        json(res, 200, { ...agent, running: agentManager.isRunning(agentId) });
        return;
      }

      if (method === "GET" && sub === "/messages") {
        const agent = agentManager.getAgent(agentId);
        if (!agent) {
          error(res, 404, "Agent not found");
          return;
        }
        const messages = agentManager.getMessages(agentId);
        json(res, 200, { messages });
        return;
      }

      // Live footer-style stats (tokens / context / compaction / model),
      // mirroring what pi's TUI footer shows. Returns 200 with a `stats`
      // field that's null for stopped agents (no live session).
      if (method === "GET" && sub === "/stats") {
        const agent = agentManager.getAgent(agentId);
        if (!agent) {
          error(res, 404, "Agent not found");
          return;
        }
        const stats = agentManager.getLiveStats(agentId);
        json(res, 200, { stats, running: agentManager.isRunning(agentId) });
        return;
      }

      // List of every model the registry knows about. Drives the model
      // picker dropdown in the agent header. Result is sorted by provider
      // then id and includes context-window + reasoning bits the UI needs.
      if (method === "GET" && sub === "/models") {
        const agent = agentManager.getAgent(agentId);
        if (!agent) {
          error(res, 404, "Agent not found");
          return;
        }
        const models = await agentManager.listAvailableModels();
        json(res, 200, { models, current: agent.model });
        return;
      }

      // Switch this agent to a different model. Persists on the agent
      // config so resumes pick it up; live session (if any) is reconfigured
      // via pi's `setModel()` so the next turn uses the new model.
      if (method === "POST" && sub === "/model") {
        try {
          const body = JSON.parse(await readBody(req)) as { model?: string };
          if (!body.model || typeof body.model !== "string") {
            error(res, 400, "model is required (e.g. \"hawk/claude-opus-4-7\")");
            return;
          }
          await agentManager.setAgentModel(agentId, body.model);
          json(res, 200, { ok: true, model: body.model });
        } catch (err) {
          error(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      // List of user messages in this agent's session that can serve as
      // fork points. UI uses this to render "fork from here" buttons.
      if (method === "GET" && sub === "/fork-points") {
        const agent = agentManager.getAgent(agentId);
        if (!agent) {
          error(res, 404, "Agent not found");
          return;
        }
        const points = agentManager.getForkPoints(agentId);
        json(res, 200, { points });
        return;
      }

      // Fork this agent into a new one. Optional `entryId` truncates the
      // forked session at that user message; optional `name` overrides the
      // default `<parent>-fork` slug.
      if (method === "POST" && sub === "/fork") {
        try {
          const body = JSON.parse(await readBody(req)) as {
            name?: string;
            entryId?: string;
          };
          const child = await agentManager.forkAgent(agentId, body);
          broadcast({ kind: "agent_created", agent: child });
          json(res, 201, child);
        } catch (err) {
          error(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === "POST" && sub === "/message") {
        try {
          const body = JSON.parse(await readBody(req)) as SendMessageRequest;
          if (!body.message || typeof body.message !== "string") {
            error(res, 400, "message is required");
            return;
          }
          if (!agentManager.isRunning(agentId)) {
            try {
              await agentManager.resumeAgent(agentId);
            } catch {
              error(res, 409, "Agent is not running and could not be resumed");
              return;
            }
          }
          // `mode` is optional; agent-manager defaults to "steer" during a
          // streaming turn (matches pi's TUI). UI can pass "followUp" to
          // queue without interrupting.
          const mode = body.mode === "followUp" ? "followUp" : "steer";
          agentManager.sendMessage(agentId, body.message, { mode }).catch((err) => {
            console.error(`[server] sendMessage error for ${agentId}: ${err}`);
            broadcast({
              kind: "error",
              message: `Failed to send message to agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
          json(res, 202, { accepted: true });
        } catch (err) {
          error(res, 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === "POST" && sub === "/stop") {
        try {
          await agentManager.stopAgent(agentId);
          json(res, 200, { stopped: true });
        } catch (err) {
          error(res, 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === "POST" && sub === "/resume") {
        try {
          await agentManager.resumeAgent(agentId);
          json(res, 200, { resumed: true });
        } catch (err) {
          error(res, 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === "DELETE" && sub === "") {
        try {
          const qp = url.searchParams;
          const deleteOpts: DeleteAgentOptions = {
            deleteWorktree: qp.get("deleteWorktree") === "true",
            deleteSessions: qp.get("deleteSessions") === "true",
          };
          const rawBody = await readBody(req).catch(() => "");
          if (rawBody) {
            try {
              const parsed = JSON.parse(rawBody) as DeleteAgentOptions;
              if (typeof parsed.deleteWorktree === "boolean")
                deleteOpts.deleteWorktree = parsed.deleteWorktree;
              if (typeof parsed.deleteSessions === "boolean")
                deleteOpts.deleteSessions = parsed.deleteSessions;
            } catch {
              /* ignore bad body */
            }
          }
          await agentManager.removeAgent(agentId, deleteOpts);
          broadcast({ kind: "agent_removed", agentId });
          json(res, 200, { removed: true, ...deleteOpts });
        } catch (err) {
          error(res, 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    if (method === "GET") {
      const served = await serveStatic(res, pathname);
      if (served) return;
    }

    error(res, 404, "Not found");
  }

  // ---- HTTP + WebSocket server ----
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error("[server] unhandled error:", err);
      if (!res.headersSent) error(res, 500, "Internal server error");
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    wsClients.add(ws);
    console.log(`[ws] client connected (${wsClients.size} total)`);

    // Prime the client with the full state so it doesn't have to make
    // follow-up REST calls on first load.
    const agents = agentManager.getAllAgents().map((a) => ({
      ...a,
      running: agentManager.isRunning(a.id),
    }));
    ws.send(JSON.stringify({ kind: "agents_list", agents } satisfies WsEnvelope));
    ws.send(
      JSON.stringify({
        kind: "projects_list",
        projects: projectManager.getAllProjects(),
      } satisfies WsEnvelope),
    );

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[ws] client disconnected (${wsClients.size} total)`);
    });
  });

  // ---- startup ----
  console.log("[pirouette] starting...");
  console.log(`[pirouette] data dir: ${dataDir}`);
  console.log(`[pirouette] web dir: ${webDir}`);

  await stateManager.load();
  console.log(
    `[pirouette] loaded state: ${agentManager.getAllAgents().length} agent(s), ` +
      `${projectManager.getAllProjects().length} project(s)`,
  );

  // Ensure the default `scratchpad` project exists so `pru launch` with no
  // --project flag always has a target. Idempotent on subsequent boots.
  await projectManager.ensureDefaultProject();

  await agentManager.resumeAll();

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.log(`[pirouette] listening on http://${host}:${port}`);
      resolve();
    });
  });

  const shutdown = async () => {
    console.log("\n[pirouette] shutting down...");
    await agentManager.shutdown();
    for (const ws of wsClients) ws.close();
    wss.close();
    server.close();
  };

  return { server, shutdown };
}

// ---- direct-execution entry point --------------------------------------
// When run as a script (e.g. `tsx src/server/index.ts`), this block fires.
// When imported (e.g. from the CLI), `runServer()` is a no-op until the
// caller invokes it.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");

if (isMain) {
  runServer()
    .then(({ shutdown }) => {
      const onExit = async () => {
        await shutdown();
        process.exit(0);
      };
      process.on("SIGINT", onExit);
      process.on("SIGTERM", onExit);
    })
    .catch((err) => {
      console.error("[pirouette] fatal:", err);
      process.exit(1);
    });
}
