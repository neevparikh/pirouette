#!/usr/bin/env node
/** pru — Pirouette CLI for managing cloud pi agents. */

import { readFileSync } from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

// Reuse compiled bytecode across runs (Node >= 22.1; a no-op elsewhere).
// Covers everything loaded below via dynamic import — notably the server's
// large dependency tree, which shortens restarts.
(nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
/* Command modules are loaded lazily: only the one being run gets imported.
 * Importing them all up front pulled in the whole server (pi-coding-agent and
 * its dependency tree) for every invocation, which made even `pru list` take
 * ~0.7s of module loading before it sent a single request. */
type Action = (...args: unknown[]) => Promise<void>;
function lazy<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string): Action {
  return async (...args: unknown[]) => {
    await (((await load())[name]) as (...a: unknown[]) => unknown)(...args);
  };
}

const launch = lazy(() => import("./commands/launch.js"), "launch");
const list = lazy(() => import("./commands/list.js"), "list");
const status = lazy(() => import("./commands/status.js"), "status");
const open = lazy(() => import("./commands/open.js"), "open");
const ssh = lazy(() => import("./commands/ssh.js"), "ssh");
const send = lazy(() => import("./commands/send.js"), "send");
const stop = lazy(() => import("./commands/stop.js"), "stop");
const interrupt = lazy(() => import("./commands/interrupt.js"), "interrupt");
const notify = lazy(() => import("./commands/notify.js"), "notify");
const watchCmd = lazy(() => import("./commands/watch.js"), "watchCmd");
const watchList = lazy(() => import("./commands/watch.js"), "watchList");
const watchPr = lazy(() => import("./commands/watch.js"), "watchPr");
const watchRm = lazy(() => import("./commands/watch.js"), "watchRm");
const watchTimer = lazy(() => import("./commands/watch.js"), "watchTimer");
const watchUntil = lazy(() => import("./commands/watch.js"), "watchUntil");
const handoff = lazy(() => import("./commands/handoff.js"), "handoff");
const compact = lazy(() => import("./commands/compact.js"), "compact");
const archive = lazy(() => import("./commands/archive.js"), "archive");
const unarchive = lazy(() => import("./commands/archive.js"), "unarchive");
const rename = lazy(() => import("./commands/rename.js"), "rename");
const rm = lazy(() => import("./commands/rm.js"), "rm");
const server = lazy(() => import("./commands/server.js"), "server");
const configShow = lazy(() => import("./commands/config.js"), "configShow");
const configPath = lazy(() => import("./commands/config.js"), "configPath");
const configEdit = lazy(() => import("./commands/config.js"), "configEdit");
const projectAdd = lazy(() => import("./commands/project.js"), "projectAdd");
const projectList = lazy(() => import("./commands/project.js"), "projectList");
const projectRm = lazy(() => import("./commands/project.js"), "projectRm");
const setup = lazy(() => import("./commands/setup.js"), "setup");
const teardown = lazy(() => import("./commands/teardown.js"), "teardown");
const destroy = lazy(() => import("./commands/destroy.js"), "destroy");
const logs = lazy(() => import("./commands/logs.js"), "logs");
const sync = lazy(() => import("./commands/sync.js"), "sync");
const selfUpdate = lazy(() => import("./commands/self-update.js"), "selfUpdate");
const tunnel = lazy(() => import("./commands/tunnel.js"), "tunnel");

/** Read pirouette's version straight from package.json so the CLI's
 *  `--version` output never drifts from the published package version.
 *  Resolves the same way regardless of run mode:
 *    - dev    (src/cli/index.ts via tsx)  → repo root via ../../package.json
 *    - built  (dist/cli/index.js)         → repo root via ../../package.json
 *  In both layouts, package.json is two directories up. */
