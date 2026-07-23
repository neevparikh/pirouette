#!/usr/bin/env node
/** pru — Pirouette CLI for managing cloud pi agents. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { launch } from "./commands/launch.js";
import { list } from "./commands/list.js";
import { status } from "./commands/status.js";
import { open } from "./commands/open.js";
import { ssh } from "./commands/ssh.js";
import { send } from "./commands/send.js";
import { stop } from "./commands/stop.js";
import { rm } from "./commands/rm.js";
import { server } from "./commands/server.js";
import { configShow, configPath, configEdit } from "./commands/config.js";
import { projectAdd, projectList, projectRm } from "./commands/project.js";
import { setup } from "./commands/setup.js";
import { teardown } from "./commands/teardown.js";
import { destroy } from "./commands/destroy.js";
import { logs } from "./commands/logs.js";
import { sync } from "./commands/sync.js";
import { selfUpdate } from "./commands/self-update.js";
import { tunnel } from "./commands/tunnel.js";

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
  .option("-m, --model <model>", "Model to use (e.g. anthropic/claude-sonnet-4-20250514)")
  .option("-t, --thinking <level>", "Thinking level (off, minimal, low, medium, high)", "off")
  .action(launch);

program
  .command("list")
  .alias("ls")
  .description("List all agents, grouped by project")
  .option("-p, --project <name>", "Only list agents in this project")
  .action(list);

program
  .command("status")
  .description("Show server and agent status")
  .action(status);

program
  .command("send <agent> <message>")
  .description("Send a message to an agent")
  .action(send);

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

program.parse();
