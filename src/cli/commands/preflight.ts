/** `pru preflight` — validate provider config + resource discovery without
 *  creating anything. Provider-aware: EC2 checks AWS resources, byo-host
 *  checks SSH reachability + the persistent root.
 *
 *  Run this before `pru setup` on a fresh checkout. Safe to run anytime.
 */

import { execFileSync } from "node:child_process";

import {
  loadConfig,
  requireConfigured,
  resolveByoHostConfig,
  type PirouetteConfig,
} from "../../config.js";
import {
  AwsError,
  findEbsVolume,
  findKeyPair,
  findLatestAmi,
  findSecurityGroup,
  findSubnets,
  findVpc,
  pickSubnet,
  readPublicKey,
  whoami,
} from "../remote/aws.js";
import { ssh as runSsh } from "../remote/ssh.js";

type CheckResult = { label: string; ok: boolean; detail: string };

async function runChecks(): Promise<CheckResult[]> {
  const { config } = loadConfig();
  const kind = config.provider?.kind ?? "ec2";
  if (kind === "byo-host") return runByoHostChecks(config);
  return runEc2Checks(config);
}

async function runEc2Checks(config: PirouetteConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. required config
  try {
    requireConfigured(config);
    results.push({ label: "config", ok: true, detail: "required fields present" });
  } catch (err) {
    results.push({
      label: "config",
      ok: false,
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    });
    return results; // no point continuing without Owner/key_name
  }

  // 2. AWS credentials
  try {
    const id = await whoami(config);
    results.push({
      label: "aws credentials",
      ok: true,
      detail: `${id.arn} (account ${id.account})`,
    });
  } catch (err) {
    results.push({
      label: "aws credentials",
      ok: false,
      detail:
        err instanceof AwsError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    });
    return results; // nothing else will work
  }

  // 3. VPC
  let vpcId = "";
  try {
    const vpc = await findVpc(config);
    vpcId = vpc.id;
    results.push({ label: "vpc", ok: true, detail: `${vpc.id} (${vpc.cidr})` });
  } catch (err) {
    results.push({ label: "vpc", ok: false, detail: (err as Error).message });
    return results;
  }

  // 4. subnets
  try {
    const subnets = await findSubnets(vpcId, config);
    const picked = pickSubnet(subnets);
    const others = subnets.filter((s) => s.id !== picked.id);
    results.push({
      label: "subnets",
      ok: true,
      detail:
        `picked ${picked.name} (${picked.id}, ${picked.availabilityZone}, ` +
        `${picked.availableIpCount} IPs free)` +
        (others.length > 0
          ? ` + ${others.length} other candidate${others.length === 1 ? "" : "s"}`
          : ""),
    });
  } catch (err) {
    results.push({ label: "subnets", ok: false, detail: (err as Error).message });
  }

  // 5. security group
  try {
    const sg = await findSecurityGroup(vpcId, config);
    results.push({ label: "security group", ok: true, detail: `${sg.name} (${sg.id})` });
  } catch (err) {
    results.push({ label: "security group", ok: false, detail: (err as Error).message });
  }

  // 6. keypair (and verify we can read the local public key file too —
  //    if setup needs to import it, this is the file it'll send.)
  try {
    const kp = await findKeyPair(config);
    if (kp) {
      // Optional sanity-check: also confirm the local pubkey is readable
      // so a later import isn't surprised by a permissions issue. Failure
      // here is informational, not fatal, since the key already exists.
      let pubInfo = "";
      try {
        const pub = readPublicKey(config);
        pubInfo = ` (local pubkey ${pub.split(" ")[0]} ok)`;
      } catch {
        pubInfo = ` (warning: ${config.ssh.public_key_path} unreadable)`;
      }
      results.push({
        label: "keypair",
        ok: true,
        detail: `${kp.name} (${kp.type}, ${kp.fingerprint.slice(0, 20)}\u2026)${pubInfo}`,
      });
    } else {
      // Confirm the local pubkey is at least readable; without it we can't
      // even attempt an import.
      let localOk = true;
      try {
        readPublicKey(config);
      } catch {
        localOk = false;
      }
      // Expand ~/ so the devops ask below is copy-pasteable as-is. The
      // running shell typically *would* expand ~/ but inside `fileb://...`
      // the AWS CLI sees it literally, which has burned us before.
      const expandedPub = config.ssh.public_key_path.startsWith("~/")
        ? `${process.env.HOME ?? "~"}/${config.ssh.public_key_path.slice(2)}`
        : config.ssh.public_key_path;
      results.push({
        label: "keypair",
        ok: false,
        detail:
          `"${config.instance.key_name}" not found in ${config.aws.region}.` +
          (localOk
            ? ` setup will try to import from ${config.ssh.public_key_path};` +
              ` if your role lacks ec2:ImportKeyPair, ask devops to run:\n` +
              `      aws ec2 import-key-pair --profile ${config.aws.profile} --region ${config.aws.region} \\\n` +
              `        --key-name "${config.instance.key_name}" \\\n` +
              `        --public-key-material fileb://${expandedPub}`
            : ` AND ${config.ssh.public_key_path} can't be read — fix the local file before setup.`),
      });
    }
  } catch (err) {
    results.push({ label: "keypair", ok: false, detail: (err as Error).message });
  }

  // 7. AMI
  try {
    const ami = await findLatestAmi(config);
    results.push({ label: "ami", ok: true, detail: `${ami.id}  ${ami.name}` });
  } catch (err) {
    results.push({ label: "ami", ok: false, detail: (err as Error).message });
  }

  // 8. EBS volume (informational; fresh accounts will have none yet)
  try {
    const vol = await findEbsVolume(config);
    if (vol) {
      const attached = vol.attachedInstanceId
        ? `attached to ${vol.attachedInstanceId}`
        : "available";
      results.push({
        label: "ebs volume",
        ok: true,
        detail: `${vol.id} (${vol.sizeGib} GiB, ${vol.availabilityZone}, ${attached})`,
      });
    } else {
      results.push({
        label: "ebs volume",
        ok: true,
        detail: `none yet (will be created on first \`pru setup\`)`,
      });
    }
  } catch (err) {
    results.push({ label: "ebs volume", ok: false, detail: (err as Error).message });
  }

  return results;
}

