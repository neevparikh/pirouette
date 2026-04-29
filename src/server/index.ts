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

  // Default bind: 127.0.0.1. The container path explicitly passes
  // PIROUETTE_HOST=0.0.0.0 (necessary for Docker port mapping); local-dev
  // and any "someone runs `pirouette server` directly" paths get the
  // safer default. The remaining defense — Host header validation
  // below — is what protects against DNS rebinding regardless.
  const host = opts.host ?? process.env.PIROUETTE_HOST ?? "127.0.0.1";
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

  /** Agent IDs are 8-char UUID slices in practice. We accept lowercase
   *  alphanumerics and hyphens up to 64 chars to be forward-compatible.
   *  Any character outside this set is treated as a 404 — prevents log
   *  injection (newlines / ANSI sequences) and keeps Map keys clean. */
  const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

  /** Validate + trim an incoming agent or project name. Rejects empty,
   *  too-long, or control-character-bearing values. The latter would
   *  otherwise corrupt server logs and could spoof structured log lines
   *  in tools that parse them. */
  function validateName(name: unknown): string {
    if (typeof name !== "string") throw new Error("name must be a string");
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error("name cannot be empty");
    if (trimmed.length > 200) throw new Error("name too long (max 200 chars)");
    // \x00-\x1f covers control chars including \n, \r, \t, ESC, etc.
    // \x7f is DEL. Both are useless in legitimate names.
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      throw new Error("name contains control characters");
    }
    return trimmed;
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    // Same-origin only — dashboard is served from the same listener.
    // No `Access-Control-Allow-*` headers means cross-origin reads of
    // the response body are blocked by the browser, and JSON-content-type
    // POSTs from another origin fail their preflight.
    res.writeHead(status, { "content-type": "application/json" });
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
    // Resolve the requested path under webDir. Use `path.resolve` (which
    // collapses `..` segments) plus a separator-aware `startsWith` so
    // sibling-prefix attacks (`/srv/web2/...` matching `/srv/web` prefix)
    // are rejected. The previous regex strip + plain `startsWith` was
    // a no-op on payloads like `/foo/../etc/passwd` because `path.normalize`
    // already collapsed the `..` before the regex saw it.
    const requested = urlPath === "/" ? "/index.html" : urlPath;
    const resolved = path.resolve(webDir, "." + requested);
    if (resolved !== webDir && !resolved.startsWith(webDir + path.sep)) {
      return false;
    }
    try {
      const content = await readFile(resolved);
      const ext = path.extname(resolved);
      res.writeHead(200, { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  /** Build the set of `Host` header values we accept. Anything else gets
   *  421 (Misdirected Request) without further routing. This is the
   *  primary defense against DNS rebinding: a malicious site that
   *  rebinds `evil.com` to `127.0.0.1` and tricks the browser into
   *  sending requests to us still has `Host: evil.com` (the attacker
   *  controls neither the browser's `Host` calculation nor the
   *  server's allowlist). */
  function getAllowedHosts(): Set<string> {
    const portStr = String(port);
    const allowed = new Set<string>([
      `localhost:${portStr}`,
      `127.0.0.1:${portStr}`,
    ]);
    // When binding 0.0.0.0 (container path) clients may also legitimately
    // address us by the container's bind IP. We can't enumerate every
    // possible source, so allow the actual bind host if it's not the
    // wildcard.
    if (host !== "0.0.0.0" && host !== "127.0.0.1") {
      allowed.add(`${host}:${portStr}`);
    }
    // Container path: the docker port mapping makes this listener
    // reachable as the container's hostname or any IP, but we only
    // accept connections we can recognize — same-origin only.
    return allowed;
  }

  // ---- request routing ----
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Host header validation. Reject before any further processing so
    // we don't even read the body of a request we won't honor. Returns
    // 421 (Misdirected Request) per the spec; the body is intentionally
    // sparse to avoid leaking what's allowed.
    const hostHeader = req.headers.host ?? "";
    const allowed = getAllowedHosts();
    if (!allowed.has(hostHeader)) {
      res.writeHead(421, { "content-type": "text/plain" });
      res.end("misdirected request");
      return;
    }

    // Same-origin design: refuse all cross-origin preflights outright.
    // A 405 with no Access-Control-Allow-* tells the browser "not
    // welcome", which is exactly the signal we want to give a malicious
    // tab attempting a non-simple POST.
    if (method === "OPTIONS") {
      res.writeHead(405);
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
        const name = validateName(body.name);
        const projectName =
          body.projectName != null ? validateName(body.projectName) : undefined;
        const config = await agentManager.createAgent({
          name,
          projectName,
          model: body.model,
          thinkingLevel: body.thinkingLevel,
        });
        broadcast({ kind: "agent_created", agent: config });
        json(res, 201, config);
      } catch (err) {
        error(res, 400, err instanceof Error ? err.message : String(err));
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
        const name = validateName(body.name);
        const project = await projectManager.createProject({
          name,
          repoUrl: body.repoUrl,
        });
        broadcast({ kind: "project_created", project });
        json(res, 201, project);
      } catch (err) {
        error(res, 400, err instanceof Error ? err.message : String(err));
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
      const ref = agentMatch[1];
      const sub = agentMatch[2] ?? "";

      // Reject control characters and absurd lengths up front. Mirror the
      // checks in `validateName` so accept-by-name doesn't widen the
      // attack surface beyond what create-agent already accepts.
      if (
        ref.length === 0 ||
        ref.length > 200 ||
        /[\x00-\x1f\x7f]/.test(ref)
      ) {
        error(res, 404, "Agent not found");
        return;
      }

      // Resolve id-or-name to a canonical agent. From here on we use the
      // resolved id so the underlying state-manager calls (which key by
      // id) always succeed if the agent exists. This is also where we
      // turn the long-standing silent-no-op bug into a 404 — previously,
      // `pru rm <name>` would return 200 OK while doing nothing.
      const resolved = agentManager.resolveAgentRef(ref);
      if (!resolved) {
        error(res, 404, "Agent not found");
        return;
      }
      if ("ambiguous" in resolved) {
        const list = resolved.matches
          .map((a) => `${a.id} (${a.projectName}/${a.name})`)
          .join(", ");
        error(
          res,
          409,
          `Ambiguous reference "${ref}" matches ${resolved.matches.length} agents: ${list}. Use the id.`,
        );
        return;
      }
      const agentId = resolved.id;

      // Defensive: the resolved id should always satisfy AGENT_ID_RE
      // (createAgent only emits 8-char hex ids), but if someone hand-edits
      // the state file we'd rather 404 than pass a weird id downstream.
      if (!AGENT_ID_RE.test(agentId)) {
        error(res, 404, "Agent not found");
        return;
      }

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
          // Validate name if provided (forkAgent generates a default
          // otherwise). Ditto entryId — it ends up in shell-adjacent
          // navigateTree calls so reject control characters.
          const name = body.name != null ? validateName(body.name) : undefined;
          const entryId = body.entryId;
          if (entryId != null && (typeof entryId !== "string" || /[\x00-\x1f\x7f]/.test(entryId))) {
            error(res, 400, "entryId contains control characters");
            return;
          }
          const child = await agentManager.forkAgent(agentId, { name, entryId });
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

  // WS upgrades go through their own validation. Browsers always send
  // an `Origin` header on WS upgrades; mismatched Origin (cross-origin
  // attempt to attach to our event stream) is rejected here. We also
  // re-check `Host` for symmetry with the HTTP path.
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, cb) => {
      const allowed = getAllowedHosts();
      const hostHeader = info.req.headers.host ?? "";
      if (!allowed.has(hostHeader)) {
        cb(false, 421, "misdirected request");
        return;
      }
      const originHeader = info.req.headers.origin;
      if (originHeader != null) {
        // Origin is `<scheme>://<host>` (no path). Compare against
        // both http and https for the allowed hosts. The dashboard
        // is currently served HTTP only; once HTTPS lands the same
        // allowlist applies for `https://`.
        const okOrigins = new Set<string>();
        for (const h of allowed) {
          okOrigins.add(`http://${h}`);
          okOrigins.add(`https://${h}`);
        }
        if (!okOrigins.has(originHeader)) {
          cb(false, 403, "forbidden origin");
          return;
        }
      }
      cb(true);
    },
  });
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
