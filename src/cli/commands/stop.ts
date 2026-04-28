/** pru stop <agent> — stop an agent. */
import { apiPost } from "../api.js";

export async function stop(agent: string): Promise<void> {
  try {
    await apiPost(`/api/agents/${agent}/stop`);
    console.log(`✓ agent ${agent} stopped`);
  } catch (err) {
    console.error(`✗ failed to stop agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
