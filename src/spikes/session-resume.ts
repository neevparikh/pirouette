import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const ROOT_DIR = process.cwd();
const SPIKE_ROOT = path.join(ROOT_DIR, ".pirouette", "spikes", "session-resume");
const WORKSPACE_DIR = path.join(SPIKE_ROOT, "workspace");
const SESSION_DIR = path.join(SPIKE_ROOT, "sessions");
const NOTES_PATH = path.join(WORKSPACE_DIR, "notes.txt");
const REMEMBER_TOKEN = "pirouette-session-spike-token";

type Command = "new" | "resume" | "inspect" | "reset";

function isCommand(value: string | undefined): value is Command {
  return value === "new" || value === "resume" || value === "inspect" || value === "reset";
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

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
        const name = "name" in part && typeof part.name === "string" ? part.name : "unknown";
        return `[toolCall:${name}]`;
      }
      return JSON.stringify(part);
    })
    .join("");
}

async function ensureWorkspace(): Promise<void> {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(SESSION_DIR, { recursive: true });

  await writeFile(
    NOTES_PATH,
    [
      "Pirouette session resume spike workspace.",
      "",
      `Remember token: ${REMEMBER_TOKEN}`,
      "This file exists only to give the agent a stable cwd for the session spike.",
    ].join("\n"),
  );
}

function createManagers(mode: "new" | "resume") {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const sessionManager =
    mode === "new"
      ? SessionManager.create(WORKSPACE_DIR, SESSION_DIR)
      : SessionManager.continueRecent(WORKSPACE_DIR, SESSION_DIR);

  return { authStorage, modelRegistry, settingsManager, sessionManager };
}

function summarizeMessage(message: { role: string } & Record<string, unknown>): string {
  if ("content" in message) {
    return stringifyContent(message.content).slice(0, 140);
  }
  if (message.role === "branchSummary" && "summary" in message) {
    return String(message.summary).slice(0, 140);
  }
  if (message.role === "compactionSummary" && "summary" in message) {
    return String(message.summary).slice(0, 140);
  }
  if (message.role === "bashExecution" && "output" in message) {
    return String(message.output).slice(0, 140);
  }
  return "(no text content)";
}

function printSessionSnapshot(sessionManager: SessionManager): void {
  const entries = sessionManager.getEntries();
  const messageEntries = entries.filter((entry) => entry.type === "message");

  console.log(`session file: ${sessionManager.getSessionFile() ?? "(in-memory)"}`);
  console.log(`entries on disk: ${entries.length}`);
  console.log(`messages in context: ${messageEntries.length}`);

  const recent = messageEntries.slice(-4);
  if (recent.length === 0) {
    console.log("recent messages: none");
    return;
  }

  console.log("recent messages:");
  for (const entry of recent) {
    if (!("message" in entry)) continue;
    const role = entry.message.role;
    const content = summarizeMessage(entry.message as unknown as { role: string } & Record<string, unknown>);
    console.log(`- ${role}: ${content}`);
  }
}

async function createSession(mode: "new" | "resume") {
  const { authStorage, modelRegistry, settingsManager, sessionManager } = createManagers(mode);

  const result = await createAgentSession({
    cwd: WORKSPACE_DIR,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    thinkingLevel: "off",
  });

  return { ...result, sessionManager };
}

async function runNew(): Promise<void> {
  await ensureWorkspace();

  const { session, sessionManager, modelFallbackMessage } = await createSession("new");
  console.log("created new persistent session");
  if (modelFallbackMessage) console.log(`model note: ${modelFallbackMessage}`);
  printSessionSnapshot(sessionManager);

  let sawOutput = false;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!sawOutput) {
        sawOutput = true;
        process.stdout.write("\nassistant> ");
      }
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt(
    [
      "This is a persistence-and-resume spike for Pirouette.",
      `Remember this exact token for the rest of the conversation: ${REMEMBER_TOKEN}`,
      "Reply in one short sentence that includes the token and the word ACK.",
      "Do not use any tools.",
    ].join("\n"),
  );

  if (sawOutput) process.stdout.write("\n");

  console.log("\nafter first prompt:");
  printSessionSnapshot(sessionManager);
  console.log("\nnext step: run `npm run spike:session:resume`");

  session.dispose();
}

async function runResume(): Promise<void> {
  await ensureWorkspace();

  const sessions = await SessionManager.list(WORKSPACE_DIR, SESSION_DIR);
  if (sessions.length === 0) {
    throw new Error("No saved session found. Run `npm run spike:session:new` first.");
  }

  const { session, sessionManager, modelFallbackMessage } = await createSession("resume");
  console.log("resumed most recent persistent session");
  if (modelFallbackMessage) console.log(`model note: ${modelFallbackMessage}`);

  console.log("\nbefore sending follow-up:");
  printSessionSnapshot(sessionManager);

  let sawOutput = false;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (!sawOutput) {
        sawOutput = true;
        process.stdout.write("\nassistant> ");
      }
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt(
    [
      "We just resumed an earlier session from disk.",
      "What exact token did I ask you to remember earlier?",
      "Reply with exactly the token and nothing else.",
      "Do not use any tools.",
    ].join("\n"),
  );

  if (sawOutput) process.stdout.write("\n");

  console.log("\nafter resume prompt:");
  printSessionSnapshot(sessionManager);
  console.log(`\nexpected token: ${REMEMBER_TOKEN}`);

  session.dispose();
}

async function runInspect(): Promise<void> {
  await ensureWorkspace();

  const sessions = await SessionManager.list(WORKSPACE_DIR, SESSION_DIR);
  console.log(`found ${sessions.length} session(s)`);
  for (const info of sessions) {
    console.log(`- ${info.path}`);
    console.log(`  first message: ${info.firstMessage}`);
    console.log(`  messages: ${info.messageCount}`);
    console.log(`  last updated: ${info.modified.toISOString()}`);
  }

  if (sessions.length === 0) return;

  const latest = sessions[0];
  const raw = await readFile(latest.path, "utf8");
  const lines = raw.trim().split("\n");
  console.log(`\nlatest session raw jsonl lines: ${lines.length}`);
  for (const line of lines.slice(-5)) {
    console.log(line);
  }
}

async function runReset(): Promise<void> {
  await rm(SPIKE_ROOT, { recursive: true, force: true });
  console.log(`removed ${SPIKE_ROOT}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    console.error("Usage: tsx src/spikes/session-resume.ts <new|resume|inspect|reset>");
    process.exitCode = 1;
    return;
  }

  try {
    if (command === "new") await runNew();
    if (command === "resume") await runResume();
    if (command === "inspect") await runInspect();
    if (command === "reset") await runReset();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
