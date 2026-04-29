# pirouette

Run long-lived [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
coding agents on a cloud VM, with a web dashboard for talking to them
and a CLI (`pru`) for managing the box.

You provision one EC2 instance with a Docker container; pirouette's server
runs inside the container and manages a pool of pi agents. Each agent gets
its own git worktree so they can work on different branches in parallel.

## What this is

- **Single-user.** Designed for one person on one cloud box. No multi-user
  features, no public access path.
- **Long-running.** Agents survive across SSH disconnects, browser
  refreshes, container restarts, even instance reboots (state lives on
  a persistent EBS volume).
- **Pi-native.** Uses [pi-coding-agent](https://github.com/badlogic/pi-mono)
  directly — same session format, same extensions, same provider plumbing.
  If you've used pi locally you'll recognize the model.
- **Web + CLI.** Browser dashboard for chatting; `pru` for provisioning,
  shelling in, viewing logs, shipping local changes.

## What this isn't

- **Not a multi-tenant service.** Anyone who can reach the dashboard's
  port has full shell access on your container (the agents have
  bash/edit/write tools by design). Today the only thing keeping that
  perimeter narrow is your AWS security group + SSH tunnel.
  See [Trust model](#trust-model) below.
- **Not yet authenticated** at the application layer. A random shared
  bearer token is on the roadmap.
- **Not an `eval`-style harness.** No sandboxing of agent actions
  beyond what the container itself provides.

## Install

```bash
npm install -g @neevparikh/pirouette   # provides both `pirouette` and `pru`
```

## Quick start (cloud)

The primary use case. Provisions an EC2 instance, attaches a 500 GiB
EBS volume, runs your Docker image, installs pirouette inside it, and
opens a browser to the dashboard via SSH tunnel.

One-time setup:

1. Install the AWS CLI and `aws sso login` (or otherwise authenticate)
   to a profile that can create EC2 + EBS in your target region.
2. Create `~/.pirouette/config.toml` with your AWS network info — see
   [Configuration](#configuration) below.

Then:

```bash
pru preflight     # read-only: verify AWS config + resource discovery
pru setup         # provision: instance + EBS + container + server
pru open          # SSH-tunnel :7777 to the container, open browser
```

Day-to-day:

```bash
pru open          # tunnel + browser (idempotent — safe to re-run)
pru ssh           # shell into the container
pru status        # instance state + server health
pru logs -f       # tail server logs
```

When you're done for a while:

```bash
pru teardown      # stop the instance; EBS preserved (state survives)
```

To rebuild from scratch:

```bash
pru destroy [--delete-volume]   # terminate; optionally also delete EBS
```

## Quick start (local dev)

For developing pirouette itself, or running agents locally without an
EC2 box:

```bash
pirouette server                # binds 127.0.0.1:7777
open http://localhost:7777
```

Local mode skips the entire AWS / Docker / SSH-tunnel layer — you're
just running the server process directly. Most useful for working on
the dashboard or the server code.

## Configuration

Pirouette reads TOML from three places, in order (later wins):

1. Built-in defaults
2. `./pirouette.toml` (packaged with the tool; generic defaults only)
3. `~/.pirouette/config.toml` (your per-user overrides; not checked in)

`pru config show` prints the effective merged config; `pru config edit`
opens your override file in `$EDITOR`.

### Required fields for `pru setup`

`pru setup` will refuse to run until these are set in
`~/.pirouette/config.toml`:

| key | what it is |
|---|---|
| `aws.network.vpc_name` | Name tag of the VPC to launch into |
| `aws.network.subnet_name_pattern` | Name-tag glob for private subnets; first alphabetical match wins |
| `aws.network.security_group_name` | Existing SG attached to the instance (must allow SSH inbound from your location) |
| `aws.tags.Owner` | Tag applied to every created resource — usually your email |
| `instance.key_name` | An existing EC2 keypair; if missing, pirouette imports `ssh.public_key_path` under this name |
| `container.image` | Dev container image the instance runs (see [container requirements](#container-image-requirements)) |
| `container.container_user` | Non-root user baked into that image (used for bind-mount paths) |
| `container.npm_package` | The npm package spec to install inside the container (e.g. `@your-scope/pirouette@latest`) |

### Container image requirements

Any image you use as `container.image` needs:

- A non-root user (`container.container_user`) with passwordless `sudo`
- `node` + `npm` installed globally
- `tmux`, `git`, `curl`, and an `ssh` server
- (Optional) `yadm` if you want dotfiles support

[`npx27/dev-unfetched`](https://hub.docker.com/r/npx27/dev-unfetched)
satisfies all of this out of the box (Arch Linux, user `neev`, uid
1000). Build your own for a leaner footprint.

### Minimal `~/.pirouette/config.toml`

```toml
[aws]
profile = "my-aws-profile"
region  = "us-west-2"

[aws.network]
vpc_name            = "my-vpc"
subnet_name_pattern = "my-private-subnet-*"
security_group_name = "my-dev-sg"

[aws.tags]
Owner = "you@example.com"

[instance]
key_name = "you@example.com"

[container]
image          = "npx27/dev-unfetched:latest"   # or your own image
container_user = "neev"                         # match your image's user
npm_package    = "@neevparikh/pirouette@latest"

# Optional — both are skipped if empty.
[dotfiles]
clone_url           = "https://github.com/you/dotfiles.git"
authorized_keys_url = "https://github.com/you.keys"
```

## Commands

### Agents

| command | purpose |
|---|---|
| `pru launch <name>` | Create a new pi agent (`--repo`, `--model`, `--thinking` optional) |
| `pru list` | List all agents and their state |
| `pru send <agent> <msg>` | Send a message to an agent |
| `pru stop <agent>` | Stop an agent (keeps its state) |
| `pru rm <agent>` | Remove an agent; `--all` also deletes its worktree + session files |
| `pru status` | Show remote instance + server health |

You can also create agents from the web UI by typing `@<newname> message`
in the input bar.

### Infrastructure

| command | purpose |
|---|---|
| `pru preflight` | Read-only: validate AWS config + resource discovery |
| `pru setup` | Provision / resume the EC2 instance + start the container |
| `pru teardown` | Stop the instance; EBS preserved |
| `pru destroy [--delete-volume]` | Terminate; optionally delete EBS |
| `pru open` / `pru close` | Manage the SSH port-forward to :7777 |
| `pru ssh` / `pru ssh --host` | Shell into the container (agent forwarded) / the EC2 host |
| `pru tunnel <port>` | Forward an extra port (mainly for OAuth loopback flows — see below) |
| `pru logs [-f]` | Tail server logs (`--tmux`, `--entrypoint`, `--boot` for other sources) |
| `pru sync` | Ship local changes to the remote container (dev loop) |
| `pru sync --npm` | Upgrade the container from the npm registry |
| `pru sync --secrets` | Re-push laptop's auth state (`auth.json` etc.) without redeploying |

### Config

| command | purpose |
|---|---|
| `pru config show` | Show effective merged config |
| `pru config path` | Print config file search paths |
| `pru config edit` | Open `~/.pirouette/config.toml` in `$EDITOR` |

### Environment variables

Rarely needed — the CLI reads config from TOML. These override specific
runtime values.

| var | default | purpose |
|---|---|---|
| `PIROUETTE_HOST` | `127.0.0.1` (container path passes `0.0.0.0`) | Server bind host |
| `PIROUETTE_PORT` | `7777` | Server port (or `container.pirouette_port` in config) |
| `PIROUETTE_DATA_DIR` | `.pirouette/data` | Server data directory |
| `PIROUETTE_URL` | `http://127.0.0.1:7777` | CLI → server URL (overrides tunnel) |
| `AWS_PROFILE` | — | Overrides `aws.profile` |

## Authenticating tools inside the container

Most modern CLIs you'd run in the container support **device flow** —
they print a URL and a short code, you approve on any device, the CLI
polls a server until it sees the approval. No local callback, no port
forwarding required:

| tool | what to run |
|---|---|
| AWS SSO | `aws sso login` (default behavior) |
| GitHub CLI | `gh auth login --web` |
| gcloud | `gcloud auth login --no-launch-browser` |
| Tailscale | `tailscale up` |

For these you just `pru ssh`, run the command, copy the URL it prints
into your laptop browser, approve, done.

The exception is OAuth tools that **only** support the "loopback IP"
flow — they spin up a local HTTP server on a random port and require the
browser to redirect to `http://localhost:<port>`. `gws` (Google
Workspace CLI) is one such tool. For these you need to forward the
callback port from your laptop to the container:

```bash
# Terminal 1 — inside container
pru ssh
gws auth login --services drive,sheets
# Note the port from the URL it prints, e.g. redirect_uri=http://localhost:42103

# Terminal 2 — on laptop
pru tunnel 42103
# (foreground; ctrl-c to close when auth is done)

# Terminal 3 (or just paste into your browser): open the URL gws printed
```

Use `LOCAL:REMOTE` syntax if you need different ports on each side
(e.g. `pru tunnel 8080:42103`), or `--background` to add the forward
and return immediately (close later with `pru tunnel --close 42103`).

Under the hood, `pru tunnel` reuses the SSH ControlMaster connection
that pirouette sets up at `pru setup` time (`~/.pirouette/ssh-control/`),
so adding/removing forwards is instant after the first SSH call. If no
master exists it falls back to spawning a fresh `ssh -L …` process.

## Trust model

Pirouette has no application-layer authentication. The HTTP and WebSocket
APIs are wide open to anyone who can reach the listener. What keeps that
narrow today:

- **AWS security group** — only port 22 inbound, only from the source
  SG you configure (e.g. a Tailscale subnet router).
- **SSH key** — required to open the port-forward to the container.
- **Same-origin web app** — the dashboard is served from the same
  listener as the API. Cross-origin requests are rejected by `Host`
  validation (HTTP) and `Origin` validation (WebSocket); there are no
  `Access-Control-Allow-*` headers.
- **Loopback bind by default** — `pirouette server` (local-dev) binds
  `127.0.0.1` only. The container path explicitly opts into `0.0.0.0`
  via `PIROUETTE_HOST` because Docker port-mapping requires it; the SG
  is what gates external reachability there.

In practice: **anyone who can establish a TCP connection to the dashboard
port has shell access on your container.** The agents have full
bash/edit/write tools by design. The SG + SSH tunnel are the perimeter.

### Things you're trusting (the supply chain)

- The npm package `@neevparikh/pirouette` (or whatever you set
  `container.npm_package` to).
- The dotfiles repo at `dotfiles.clone_url` (yadm clone over HTTPS).
- The keys served at `dotfiles.authorized_keys_url` (used as
  `authorized_keys` for the container's sshd).
- Your AWS account's network isolation.
- Trust-on-first-use SSH host keys (`StrictHostKeyChecking=accept-new`).
  Fine for a private VPC; pre-seed `~/.ssh/known_hosts` manually if
  you're sharing a network with untrusted parties.

Browser libraries (marked, marked-highlight, DOMPurify, highlight.js,
Tailwind) are vendored at build time — no CDN dependency at runtime.

### Operational mitigations

If your threat model is stricter than what's enforced by code today:

1. Don't broaden the SG.
2. Don't bind the dashboard to a public IP. `PIROUETTE_HOST=0.0.0.0`
   is for the container path; everything else should stay loopback.
3. Treat anyone with read access to your laptop's `~/.ssh/` as having
   full pirouette access.

## Architecture

```
Your laptop                      EC2 instance                       Docker container
───────────       SSH tunnel    ─────────────       port 7777      ──────────────────
pru CLI  ─────── localhost:7777 ──── :7777 ──── pirouette server
                                                                    ├── agent manager (pi SDK)
                                                                    ├── HTTP + WebSocket
                                                                    └── web dashboard (static)
Browser  ─────── localhost:7777 ──── :7777 ────
                                                                    sshd on :22
pru ssh ────── jump via host ─────── :2222 ────  zsh + yadm dotfiles
                                                                                     │
                                                 persistent EBS volume at /data ────┘
```

## License

MIT.
