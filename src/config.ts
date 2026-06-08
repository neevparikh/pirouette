/** Pirouette config loader.
 *
 *  Pirouette manages one or more SSH-reachable hosts the user already owns
 *  (a METR devpod, a long-running VM, a dev container, ...). A single config
 *  file describes every host under `[hosts.<name>]`; commands target one host
 *  at a time, selected with the global `--host <name>` flag (falling back to
 *  `default_host`, or the sole host if only one is defined).
 *
 *  Layering (later wins):
 *    built-in defaults  <  ./pirouette.toml (packaged)  <  ~/.pirouette/config.toml
 *
 *  Use `getConfig()` to read the merged effective config once per invocation,
 *  `selectHostName()` to resolve which host a command targets, and
 *  `resolveHost()` to get the effective per-host settings (with `[defaults]`
 *  merged in and computed dirs/tailscale-hostname applied).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

/** Dotfiles bootstrap inputs. Shared `[defaults.dotfiles]` with optional
 *  `[hosts.<name>.dotfiles]` overrides. */
export interface DotfilesConfig {
  /** Public/SSH git URL to `yadm clone` on first setup. Empty → skip. */
  clone_url: string;
  /** URL returning an `authorized_keys` body (e.g. GitHub `/<user>.keys`).
   *  Empty → skip. */
  authorized_keys_url: string;
}

/** Tailscale integration for a host. When enabled, setup installs tailscale
 *  (if missing), brings it up (interactive login on first boot), and bridges
 *  the tailnet's :443 to the pirouette server's loopback bind via
 *  `tailscale serve`. */
export interface TailscaleConfig {
  enabled: boolean;
  /** Tailnet hostname. Empty → derived as `pirouette-<ssh_alias>`. */
  hostname: string;
  /** Symlink `/var/lib/tailscale` onto the persistent volume so the node key
   *  survives host recreate. Default true. */
  state_persistent: boolean;
}

/** Values shared across hosts unless a host overrides them. */
export interface DefaultsConfig {
  /** npm package spec the host installs globally (e.g.
   *  `@your-scope/pirouette@latest`). */
  npm_package: string;
  /** Default model when `pru launch` / the web UI doesn't pass one. */
  default_model: string;
  /** Default thinking level for new agents. Empty = "off". */
  default_thinking_level: string;
  /** Port the pirouette server binds on the host. Default 7777. */
  port: number;
  /** Address the server binds on the host. Default `127.0.0.1` (reach via
   *  SSH tunnel). Set `0.0.0.0` when something in front of the loopback bind
   *  needs to reach it (a docker `-p` mapping, a host-level `tailscale
   *  serve`, ...). */
  bind_host: string;
  dotfiles: DotfilesConfig;
}

/** Per-host config as written in TOML (`[hosts.<name>]`). All fields except
 *  the SSH triple are optional and fall back to `[defaults]` / computed
 *  values; see `resolveHost`. */
export interface HostConfig {
  /** Entry in `~/.ssh/config` (e.g. "gpu"). Pirouette runs `ssh <alias>`;
   *  the alias owns identity/user/port. Required. */
  ssh_alias: string;
  /** SSH login user on the remote (owns `$HOME`). Required. */
  user: string;
  /** Mount-point of the persistent volume on the remote (e.g. `/data`).
   *  Anything under here survives host recreate. Required. */
  persistent_root: string;
  /** Override `$HOME` target. Default `${persistent_root}/home/${user}`. */
  home_dir: string;
  /** Override `$PIROUETTE_DATA_DIR`. Default
   *  `${persistent_root}/pirouette/data`. */
  data_dir: string;
  /** Override `[defaults].bind_host` for this host. */
  bind_host: string;
  /** Skip the bootstrap's home-migration on `pru setup`. Set true when the
   *  host is already set up the way you want (e.g. a docker container whose
   *  `$HOME` is a bind-mount, not a symlink). */
  adopt: boolean;
  /** Dashboard URL — `pru open` target + CLI API base. */
  public_url: string;
  /** Extra hostnames accepted in HTTP `Host` / WS `Origin` headers. */
  allowed_hosts: string[];
  // ---- optional per-host overrides of [defaults] scalars ----
  npm_package: string;
  default_model: string;
  default_thinking_level: string;
  port: number;
  tailscale: TailscaleConfig;
  dotfiles: DotfilesConfig;
}

