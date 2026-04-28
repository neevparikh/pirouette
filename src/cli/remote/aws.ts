/** AWS CLI wrapper for pirouette.
 *
 *  We shell out to the `aws` CLI rather than pulling in the SDK because:
 *    - The user already has `aws` configured with SSO credentials locally.
 *    - SSO credential refresh is handled by the CLI transparently.
 *    - The SDK would double our dep size and add auth complexity.
 *
 *  All calls use the AWS profile + region from pirouette config. Tagged
 *  resource discovery queries are cheap (single describe-* call each).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { getConfig, type PirouetteConfig } from "../../config.js";

const pExecFile = promisify(execFile);

export class AwsError extends Error {
  constructor(
    message: string,
    public readonly command: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AwsError";
  }
}

/** Run `aws ...` with the configured profile + region. Returns parsed JSON
 *  output (or undefined if output is empty). Throws `AwsError` on non-zero
 *  exit; the error's message is the first line of stderr, which is usually
 *  the actionable bit (e.g. "An error occurred (...) when calling ..."). */
export async function aws<T = unknown>(
  args: string[],
  opts: { config?: PirouetteConfig; timeoutMs?: number } = {},
): Promise<T> {
  const cfg = opts.config ?? getConfig();
  const fullArgs = [
    "--profile",
    cfg.aws.profile,
    "--region",
    cfg.aws.region,
    "--output",
    "json",
    ...args,
  ];
  try {
    const { stdout } = await pExecFile("aws", fullArgs, {
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!stdout.trim()) return undefined as T;
    return JSON.parse(stdout) as T;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: number };
    const stderr = (e.stderr ?? "").trim();
    const firstLine = stderr.split("\n").find((l) => l.trim()) ?? e.message ?? String(err);
    throw new AwsError(firstLine, ["aws", ...fullArgs], stderr);
  }
}

/** Friendly preflight: confirm AWS CLI is installed and the configured
 *  profile has valid credentials. Returns the caller identity on success. */
export async function whoami(cfg = getConfig()): Promise<{
  account: string;
  arn: string;
  userId: string;
}> {
  const result = await aws<{ Account: string; Arn: string; UserId: string }>(
    ["sts", "get-caller-identity"],
    { config: cfg },
  );
  return { account: result.Account, arn: result.Arn, userId: result.UserId };
}

// ---------- resource types ----------

export interface Vpc {
  id: string;
  cidr: string;
  tags: Record<string, string>;
}

export interface Subnet {
  id: string;
  vpcId: string;
  availabilityZone: string;
  cidr: string;
  availableIpCount: number;
  name: string;
}

export interface SecurityGroup {
  id: string;
  name: string;
  vpcId: string;
}

export interface KeyPair {
  id: string;
  name: string;
  fingerprint: string;
  type: string;
}

export interface Ami {
  id: string;
  name: string;
  creationDate: string;
}

export interface EbsVolume {
  id: string;
  state: string; // "available" | "in-use" | "creating" | ...
  sizeGib: number;
  availabilityZone: string;
  attachedInstanceId?: string;
  attachedDevice?: string;
  tags: Record<string, string>;
}

export interface Instance {
  id: string;
  state: string; // "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated"
  privateIp?: string;
  publicIp?: string;
  privateDnsName?: string;
  subnetId: string;
  availabilityZone: string;
  instanceType: string;
  launchTime: string;
  tags: Record<string, string>;
}

// ---------- helpers ----------

function tagsToMap(tags: Array<{ Key: string; Value: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) out[t.Key] = t.Value;
  return out;
}

function tagValue(tags: Array<{ Key: string; Value: string }> | undefined, key: string): string {
  return tags?.find((t) => t.Key === key)?.Value ?? "";
}

/** Build a tag-specifications arg for `ec2 run-instances` / `create-volume` /
 *  `import-key-pair`. Always merges pirouette config tags with the caller-
 *  specified Name tag. */
export function tagSpec(
  resourceType:
    | "instance"
    | "volume"
    | "network-interface"
    | "key-pair",
  extra: Record<string, string> = {},
): string {
  const cfg = getConfig();
  const merged: Record<string, string> = { ...cfg.aws.tags, ...extra };
  const tags = Object.entries(merged).map(([Key, Value]) => ({ Key, Value }));
  return JSON.stringify({ ResourceType: resourceType, Tags: tags });
}

// ---------- discovery ----------

