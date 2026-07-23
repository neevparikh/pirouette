# pirouette

Run long-lived [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
coding agents on a host you already have, with a web dashboard for talking
to them and a CLI (`pru`) for managing the box.

You point pirouette at one or more SSH-reachable Linux hosts. It installs
itself over SSH and runs a pool of pi agents inside a tmux session. Each
agent gets its own git worktree so they can work on different branches in
parallel.

## What this is

- **Bring-your-own host.** Pirouette doesn't provision or own infrastructure.
  You give it an SSH alias to a host you already manage — a METR k8s devpod,
  a long-running VM, a dev container, your team's shared researcher box — and
  it installs itself there over SSH. No cloud API calls.
- **Single-user.** Designed for one person. No multi-user features, no public
  access path.
- **Long-running.** Agents survive SSH disconnects, browser refreshes, and
  host restarts (state lives on a persistent volume you point pirouette at).
- **Pi-native.** Uses [pi-coding-agent](https://github.com/badlogic/pi-mono)
  directly — same session format, same extensions, same provider plumbing.
- **Web + CLI.** Browser dashboard for chatting; `pru` for setup, shelling
  in, viewing logs, shipping local changes.
- **Multi-host.** One config file describes every host under `[hosts.<name>]`;
  target one at a time with `--host <name>`.

## What this isn't

- **Not a multi-tenant service.** Anyone who can reach the dashboard's port
  has full shell access on the host (the agents have bash/edit/write tools by
  design). The perimeter is the SSH tunnel (or your tailnet ACL). See
  [Trust model](#trust-model).
- **Not yet authenticated** at the application layer.
- **Not an `eval`-style harness.** No sandboxing of agent actions beyond what
  the host itself provides.

## Install

```bash
npm install -g @neevparikh/pirouette   # provides both `pirouette` and `pru`
```

## Requirements for a host

Any host you target needs:

- `node` + `npm`
- `git`, `tmux`, `curl`, an OpenSSH server
- a non-root user with passwordless `sudo`
- a persistent directory (survives host recreate) for pirouette's state
- (optional) `yadm` for dotfiles

You also need an `~/.ssh/config` entry for the host so `ssh <alias>` works.

## Quick start

1. Make sure you can reach the host: an `~/.ssh/config` entry with `HostName`,
   `User`, etc., and `ssh gpu echo ok` succeeds.

2. Write `~/.pirouette/config.toml`:

   ```toml
   default_host = "gpu"

   [defaults]
   npm_package   = "@neevparikh/pirouette@latest"
   default_model = "anthropic/claude-sonnet-4-5"

   [hosts.gpu]
   ssh_alias       = "gpu"            # entry in ~/.ssh/config
   user            = "you"            # SSH login user
   persistent_root = "/data"          # mount-point of the persistent volume
   # data_dir      = ""               # optional; default ${persistent_root}/pirouette/data
   # home_dir      = ""               # optional; default ${persistent_root}/home/${user}

   [hosts.gpu.tailscale]
   enabled  = true                    # bridge the dashboard onto your tailnet
   hostname = "pirouette-gpu"

   [defaults.dotfiles]                # optional
   clone_url           = "git@github.com:you/dotfiles.git"
   authorized_keys_url = "https://github.com/you.keys"
   ```

3. Set it up:

   ```bash
   pru setup        # upload bootstrap, run it (install + tmux server), push secrets
   ```

   `pru setup` uploads a bootstrap script over SSH that migrates `$HOME` onto
   the persistent volume, clones dotfiles, installs the pirouette package,
   starts the server in tmux, and (if enabled) brings up Tailscale. It's
   idempotent — safe to re-run.

If Tailscale is enabled, setup prints an `https://<host>.<tailnet>.ts.net`
URL; drop it into `hosts.gpu.public_url`. Otherwise reach the dashboard via
an SSH tunnel (the server binds `127.0.0.1` on the host):

```bash
ssh -fN -L 7777:localhost:7777 gpu
export PIROUETTE_URL=http://localhost:7777
```

Day-to-day:

```bash
pru open          # open the dashboard URL in your browser
pru ssh           # shell into the host
pru status        # SSH probe + server health
pru logs -f       # tail server logs
pru sync          # rebuild locally -> install on host -> restart server
pru sync --npm    # upgrade to the latest published package
pru sync --secrets   # re-push laptop auth state
pru teardown      # kill the pirouette tmux session (host stays up)
pru destroy       # clear local state (use --delete-data to also rm the persistent dirs)
```

### Targeting multiple hosts

Add more `[hosts.<name>]` blocks and select per-invocation:

```bash
pru --host gpu status
pru --host ec2 logs -f
```

If `--host` is omitted, pirouette uses `default_host`, or the sole host if
only one is defined.

### Adopting an already-set-up host (e.g. a dev container)

If a host is already laid out the way you want — most commonly a Docker
container whose `$HOME` is a bind-mount rather than a symlink pirouette
should move — set `adopt` and (for containers behind a port-map or a
host-level `tailscale serve`) `bind_host`:

```toml
[hosts.ec2]
ssh_alias       = "pirouette-container"   # the alias that lands in the container
user            = "neev"
persistent_root = "/data"
data_dir        = "/data"                 # reuse existing data in place
home_dir        = "/home/neev"            # the container's bind-mounted home
bind_host       = "0.0.0.0"               # keep docker -p / tailscale-serve working
adopt           = true                    # skip the home-migration on setup
public_url      = "https://pirouette-neev.<tailnet>.ts.net"
```

With `adopt = true`, `pru setup` skips the `$HOME` migration. Setup is
idempotent and **non-disruptive**: it won't reinstall pirouette if it's
already present, and won't restart the tmux server if it's already running —
so it's safe to run against a box that's already serving, but it also won't
*apply* a new version or changed config on its own. Use `pru sync` (local
build) or `pru sync --npm` (published) to upgrade + restart a running host.

> Container note: if you reach the box through a docker `-p` mapping or a
> host-level `tailscale serve`, set `bind_host = "0.0.0.0"` — otherwise a
> `pru sync` restart rebinds the server to loopback and the dashboard goes
> dark. `pru setup` warns when `adopt` is set but `bind_host` is loopback.

## Quick start (local dev)

For developing pirouette itself, or running agents locally without a remote
host:

```bash
pirouette server                # binds 127.0.0.1:7777
open http://localhost:7777
```

Local mode runs the server process directly. Set
`PIROUETTE_URL=http://localhost:7777` in the same shell so the CLI talks to
your local server.

## Configuration

Pirouette reads TOML from three places, in order (later wins):

1. Built-in defaults
2. `./pirouette.toml` (packaged with the tool; generic defaults only)
3. `~/.pirouette/config.toml` (your hosts + per-user overrides; not checked in)

`pru config show` prints the effective merged config; `pru config edit` opens
your override file in `$EDITOR`.

### Schema

| key | scope | what it is |
|---|---|---|
| `default_host` | top-level | Host used when `--host` isn't passed |
| `defaults.npm_package` | defaults | npm spec installed on the host (required) |
| `defaults.default_model` | defaults | Model used when none is specified |
| `defaults.default_thinking_level` | defaults | `off`/`minimal`/`low`/`medium`/`high` |
| `defaults.port` | defaults | Server port (default 7777) |
| `defaults.bind_host` | defaults | Server bind address (default `127.0.0.1`) |
| `defaults.dotfiles.clone_url` | defaults | `yadm clone` URL (optional) |
| `defaults.dotfiles.authorized_keys_url` | defaults | authorized_keys URL (optional) |
| `hosts.<name>.ssh_alias` | host | `~/.ssh/config` alias (required) |
| `hosts.<name>.user` | host | SSH login user (required) |
| `hosts.<name>.persistent_root` | host | Mount-point of the persistent volume (required) |
| `hosts.<name>.data_dir` | host | Override `$PIROUETTE_DATA_DIR` |
| `hosts.<name>.home_dir` | host | Override `$HOME` target |
| `hosts.<name>.bind_host` | host | Override `defaults.bind_host` |
| `hosts.<name>.adopt` | host | Skip the home-migration on setup |
| `hosts.<name>.public_url` | host | Dashboard URL (API base / `pru open`) |
| `hosts.<name>.allowed_hosts` | host | Extra `Host`/`Origin` header values |
| `hosts.<name>.tailscale.*` | host | Tailscale bring-up (see below) |

Any `defaults` scalar (`npm_package`, `default_model`, `port`, ...) can be
overridden inside a `[hosts.<name>]` block. `[defaults.dotfiles]` can be
overridden per host under `[hosts.<name>.dotfiles]`.

## Commands

### Agents

| command | purpose |
|---|---|
| `pru launch <name>` | Create a new pi agent (`--project`, `--model`, `--thinking` optional) |
| `pru list` | List all agents and their state |
| `pru send <agent> <msg>` | Send a message to an agent |
| `pru stop <agent>` | Stop an agent (keeps its state) |
| `pru rm <agent>` | Remove an agent; `--all` also deletes its worktree + session files |
| `pru status` | Show host + server health |

You can also create agents from the web UI by typing `@<newname> message`
in the input bar.

### Host

All host commands accept the global `--host <name>` selector.

| command | purpose |
|---|---|
| `pru setup` | Set up / refresh the host (bootstrap + start the server) |
| `pru teardown` | Kill the pirouette tmux session (host stays up; state preserved) |
| `pru destroy [--delete-data]` | Clear local state; `--delete-data` also nukes the host's persistent dirs |
| `pru open` | Open the dashboard (uses `public_url` / `PIROUETTE_URL`) |
| `pru ssh` | Shell into the host's SSH alias |
| `pru tunnel <port>` | Forward an extra port (mainly OAuth loopback flows — see below) |
| `pru logs [-f]` | Tail server logs (`--tmux`, `--entrypoint` for other sources) |
| `pru sync` | Rebuild locally → install on host → restart server |
| `pru sync --npm` | Upgrade the host from the npm registry |
| `pru sync --secrets` | Re-push laptop auth state (`auth.json` etc.) without redeploying |
| `pru self-update` | Update pirouette **from inside the host** (safe for agents — see below) |

### Self-update (agents updating their own host)

`pru sync --npm` runs from your laptop over SSH. But an **agent** running
*inside* pirouette can't safely update its own instance that way: an agent's
shell commands are child processes of the `pirouette.service` systemd cgroup,
so the naive

```sh
npm install -g @neevparikh/pirouette@latest && sudo systemctl restart pirouette
```

self-destructs — restarting the service kills the whole cgroup, including the
very command doing the restart. Any follow-on step never runs.

`pru self-update` fixes this. It launches the install-and-restart work into a
**detached systemd transient unit** (`sudo systemd-run`), i.e. its own cgroup
outside `pirouette.service`, then returns immediately:

```sh
pru self-update                 # reinstall the configured package @latest + restart
pru self-update --target 1.2.3  # pin a specific version
pru self-update --package @scope/fork@next
```

Because the worker lives in a separate cgroup, the service restart doesn't kill
it. The old server exits gracefully (persisting every running agent as
`shutdown` state), and the new server's `resumeAll()` brings those agents back
with their conversations intact — including the agent that kicked off the
update. Follow progress with `journalctl -u pirouette-self-update -f` or
`pru logs` after the restart.

> The systemd unit uses `KillMode=mixed`, so on stop/restart only the main
> server process gets `SIGTERM` first — giving it a window to persist agent
> state before systemd `SIGKILL`s any leftover children. This is what makes
> resume-after-restart reliable.

### Config

| command | purpose |
|---|---|
| `pru config show` | Show effective merged config |
| `pru config path` | Print config file search paths |
| `pru config edit` | Open `~/.pirouette/config.toml` in `$EDITOR` |

### Environment variables

| var | default | purpose |
|---|---|---|
| `PIROUETTE_SELECTED_HOST` | — | Host to target (set by `--host`) |
| `PIROUETTE_URL` | selected host's `public_url` | CLI → server URL (overrides config) |
| `PIROUETTE_HOST` | `127.0.0.1` | Server bind host (set on the host by setup) |
| `PIROUETTE_PORT` | `7777` | Server port |
| `PIROUETTE_DATA_DIR` | `.pirouette/data` | Server data directory |

## Authenticating tools inside the host

Most modern CLIs support **device flow** — they print a URL and a short code,
you approve on any device. No local callback, no port forwarding:

| tool | what to run |
|---|---|
| AWS SSO | `aws sso login` |
| GitHub CLI | `gh auth login --web` |
| gcloud | `gcloud auth login --no-launch-browser` |
| Tailscale | `tailscale up` |

For these, `pru ssh`, run the command, copy the URL into your laptop browser,
approve, done.

The exception is OAuth tools that **only** support the "loopback IP" flow
(e.g. `gws`). For these, forward the callback port:

```bash
# Terminal 1 — on the host
pru ssh
gws auth login --services drive,sheets
# Note the port from the URL, e.g. redirect_uri=http://localhost:42103

# Terminal 2 — on laptop
pru tunnel 42103
# (foreground; ctrl-c to close when auth is done)

# Then paste the URL gws printed into your browser.
```

Use `LOCAL:REMOTE` (e.g. `pru tunnel 8080:42103`) for asymmetric ports, or
`--background` to add the forward and return (close with `pru tunnel --close
42103`).

## Trust model

Pirouette has no application-layer authentication. The HTTP and WebSocket
APIs are open to anyone who can reach the listener. What keeps that narrow:

- **Loopback bind (default).** The server binds `127.0.0.1` on the host; the
  only way in is an SSH tunnel from your laptop. The host's network can't
  reach the listener at all — safe even on a shared k8s pod network.
- **`bind_host = "0.0.0.0"` (opt-in).** Needed when something in front of the
  loopback bind must reach it (a docker `-p` mapping, a host-level `tailscale
  serve`). The perimeter is then whatever fronts it (the SSH tunnel into the
  container, or your tailnet ACL).
- **Tailscale.** When `tailscale.enabled`, the server stays bound to loopback;
  `tailscale serve` (same netns) bridges the tailnet's :443 to it. The
  perimeter is your tailnet ACL.
- **Same-origin web app.** The dashboard is served from the same listener as
  the API. Cross-origin requests are rejected by `Host` (HTTP) and `Origin`
  (WebSocket) validation; no `Access-Control-Allow-*` headers. (DNS-rebinding
  defense; not auth.) Non-loopback hostnames must be allow-listed via
  `hosts.<name>.allowed_hosts`.

In practice: **anyone who can open a TCP connection to the dashboard port has
shell access on the host.** The agents have full bash/edit/write tools by
design.

### Things you're trusting (the supply chain)

- The npm package `@neevparikh/pirouette` (or whatever `defaults.npm_package`
  points at).
- The dotfiles repo at `dotfiles.clone_url`.
- The keys served at `dotfiles.authorized_keys_url`.
- Trust-on-first-use SSH host keys (governed by your `~/.ssh/config`).

Browser libraries (marked, marked-highlight, DOMPurify, highlight.js,
Tailwind) are vendored at build time — no CDN dependency at runtime.

## Architecture

```
Your laptop                         Host (devpod / VM / container)
───────────         SSH tunnel      ──────────────────────────────
pru CLI  ───────  localhost:7777 ─────── :7777  pirouette server
                  (or tailscale serve)            ├── agent manager (pi SDK)
Browser  ───────  localhost:7777 ─────── :7777   ├── HTTP + WebSocket
                                                  └── web dashboard (static)
pru ssh ─────────────── ssh <alias> ───────────  tmux: pirouette server
                                                                     │
                                  persistent volume ($PIROUETTE_DATA_DIR,
                                  $HOME) ─────────────────────────────┘
```

## License

MIT.
