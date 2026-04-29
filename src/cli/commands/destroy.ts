/** `pru destroy` — terminate the EC2 instance.
 *
 *  Required confirmation. Keeps the EBS data volume by default — pass
 *  `--delete-volume` to nuke the volume too (irrecoverable).
 *
 *  After destroy you can `pru setup` again to provision a fresh instance;
 *  unless you also deleted the volume, your agent state survives.
 */

import { createInterface } from "node:readline/promises";

import { getConfig } from "../../config.js";
import {
  deleteEbsVolume,
  findEbsVolume,
  getInstance,
  terminateInstance,
} from "../remote/aws.js";
import { killControlMasters, removeSshConfig } from "../remote/ssh.js";
import { clearRemoteState, loadRemoteState } from "../remote/state.js";

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

export async function destroy(opts: { deleteVolume?: boolean; yes?: boolean }): Promise<void> {
  const cfg = getConfig();
  const state = loadRemoteState();

  if (!state.instanceId && !state.volumeId) {
    console.log("nothing to destroy.");
    return;
  }

  const inst = state.instanceId ? await getInstance(state.instanceId, cfg) : null;
  const volume = await findEbsVolume(cfg); // re-query by tag in case state is stale

  console.log("about to destroy:");
  if (inst) console.log(`  instance  ${inst.id}  (${inst.state}, ${inst.privateIp ?? "no-ip"})`);
  if (volume && opts.deleteVolume) {
    console.log(`  volume    ${volume.id}  (${volume.sizeGib} GiB, ${volume.availabilityZone}) \u2014 will be deleted`);
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

  if (volume && opts.deleteVolume) {
    // Re-check attachment; AWS won't let us delete an attached volume, and
    // terminate-instances detaches the root vol automatically but doesn't
    // always propagate instantly. Wait briefly.
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

  // Tear down any live SSH control-master connections before we drop the
  // config block they reference. Best-effort — a stale socket left behind
  // is harmless (the next master open will overwrite it).
  killControlMasters([cfg.ssh.host_alias, `${cfg.ssh.host_alias}-container`]);
  removeSshConfig();
  clearRemoteState();
  console.log("  done.");
}
