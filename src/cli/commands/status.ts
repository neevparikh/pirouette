/** pru status — show remote instance + local server + agent status. */
import { apiGet } from "../api.js";
import { getConfig } from "../../config.js";
import { getInstance } from "../remote/aws.js";
import { loadRemoteState } from "../remote/state.js";

interface Agent {
  id: string;
  name: string;
  state: string;
  running: boolean;
}

export async function status(): Promise<void> {
  // ---- remote (best-effort; skip if no state / no AWS creds) ----
  const state = loadRemoteState();
  if (state.instanceId) {
    try {
      const inst = await getInstance(state.instanceId, getConfig());
      if (inst) {
        console.log(`remote:`);
        console.log(`  instance   ${inst.id}  (${inst.state})`);
        console.log(`  ip         ${inst.privateIp ?? "—"}`);
        console.log(`  az         ${inst.availabilityZone}`);
        console.log(`  type       ${inst.instanceType}`);
        if (state.volumeId) console.log(`  volume     ${state.volumeId}`);
        console.log("");
      } else {
        console.log(`remote:    instance ${state.instanceId} not found\n`);
      }
    } catch (err) {
      console.log(`remote:    AWS query failed (${err instanceof Error ? err.message : err})\n`);
    }
  }

  // ---- local / tunneled pirouette server ----
  try {
    const health = await apiGet<{ ok: boolean; agents: number }>("/api/health");
    console.log(`server:    ${health.ok ? "ok" : "down"}  (${health.agents} agent(s))`);

    const data = await apiGet<{ agents: Agent[] }>("/api/agents");
    if (data.agents.length > 0) {
      console.log("");
      for (const a of data.agents) {
        const running = a.running ? "running" : "stopped";
        console.log(`  ${a.name} (${a.id}) — ${a.state} [${running}]`);
      }
    }
  } catch (err) {
    if (state.instanceId) {
      console.log(`server:    unreachable (${err instanceof Error ? err.message : err})`);
      console.log("           try:  pru open    # set up SSH port-forward");
    } else {
      console.log(`server:    unreachable (${err instanceof Error ? err.message : err})`);
    }
  }
}