function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("pru")
  .description("Pirouette — manage pi agents on your own hosts")
  .version(readVersion())
  // Global --host option. Selects which [hosts.<name>] block in
  // ~/.pirouette/config.toml a command targets. Falls back to
  // `default_host`, or the sole host if exactly one is defined.
  //
  // Set as a preAction hook -- runs before any subcommand handler
  // resolves a host. Hoisted into $PIROUETTE_SELECTED_HOST (rather than
  // threaded through every code path) because config-loading is a
  // module-singleton and re-plumbing it for an injected name would be
  // invasive. Read by selectHostName() in config.ts.
  .option("-H, --host <name>", "Target host from config (default: default_host / sole host)")
  .hook("preAction", (thisCommand) => {
    const host = thisCommand.opts().host as string | undefined;
    if (host) process.env.PIROUETTE_SELECTED_HOST = host;
  });

program
  .command("server")
  .description("Start the pirouette server in-process (used by the host bootstrap and for local dev)")
  .option("-p, --port <port>", "Port to listen on (default: $PIROUETTE_PORT or 7777)")
  .option("-d, --data-dir <dir>", "Data directory (default: $PIROUETTE_DATA_DIR or .pirouette/data)")
  .action(server);

program
  .command("launch <name>")
  .description("Launch a new pi agent in a project (defaults to `scratchpad`)")
  .option("-p, --project <name>", "Project this agent belongs to (default: scratchpad)")
  .option(
    "-m, --model <model>",
    "Model as <provider>/<id>, from a provider this host is logged into " +
      "(omit to use the host's default model)",
  )
  .option("-t, --thinking <level>", "Thinking level (off, minimal, low, medium, high)", "off")
  .action(launch);

program
  .command("list")
  .alias("ls")
  .description("List all agents, grouped by project")
  .option("-p, --project <name>", "Only list agents in this project")
  .option("-a, --archived", "Include archived agents (hidden by default)")
  .action(list);

program
  .command("status")
  .description("Show server and agent status")
  .action(status);

