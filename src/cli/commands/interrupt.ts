/** pru interrupt <agent> — cancel an agent's in-flight turn.
 *
 *  The CLI twin of hitting Escape in the dashboard (or in pi's TUI): the
 *  session stays alive and ready for the next message, only the current
 *  turn / compaction / bash run is cancelled. Use `pru stop` when you
 *  actually want the agent down. */
import { apiPost } from "../api.js";

/** Response shape of POST /api/agents/:id/interrupt. Declared locally
 *  (rather than imported from the server) to match the other commands --
 *  the CLI talks to the API over HTTP, not to the server's module graph. */
interface InterruptResult {
  interrupted: boolean;
  cancelled: string[];
  cleared: { steering: string[]; followUp: string[] };
  settled: boolean;
}

export async function interrupt(agent: string): Promise<void> {
  try {
    const result = await apiPost<InterruptResult>(`/api/agents/${agent}/interrupt`);
    if (!result.interrupted) {
      console.log(`· agent ${agent} had nothing in flight`);
      return;
    }
    const what = result.cancelled.join(" + ");
    console.log(
      `✓ agent ${agent}: interrupted ${what}` + (result.settled ? "" : " (abort still settling)"),
    );
    const dropped = [...result.cleared.steering, ...result.cleared.followUp];
    if (dropped.length > 0) {
      console.log(`  dropped ${dropped.length} queued message(s):`);
      for (const m of dropped) {
        const head = m.length > 70 ? `${m.slice(0, 68)}…` : m;
        console.log(`    · ${head.replace(/\n/g, " ")}`);
      }
    }
  } catch (err) {
    console.error(`✗ failed to interrupt agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
