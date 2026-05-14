/** EC2Provider — the AWS+Docker host model that pirouette has always used.
 *
 *  Behaviour:
 *    - `provision()` is the existing `pru setup` flow (discover VPC/subnet/SG,
 *      find-or-create the data EBS, launch the instance, attach the volume,
 *      bootstrap docker via cloud-init, start the container, push secrets,
 *      wait for `/api/health`). Idempotent — re-running on a state file that
 *      already names a running instance returns immediately after refreshing
 *      SSH config.
 *    - `stop()` is `pru teardown` — stops the instance, preserves the EBS.
 *    - `destroy()` is `pru destroy` — terminates the instance and optionally
 *      deletes the data volume.
 *    - `status()` is the AWS-side of `pru status`.
 *    - `buildLogsCommand()` produces the docker-exec-wrapped command for
 *      `pru logs`.
 *
 *  This file moves the helpers that used to live in setup.ts (build user-data,
 *  wait for cloud-init, bootstrap the container) into provider scope so
 *  setup.ts can shrink to a dispatcher.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  containerHome,
  expandHome,
  getConfig,
  requireConfigured,
  type PirouetteConfig,
} from "../../../config.js";
import {
  attachEbsVolume,
  createEbsVolume,
  deleteEbsVolume,
  findEbsVolume,
  findKeyPair,
  findLatestAmi,
  findSecurityGroup,
  findSubnets,
  findVpc,
  getInstance,
  importKeyPair,
  launchInstance,
  pickSubnet,
  startInstance,
  stopInstance,
  terminateInstance,
  whoami,
  type Instance,
} from "../aws.js";
import {
  AGENT_SOCK_MOUNT,
  CONTAINER_SSH_PORT,
  PIROUETTE_PORT,
  containerHomeMount,
  getContainerStatus,
  startContainer,
  uploadEntrypointScript,
  waitForServerReady,
} from "../container.js";
import { checkLocalAuth, pushSecrets } from "../secrets.js";
import {
  ensureKnownHostsEntry,
  killControlMasters,
  removeSshConfig,
  ssh as runSsh,
  upsertSshConfig,
  waitForSsh,
} from "../ssh.js";
import {
  clearRemoteState,
  loadRemoteState,
  updateRemoteState,
} from "../state.js";
import type {
  HostProvider,
  LogsCommand,
  LogsOptions,
  ProviderKind,
  ProviderStatus,
  SshTarget,
} from "../provider.js";

const DATA_MOUNT = "/var/lib/pirouette";
/** Device name we ask AWS to use. On Nitro instances this is advisory —
 *  the kernel will expose the volume as some /dev/nvme*n1 regardless. */
const ATTACH_DEVICE = "/dev/sdf";

/** Resolve a script in the sibling `scripts/` directory. Works in both dev
 *  (src/cli/remote/providers/ec2.ts → repo/scripts) and built (dist/cli/
 *  remote/providers/ec2.js → dist/../scripts → repo/scripts) layouts. */
function scriptPath(name: string): string {
  const here = fileURLToPath(import.meta.url);
  // Four levels up from src/cli/remote/providers/ → repo root.
  return path.resolve(path.dirname(here), "..", "..", "..", "..", "scripts", name);
}

