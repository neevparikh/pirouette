/** `pru setup` — provision (or resume) the host pirouette runs on.
 *
 *  Thin dispatcher around the provider abstraction. For `kind = "ec2"`
 *  (the default and only provider in Phase 1), the heavy lifting lives in
 *  `src/cli/remote/providers/ec2.ts` — this file just orchestrates
 *  preflight → provision.
 *
 *  Idempotent: safe to re-run. The provider's `provision()` is responsible
 *  for the "found existing host, just resume it" fast path.
 *
 *  See docs/plans/2026-05-13-provider-abstraction.md for the design.
 */

import { getProvider } from "../remote/provider.js";

export async function setup(): Promise<void> {
  const provider = getProvider();
  await provider.preflight();
  await provider.provision();
}
