import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const ROOT_DIR = process.cwd();
const SPIKE_ROOT = path.join(ROOT_DIR, ".pirouette", "spikes", "event-streaming");
const WORKSPACE_DIR = path.join(SPIKE_ROOT, "workspace");
const SESSION_DIR = path.join(SPIKE_ROOT, "sessions");
const NOTES_PATH = path.join(WORKSPACE_DIR, "notes.txt");
const HOST = process.env.PIROUETTE_STREAM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PIROUETTE_STREAM_PORT ?? 7781);
const STREAM_TOKEN = "STREAMING_SPIKE_OK";
const DEFAULT_PROMPT = [
  "Use the read tool to read notes.txt in the current directory.",
  "Then reply with exactly the token from the second line of that file and nothing else.",
].join("\n");

type Command = "serve" | "client" | "reset";

type NormalizedEvent = { type: string; [key: string]: unknown };

type StreamEnvelope =
  | { kind: "server_ready"; port: number; prompt: string; sessionFile: string | undefined }
  | { kind: "prompt_accepted"; prompt: string }
  | { kind: "prompt_rejected"; reason: string }
  | { kind: "session_event"; event: NormalizedEvent }
  | { kind: "server_error"; message: string };

function isCommand(value: string | undefined): value is Command {
  return value === "serve" || value === "client" || value === "reset";
}

async function ensureWorkspace(): Promise<void> {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(SESSION_DIR, { recursive: true });
  await writeFile(
    NOTES_PATH,
    [
      "Pirouette event streaming spike.",
      STREAM_TOKEN,
      "The second line is the only token the agent should return.",
    ].join("\n"),
  );
}

function createManagers() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const sessionManager = SessionManager.create(WORKSPACE_DIR, SESSION_DIR);

  return { authStorage, modelRegistry, settingsManager, sessionManager };
}

function normalizeMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      if (
        "type" in part &&
        part.type === "thinking" &&
        "thinking" in part &&
        typeof part.thinking === "string"
      ) {
        return `[thinking:${part.thinking}]`;
      }
      if ("type" in part && part.type === "toolCall") {
        const toolName = "name" in part && typeof part.name === "string" ? part.name : "unknown";
        return `[toolCall:${toolName}]`;
      }
      return JSON.stringify(part);
    })
    .join("");
}

function normalizeEvent(event: AgentSessionEvent): NormalizedEvent {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
      return { type: event.type };
    case "turn_end":
      return {
        type: event.type,
        toolResults: event.toolResults.map((result) => ({ toolName: result.toolName, isError: result.isError })),
      };
    case "message_start":
    case "message_end":
      return { type: event.type, role: event.message.role, text: normalizeMessageText((event.message as { content?: unknown }).content) };
    case "message_update": {
      if (event.assistantMessageEvent.type === "text_delta") {
        return { type: event.type, updateType: "text_delta", delta: event.assistantMessageEvent.delta };
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return { type: event.type, updateType: "thinking_delta", delta: event.assistantMessageEvent.delta };
      }
      if (event.assistantMessageEvent.type === "toolcall_end") {
        return {
          type: event.type,
          updateType: "toolcall_end",
          toolName: event.assistantMessageEvent.toolCall.name,
          toolCallId: event.assistantMessageEvent.toolCall.id,
        };
      }
      return { type: event.type, updateType: event.assistantMessageEvent.type };
    }
    case "tool_execution_start":
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      };
    case "queue_update":
      return { type: event.type, steering: [...event.steering], followUp: [...event.followUp] };
    case "compaction_start":
      return { type: event.type, reason: event.reason };
    case "compaction_end":
      return { type: event.type, reason: event.reason, aborted: event.aborted, willRetry: event.willRetry };
    case "auto_retry_start":
      return { type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs };
    case "auto_retry_end":
      return { type: event.type, attempt: event.attempt, success: event.success };
  }
}

function sendJson(ws: WebSocket, envelope: StreamEnvelope): void {
  ws.send(JSON.stringify(envelope));
}