export interface PirouetteConfig {
  /** Host targeted when `--host` isn't passed. Empty → use the sole host if
   *  there's exactly one, else error. */
  default_host: string;
  defaults: DefaultsConfig;
  /** Named hosts, keyed by `<name>` from `[hosts.<name>]`. */
  hosts: Record<string, Partial<HostConfig>>;
}

/** Built-in fallback values. The packaged `pirouette.toml` is the real source
 *  of generic defaults; this is a last resort if that file is missing. No
 *  hosts are defined here — those are always user-specific. */
const BUILTIN_DEFAULTS: PirouetteConfig = {
  default_host: "",
  defaults: {
    npm_package: "",
    default_model: "",
    default_thinking_level: "",
    port: 7777,
    bind_host: "127.0.0.1",
    dotfiles: { clone_url: "", authorized_keys_url: "" },
  },
  hosts: {},
};

export interface ConfigSource {
  path: string;
  exists: boolean;
  data: Partial<PirouetteConfig>;
}

/** Find the packaged pirouette.toml by walking up from this source file.
 *  One level up reaches the package root in both dev (src/) and built (dist/)
 *  layouts. */
function repoConfigPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "pirouette.toml");
}

/** Location of the user override config. */
export function userConfigPath(): string {
  return path.join(homedir(), ".pirouette", "config.toml");
}

function loadTomlIfExists(p: string): ConfigSource {
  try {
    const raw = readFileSync(p, "utf8");
    return { path: p, exists: true, data: parseToml(raw) as Partial<PirouetteConfig> };
  } catch {
    return { path: p, exists: false, data: {} };
  }
}

/** Deep-merge `b` on top of `a`. Plain objects merge recursively; arrays and
 *  scalars replace. */
function deepMerge<T>(a: T, b: Partial<T>): T {
  if (a === null || a === undefined) return b as T;
  if (b === null || b === undefined) return a;
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
    return b as T;
  }
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge((a as Record<string, unknown>)[k], v as Partial<unknown>);
  }
  return out as T;
}

export interface LoadedConfig {
  config: PirouetteConfig;
  sources: ConfigSource[];
}

export function loadConfig(): LoadedConfig {
  const sources: ConfigSource[] = [
    loadTomlIfExists(repoConfigPath()),
    loadTomlIfExists(userConfigPath()),
  ];

  let config: PirouetteConfig = BUILTIN_DEFAULTS;
  for (const s of sources) {
    if (s.exists) config = deepMerge(config, s.data);
  }
  return { config, sources };
}

let cached: LoadedConfig | null = null;
export function getConfig(): PirouetteConfig {
  if (!cached) cached = loadConfig();
  return cached.config;
}

/** Reset cached config (used by tests). */
export function resetConfigCache(): void {
  cached = null;
}

// ---- host selection + resolution ----------------------------------------

/** Names of all configured hosts. */
export function listHostNames(config: PirouetteConfig = getConfig()): string[] {
  return Object.keys(config.hosts ?? {});
}

/** Resolve which host a command targets. Precedence:
 *    1. `explicit` (the global `--host` flag, threaded via
 *       `$PIROUETTE_SELECTED_HOST` set in the CLI preAction hook)
 *    2. `config.default_host`
 *    3. the sole host if exactly one is defined
 *  Throws an actionable error otherwise. */
export function selectHostName(
  explicit?: string,
  config: PirouetteConfig = getConfig(),
): string {
  const names = listHostNames(config);
  const chosen = explicit ?? process.env.PIROUETTE_SELECTED_HOST ?? config.default_host ?? "";

  if (chosen) {
    if (!names.includes(chosen)) {
      throw new Error(
        `Unknown host ${JSON.stringify(chosen)}. ` +
          (names.length > 0
            ? `Configured hosts: ${names.join(", ")}. `
            : `No hosts configured. `) +
          `Define [hosts.${chosen}] in ${userConfigPath()}.`,
      );
    }
    return chosen;
  }

  if (names.length === 1) return names[0];
  if (names.length === 0) {
    throw new Error(
      `No hosts configured. Add a [hosts.<name>] block to ${userConfigPath()}.\n\n` +
        EXAMPLE_CONFIG,
    );
  }
  throw new Error(
    `Multiple hosts configured (${names.join(", ")}); pick one with --host <name> ` +
      `or set default_host in ${userConfigPath()}.`,
  );
}

