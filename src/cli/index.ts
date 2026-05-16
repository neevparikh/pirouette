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
import { preflight } from "./commands/preflight.js";
import { setup } from "./commands/setup.js";
import { teardown } from "./commands/teardown.js";
import { destroy } from "./commands/destroy.js";
import { logs } from "./commands/logs.js";
import { sync } from "./commands/sync.js";
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
  .description("Pirouette — manage cloud pi agents")
  .version(readVersion())
  // Global --config option. Lets users keep one TOML per deployment
  // (e.g. ~/.pirouette/ec2.toml + ~/.pirouette/gpu.toml) and switch
  // between them per-invocation. State file is automatically derived
  // to sit alongside the config: ec2.toml -> ec2.host.json, etc., so
  // each deployment's state stays separate.
  //
  // Resolution precedence:
  //   --config <path>           (this flag)
  //   $PIROUETTE_CONFIG         (env var)
  //   ~/.pirouette/config.toml  (historical default)
  //
  // Set as a preAction hook -- runs before any subcommand handler reads
  // getConfig(). Hoisted into the env var (rather than threaded through
  // every code path) because config-loading is module-singleton and
  // re-plumbing the cache for an injected path would be invasive.
  .option(
    "-c, --config <path>",
    "Path to pirouette config TOML (default: $PIROUETTE_CONFIG or ~/.pirouette/config.toml)",
  )
  .hook("preAction", (thisCommand) => {
    const cfg = thisCommand.opts().config as string | undefined;
    if (cfg) process.env.PIROUETTE_CONFIG = cfg;
  });

program
  .command("server")
  .description("Start the pirouette server in-process (used by the container entrypoint and for local dev)")
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
  .description("Forward laptop:PORT ↔ container:PORT (or LOCAL:REMOTE). For OAuth loopback flows.")
  .option("-d, --background", "Add the forward and return immediately (close with --close)")
  .option("--close", "Remove a previously-added forward")
  .action(async (port: string, opts: { background?: boolean; close?: boolean }) => {
    await tunnel(port, opts);
  });

program
  .command("ssh")
  .description("Shell into the pirouette host (agent-forwarded). EC2: lands in container; --host for the EC2 host. byo-host: lands on the configured SSH alias.")
  .option("--host", "EC2 only: SSH into the host instead of the container")
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
  .command("preflight")
  .description("Check AWS config + resources are reachable (safe, read-only)")
  .action(preflight);

program
  .command("setup")
  .description("Provision / resume the pirouette host (EC2 or byo-host, per provider.kind)")
  .action(setup);

program
  .command("teardown")
  .description("Stop the host. EC2: stops the instance (EBS preserved). byo-host: kills the tmux session.")
  .action(teardown);

program
  .command("destroy")
  .description("Destroy the host. EC2: terminates the instance. byo-host: clears local state. --delete-volume nukes the persistent volume on both.")
  .option("--delete-volume", "Also delete the persistent EBS data volume (destructive)")
  .option("-y, --yes", "Skip interactive confirmation")
  .action(destroy);

program
  .command("logs")
  .description("Tail server logs from the container (default: server log)")
  .option("-f, --follow", "Stream continuously (like tail -f)")
  .option("-n, --lines <n>", "Number of lines to show", "200")
  .option("--tmux", "Show the current pirouette tmux pane")
  .option("--entrypoint", "Show the container entrypoint startup log")
  .option("--boot", "EC2 only: show cloud-init output (host-level bootstrap)")
  .action(logs);

program
  .command("sync")
  .description("Ship local changes to the remote container (dev loop)")
  .option("--npm", "Upgrade from npm registry instead of rebuilding locally")
  .option(
    "--secrets",
    "Re-push laptop-local auth state (auth.json, hawk token cache) into the container without a redeploy",
  )
  .action(sync);

program.parse();
