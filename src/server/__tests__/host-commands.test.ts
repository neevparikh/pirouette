import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEOUT_SECONDS,
  HostCommandRunner,
  hostCommandId,
  resolveHostCommands,
  type HostCommandStatus,
} from "../host-commands.js";

async function waitFor(
  runner: HostCommandRunner,
  id: string,
  done: (s: HostCommandStatus) => boolean = (s) => s.state === "exited",
): Promise<HostCommandStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = runner.get(id)!;
    if (done(status)) return status;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last status: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function runnerFor(commands: Array<Record<string, unknown>>, opts = {}): HostCommandRunner {
  return new HostCommandRunner(resolveHostCommands(commands).commands, { cwd: tmpdir(), ...opts });
}

describe("resolveHostCommands", () => {
  it("accepts nothing configured", () => {
    expect(resolveHostCommands(undefined)).toEqual({ commands: [], warnings: [] });
  });

  it("resolves entries and derives ids", () => {
    const { commands, warnings } = resolveHostCommands([
      { name: "Provider Login", command: " cli login ", description: "renew", timeout_seconds: 30 },
      { name: "sync", command: "true" },
    ]);
    expect(warnings).toEqual([]);
    expect(commands).toEqual([
      { id: "provider-login", name: "Provider Login", command: "cli login", description: "renew", timeoutMs: 30_000 },
      { id: "sync", name: "sync", command: "true", description: "", timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000 },
    ]);
    expect(hostCommandId("  A  b/c! ")).toBe("a-b-c");
  });

  it("skips bad entries with a warning", () => {
    const { commands, warnings } = resolveHostCommands([
      { name: "ok", command: "true" },
      { name: "no command" },
      { name: "OK", command: "false" },
      { name: "!!!", command: "true" },
      "nope",
      { name: "slow", command: "true", timeout_seconds: -1 },
    ]);
    expect(commands.map((c) => c.id)).toEqual(["ok", "slow"]);
    expect(commands[1].timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000);
    expect(warnings).toHaveLength(5);
    expect(resolveHostCommands({ name: "x" }).warnings).toHaveLength(1);
  });
});

describe("HostCommandRunner", () => {
  let runner: HostCommandRunner | undefined;
  afterEach(() => runner?.stopAll());

  it("runs a command and captures stdout, stderr and the exit code", async () => {
    runner = runnerFor([{ name: "hello", command: "echo out; echo err >&2; exit 3" }]);
    expect(runner.list()).toMatchObject([{ id: "hello", state: "idle" }]);
    expect(runner.list()[0].output).toBeUndefined();
    expect(runner.start("hello")).toMatchObject({ state: "running" });
    const status = await waitFor(runner, "hello");
    expect(status).toMatchObject({ exitCode: 3, timedOut: false, stopped: false });
    expect(status.output).toContain("out\n");
    expect(status.output).toContain("err\n");
  });

  it("tells the command it was started from the dashboard and prints browser URLs", async () => {
    runner = runnerFor([{ name: "env", command: 'echo "$PIROUETTE_HOST_COMMAND"; $BROWSER https://example.com/x' }], {
      env: { PATH: process.env.PATH },
    });
    runner.start("env");
    expect((await waitFor(runner, "env")).output).toBe("env\nhttps://example.com/x\n");
  });

  it("refuses unknown commands and a second concurrent run", async () => {
    runner = runnerFor([{ name: "sleep", command: "sleep 30" }]);
    expect(runner.start("nope")).toBe("unknown");
    expect(runner.get("nope")).toBeUndefined();
    runner.start("sleep");
    expect(runner.start("sleep")).toBe("running");
  });

  it("stops a running command and what it started", async () => {
    runner = runnerFor([{ name: "sleep", command: "echo started; sleep 30 & wait" }]);
    expect(runner.stop("sleep")).toBe(false);
    runner.start("sleep");
    await waitFor(runner, "sleep", (s) => s.output === "started\n");
    expect(runner.stop("sleep")).toBe(true);
    expect(await waitFor(runner, "sleep")).toMatchObject({ stopped: true, timedOut: false });
    expect(runner.start("sleep")).toMatchObject({ state: "running", output: "" });
  });

  it("ends a command at its timeout", async () => {
    runner = runnerFor([{ name: "slow", command: "sleep 30", timeout_seconds: 0.1 }]);
    runner.start("slow");
    const status = await waitFor(runner, "slow");
    expect(status).toMatchObject({ timedOut: true, stopped: false });
    expect(status.output).toContain("timed out");
  });

  it("keeps only the end of long output", async () => {
    runner = runnerFor([{ name: "noisy", command: "seq 1 2000" }], { maxOutputChars: 100 });
    runner.start("noisy");
    const status = await waitFor(runner, "noisy");
    expect(status.outputTruncated).toBe(true);
    expect(status.output!.length).toBe(100);
    expect(status.output!.endsWith("1999\n2000\n")).toBe(true);
  });
});