/** Effective per-host config: `[defaults]` merged with `[hosts.<name>]`, plus
 *  computed `home_dir`/`data_dir`/tailscale hostname. */
export interface EffectiveHostConfig {
  name: string;
  ssh_alias: string;
  user: string;
  persistent_root: string;
  home_dir: string;
  data_dir: string;
  bind_host: string;
  adopt: boolean;
  port: number;
  npm_package: string;
  default_model: string;
  default_thinking_level: string;
  public_url: string;
  allowed_hosts: string[];
  dotfiles: DotfilesConfig;
  tailscale: TailscaleConfig;
}

/** Resolve the effective config for a named host. Throws if the host is not
 *  defined or is missing a required field (ssh_alias / user / persistent_root). */
export function resolveHost(
  name: string,
  config: PirouetteConfig = getConfig(),
): EffectiveHostConfig {
  const h = config.hosts?.[name];
  if (!h) {
    throw new Error(
      `Host ${JSON.stringify(name)} is not defined in ${userConfigPath()}. ` +
        `Add a [hosts.${name}] block.`,
    );
  }

  const d = config.defaults;
  const missing: string[] = [];
  if (!h.ssh_alias) missing.push(`hosts.${name}.ssh_alias`);
  if (!h.user) missing.push(`hosts.${name}.user`);
  if (!h.persistent_root) missing.push(`hosts.${name}.persistent_root`);
  const npm_package = h.npm_package || d.npm_package;
  if (!npm_package) missing.push(`hosts.${name}.npm_package (or defaults.npm_package)`);
  if (missing.length > 0) {
    throw new Error(
      `Missing required config for host ${JSON.stringify(name)}:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n\nSet them in ${userConfigPath()}. Example:\n\n${EXAMPLE_CONFIG}`,
    );
  }

  const ts: Partial<TailscaleConfig> = h.tailscale ?? {};
  const dot: Partial<DotfilesConfig> = h.dotfiles ?? {};
  return {
    name,
    ssh_alias: h.ssh_alias!,
    user: h.user!,
    persistent_root: h.persistent_root!,
    home_dir: h.home_dir || `${h.persistent_root}/home/${h.user}`,
    data_dir: h.data_dir || `${h.persistent_root}/pirouette/data`,
    bind_host: h.bind_host || d.bind_host || "127.0.0.1",
    adopt: h.adopt === true,
    port: h.port ?? d.port ?? 7777,
    npm_package,
    default_model: h.default_model ?? d.default_model ?? "",
    default_thinking_level: h.default_thinking_level ?? d.default_thinking_level ?? "",
    public_url: h.public_url ?? "",
    allowed_hosts: h.allowed_hosts ?? [],
    dotfiles: {
      clone_url: dot.clone_url ?? d.dotfiles.clone_url ?? "",
      authorized_keys_url: dot.authorized_keys_url ?? d.dotfiles.authorized_keys_url ?? "",
    },
    tailscale: {
      enabled: ts.enabled === true,
      hostname:
        ts.hostname ||
        `pirouette-${(h.ssh_alias ?? name).replace(/[^a-zA-Z0-9-]+/g, "-")}`.slice(0, 63),
      state_persistent: ts.state_persistent !== false,
    },
  };
}

/** Convenience: resolve the host the current invocation targets (honouring
 *  `--host` via `$PIROUETTE_SELECTED_HOST`). */
export function resolveSelectedHost(
  config: PirouetteConfig = getConfig(),
): EffectiveHostConfig {
  return resolveHost(selectHostName(undefined, config), config);
}

const EXAMPLE_CONFIG = [
  `default_host = "gpu"`,
  ``,
  `[defaults]`,
  `npm_package   = "@your-scope/pirouette@latest"`,
  `default_model = "anthropic/claude-sonnet-4-5"`,
  ``,
  `[hosts.gpu]`,
  `ssh_alias       = "gpu"           # entry in ~/.ssh/config`,
  `user            = "you"           # SSH login user`,
  `persistent_root = "/data"         # mount-point of your persistent volume`,
  `public_url      = "https://pirouette-gpu.<tailnet>.ts.net"  # optional`,
].join("\n");
