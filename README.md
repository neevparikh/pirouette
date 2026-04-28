# pirouette

Run long-lived [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agents in the cloud, with a web dashboard to interact with them and a CLI for management.

Single-user by design. You run one EC2 instance with a Docker container; pirouette's server lives inside the container and manages a pool of pi agents for you.

## What's new in 0.2

- **Vim modal editing** in the message input (toggle in input footer; persists)
- **Live message-queue display** + steer / follow-up choice while streaming
- **Per-agent model selector** in the agent header
- **Session forking** with parent tree visualization in the sidebar
- **Pi-style live footer** in the agent header (tokens, cost, context %, thinking)
- **Full base16 theme picker** (449 themes, light/dark/system slots)
- **Auto-push of laptop auth state** at `pru setup`; new `pru sync --secrets`
- **Configurable container entrypoint** (`container.entrypoint_script`)
- **Streaming flash + whole-page rebuild** both fixed (per-block reconciliation)

Full list in [`CHANGELOG.md`](CHANGELOG.md).

## Install

```bash
npm install -g @neevparikh/pirouette   # provides both `pirouette` and `pru`
```

## Quick start (local only — no cloud)

```bash
pirouette server                # serves on :7777
open http://localhost:7777
```

## Quick start (cloud)

One-time setup:

1. Install the AWS CLI and log in to the profile you want to use.
2. Make sure that profile can create EC2 instances + EBS volumes in your target region.
3. Create `~/.pirouette/config.toml` with your AWS network info (see below).

Then:

```bash
pru preflight     # read-only: verifies your AWS config + resources
pru setup         # provisions: instance + 500 GiB EBS + container + server
pru open          # SSH port-forward :7777 + opens browser
```

When you're done working for a while:

```bash
pru teardown      # stops the instance; EBS data volume preserved
```

## Configuration

Pirouette reads TOML config from three places, in order (later wins):

1. Built-in defaults
2. `./pirouette.toml` (packaged with the tool; generic defaults only)
3. `~/.pirouette/config.toml` (your per-user overrides; not checked in)

Run `pru config show` to see the effective merged config.

### Required fields

`pru setup` will refuse to run until these are set in `~/.pirouette/config.toml`:

| key | what it is |
|---|---|
| `aws.network.vpc_name` | Name tag of the VPC to launch into |
| `aws.network.subnet_name_pattern` | Name-tag glob for private subnets; first alphabetical match is used |
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

One image that satisfies all of this out of the box: [`npx27/dev-unfetched`](https://hub.docker.com/r/npx27/dev-unfetched) (Arch Linux, user `neev`, uid 1000). Build your own for a leaner footprint.

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
container_user = "neev"                           # match your image's user
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
| `pru launch <name>` | Create a new pi agent (optional `--repo`, `--model`, `--thinking`) |
| `pru list` | List all agents and their state |
| `pru send <agent> <msg>` | Send a message to an agent |
| `pru stop <agent>` | Stop an agent (keeps its state) |
| `pru rm <agent>` | Remove an agent; `--all` also deletes its worktree + session files |
| `pru status` | Show remote instance + server health |

### Infrastructure

| command | purpose |
|---|---|
| `pru preflight` | Read-only: validate AWS config and resource discovery |
| `pru setup` | Provision / resume the EC2 instance + start the container |
| `pru teardown` | Stop the instance; EBS preserved |
| `pru destroy [--delete-volume]` | Terminate; optionally delete EBS |
| `pru open` / `pru close` | Manage the SSH port-forward to :7777 |
| `pru ssh` / `pru ssh --host` | Shell into the container (agent forwarded) / the EC2 host |
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

## Environment variables

Rarely needed — the CLI reads config from TOML. These override specific runtime values.

| var | default | purpose |
|---|---|---|
| `PIROUETTE_HOST` | `0.0.0.0` | Server bind host |
| `PIROUETTE_PORT` | `7777` | Server port (or `container.pirouette_port` in config) |
| `PIROUETTE_DATA_DIR` | `.pirouette/data` | Server data directory |
| `PIROUETTE_URL` | `http://127.0.0.1:7777` | CLI → server URL (overrides tunnel) |
| `AWS_PROFILE` | — | Overrides `aws.profile` |

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

See [docs/initial_setup.md](docs/initial_setup.md) for design notes and [docs/todos.md](docs/todos.md) for status.

## License

MIT.