function userDataScriptPath(): string {
  return scriptPath("ec2-user-data.sh");
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function buildUserData(volumeId: string, dockerImage: string): string {
  const template = readFileSync(userDataScriptPath(), "utf8");
  const preamble = [
    "#!/bin/bash",
    `export PIROUETTE_VOLUME_ID=${shellQuote(volumeId)}`,
    `export PIROUETTE_DATA_MOUNT=${shellQuote(DATA_MOUNT)}`,
    `export PIROUETTE_DOCKER_IMAGE=${shellQuote(dockerImage)}`,
    "",
  ].join("\n");
  const body = template.replace(/^#!\s*\/bin\/bash\s*\n/, "");
  return preamble + body;
}

/** Wait for cloud-init's marker file to show the host bootstrap is done. */
async function waitForBootstrap(): Promise<void> {
  const deadline = Date.now() + 6 * 60 * 1000;
  const interval = 5000;
  let lastLog = "";
  while (Date.now() < deadline) {
    try {
      const { stdout } = await runSsh(
        `test -f /var/lib/pirouette/.bootstrap-done && echo done || tail -1 /var/log/cloud-init-output.log`,
      );
      const out = stdout.trim();
      if (out === "done") {
        console.log("  bootstrap done.");
        return;
      }
      if (out !== lastLog) {
        console.log(`  … ${out.slice(0, 120)}`);
        lastLog = out;
      }
    } catch {
      // ignore transient failures; keep polling
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("timed out waiting for host bootstrap; check /var/log/cloud-init-output.log");
}

/** Idempotent docker-on-EC2 bootstrap: upload entrypoint script, run the
 *  container, push secrets, update ~/.ssh/config with host + container
 *  aliases, wait for /api/health. */
async function bootstrapContainer(
  cfg: PirouetteConfig,
  inst: Instance,
): Promise<void> {
  const homeMount = containerHomeMount(cfg);
  await runSsh(`sudo mkdir -p ${homeMount} && sudo chown 1000:1000 ${homeMount}`);

  const entrypointPath = cfg.container.entrypoint_script
    ? expandHome(cfg.container.entrypoint_script)
    : scriptPath("pirouette-entrypoint.sh");
  if (cfg.container.entrypoint_script) {
    console.log(`uploading custom entrypoint script (${cfg.container.entrypoint_script})...`);
  } else {
    console.log("uploading container entrypoint script...");
  }
  await uploadEntrypointScript(entrypointPath);

  const status = await getContainerStatus();
  if (status.running) {
    console.log(`  container ${status.id?.slice(0, 12)} already running; replacing with current config`);
  }

  console.log(`starting container (${cfg.container.image})...`);
  const env: Record<string, string> = {
    PIROUETTE_DATA_DIR: "/data",
    PIROUETTE_PACKAGE: cfg.container.npm_package,
    PIROUETTE_PORT: String(PIROUETTE_PORT),
    // Container must bind 0.0.0.0 so Docker's port mapping (`-p 7777:7777`)
    // can route inbound traffic to it. The server defaults to 127.0.0.1 for
    // local-dev safety; we override here. The Host-header allowlist inside
    // the server is what gates which clients are accepted.
    PIROUETTE_HOST: "0.0.0.0",
  };
  if (cfg.container.default_model) env.PIROUETTE_DEFAULT_MODEL = cfg.container.default_model;
  if (cfg.dotfiles.clone_url) env.PIROUETTE_DOTFILES_URL = cfg.dotfiles.clone_url;
  if (cfg.dotfiles.authorized_keys_url)
    env.PIROUETTE_AUTHORIZED_KEYS_URL = cfg.dotfiles.authorized_keys_url;
  if (cfg.server?.allowed_hosts && cfg.server.allowed_hosts.length > 0) {
    env.PIROUETTE_ALLOWED_HOSTS = cfg.server.allowed_hosts.join(",");
  }
  await startContainer({ image: cfg.container.image, env });

  console.log("pushing local auth secrets...");
  const sec = await pushSecrets(cfg);
  if (sec.pushed === 0 && sec.missing.length > 0) {
    console.log(
      `  (none pushed; pi providers will need /login on first use. Missing: ${sec.missing.join(", ")})`,
    );
  }

  const containerAlias = `${cfg.ssh.host_alias}-container`;
  upsertSshConfig([
    {
      alias: cfg.ssh.host_alias,
      hostName: inst.privateIp!,
      user: cfg.ssh.user,
      keyPath: expandHome(cfg.ssh.private_key),
      remoteForwards: [
        { remote: `${AGENT_SOCK_MOUNT}/ssh.sock`, local: "${SSH_AUTH_SOCK}" },
      ],
    },
    {
      alias: containerAlias,
      hostName: "localhost",
      user: cfg.container.container_user,
      port: CONTAINER_SSH_PORT,
      proxyJump: cfg.ssh.host_alias,
    },
  ]);
  console.log(`  ~/.ssh/config updated (${cfg.ssh.host_alias}, ${containerAlias})`);

  console.log("waiting for pirouette server to be healthy...");
  await waitForServerReady({ timeoutMs: 4 * 60 * 1000 });
  console.log(`  server is up on container:${PIROUETTE_PORT}`);
}

async function resumeExisting(cfg: PirouetteConfig, inst: Instance): Promise<void> {
  if (inst.state === "stopped") {
    console.log(`starting instance ${inst.id}...`);
    inst = await startInstance(inst.id, cfg);
  } else if (inst.state === "running") {
    // nothing to do
  } else {
    throw new Error(`Instance ${inst.id} is in unexpected state: ${inst.state}`);
  }

  // The private IP can change if no Elastic IP is attached and the instance
  // was stopped+started. Refresh state + SSH config.
  updateRemoteState({
    kind: "ec2",
    instanceId: inst.id,
    privateIp: inst.privateIp,
    availabilityZone: inst.availabilityZone,
  });

  const target = {
    user: cfg.ssh.user,
    host: inst.privateIp!,
    keyPath: expandHome(cfg.ssh.private_key),
  };
  upsertSshConfig([
    {
      alias: cfg.ssh.host_alias,
      hostName: inst.privateIp!,
      user: cfg.ssh.user,
      keyPath: expandHome(cfg.ssh.private_key),
      remoteForwards: [
        { remote: `${AGENT_SOCK_MOUNT}/ssh.sock`, local: "${SSH_AUTH_SOCK}" },
      ],
    },
    {
      alias: `${cfg.ssh.host_alias}-container`,
      hostName: "localhost",
      user: cfg.container.container_user,
      port: CONTAINER_SSH_PORT,
      proxyJump: cfg.ssh.host_alias,
    },
  ]);

  console.log(`waiting for SSH on ${inst.privateIp}...`);
  await waitForSsh(target, { timeoutMs: 3 * 60 * 1000 });
  ensureKnownHostsEntry(inst.privateIp!);

  // EC2 stop+start keeps the container (--restart=unless-stopped) but be
  // explicit and re-run bootstrap to refresh the entrypoint + env.
  await bootstrapContainer(cfg, inst);

  console.log("  ready.");
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt + " [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export class EC2Provider implements HostProvider {
  readonly kind: ProviderKind = "ec2";

  constructor(private cfg: PirouetteConfig = getConfig()) {}

  async preflight(): Promise<void> {
    requireConfigured(this.cfg);
    const id = await whoami(this.cfg);
    console.log(`aws  ${id.arn}`);

    // Warn (don't fail) if the laptop has no pi auth state to push.
    const auth = checkLocalAuth();
    if (!auth.ready) {
      console.log("");
      console.log("WARNING: " + auth.hint);
      console.log("");
    }
  }

  async provision(): Promise<void> {
    const cfg = this.cfg;

    // ---- existing-instance fast path ----
    const state = loadRemoteState();
    if (state.instanceId) {
      const inst = await getInstance(state.instanceId, cfg);
      if (inst) {
        console.log(`found existing instance ${inst.id} (${inst.state})`);
        await resumeExisting(cfg, inst);
        return;
      }
      console.log(`state referenced ${state.instanceId}, but it's gone; provisioning a new one`);
    }

    // ---- first-run: discover network + prereqs ----
    console.log("discovering AWS resources...");
    const vpc = await findVpc(cfg);
    const subnets = await findSubnets(vpc.id, cfg);
    const subnet = pickSubnet(subnets);
    const sg = await findSecurityGroup(vpc.id, cfg);

    let kp = await findKeyPair(cfg);
    if (!kp) {
      console.log(`keypair "${cfg.instance.key_name}" not present; attempting import…`);
      const r = await importKeyPair(cfg);
      if (r.kind === "imported" || r.kind === "already-exists") {
        kp = r.keyPair;
        console.log(
          `  ${r.kind === "imported" ? "imported" : "found"} ${kp.name} (${kp.fingerprint.slice(0, 20)}\u2026)`,
        );
      } else if (r.kind === "unauthorized") {
        const expandedPub = cfg.ssh.public_key_path.startsWith("~/")
          ? `${process.env.HOME ?? "~"}/${cfg.ssh.public_key_path.slice(2)}`
          : cfg.ssh.public_key_path;
        const id = await whoami(cfg);
        throw new Error(
          `Cannot create keypair "${cfg.instance.key_name}" in ${cfg.aws.region} — ` +
            `your IAM role lacks ec2:ImportKeyPair there.\n\n` +
            `Ask devops/admin to run (one-time, account ${id.account}):\n\n` +
            `  aws ec2 import-key-pair \\\n` +
            `    --profile <admin-profile> --region ${cfg.aws.region} \\\n` +
            `    --key-name "${cfg.instance.key_name}" \\\n` +
            `    --public-key-material fileb://${expandedPub}\n\n` +
            `Or have them grant ec2:ImportKeyPair (scoped to KeyName=\${aws:username}) ` +
            `on the role you're using.\n\nUnderlying error: ${r.reason}`,
        );
      } else {
        throw new Error(
          `Failed to import keypair "${cfg.instance.key_name}" in ${cfg.aws.region}: ${r.reason}`,
        );
      }
    }
    const ami = await findLatestAmi(cfg);
    console.log(`  vpc:    ${vpc.id}`);
    console.log(`  subnet: ${subnet.id} (${subnet.availabilityZone})`);
    console.log(`  sg:     ${sg.id}`);
    console.log(`  kp:     ${kp.name}`);
    console.log(`  ami:    ${ami.id} (${ami.name.split("/").pop()})`);

    // ---- EBS data volume ----
    let volume = await findEbsVolume(cfg);
    let targetSubnet = subnet;
    if (volume) {
      console.log(
        `reusing existing EBS volume ${volume.id} in ${volume.availabilityZone} (${volume.sizeGib} GiB)`,
      );
      if (volume.availabilityZone !== subnet.availabilityZone) {
        const alt = subnets.find((s) => s.availabilityZone === volume!.availabilityZone);
        if (!alt) {
          throw new Error(
            `EBS volume ${volume.id} is in ${volume.availabilityZone} but no matching subnet is configured there. ` +
              `Either move the volume (create a snapshot, restore in a new AZ) or widen subnet_name_pattern.`,
          );
        }
        console.log(`  switching to subnet ${alt.name} (${alt.id}) to match the volume's AZ`);
        targetSubnet = alt;
      }
    } else {
      console.log(`creating ${cfg.ebs.size_gb} GiB ${cfg.ebs.type} EBS volume in ${subnet.availabilityZone}...`);
      volume = await createEbsVolume(subnet.availabilityZone, cfg);
      console.log(`  created ${volume.id}`);
    }

    // ---- launch ----
    const userData = buildUserData(volume.id, cfg.container.image);
    console.log(`launching ${cfg.instance.type} into ${targetSubnet.id}...`);
    const inst = await launchInstance({
      amiId: ami.id,
      subnetId: targetSubnet.id,
      securityGroupId: sg.id,
      keyName: kp.name,
      userData,
      config: cfg,
    });
    console.log(`  instance ${inst.id} running (${inst.privateIp})`);

    // ---- attach EBS ----
    if (!volume.attachedInstanceId) {
      console.log(`attaching ${volume.id} to ${inst.id} at ${ATTACH_DEVICE}...`);
      await attachEbsVolume(volume.id, inst.id, ATTACH_DEVICE, cfg);
    } else if (volume.attachedInstanceId !== inst.id) {
      throw new Error(
        `EBS volume ${volume.id} is already attached to ${volume.attachedInstanceId}, not our new instance ${inst.id}. Detach manually and retry.`,
      );
    }

    // ---- persist state + SSH config ----
    updateRemoteState({
      kind: "ec2",
      instanceId: inst.id,
      privateIp: inst.privateIp,
      availabilityZone: inst.availabilityZone,
      volumeId: volume.id,
      sshHostAlias: cfg.ssh.host_alias,
      createdAt: new Date().toISOString(),
    });

    const target = {
      user: cfg.ssh.user,
      host: inst.privateIp!,
      keyPath: expandHome(cfg.ssh.private_key),
    };
    // Initial SSH config entry for the host only. We'll upsert again later
    // (inside bootstrapContainer) to add the -container alias and the
    // RemoteForward — we don't have those details yet at this point.
    upsertSshConfig([
      {
        alias: cfg.ssh.host_alias,
        hostName: target.host,
        user: target.user,
        keyPath: target.keyPath,
      },
    ]);

    // ---- wait for ssh ----
    console.log(`waiting for SSH on ${inst.privateIp}...`);
    await waitForSsh(target, {
      timeoutMs: 4 * 60 * 1000,
      onAttempt: (i) => {
        if (i > 1 && i % 6 === 0) process.stdout.write(".");
      },
    });
    ensureKnownHostsEntry(inst.privateIp!);

    console.log(`waiting for host bootstrap (cloud-init + docker + image pull)...`);
    await waitForBootstrap();

    await bootstrapContainer(cfg, inst);

    console.log("");
    console.log("  setup complete.");
    console.log(`  pru open         # forward :${PIROUETTE_PORT} and open the dashboard`);
    console.log(`  pru ssh          # shell into the container (agent forwarded)`);
    console.log(`  pru logs         # tail server logs`);
    console.log(`  pru status       # check server health`);
  }

  async stop(): Promise<void> {
    const cfg = this.cfg;
    const state = loadRemoteState();
    if (!state.instanceId) {
      console.log("no instance configured. nothing to do.");
      return;
    }

    const inst = await getInstance(state.instanceId, cfg);
    if (!inst) {
      console.log(`instance ${state.instanceId} no longer exists. clearing state file.`);
      return;
    }

    if (inst.state === "stopped" || inst.state === "stopping") {
      console.log(`instance ${inst.id} is already ${inst.state}.`);
      return;
    }
    if (inst.state !== "running") {
      throw new Error(`cannot stop instance in state "${inst.state}".`);
    }

    console.log(`stopping ${inst.id} (${inst.privateIp})...`);
    await stopInstance(inst.id, cfg);

    killControlMasters([cfg.ssh.host_alias, `${cfg.ssh.host_alias}-container`]);

    console.log(`  stopped.  pru setup     # to resume`);
    console.log(`  EBS volume ${state.volumeId ?? "?"} preserved; agent state survives.`);
  }

  async destroy(opts: { deletePersistent: boolean; yes?: boolean }): Promise<void> {
    const cfg = this.cfg;
    const state = loadRemoteState();

    if (!state.instanceId && !state.volumeId) {
      console.log("nothing to destroy.");
      return;
    }

    const inst = state.instanceId ? await getInstance(state.instanceId, cfg) : null;
    const volume = await findEbsVolume(cfg); // re-query by tag in case state is stale

    console.log("about to destroy:");
    if (inst) console.log(`  instance  ${inst.id}  (${inst.state}, ${inst.privateIp ?? "no-ip"})`);
    if (volume && opts.deletePersistent) {
      console.log(
        `  volume    ${volume.id}  (${volume.sizeGib} GiB, ${volume.availabilityZone}) \u2014 will be deleted`,
      );
    } else if (volume) {
      console.log(`  volume    ${volume.id}  (${volume.sizeGib} GiB) \u2014 preserved; pass --delete-volume to nuke`);
    }

    if (!opts.yes) {
      const sure = await confirm("proceed?");
      if (!sure) {
        console.log("cancelled.");
        return;
      }
    }

    if (inst && inst.state !== "terminated") {
      console.log(`terminating ${inst.id}...`);
      await terminateInstance(inst.id, cfg);
      console.log(`  terminated.`);
    }

    if (volume && opts.deletePersistent) {
      // AWS won't let us delete an attached volume; terminate-instances
      // detaches the root vol automatically but doesn't always propagate
      // instantly. Poll briefly.
      let attached = volume.attachedInstanceId;
      for (let i = 0; i < 30 && attached; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const fresh = await findEbsVolume(cfg);
        attached = fresh?.attachedInstanceId;
      }
      console.log(`deleting volume ${volume.id}...`);
      await deleteEbsVolume(volume.id, cfg);
      console.log(`  deleted.`);
    }

    killControlMasters([cfg.ssh.host_alias, `${cfg.ssh.host_alias}-container`]);
    removeSshConfig();
    clearRemoteState();
    console.log("  done.");
  }

  async status(): Promise<ProviderStatus> {
    const cfg = this.cfg;
    const state = loadRemoteState();

    if (!state.instanceId) {
      return { state: "absent", detail: "no instance configured", sshTarget: null };
    }

    try {
      const inst = await getInstance(state.instanceId, cfg);
      if (!inst) {
        return {
          state: "absent",
          detail: `instance ${state.instanceId} not found`,
          sshTarget: null,
        };
      }

      const extra: string[] = [
        `  instance   ${inst.id}  (${inst.state})`,
        `  ip         ${inst.privateIp ?? "\u2014"}`,
        `  az         ${inst.availabilityZone}`,
        `  type       ${inst.instanceType}`,
      ];
      if (state.volumeId) extra.push(`  volume     ${state.volumeId}`);

      const target: SshTarget | null = inst.privateIp
        ? {
            user: cfg.ssh.user,
            host: inst.privateIp,
            keyPath: expandHome(cfg.ssh.private_key),
          }
        : null;

      const coarse =
        inst.state === "running"
          ? "running"
          : inst.state === "stopped"
            ? "stopped"
            : inst.state === "pending"
              ? "creating"
              : inst.state === "shutting-down" || inst.state === "terminated"
                ? "deleting"
                : "unknown";

      return {
        state: coarse as ProviderStatus["state"],
        detail: `${inst.id} ${inst.state}`,
        sshTarget: target,
        extraLines: extra,
      };
    } catch (err) {
      return {
        state: "unknown",
        detail: `AWS query failed (${err instanceof Error ? err.message : err})`,
        sshTarget: null,
      };
    }
  }

  sshTarget(): SshTarget {
    const state = loadRemoteState();
    if (!state.privateIp) {
      throw new Error("No remote instance configured. Run `pru setup` first.");
    }
    return {
      user: this.cfg.ssh.user,
      host: state.privateIp,
      keyPath: expandHome(this.cfg.ssh.private_key),
    };
  }

  buildLogsCommand(opts: LogsOptions): LogsCommand {
    const cfg = this.cfg;
    const lines = validateLines(opts.lines);
    const follow = opts.follow ? "-f" : "";
    const entrypointLog = `${containerHome(cfg)}/logs/entrypoint.log`;

    let command: string;
    if (opts.boot) {
      command = `sudo tail -n ${lines} ${follow} /var/log/cloud-init-output.log`;
    } else if (opts.entrypoint) {
      command = `docker exec pirouette tail -n ${lines} ${follow} ${entrypointLog} 2>/dev/null || echo '(entrypoint log not ready yet)'`;
    } else if (opts.tmux) {
      command = `docker exec pirouette tmux capture-pane -p -S -${lines} -t pirouette 2>/dev/null || echo '(pirouette tmux session not running)'`;
    } else {
      const log = "/var/lib/pirouette/logs/pirouette.log";
      command = `[ -f ${log} ] && tail -n ${lines} ${follow} ${log} || (echo '(pirouette.log not ready; showing entrypoint log)' && docker exec pirouette tail -n ${lines} ${follow} ${entrypointLog})`;
    }

    return { command, sshAlias: cfg.ssh.host_alias };
  }
}

/** Validate `--lines` for `pru logs`. Shared between providers; lifted out
 *  of commands/logs.ts so it can live next to the EC2 command builder. */
function validateLines(raw: string | undefined): string {
  const n = Number(raw ?? "200");
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
    throw new Error(`--lines must be a positive integer up to 100000 (got: ${raw})`);
  }
  return String(Math.floor(n));
}