export async function findVpc(cfg = getConfig()): Promise<Vpc> {
  const result = await aws<{ Vpcs: Array<{ VpcId: string; CidrBlock: string; Tags?: Array<{ Key: string; Value: string }> }> }>([
    "ec2",
    "describe-vpcs",
    "--filters",
    `Name=tag:Name,Values=${cfg.aws.network.vpc_name}`,
  ], { config: cfg });

  if (!result.Vpcs || result.Vpcs.length === 0) {
    throw new Error(
      `No VPC with tag Name="${cfg.aws.network.vpc_name}" in ${cfg.aws.region}.`,
    );
  }
  if (result.Vpcs.length > 1) {
    throw new Error(
      `Multiple VPCs match Name="${cfg.aws.network.vpc_name}" in ${cfg.aws.region}: ` +
        result.Vpcs.map((v) => v.VpcId).join(", "),
    );
  }
  const v = result.Vpcs[0];
  return { id: v.VpcId, cidr: v.CidrBlock, tags: tagsToMap(v.Tags) };
}

/** Find all private subnets in the VPC matching the configured name pattern.
 *  Returned sorted by Name tag, so the caller always picks the same subnet
 *  across runs. */
export async function findSubnets(vpcId: string, cfg = getConfig()): Promise<Subnet[]> {
  const result = await aws<{
    Subnets: Array<{
      SubnetId: string;
      VpcId: string;
      AvailabilityZone: string;
      CidrBlock: string;
      AvailableIpAddressCount: number;
      Tags?: Array<{ Key: string; Value: string }>;
    }>;
  }>([
    "ec2",
    "describe-subnets",
    "--filters",
    `Name=vpc-id,Values=${vpcId}`,
    `Name=tag:Name,Values=${cfg.aws.network.subnet_name_pattern}`,
  ], { config: cfg });

  const subnets: Subnet[] = (result.Subnets ?? []).map((s) => ({
    id: s.SubnetId,
    vpcId: s.VpcId,
    availabilityZone: s.AvailabilityZone,
    cidr: s.CidrBlock,
    availableIpCount: s.AvailableIpAddressCount,
    name: tagValue(s.Tags, "Name"),
  }));
  subnets.sort((a, b) => a.name.localeCompare(b.name));
  if (subnets.length === 0) {
    throw new Error(
      `No subnets in VPC ${vpcId} matching Name="${cfg.aws.network.subnet_name_pattern}".`,
    );
  }
  return subnets;
}

/** Pick the best subnet: alphabetically first among those with > 0 available IPs.
 *  Deterministic so repeated `pru setup` calls always land on the same subnet. */
export function pickSubnet(subnets: Subnet[]): Subnet {
  const usable = subnets.filter((s) => s.availableIpCount > 0);
  if (usable.length === 0) {
    throw new Error("All matching subnets are out of IP addresses.");
  }
  return usable[0];
}

