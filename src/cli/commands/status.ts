/** `pru status` — show the selected host's state + the pirouette server +
 *  agent status. */
import { apiGet } from "../api.js";
import { getHost } from "../remote/host.js";

interface Agent {
  id: string;
  name: string;
  state: string;
  running: boolean;
}

export async function status(): Promise<void> {
  // ---- remote host (best-effort) ----
  try {
    const s = await getHost().status();
    console.log("host:");
    for (const line of s.extraLines ?? []) console.log(line);
    console.log("");
  } catch (err) {
    console.log(`host:      ${err instanceof Error ? err.message : err}\n`);
  }

  // ---- pirouette server + agents ----
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
    console.log(`server:    unreachable (${err instanceof Error ? err.message : err})`);
    console.log("           set hosts.<name>.public_url or export PIROUETTE_URL,");
    console.log("           or open an SSH tunnel (see `pru setup` output).");
  }
}
