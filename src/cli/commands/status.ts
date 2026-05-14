/** pru status — show host (provider-specific) + local server + agent status. */
import { apiGet } from "../api.js";
import { getProvider } from "../remote/provider.js";
import { loadRemoteState } from "../remote/state.js";

interface Agent {
  id: string;
  name: string;
  state: string;
  running: boolean;
}

export async function status(): Promise<void> {
  // ---- remote host (provider-specific; best-effort) ----
  const state = loadRemoteState();
  const provisioned = Boolean(state.instanceId || state.volumeId);
  if (provisioned) {
    try {
      const s = await getProvider().status();
      // Multi-line format only when we have real instance info to show.
      // "absent" / "unknown" (AWS query error) get the one-liner with the
      // detail message inline — matches pre-refactor behaviour.
      if (s.extraLines && s.extraLines.length > 0) {
        console.log(`remote:`);
        for (const line of s.extraLines) console.log(line);
        console.log("");
      } else {
        console.log(`remote:    ${s.detail}\n`);
      }
    } catch (err) {
      console.log(`remote:    ${err instanceof Error ? err.message : err}\n`);
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
    if (provisioned) {
      console.log(`server:    unreachable (${err instanceof Error ? err.message : err})`);
      console.log("           try:  pru open    # set up SSH port-forward");
    } else {
      console.log(`server:    unreachable (${err instanceof Error ? err.message : err})`);
    }
  }
}