export async function findSecurityGroup(vpcId: string, cfg = getConfig()): Promise<SecurityGroup> {
  const result = await aws<{ SecurityGroups: Array<{ GroupId: string; GroupName: string; VpcId: string }> }>([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=vpc-id,Values=${vpcId}`,
    `Name=group-name,Values=${cfg.aws.network.security_group_name}`,
  ], { config: cfg });

  if (!result.SecurityGroups || result.SecurityGroups.length === 0) {
    throw new Error(
      `Security group "${cfg.aws.network.security_group_name}" not found in VPC ${vpcId}.`,
    );
  }
  const sg = result.SecurityGroups[0];
  return { id: sg.GroupId, name: sg.GroupName, vpcId: sg.VpcId };
}

export async function findKeyPair(cfg = getConfig()): Promise<KeyPair | null> {
  try {
    const result = await aws<{ KeyPairs: Array<{ KeyPairId: string; KeyName: string; KeyFingerprint: string; KeyType: string }> }>([
      "ec2",
      "describe-key-pairs",
      "--key-names",
      cfg.instance.key_name,
    ], { config: cfg });
    if (!result.KeyPairs || result.KeyPairs.length === 0) return null;
    const k = result.KeyPairs[0];
    return { id: k.KeyPairId, name: k.KeyName, fingerprint: k.KeyFingerprint, type: k.KeyType };
  } catch (err) {
    // `describe-key-pairs --key-names <missing>` returns a non-zero exit with
    // InvalidKeyPair.NotFound; distinguish from real errors.
    if (err instanceof AwsError && err.stderr.includes("does not exist")) {
      return null;
    }
    throw err;
  }
}

/** Result of attempting to import the user's SSH public key as an EC2
 *  key pair. We disambiguate "not allowed" from other errors so the caller
 *  can emit a useful actionable hint (e.g. "ask devops"). */
export type ImportKeyPairResult =
  | { kind: "imported"; keyPair: KeyPair }
  | { kind: "already-exists"; keyPair: KeyPair }
  | { kind: "unauthorized"; reason: string }
  | { kind: "error"; reason: string };

/** Expand a leading `~/` in a path against the current user's home dir. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/** Read the user's public key from disk, expanding `~/`. Throws on missing /
 *  unreadable file with a hint pointing at the configured path. */
export function readPublicKey(cfg = getConfig()): string {
  const expanded = expandHome(cfg.ssh.public_key_path);
  try {
    return readFileSync(expanded, "utf8").trim();
  } catch (err) {
    throw new Error(
      `Cannot read public key at ${expanded}: ${(err as Error).message}\n` +
        `Update ssh.public_key_path in your pirouette config to point at a readable .pub file.`,
    );
  }
}

/** Import the user's SSH public key as `cfg.instance.key_name` in the
 *  configured region. Tags the pair with `aws.tags` so IAM tag conditions
 *  pass (some accounts require Environment / Project / Owner). Idempotent
 *  in the sense that an existing matching key returns kind="already-exists". */
export async function importKeyPair(
  cfg = getConfig(),
): Promise<ImportKeyPairResult> {
  // First check whether it already exists — this is the most common case
  // and avoids needing ImportKeyPair perms when the key is pre-imported by
  // an admin. Don't blindly call ImportKeyPair, because Researcher-style
  // roles often *can* DescribeKeyPairs but *can't* ImportKeyPair; we want
  // the happy path to work even without write perms.
  const existing = await findKeyPair(cfg);
  if (existing) return { kind: "already-exists", keyPair: existing };

  let publicKey: string;
  try {
    publicKey = readPublicKey(cfg);
  } catch (err) {
    return { kind: "error", reason: (err as Error).message };
  }

  // The AWS CLI accepts `--public-key-material` as raw bytes; we pass the
  // expanded path via `fileb://` to avoid having to base64-encode here.
  const expanded = expandHome(cfg.ssh.public_key_path);

  // First attempt: import with tag-specifications. METR's IAM policy in
  // some accounts gates ImportKeyPair on having Owner/Environment/Project
  // tags, so this is the friendlier path when allowed.
  //
  // Fallback attempt: import *without* tags. Some scoped-down roles allow
  // ImportKeyPair but not ec2:CreateTags on key-pair resources. If the
  // tagged import fails with a CreateTags-specific UnauthorizedOperation,
  // re-try plain. Other UnauthorizedOperation errors propagate up so the
  // caller can surface the "ask devops" message.
  const baseArgs = [
    "ec2",
    "import-key-pair",
    "--key-name",
    cfg.instance.key_name,
    "--public-key-material",
    `fileb://${expanded}`,
  ];
  try {
    await aws([
      ...baseArgs,
      "--tag-specifications",
      tagSpec("key-pair", { Name: cfg.instance.key_name }),
    ], { config: cfg });
  } catch (err) {
    if (err instanceof AwsError) {
      const msg = err.stderr;
      if (msg.includes("InvalidKeyPair.Duplicate")) {
        const fresh = await findKeyPair(cfg);
        if (fresh) return { kind: "already-exists", keyPair: fresh };
      }
      // CreateTags-specific block — retry without tags.
      const isCreateTagsBlock =
        msg.includes("is not authorized to perform: ec2:CreateTags");
      if (isCreateTagsBlock) {
        try {
          await aws(baseArgs, { config: cfg });
        } catch (err2) {
          if (err2 instanceof AwsError) {
            if (err2.stderr.includes("UnauthorizedOperation") || err2.stderr.includes("is not authorized")) {
              return { kind: "unauthorized", reason: err2.stderr.split("\n")[0] };
            }
            return { kind: "error", reason: err2.stderr.split("\n")[0] };
          }
          return { kind: "error", reason: (err2 as Error).message };
        }
      } else if (msg.includes("UnauthorizedOperation") || msg.includes("is not authorized")) {
        return { kind: "unauthorized", reason: msg.split("\n")[0] };
      } else {
        return { kind: "error", reason: msg.split("\n")[0] };
      }
    } else {
      return { kind: "error", reason: (err as Error).message };
    }
  }

  const fresh = await findKeyPair(cfg);
  if (!fresh) {
    return { kind: "error", reason: "ImportKeyPair returned without error but the key still isn't visible." };
  }
  return { kind: "imported", keyPair: fresh };
}


/** Find the most recent AMI matching the configured name pattern + owner.
 *  We push sorting to the server side via `--query sort_by(... &CreationDate)[-1]`
 *  and return just the tip — a full account can have hundreds of matching AMIs,
 *  and transferring them all wastes bandwidth. */
export async function findLatestAmi(cfg = getConfig()): Promise<Ami> {
  const latest = await aws<
    { ImageId: string; Name: string; CreationDate: string } | null
  >([
    "ec2",
    "describe-images",
    "--owners",
    cfg.instance.ami_owner,
    "--filters",
    `Name=name,Values=${cfg.instance.ami_name_pattern}`,
    `Name=state,Values=available`,
    `Name=architecture,Values=x86_64`,
    "--query",
    "sort_by(Images, &CreationDate)[-1].{ImageId:ImageId,Name:Name,CreationDate:CreationDate}",
  ], { config: cfg });

  if (!latest) {
    throw new Error(`No AMI matching "${cfg.instance.ami_name_pattern}" (owner ${cfg.instance.ami_owner}).`);
  }
  return { id: latest.ImageId, name: latest.Name, creationDate: latest.CreationDate };
}

/** Find an EBS volume tagged with the configured volume name. Returns null if
 *  none exists yet (first-time setup). */
export async function findEbsVolume(cfg = getConfig()): Promise<EbsVolume | null> {
  const result = await aws<{
    Volumes: Array<{
      VolumeId: string;
      State: string;
      Size: number;
      AvailabilityZone: string;
      Attachments?: Array<{ InstanceId: string; Device: string }>;
      Tags?: Array<{ Key: string; Value: string }>;
    }>;
  }>([
    "ec2",
    "describe-volumes",
    "--filters",
    `Name=tag:Name,Values=${cfg.ebs.volume_name}`,
  ], { config: cfg });

  const volumes = result.Volumes ?? [];
  if (volumes.length === 0) return null;
  if (volumes.length > 1) {
    throw new Error(
      `Multiple EBS volumes tagged Name="${cfg.ebs.volume_name}" exist (${volumes.map((v) => v.VolumeId).join(", ")}). ` +
        `Resolve manually in the AWS console.`,
    );
  }
  const v = volumes[0];
  const att = v.Attachments?.[0];
  return {
    id: v.VolumeId,
    state: v.State,
    sizeGib: v.Size,
    availabilityZone: v.AvailabilityZone,
    attachedInstanceId: att?.InstanceId,
    attachedDevice: att?.Device,
    tags: tagsToMap(v.Tags),
  };
}

// ---------- mutating operations (create / attach / stop / start / terminate) --

/** Create a new EBS volume in the given AZ. Tags it with pirouette's
 *  required + custom tags plus `Name=<cfg.ebs.volume_name>` so it's
 *  discoverable by `findEbsVolume`. Returns once the volume reaches the
 *  "available" state. */
export async function createEbsVolume(
  availabilityZone: string,
  cfg = getConfig(),
): Promise<EbsVolume> {
  const created = await aws<{ VolumeId: string }>([
    "ec2",
    "create-volume",
    "--availability-zone",
    availabilityZone,
    "--size",
    String(cfg.ebs.size_gb),
    "--volume-type",
    cfg.ebs.type,
    "--tag-specifications",
    tagSpec("volume", { Name: cfg.ebs.volume_name }),
  ], { config: cfg });

  // Wait for "available" state. The CLI has a built-in waiter; use it.
  await aws<undefined>([
    "ec2",
    "wait",
    "volume-available",
    "--volume-ids",
    created.VolumeId,
  ], { config: cfg, timeoutMs: 5 * 60 * 1000 });

  const v = await findEbsVolume(cfg);
  if (!v) throw new Error(`Just created volume ${created.VolumeId} but couldn't re-find it by tag.`);
  return v;
}

export async function attachEbsVolume(
  volumeId: string,
  instanceId: string,
  device: string,
  cfg = getConfig(),
): Promise<void> {
  await aws([
    "ec2",
    "attach-volume",
    "--volume-id",
    volumeId,
    "--instance-id",
    instanceId,
    "--device",
    device,
  ], { config: cfg });
}

/** Launch an EC2 instance into the configured subnet + security group.
 *  `userData` is a shell script; we base64-encode it for the CLI.
 *  Returns once the instance is in "running" state. */
export async function launchInstance(args: {
  amiId: string;
  subnetId: string;
  securityGroupId: string;
  keyName: string;
  userData: string;
  config?: PirouetteConfig;
}): Promise<Instance> {
  const cfg = args.config ?? getConfig();

  // cloud-init expects user-data base64-encoded when passed via `--user-data`
  // with binary content. The AWS CLI auto-decodes if you use file:// but we
  // pass the raw string, so encode explicitly.
  const encoded = Buffer.from(args.userData, "utf8").toString("base64");

  const result = await aws<{ Instances: Array<{ InstanceId: string }> }>([
    "ec2",
    "run-instances",
    "--image-id",
    args.amiId,
    "--instance-type",
    cfg.instance.type,
    "--key-name",
    args.keyName,
    "--subnet-id",
    args.subnetId,
    "--security-group-ids",
    args.securityGroupId,
    "--user-data",
    encoded,
    "--count",
    "1",
    "--tag-specifications",
    tagSpec("instance", { Name: "pirouette" }),
    tagSpec("volume", { Name: "pirouette-root" }), // root EBS vol tags
    tagSpec("network-interface", { Name: "pirouette" }),
  ], { config: cfg });

  const instanceId = result.Instances[0].InstanceId;

  // Wait for the instance to reach "running". The AWS CLI waiter polls at a
  // sane interval (15s) and times out at 40 tries (10 min), which matches
  // what we want.
  await aws<undefined>([
    "ec2",
    "wait",
    "instance-running",
    "--instance-ids",
    instanceId,
  ], { config: cfg, timeoutMs: 10 * 60 * 1000 });

  const inst = await getInstance(instanceId, cfg);
  if (!inst) throw new Error(`Instance ${instanceId} launched but can't be found.`);
  return inst;
}

export async function startInstance(instanceId: string, cfg = getConfig()): Promise<Instance> {
  await aws([
    "ec2",
    "start-instances",
    "--instance-ids",
    instanceId,
  ], { config: cfg });
  await aws<undefined>([
    "ec2",
    "wait",
    "instance-running",
    "--instance-ids",
    instanceId,
  ], { config: cfg, timeoutMs: 10 * 60 * 1000 });
  const inst = await getInstance(instanceId, cfg);
  if (!inst) throw new Error(`Instance ${instanceId} started but can't be found.`);
  return inst;
}

export async function stopInstance(instanceId: string, cfg = getConfig()): Promise<void> {
  await aws([
    "ec2",
    "stop-instances",
    "--instance-ids",
    instanceId,
  ], { config: cfg });
  await aws<undefined>([
    "ec2",
    "wait",
    "instance-stopped",
    "--instance-ids",
    instanceId,
  ], { config: cfg, timeoutMs: 10 * 60 * 1000 });
}

export async function terminateInstance(instanceId: string, cfg = getConfig()): Promise<void> {
  await aws([
    "ec2",
    "terminate-instances",
    "--instance-ids",
    instanceId,
  ], { config: cfg });
  await aws<undefined>([
    "ec2",
    "wait",
    "instance-terminated",
    "--instance-ids",
    instanceId,
  ], { config: cfg, timeoutMs: 10 * 60 * 1000 });
}

export async function deleteEbsVolume(volumeId: string, cfg = getConfig()): Promise<void> {
  await aws([
    "ec2",
    "delete-volume",
    "--volume-id",
    volumeId,
  ], { config: cfg });
}

export async function getInstance(instanceId: string, cfg = getConfig()): Promise<Instance | null> {
  try {
    const result = await aws<{
      Reservations: Array<{
        Instances: Array<{
          InstanceId: string;
          State: { Name: string };
          PrivateIpAddress?: string;
          PublicIpAddress?: string;
          PrivateDnsName?: string;
          SubnetId: string;
          Placement: { AvailabilityZone: string };
          InstanceType: string;
          LaunchTime: string;
          Tags?: Array<{ Key: string; Value: string }>;
        }>;
      }>;
    }>([
      "ec2",
      "describe-instances",
      "--instance-ids",
      instanceId,
    ], { config: cfg });

    const inst = result.Reservations?.[0]?.Instances?.[0];
    if (!inst) return null;
    return {
      id: inst.InstanceId,
      state: inst.State.Name,
      privateIp: inst.PrivateIpAddress,
      publicIp: inst.PublicIpAddress,
      privateDnsName: inst.PrivateDnsName,
      subnetId: inst.SubnetId,
      availabilityZone: inst.Placement.AvailabilityZone,
      instanceType: inst.InstanceType,
      launchTime: inst.LaunchTime,
      tags: tagsToMap(inst.Tags),
    };
  } catch (err) {
    if (err instanceof AwsError && err.stderr.includes("does not exist")) {
      return null;
    }
    throw err;
  }
}
