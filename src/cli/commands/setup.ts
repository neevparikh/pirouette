/** `pru setup` — provision / resume the pirouette EC2 instance.
 *
 *  High-level flow:
 *    1. Preflight: validate config + AWS creds.
 *    2. Discover network resources (VPC, subnet, SG, keypair, AMI).
 *    3. Existing-instance fast path: if `~/.pirouette/ec2.json` names an
 *       instance, ensure it's running (start if stopped), refresh SSH config,
 *       and return.
 *    4. First-run path:
 *       a. Find or create the pirouette-data EBS volume.
 *       b. Launch an instance into the same AZ as the volume, with user-data
 *          that installs docker + mounts the volume on first boot.
 *       c. Attach the volume.
 *       d. Wait for SSH.
 *       e. Write state, update ~/.ssh/config.
 *
 *  Idempotent: safe to re-run. If something fails partway through, the next
 *  `pru setup` will resume where it left off (resource discovery is keyed on
 *  tags, not state-file IDs).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expandHome, getConfig, requireConfigured } from "../../config.js";
import {
  attachEbsVolume,
  createEbsVolume,
  findEbsVolume,
  findKeyPair,
  importKeyPair,
  findLatestAmi,
  findSecurityGroup,
  findSubnets,
  findVpc,
  getInstance,
  launchInstance,
  pickSubnet,
  startInstance,
  whoami,
  type EbsVolume,
  type Instance,
} from "../remote/aws.js";
import {
  AGENT_SOCK_MOUNT,
  CONTAINER_SSH_PORT,
  PIROUETTE_PORT,
  getContainerStatus,
  startContainer,
  uploadEntrypointScript,
  waitForServerReady,
} from "../remote/container.js";
import { checkLocalAuth, pushSecrets } from "../remote/secrets.js";
import {
  ensureKnownHostsEntry,
  upsertSshConfig,
  waitForSsh,
} from "../remote/ssh.js";
import { loadRemoteState, updateRemoteState } from "../remote/state.js";

const DATA_MOUNT = "/var/lib/pirouette";
/** Device name we ask AWS to use. On Nitro instances this is advisory —
 *  the kernel will expose the volume as some /dev/nvme*n1 regardless. */
const ATTACH_DEVICE = "/dev/sdf";

/** Resolve a script in the sibling `scripts/` directory. Works in both dev
 *  (src/cli/commands/setup.ts → repo/scripts) and built (dist/cli/commands/
 *  setup.js → dist/../scripts → repo/scripts) layouts. */
function scriptPath(name: string): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..", "scripts", name);
}

function userDataScriptPath(): string {
  return scriptPath("ec2-user-data.sh");
}

