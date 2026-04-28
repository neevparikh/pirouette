/** pru send <agent> <message> — send a message to an agent. */
import { apiPost } from "../api.js";

export async function send(agent: string, message: string): Promise<void> {
  try {
    await apiPost(`/api/agents/${agent}/message`, { message });
    console.log(`✓ message sent to ${agent}`);
  } catch (err) {
    console.error(`✗ failed to send message: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
