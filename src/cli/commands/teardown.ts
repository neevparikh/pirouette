/** `pru teardown` — stop the EC2 instance.
 *
 *  Preserves the EBS data volume and the instance itself. Use this between
 *  work sessions to stop paying for compute; use `pru setup` to resume.
 *
 *  You still pay for the stopped instance's root EBS volume (~$10/mo for
 *  the default gp3 root) and for the `pirouette-data` volume. The compute
 *  cost is what dominates though, and that stops.
 */

import { getConfig } from "../../config.js";
import { getInstance, stopInstance } from "../remote/aws.js";
import { loadRemoteState } from "../remote/state.js";

export async function teardown(): Promise<void> {
  const cfg = getConfig();
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
  console.log(`  stopped.  pru setup     # to resume`);
  console.log(`  EBS volume ${state.volumeId ?? "?"} preserved; agent state survives.`);
}