function buildUserData(volumeId: string, dockerImage: string): string {
  const template = readFileSync(userDataScriptPath(), "utf8");
  // Prepend an env block so the script's `$PIROUETTE_*` references resolve.
  // Safer than in-file placeholders because we can't corrupt shell syntax
  // by forgetting to escape a value.
  const preamble = [
    "#!/bin/bash",
    `export PIROUETTE_VOLUME_ID=${shellQuote(volumeId)}`,
    `export PIROUETTE_DATA_MOUNT=${shellQuote(DATA_MOUNT)}`,
    `export PIROUETTE_DOCKER_IMAGE=${shellQuote(dockerImage)}`,
    "",
  ].join("\n");
  // Strip the template's own shebang; ours goes first.
  const body = template.replace(/^#!\s*\/bin\/bash\s*\n/, "");
  return preamble + body;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export async function setup(): Promise<void> {
  const cfg = getConfig();
  requireConfigured(cfg);

  // ---- preflight (cheap) -----------------------------------------------
  const id = await whoami(cfg);
  console.log(`aws  ${id.arn}`);

  // Warn loudly if the laptop has no auth state to push. We don't bail —
  // setup still produces a working container, just one that can't reach
  // hawk models until the user logs in. Doing this before launch saves
  // ~5 minutes of head-scratching when the first agent fails.
  const auth = checkLocalAuth();
  if (!auth.ready) {
    console.log("");
    console.log("WARNING: " + auth.hint);
    console.log("");
  }

  // ---- existing-instance fast path -------------------------------------
  const state = loadRemoteState();
  if (state.instanceId) {
    const inst = await getInstance(state.instanceId, cfg);
    if (inst) {
      console.log(`found existing instance ${inst.id} (${inst.state})`);
      return resumeExisting(inst);
    }
    console.log(`state referenced ${state.instanceId}, but it's gone; provisioning a new one`);
  }

  // ---- first-run: discover network + prereqs ---------------------------
  console.log("discovering AWS resources...");
  const vpc = await findVpc(cfg);
  const subnets = await findSubnets(vpc.id, cfg);
  const subnet = pickSubnet(subnets);
  const sg = await findSecurityGroup(vpc.id, cfg);
  // Resolve the EC2 key pair, importing the local pubkey if needed. Three
  // paths:
  //   1. Already present — use it.
  //   2. Missing, ImportKeyPair allowed — push from `ssh.public_key_path`.
  //   3. Missing, ImportKeyPair *not* allowed (common for region-scoped
  //      researcher policies) — fail with a copy-pasteable devops ask.
  let kp = await findKeyPair(cfg);
  if (!kp) {
    console.log(`keypair "${cfg.instance.key_name}" not present; attempting import…`);
    const r = await importKeyPair(cfg);
    if (r.kind === "imported" || r.kind === "already-exists") {
      kp = r.keyPair;
      console.log(`  ${r.kind === "imported" ? "imported" : "found"} ${kp.name} (${kp.fingerprint.slice(0, 20)}\u2026)`);
    } else if (r.kind === "unauthorized") {
      // Region-scoped IAM policies (e.g. METR Researcher in us-west-2) can
      // grant RunInstances but not ImportKeyPair. Surface a complete ask
      // for the devops/admin who *can* import the key once.
      const expandedPub = cfg.ssh.public_key_path.startsWith("~/")
        ? `${process.env.HOME ?? "~"}/${cfg.ssh.public_key_path.slice(2)}`
        : cfg.ssh.public_key_path;
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

  // ---- EBS data volume -------------------------------------------------
  // The volume must live in the same AZ as the instance (EBS is AZ-scoped).
  // If an existing volume lives in a different AZ than our chosen subnet,
  // prefer the volume's AZ and re-pick a subnet there.
  let volume = await findEbsVolume(cfg);
  let targetSubnet = subnet;
  if (volume) {
    console.log(`reusing existing EBS volume ${volume.id} in ${volume.availabilityZone} (${volume.sizeGib} GiB)`);
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

  // ---- launch ---------------------------------------------------------
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

  // ---- attach EBS -----------------------------------------------------
  if (!volume.attachedInstanceId) {
    console.log(`attaching ${volume.id} to ${inst.id} at ${ATTACH_DEVICE}...`);
    await attachEbsVolume(volume.id, inst.id, ATTACH_DEVICE, cfg);
  } else if (volume.attachedInstanceId !== inst.id) {
    throw new Error(
      `EBS volume ${volume.id} is already attached to ${volume.attachedInstanceId}, not our new instance ${inst.id}. Detach manually and retry.`,
    );
  }

  // ---- persist state + SSH config -------------------------------------
  updateRemoteState({
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

  // ---- wait for ssh --------------------------------------------------
  console.log(`waiting for SSH on ${inst.privateIp}...`);
  await waitForSsh(target, {
    timeoutMs: 4 * 60 * 1000,
    onAttempt: (i) => {
      if (i > 1 && i % 6 === 0) process.stdout.write(".");
    },
  });
  ensureKnownHostsEntry(inst.privateIp!);

  // Wait for the host's bootstrap script (installs docker, mounts EBS, pulls
  // the image). We watch the marker file the user-data script touches.
  console.log(`waiting for host bootstrap (cloud-init + docker + image pull)...`);
  await waitForBootstrap(cfg);

  // Start the container. Idempotent — `startContainer` removes any existing
  // pirouette container first.
  await bootstrapContainer(cfg, inst);

  console.log("");
  console.log("  setup complete.");
  console.log(`  pru open         # forward :${PIROUETTE_PORT} and open the dashboard`);
  console.log(`  pru ssh          # shell into the container (agent forwarded)`);
  console.log(`  pru logs         # tail server logs`);
  console.log(`  pru status       # check server health`);
}

async function waitForBootstrap(cfg: ReturnType<typeof getConfig>): Promise<void> {
  const { ssh: runSsh } = await import("../remote/ssh.js");
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

async function bootstrapContainer(
  cfg: ReturnType<typeof getConfig>,
  inst: Instance,
): Promise<void> {
  const { ssh: runSsh } = await import("../remote/ssh.js");
  const { containerHomeMount } = await import("../remote/container.js");

  // Create the container-home bind-mount dir on the host (idempotent).
  // Named after the container user so non-default images coexist cleanly.
  const homeMount = containerHomeMount(cfg);
  await runSsh(`sudo mkdir -p ${homeMount} && sudo chown 1000:1000 ${homeMount}`);

  // Allow users to override the bundled entrypoint with their own (e.g. to
  // swap yadm for chezmoi/stow, change how the npm package gets installed,
  // or add pre-server hooks). When unset we fall back to the script that
  // ships with the npm package.
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
  // Env vars consumed by scripts/pirouette-entrypoint.sh. Empty string means
  // "skip" for the optional ones (dotfiles, authorized_keys_url).
  const env: Record<string, string> = {
    PIROUETTE_DATA_DIR: "/data",
    PIROUETTE_PACKAGE: cfg.container.npm_package,
    PIROUETTE_PORT: String(PIROUETTE_PORT),
    // Container must bind 0.0.0.0 so Docker's port mapping (`-p 7777:7777`)
    // can route inbound traffic to it. The server defaults to 127.0.0.1
    // for local-dev safety; we override here. The Host-header allowlist
    // inside the server is what gates which clients are accepted.
    PIROUETTE_HOST: "0.0.0.0",
  };
  if (cfg.container.default_model)
    env.PIROUETTE_DEFAULT_MODEL = cfg.container.default_model;
  if (cfg.dotfiles.clone_url) env.PIROUETTE_DOTFILES_URL = cfg.dotfiles.clone_url;
  if (cfg.dotfiles.authorized_keys_url)
    env.PIROUETTE_AUTHORIZED_KEYS_URL = cfg.dotfiles.authorized_keys_url;
  await startContainer({ image: cfg.container.image, env });

  // Push laptop-local auth state into the container's persistent home.
  // The dotfiles repo is public, so OAuth refresh tokens / cached JWTs
  // can't ride along; we ship them out-of-band here so the very first
  // model-discovery call inside the container has credentials. Both
  // files are idempotent overwrites and are skipped if not present
  // locally (e.g. you haven't `/login`'d hawk on this laptop yet).
  console.log("pushing local auth secrets...");
  const sec = await pushSecrets(cfg);
  if (sec.pushed === 0 && sec.missing.length > 0) {
    console.log(
      `  (none pushed; pi providers will need /login on first use. Missing: ${sec.missing.join(", ")})`,
    );
  }

  // Update ~/.ssh/config with both host + container aliases.
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

async function resumeExisting(inst: Instance): Promise<void> {
  const cfg = getConfig();
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

  // Make sure the container is still running (EC2 stop+start would have
  // kept it due to --restart=unless-stopped, but be explicit).
  await bootstrapContainer(cfg, inst);

  console.log("  ready.");
}
