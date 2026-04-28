/** pru rm <agent> — remove an agent and optionally its worktree/sessions. */
import { apiDelete } from "../api.js";

export async function rm(
  agent: string,
  opts: { worktree?: boolean; sessions?: boolean; all?: boolean },
): Promise<void> {
  const deleteWorktree = !!(opts.all || opts.worktree);
  const deleteSessions = !!(opts.all || opts.sessions);
  const qs = new URLSearchParams();
  if (deleteWorktree) qs.set("deleteWorktree", "true");
  if (deleteSessions) qs.set("deleteSessions", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  try {
    await apiDelete(`/api/agents/${agent}${suffix}`);
    const extras: string[] = [];
    if (deleteWorktree) extras.push("worktree");
    if (deleteSessions) extras.push("sessions");
    const extraStr = extras.length ? ` (also deleted: ${extras.join(", ")})` : "";
    console.log(`✓ removed ${agent}${extraStr}`);
  } catch (err) {
    console.error(`✗ failed to remove agent: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