program
  .command("send <agent> [message]")
  .description(
    "Send a message to an agent. From inside an agent it is sent as that agent " +
      "(labelled with the sender, with a reply hint); from a human shell, as the user.",
  )
  .option("-f, --message-file <path>", "Read the message from a file")
  .option("--follow-up", "If the agent is mid-turn, queue until the turn ends instead of steering")
  .option("--as-user", "Send as the user even from inside an agent")
  .option(
    "--attach <path>",
    "Upload a file to the server host and reference it in the message (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(send);

program
  .command("notify [message]")
  .description(
    "Raise a desktop notification in open dashboards (where the notify toggle is on). " +
      "Attributed to the agent running the command unless --agent is given.",
  )
  .option("-a, --agent <agent>", "Agent the notification is about (default: the agent running the command)")
  .option("-t, --title <title>", "Notification title (default: the agent's name)")
  .option("-u, --url <url>", "Open this http(s) URL when the notification is clicked")
  .option("-f, --message-file <path>", "Read the message from a file")
  .action(notify);

const watchCmdGroup = program
  .command("watch")
  .description(
    "Wake an agent with a message when something happens: a PR's checks or reviews, " +
      "a background command exiting, a condition becoming true, or a timer. " +
      "From inside an agent it wakes that agent.",
  );

/** Options every `pru watch <kind>` takes. */
function withWatchOptions(cmd: Command, timeoutHelp: string | null): Command {
  cmd
    .option("-a, --agent <agent>", "Agent to wake (default: the agent running the command)")
    .option("-n, --note <text>", "Reminder included in the wake-up message (what to do next)")
    .option("--steer", "If the agent is mid-turn, deliver after its current step instead of after the turn");
  if (timeoutHelp) cmd.option("-t, --timeout <duration>", timeoutHelp);
  return cmd;
}

withWatchOptions(
  watchCmdGroup
    .command("pr <pr>")
    .description(
      "Watch a GitHub PR (number or URL): fires when its checks have all passed or one fails, " +
        "a new review or comment arrives, it's merged or closed, or it gets a merge conflict",
    )
    .option("-R, --repo <owner/name>", "Repository (default: the one in the current directory)")
    .option("--on <events>", "Comma-separated subset of checks,reviews,merged,conflict (default: all)")
    .option("-e, --every <duration>", "How often to check (default 60s)"),
  "Give up after this long (default 24h)",
).action(watchPr);

withWatchOptions(
  watchCmdGroup
    .command("cmd <command...>")
    .description(
      "Run a shell command in the background (in the current directory); fires when it exits, " +
        "with the exit code and the end of its output. Quote the command.",
    ),
  "Kill the command and fire if it runs longer than this (default: no limit)",
).action(watchCmd);

withWatchOptions(
  watchCmdGroup
    .command("until <command...>")
    .description(
      "Re-run a shell command (in the current directory) until it exits 0, then fire with its output. " +
        "Quote the command.",
    )
    .option("-e, --every <duration>", "How often to run it (default 60s)"),
  "Give up after this long (default 24h)",
).action(watchUntil);

withWatchOptions(
  watchCmdGroup.command("timer <duration>").description("Fire after a delay, e.g. 30m, 2h, 1d"),
  null,
).action(watchTimer);

watchCmdGroup
  .command("ls")
  .alias("list")
  .description("List pending watches (yours, from inside an agent; otherwise all)")
  .option("-a, --agent <agent>", "Only this agent's watches")
  .option("--all", "Every agent's watches, even from inside an agent")
  .action(watchList);

watchCmdGroup
  .command("rm <ids...>")
  .description("Cancel watches (kills a running `watch cmd`)")
  .action(watchRm);

program
  .command("interrupt <agent>")
  .alias("esc")
  .description("Cancel an agent's current turn (session stays alive) — same as Escape in the dashboard")
  .action(interrupt);

program
  .command("handoff [agent]")
  .description(
    "Hand an agent's work to a fresh agent in the same worktree (archives the old one). " +
      "Defaults to the agent running the command.",
  )
  .option("-n, --name <name>", "Name for the successor (default: <agent>-2, -3, ...)")
  .option("-m, --message <text>", "Briefing sent to the successor as its first message")
  .option("-f, --message-file <path>", "Read the briefing from a file")
  .action(handoff);

program
  .command("compact [agent]")
  .description(
    "Compact an agent's context in place (summarise the conversation). Waits for the " +
      "current turn to end, so an agent can compact itself. Defaults to the agent running the command.",
  )
  .option("-i, --instructions <text>", "What the summary should keep or focus on")
  .option("-f, --instructions-file <path>", "Read the summary instructions from a file")
  .option("-m, --message <text>", "Message sent as a new turn after compacting (self default: 'continue')")
  .option("--no-continue", "Don't send any message after compacting")
  .option("--now", "Compact immediately, aborting the agent's current turn (not for self)")
  .action(compact);

program
  .command("archive [agent]")
  .description(
    "Archive a chat: hide it from the dashboard's chat list, keeping the agent, " +
      "its worktree and its transcript. Defaults to the agent running the command.",
  )
  .option("-s, --stop", "Also stop the agent (archiving alone leaves it running)")
  .action(archive);

program
  .command("unarchive [agent]")
  .description("Bring an archived chat back into the dashboard's chat list")
  .action(unarchive);

program
  .command("rename <agent> [new-name]")
  .description(
    "Rename a chat (display name only — worktree, branch and sessions are untouched). " +
      "With one argument, renames the agent running the command.",
  )
  .action(rename);

program
  .command("stop <agent>")
  .description("Stop an agent")
  .action(stop);

program
  .command("rm <agent>")
  .alias("remove")
  .description("Remove an agent (stops it and deletes its state)")
  .option("--worktree", "Also delete the agent's worktree directory on disk")
  .option("--sessions", "Also delete the agent's session files on disk")
  .option("--all", "Delete everything (worktree + sessions)")
  .action(rm);

program
  .command("open")
  .description("Open the web dashboard in your browser")
  .action(open);

program
  .command("tunnel <port>")
  .description("Forward laptop:PORT ↔ host:PORT (or LOCAL:REMOTE). For OAuth loopback flows.")
  .option("-d, --background", "Add the forward and return immediately (close with --close)")
  .option("--close", "Remove a previously-added forward")
  .action(async (port: string, opts: { background?: boolean; close?: boolean }) => {
    await tunnel(port, opts);
  });

program
  .command("ssh")
  .description("Shell into the selected host (the SSH alias from config)")
  .action(ssh);

const projectCmd = program
  .command("project")
  .description("Manage projects (workspaces that group agents)");

projectCmd
  .command("list")
  .alias("ls")
  .description("List all projects")
  .action(projectList);

projectCmd
  .command("add <name>")
  .description("Create a new project (optionally cloning a repo)")
  .option("-r, --repo <url>", "Clone this git repo into the project")
  .action(projectAdd);

projectCmd
  .command("rm <name>")
  .alias("remove")
  .description("Remove a project")
  .option("--delete-repo", "Also rm -rf the project's repo + worktrees on disk")
  .option("-f, --force", "Remove even if the project has agents (orphans them)")
  .action(projectRm);

const configCmd = program
  .command("config")
  .description("Manage pirouette configuration");

configCmd
  .command("show")
  .description("Show effective merged configuration")
  .action(configShow);

configCmd
  .command("path")
  .description("List config file search paths")
  .action(configPath);

configCmd
  .command("edit")
  .description("Open ~/.pirouette/config.toml in $EDITOR")
  .action(configEdit);

program
  .command("setup")
  .description("Set up / refresh the selected host (bootstrap + start the server)")
  .action(setup);

program
  .command("teardown")
  .description("Stop the pirouette server on the host (stops the systemd service; state preserved)")
  .action(teardown);

program
  .command("destroy")
  .description("Clear pirouette's local state for the host. --delete-data also nukes the host's persistent dirs.")
  .option("--delete-data", "Also rm -rf the host's persistent data + home dirs (destructive)")
  .option("-y, --yes", "Skip interactive confirmation")
  .action(destroy);

program
  .command("logs")
  .description("Tail pirouette server logs from the host (default: server log)")
  .option("-f, --follow", "Stream continuously (like tail -f)")
  .option("-n, --lines <n>", "Number of lines to show", "200")
  .option("--journal", "Show the systemd journal (journalctl -u pirouette) instead of the log file")
  // Deprecated alias for --journal (the server no longer runs in tmux).
  .option("--tmux", "Deprecated alias for --journal", false)
  .option("--entrypoint", "Show the host bootstrap log")
  .action(logs);

program
  .command("self-update")
  .description(
    "Update THIS pirouette instance from the inside (safe for agents). " +
      "Runs the npm install + service restart in a detached systemd unit so " +
      "the restart doesn't kill the command that triggered it.",
  )
  .option("--package <spec>", "npm spec to install, or a git spec (github:owner/repo[#ref], git+https://...) to build from source")
  .option("--target <version>", "Version or dist-tag to install (npm mode; default: latest)")
  .option("--from-git [ref]", "Build + install from a git clone of this repo at [ref] (default branch if omitted)")
  .option("--ref <ref>", "Git ref (branch/tag/sha) to build (git mode)")
  .option("--service <name>", "systemd service to restart (default: pirouette)")
  .option("--unit <name>", "Transient systemd unit name for the worker (default: pirouette-self-update)")
  .option("--settle <seconds>", "Seconds the worker waits before starting (default: 2)")
  .option("--foreground", "Run the updater in this process (debug only; the restart will kill it)")
  .option(
    "--force",
    "Install even if the resolved version is the same as, or older than, what's running",
  )
  .action(selfUpdate);

program
  .command("sync")
  .description("Ship local changes to the host (dev loop)")
  .option("--npm", "Upgrade from npm registry instead of rebuilding locally")
  .option(
    "--secrets",
    "Re-push laptop-local auth state (auth.json, AWS caches, ...) without a redeploy",
  )
  .action(sync);

await program.parseAsync();
