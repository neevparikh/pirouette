/** HostProvider — abstraction over "where pirouette runs."
 *
 *  Today the only implementation is `EC2Provider`, which reproduces the
 *  existing `pru setup`/`teardown`/`destroy` behaviour. Phase 2 will add a
 *  `ByoHostProvider` that targets an SSH alias the user already manages
 *  (e.g. a METR k8s devpod).
 *
 *  Design goals:
 *    - Existing EC2 deployments must be 100% unaffected by introducing
 *      the abstraction. The interface here is shaped around what the
 *      EC2 path already does; we don't take that path apart yet.
 *    - The interface is wide enough to host `byo-host` and a future
 *      `devpod-k8s` without re-shaping. New providers may no-op some
 *      methods (e.g. `stop`/`destroy` on byo-host where pirouette doesn't
 *      own the host).
 *    - No new runtime deps. Providers shell out to existing tooling
 *      (`aws` CLI, `ssh`, `scp`, eventually `kubectl`).
 *
 *  See docs/plans/2026-05-13-provider-abstraction.md for the full design.
 */

import { getConfig, type PirouetteConfig } from "../../config.js";
import { EC2Provider } from "./providers/ec2.js";

/** Identifier kinds. Stringly-typed `kind` in the state file uses this
 *  union; new providers add their literal here. */
export type ProviderKind = "ec2";

/** Where SSH should connect to reach the host. Either a literal IP/hostname
 *  with explicit user+key+port, or an alias in `~/.ssh/config` that handles
 *  all of that (used by byo-host in Phase 2). */
export interface SshTarget {
  user: string;
  /** IP, hostname, or ssh-config alias. See `useAlias`. */
  host: string;
  port?: number;
  keyPath?: string;
  /** If true, `host` is a `Host` alias from `~/.ssh/config` and the SSH
   *  layer should NOT pass `-i`/`-p`/`-o User=` overrides — the alias
   *  handles those. */
  useAlias?: boolean;
}

/** Inputs to the bootstrap-over-SSH step (Phase 2). Unused in Phase 1
 *  but defined here so the EC2 path can compile against the same shape.
 *  All paths are configurable via TOML on the providers that use them. */
export interface BootstrapEnv {
  /** `$PIROUETTE_DATA_DIR` — server state on the persistent volume. */
  dataDir: string;
  /** `$HOME` target after the persistent-home symlink swap. */
  home: string;
  /** Mount-point of the persistent volume on the remote (e.g. `/data`,
   *  `/var/lib/pirouette`). */
  persistentRoot: string;
  /** SSH login user on the remote. */
  user: string;
  /** Port pirouette server listens on. */
  port: number;
}

export interface ProviderStatus {
  /** Coarse lifecycle state. "absent" means no record in host.json. */
  state: "absent" | "running" | "stopped" | "creating" | "deleting" | "unknown";
  /** Freeform single-line summary rendered by `pru status`. */
  detail: string;
  /** Current SSH target if reachable, else null. */
  sshTarget: SshTarget | null;
  /** Optional extra lines (instance id, AZ, volume, etc.) rendered by
   *  `pru status` after the headline. */
  extraLines?: string[];
}

/** Options shared by the `pru logs` command and provider `buildLogsCommand`
 *  implementations. Defined here (not in commands/logs.ts) so providers
 *  don't import upward from commands/. */
export interface LogsOptions {
  follow?: boolean;
  lines?: string;
  tmux?: boolean;
  entrypoint?: boolean;
  boot?: boolean;
}

/** Output of `buildLogsCommand`. `command` runs on the remote host;
 *  `sshAlias` is the ~/.ssh/config alias to ssh to. */
export interface LogsCommand {
  /** Remote command (will be passed to `ssh <sshAlias> <command>`). */
  command: string;
  /** SSH config alias to connect to. */
  sshAlias: string;
}

export interface HostProvider {
  /** Stable identifier for logs/UX and state.kind. */
  readonly kind: ProviderKind;

  /** Cheap read-only checks: required config keys, credentials present,
   *  SSH/AWS reachable. Throws on failure with an actionable message.
   *  Called at the top of `pru setup` and by `pru preflight`. */
  preflight(): Promise<void>;

  /** Idempotent: create-or-resume. Performs the full lifecycle —
   *  provision compute, attach persistent storage, run the entrypoint,
   *  wait for the server's `/api/health` to respond. Persists state to
   *  `host.json` as it progresses. */
  provision(): Promise<void>;

  /** Stop the host without destroying persistent state. EC2: stops the
   *  instance. byo-host (Phase 2): no-op. */
  stop(): Promise<void>;

  /** Destroy compute and (optionally) persistent storage. */
  destroy(opts: { deletePersistent: boolean; yes?: boolean }): Promise<void>;

  /** Liveness + state for `pru status`. Best-effort: should NOT throw on
   *  transient AWS/SSH errors — surface them in `detail` instead. */
  status(): Promise<ProviderStatus>;

  /** Resolve the SSH target from persisted state. Throws if not provisioned. */
  sshTarget(): SshTarget;

  /** Build the remote command (and target alias) for `pru logs`. EC2 wraps
   *  in `docker exec pirouette …`; other providers run directly. */
  buildLogsCommand(opts: LogsOptions): LogsCommand;
}

/** Provider factory. Reads `provider.kind` from config and instantiates
 *  the matching implementation. Throws on unknown kinds with a clear
 *  message naming the config key. */
export function getProvider(cfg: PirouetteConfig = getConfig()): HostProvider {
  const kind = cfg.provider?.kind ?? "ec2";
  switch (kind) {
    case "ec2":
      return new EC2Provider(cfg);
    default:
      throw new Error(
        `Unknown provider.kind: ${JSON.stringify(kind)}. ` +
          `Edit ~/.pirouette/config.toml; supported values: "ec2".`,
      );
  }
}