describe("host command API", () => {
  let handle: { shutdown: () => Promise<void> };
  let port: number;
  let dataDir: string;
  let home: string;
  const savedHome = process.env.HOME;

  function call(
    method: string,
    urlPath: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
      });
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  }
  const JSON_TYPE = { "content-type": "application/json" };

  beforeAll(async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const net = await import("node:net");
    port = await new Promise<number>((resolve) => {
      const srv = net.createServer().listen(0, () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    dataDir = mkdtempSync(path.join(tmpdir(), "pirouette-hostcmd-data-"));
    home = mkdtempSync(path.join(tmpdir(), "pirouette-hostcmd-home-"));
    mkdirSync(path.join(home, ".pirouette"));
    writeFileSync(
      path.join(home, ".pirouette", "config.toml"),
      '[[defaults.host_commands]]\nname = "Say Hi"\ncommand = "echo hi"\ndescription = "greets"\n',
    );
    process.env.HOME = home;
    const { resetConfigCache } = await import("../../config.js");
    resetConfigCache();
    const { runServer } = await import("../index.js");
    handle = await runServer({ port, dataDir, webDir: dataDir });
  });

  afterAll(async () => {
    await handle?.shutdown();
    process.env.HOME = savedHome;
    const { resetConfigCache } = await import("../../config.js");
    resetConfigCache();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("lists, runs and reports configured commands", async () => {
    const list = await call("GET", "/api/host-commands");
    expect(list.status).toBe(200);
    expect(list.body.commands).toMatchObject([
      { id: "say-hi", name: "Say Hi", command: "echo hi", description: "greets", state: "idle" },
    ]);

    const run = await call("POST", "/api/host-commands/say-hi/run", JSON_TYPE);
    expect(run.status).toBe(202);
    let status = run.body.command;
    for (let i = 0; i < 200 && status.state !== "exited"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await call("GET", "/api/host-commands/say-hi")).body.command;
    }
    expect(status).toMatchObject({ state: "exited", exitCode: 0, output: "hi\n" });
  });

  it("rejects unknown commands and requests a cross-origin form could send", async () => {
    expect((await call("GET", "/api/host-commands/nope")).status).toBe(404);
    expect((await call("POST", "/api/host-commands/nope/run", JSON_TYPE)).status).toBe(404);
    expect((await call("POST", "/api/host-commands/nope/stop", JSON_TYPE)).status).toBe(404);
    expect((await call("POST", "/api/host-commands/say-hi/run")).status).toBe(415);
    expect((await call("POST", "/api/host-commands/say-hi/run", { "content-type": "text/plain" })).status).toBe(415);
    const stop = await call("POST", "/api/host-commands/say-hi/stop", JSON_TYPE);
    expect(stop.status).toBe(200);
    expect(stop.body.stopped).toBe(false);
  });
});