/** byo-host preflight: SSH-alias resolution, SSH probe, persistent_root
 *  reachability. Much smaller surface than EC2 because pirouette doesn't
 *  own the host — if SSH works and `/persistent_root` is writable (or
 *  becomes writable via sudo chown on first mount), provision will
 *  succeed. */
async function runByoHostChecks(config: PirouetteConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. required config
  try {
    requireConfigured(config);
    results.push({ label: "config", ok: true, detail: "required fields present" });
  } catch (err) {
    results.push({
      label: "config",
      ok: false,
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    });
    return results;
  }

  const b = resolveByoHostConfig(config);
  results.push({
    label: "resolved paths",
    ok: true,
    detail: `ssh_alias=${b.ssh_alias}, persistent_root=${b.persistent_root}, home_dir=${b.home_dir}, data_dir=${b.data_dir}`,
  });

  // 2. ssh alias resolves in ~/.ssh/config
  try {
    execFileSync("ssh", ["-G", b.ssh_alias], { stdio: ["ignore", "ignore", "pipe"] });
    results.push({
      label: "ssh alias",
      ok: true,
      detail: `${b.ssh_alias} resolves via ~/.ssh/config`,
    });
  } catch (err) {
    results.push({
      label: "ssh alias",
      ok: false,
      detail: `${b.ssh_alias} not found in ~/.ssh/config (${err instanceof Error ? err.message : err})`,
    });
    return results;
  }

  // 3. ssh echo probe
  const target = { user: b.user, host: b.ssh_alias, useAlias: true as const };
  try {
    const { stdout } = await runSsh("echo ok", { target, timeoutMs: 15_000 });
    if (stdout.trim() === "ok") {
      results.push({ label: "ssh probe", ok: true, detail: `echo ok from ${b.ssh_alias}` });
    } else {
      results.push({
        label: "ssh probe",
        ok: false,
        detail: `unexpected response: ${JSON.stringify(stdout)}`,
      });
      return results;
    }
  } catch (err) {
    results.push({
      label: "ssh probe",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  // 4. persistent_root exists (writable or sudo-chown-able). Refuse if
  //    the path doesn't exist at all — that's almost always a config typo.
  try {
    const { stdout } = await runSsh(
      `if [ -d ${shellQuote(b.persistent_root)} ]; then echo ok; else echo missing; fi`,
      { target, timeoutMs: 15_000 },
    );
    if (stdout.trim() === "ok") {
      results.push({
        label: "persistent root",
        ok: true,
        detail: `${b.persistent_root} present on ${b.ssh_alias}`,
      });
    } else {
      results.push({
        label: "persistent root",
        ok: false,
        detail: `${b.persistent_root} does not exist on ${b.ssh_alias} — check provider.byo-host.persistent_root`,
      });
    }
  } catch (err) {
    results.push({
      label: "persistent root",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Tooling sanity check on the remote (node, npm, git, tmux must exist).
  try {
    const { stdout } = await runSsh(
      `for t in node npm git tmux; do command -v "$t" >/dev/null && echo "$t ok" || echo "$t MISSING"; done`,
      { target, timeoutMs: 15_000 },
    );
    const lines = stdout.trim().split("\n").map((l) => l.trim());
    const missing = lines.filter((l) => l.includes("MISSING"));
    if (missing.length === 0) {
      results.push({
        label: "remote tooling",
        ok: true,
        detail: `node, npm, git, tmux present`,
      });
    } else {
      results.push({
        label: "remote tooling",
        ok: false,
        detail: `missing on ${b.ssh_alias}: ${missing.join(", ")}`,
      });
    }
  } catch (err) {
    results.push({
      label: "remote tooling",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export async function preflight(): Promise<void> {
  const results = await runChecks();

  let width = 0;
  for (const r of results) width = Math.max(width, r.label.length);

  for (const r of results) {
    const mark = r.ok ? "\u2713" : "\u2717";
    console.log(`  ${mark} ${r.label.padEnd(width)}  ${r.detail}`);
  }

  const allOk = results.every((r) => r.ok);
  console.log("");
  if (allOk) {
    console.log("preflight passed \u2014 safe to run `pru setup`.");
  } else {
    console.log("preflight failed \u2014 fix the above before `pru setup`.");
    process.exit(1);
  }
}