function broadcast(clients: Set<WebSocket>, envelope: StreamEnvelope): void {
  const payload = JSON.stringify(envelope);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function getHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pirouette streaming spike</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #111827; color: #f3f4f6; }
      textarea { width: 100%; min-height: 90px; margin-bottom: 12px; background: #1f2937; color: #f3f4f6; border: 1px solid #374151; padding: 12px; }
      button { background: #2563eb; color: white; border: 0; padding: 10px 14px; border-radius: 6px; cursor: pointer; }
      pre { white-space: pre-wrap; background: #030712; border: 1px solid #374151; padding: 12px; min-height: 360px; overflow: auto; }
      .row { margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <h1>Pirouette streaming spike</h1>
    <div class="row"><textarea id="prompt">${DEFAULT_PROMPT}</textarea></div>
    <div class="row"><button id="send">Send prompt</button></div>
    <pre id="log"></pre>
    <script>
      const log = document.getElementById('log');
      const promptEl = document.getElementById('prompt');
      const sendBtn = document.getElementById('send');
      function append(value) {
        log.textContent += value + "\\n";
        log.scrollTop = log.scrollHeight;
      }
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(protocol + '://' + location.host + '/ws');
      ws.onopen = () => append('[ws] connected');
      ws.onmessage = (message) => append(message.data);
      ws.onerror = () => append('[ws] error');
      ws.onclose = () => append('[ws] closed');
      sendBtn.onclick = async () => {
        append('[http] sending prompt');
        const response = await fetch('/prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: promptEl.value }),
        });
        append('[http] status ' + response.status + ' ' + await response.text());
      };
    </script>
  </body>
</html>`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function createSession() {
  const { authStorage, modelRegistry, settingsManager, sessionManager } = createManagers();
  const model = getModel("anthropic", "claude-haiku-4-5");
  if (!model) {
    throw new Error("Could not find anthropic/claude-haiku-4-5 model");
  }

  const result = await createAgentSession({
    cwd: WORKSPACE_DIR,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    model,
    thinkingLevel: "off",
  });

  return { ...result, sessionManager };
}

async function runServe(): Promise<void> {
  await ensureWorkspace();
  const { session } = await createSession();
  const clients = new Set<WebSocket>();

  session.subscribe((event) => {
    broadcast(clients, { kind: "session_event", event: normalizeEvent(event) });
  });

  let isPromptActive = false;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(getHtml());
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/prompt") {
        if (isPromptActive || session.isStreaming) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          res.end("agent is already processing a prompt");
          broadcast(clients, { kind: "prompt_rejected", reason: "agent is already processing a prompt" });
          return;
        }

        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody) as { prompt?: unknown };
        const prompt = typeof parsed.prompt === "string" && parsed.prompt.trim().length > 0 ? parsed.prompt : DEFAULT_PROMPT;

        isPromptActive = true;
        broadcast(clients, { kind: "prompt_accepted", prompt });
        void session
          .prompt(prompt)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            broadcast(clients, { kind: "server_error", message });
          })
          .finally(() => {
            isPromptActive = false;
          });

        res.writeHead(202, { "content-type": "text/plain; charset=utf-8" });
        res.end("prompt accepted");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
      broadcast(clients, { kind: "server_error", message });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    sendJson(ws, {
      kind: "server_ready",
      port: PORT,
      prompt: DEFAULT_PROMPT,
      sessionFile: session.sessionFile,
    });
    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, HOST, () => {
      console.log(`streaming spike server listening on http://${HOST}:${PORT}`);
      console.log(`open in browser: http://${HOST}:${PORT}`);
      console.log(`session file: ${session.sessionFile ?? "(none)"}`);
    });

    const shutdown = () => {
      void session.abort().catch(() => {});
      session.dispose();
      for (const client of clients) client.close();
      wss.close(() => {
        server.close(() => resolve());
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function runClient(): Promise<void> {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
  let promptSent = false;
  let text = "";
  let sawToolExecution = false;
  let sawPromptAccepted = false;
  let finished = false;
  let settled = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let hardTimeout: NodeJS.Timeout | undefined;
  const events: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      ws.close();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      ws.close();
      resolve();
    };

    const maybeFinish = () => {
      if (!finished) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const trimmed = text.trim();
        console.log(`final streamed text: ${trimmed}`);
        console.log(`saw tool execution: ${sawToolExecution}`);
        console.log(`event types: ${events.join(", ")}`);
        if (trimmed !== STREAM_TOKEN) {
          fail(new Error(`Expected final streamed text to equal ${STREAM_TOKEN}, got ${trimmed}`));
          return;
        }
        if (!sawToolExecution) {
          fail(new Error("Expected to observe at least one tool execution event"));
          return;
        }
        succeed();
      }, 2500);
    };

    hardTimeout = setTimeout(() => {
      fail(new Error("Timed out waiting for streamed agent events"));
    }, 90000);

    ws.on("message", async (raw: RawData) => {
      const envelope = JSON.parse(String(raw)) as StreamEnvelope;
      if (envelope.kind === "server_ready" && !promptSent) {
        promptSent = true;
        console.log(`connected to streaming server on port ${envelope.port}`);
        console.log(`session file: ${envelope.sessionFile ?? "(none)"}`);
        const response = await fetch(`http://${HOST}:${PORT}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: DEFAULT_PROMPT }),
        });
        console.log(`prompt response: ${response.status} ${await response.text()}`);
        return;
      }

      if (envelope.kind === "prompt_accepted") {
        sawPromptAccepted = true;
        finished = false;
        text = "";
        if (idleTimer) clearTimeout(idleTimer);
        return;
      }

      if (envelope.kind === "session_event") {
        events.push(envelope.event.type);
        console.log(JSON.stringify(envelope));
        if (envelope.event.type === "tool_execution_start") {
          sawToolExecution = true;
        }
        if (envelope.event.type === "message_update" && envelope.event.updateType === "text_delta") {
          text += String(envelope.event.delta ?? "");
        }
        if (envelope.event.type === "agent_end" && sawPromptAccepted) {
          finished = true;
          maybeFinish();
          return;
        }
        if (finished) {
          maybeFinish();
        }
      }
    });

    ws.on("error", (error: Error) => fail(error));
    ws.on("close", () => {
      if (!settled) {
        fail(new Error("WebSocket closed before streaming validation completed"));
      }
    });
  });
}

async function runReset(): Promise<void> {
  await rm(SPIKE_ROOT, { recursive: true, force: true });
  console.log(`removed ${SPIKE_ROOT}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    console.error("Usage: tsx src/spikes/event-streaming.ts <serve|client|reset>");
    process.exitCode = 1;
    return;
  }

  if (command === "serve") await runServe();
  if (command === "client") await runClient();
  if (command === "reset") await runReset();
}

await main();
