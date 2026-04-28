## context

Pirouette (`pru`) runs long-lived pi coding agents on a single EC2 instance inside a Docker container, with a web dashboard for interaction and a CLI for management.

### core decisions

- **Language:** TypeScript throughout (CLI + web backend + agent management), to use the pi SDK natively.
- **Pi integration:** Use the pi SDK (`@mariozechner/pi-coding-agent`) directly — `createAgentSession`, `SessionManager`, RPC mode where needed. This gives us full control over sessions, streaming, tools, extensions, compaction, forking, etc.
- **Container:** Single `npx27/dev-unfetched` (Arch Linux) container on a single EC2 instance. All agents share the container, isolated by git worktree + filesystem.
- **Web UI:** Chat-focused dashboard (inspired by Orchestra), using the base16 theming system from [neevparikh.github.io](https://github.com/neevparikh/neevparikh.github.io). Initially exposed over Tailscale, with browser push notifications.
- **CLI (`pru`):** Management only (provisioning, launching agents, status). All agent interaction happens via the web UI.
- **Routing:** Orchestra-style keyword/availability scoring to auto-route messages to the best agent.
- **Agent lifecycle:** Agents persist across restarts via pi's session resume. Idle agents sit waiting for messages. Notify user (browser push) when agent finishes and needs input.
- **Durability model:** Treat the container as disposable. Store pi sessions, repos, worktrees, and pirouette metadata on a persistent EBS-backed data directory mounted into the container.

### non-goals
- Multiple EC2 instances or host types.
- Any isolation beyond git-worktree + filesystem.
- Slack/Signal notifications (browser push only for now).
- MCP or sub-agent orchestration (just standalone pi agents).

---

## architecture

```
Your Machine                              EC2 (m6i.16xlarge)
────────────                              ──────────────────────────────────────
pru CLI ──── SSH ──────────────────────>  Docker container (npx27/dev-unfetched)
                                          │
                                          ├── pirouette server (Node.js)
                                          │   ├── REST API + WebSocket
                                          │   ├── Agent manager (pi SDK sessions)
                                          │   ├── Router (keyword/availability scoring)
                                          │   └── Git worktree manager
                                          │
Browser  <──── HTTPS over Tailscale ───────>│
  │                                       │
  ├── Tailscale access                    ├── Agent 1 (pi session, worktree A)
  ├── WebSocket (live streaming)          ├── Agent 2 (pi session, worktree B)
  ├── Push notifications                  ├── Agent 3 (pi session, worktree C)
  └── base16 theme picker                └── /data/
                                                ├── repos/<project>/
                                                │   ├── .git/
                                                │   └── .pirouette-worktrees/
                                                │       ├── agent-1/
                                                │       └── agent-2/
                                                ├── sessions/
                                                └── state/
```

### key components

1. **`pru` CLI** (runs on your laptop)
   - Provisions EC2 + launches container
   - Manages agents (launch, list, stop)
   - SSHs into container (with agent forwarding)
   - Opens web UI in browser
   - Talks to the pirouette server inside the container via SSH tunnel or direct HTTP

2. **Pirouette server** (runs inside container)
   - Node.js process managing all agent sessions via pi SDK
   - Serves the web dashboard (static frontend + API)
   - WebSocket for live agent streaming to browser
   - Persists state to disk on the mounted `/data` volume (agent configs, project mappings, session files)

3. **Web dashboard** (served by pirouette server)
   - Chat-per-agent view (read messages, send replies)
   - Project/agent overview panel
   - base16 theme system (reuse from personal website)
   - Initially reachable only over Tailscale
   - Browser push notifications when agents need input
   - Mobile-friendly (phase 3)

---

## phases

### phase 0 — technical spikes

**Goal:** De-risk the parts that could invalidate the architecture before building the full product.

#### spikes to run first
- **pi session persistence + resume:** prove `createAgentSession()` + `SessionManager` can create, persist, stop, and resume a session cleanly after a server restart.
- **event streaming:** prove agent events can be subscribed to on the backend and forwarded to a browser client over WebSocket with acceptable fidelity.
- **worktree lifecycle:** prove repo clone, worktree creation, branch naming, cleanup, and relaunch all behave predictably.
- **container git auth:** prove an agent running inside the container can fetch, push, and use `gh`/git flows with the intended auth setup.
- **Tailscale ingress + TLS:** prove the EC2 instance can join the tailnet, serve the app over Tailscale, and obtain HTTPS certs cleanly via Tailscale/Caddy integration.

#### output of phase 0
- A minimal local or EC2-hosted prototype that exercises the above paths end-to-end.
- Notes on any SDK limitations, auth quirks, or operational gotchas discovered during spikes.
- A clear go/no-go decision before building the broader server + UI surface area.

### phase 1 — MVP: EC2 + agents + basic web UI

**Goal:** Provision instance, launch pi agents, view them in a browser.

#### pru CLI commands
```
pru setup                          # Provision EC2, launch container, bootstrap
pru status                         # Show instance state + running agents
pru launch <name> [--repo <url>]   # Start a new pi agent (clone repo or bare)
pru list                           # List all agents and their states
pru stop <agent>                   # Stop an agent
pru ssh                            # SSH into container (ForwardAgent yes)
pru open                           # Open web UI in browser (Tailscale HTTPS URL)
pru teardown                       # Stop instance (agents resume on next setup)
```

#### pirouette server (MVP)
- Start/stop pi agent sessions via SDK (`createAgentSession`)
- Each agent gets a pi session with `SessionManager.create()` for persistence
- REST API: `GET /api/agents`, `POST /api/agents`, `POST /api/agents/:id/message`, `DELETE /api/agents/:id`
- WebSocket: stream agent events (text deltas, tool calls, status changes) to browser
- Serve static web dashboard

#### web dashboard (MVP)
- Single-page app
- Left sidebar: list of agents (name, status indicator, project)
- Main panel: chat view for selected agent (messages, tool call summaries)
- Input bar at bottom to send messages
- Basic styling with base16 theming (hardcode one dark + one light theme)
- Access restricted by serving over Tailscale
- No routing yet — you pick which agent to message

#### EC2 / container setup
- Instance type: `m6i.16xlarge` (or similar — beefy for many concurrent agents)
- AMI: Amazon Linux 2023 or Ubuntu (just needs Docker)
- Docker image: `npx27/dev-unfetched` (has pi, node, npm, uv, git, gh, tmux, etc.)
- Attach a persistent EBS data volume to the instance and mount it on the host (for example `/var/lib/pirouette`)
- Bind-mount that host path into the container as `/data`
- Container runs with SSH forwarding so `gh` and git work via forwarded agent
- pirouette server starts automatically inside container
- Repos, worktrees, session files, and pirouette state all live under `/data`, not in the container writable layer

#### agent launch flow
1. `pru launch my-agent --repo https://github.com/user/project`
2. Server clones repo to `/data/repos/project/` (if not already there)
3. Creates git worktree at `/data/repos/.pirouette-worktrees/project/my-agent/`
4. Starts pi session with `cwd` set to the worktree and session files stored under `/data/sessions/`
5. If `--repo` is omitted, starts agent in a bare directory and the agent can set up its own repo

### phase 2 — routing + projects

**Goal:** Smart routing, proper project/worktree management.

#### routing
- Orchestra-style scoring: keyword relevance, specialization, availability, disruption penalty, recency
- Messages auto-route to best agent (can still explicitly target with `@agent-name`)
- If no good match and under agent cap (5 per project), offer to spawn new agent

#### projects concept
- A "project" = a git repo (or bare directory)
- Multiple agents per project, each in their own worktree/branch (`agent/<name>`)
- `pru project list` — list projects
- `pru project add <repo-url>` — register a project
- Web UI: project selector, view agents grouped by project

#### worktree management
- Auto-create worktree + branch on agent launch
- Worktrees stored outside the main repo (like Orchestra: `/data/repos/.pirouette-worktrees/<project>/<agent>/`)
- Support rebasing agent branches on main
- Push agent branches to origin

### phase 2.5 — auth + public ingress

**Goal:** Move from tailnet-only access to a more shareable web deployment.

#### auth / ingress setup
- Add Google OAuth login gate once the app needs to be accessible outside Tailscale
- Decide whether to keep Tailscale as an admin path or expose a public hostname as the primary entrypoint
- If exposing publicly, add a subdomain such as `agents.neevparikh.com` (or `pru.neevparikh.com`)
- Choose reverse proxy and certificate flow for public access

### phase 3 — mobile, notifications, polish

**Goal:** Production-quality web experience.

#### network / serving setup
- Start with Tailscale-only access for internal use
- Use Tailscale HTTPS certs for the tailnet-served app
- Prefer Caddy for HTTPS termination and simple Tailscale cert integration → pirouette server on localhost:7777
- Revisit public DNS / non-Tailscale ingress later if needed

#### mobile improvements
- Responsive layout (already using Tailwind, but optimize touch targets, scrolling)
- Bottom nav for mobile
- Swipe between agents

#### browser push notifications
- Service worker for push notifications
- Notify when: agent finishes task and needs input, agent errors, agent explicitly requests user attention
- Pi extension or custom tool that agents can call to "ping" the user

#### enhanced web features
- Session forking UI (use pi's `/fork` via SDK)
- Session tree visualization (`/tree` equivalent)
- Agent cost tracking display
- Theme picker (full base16 scheme list, like personal website)

---

## technical details

### pi SDK usage

Each agent is a `createAgentSession()` call:

```typescript
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";

const sessionRoot = "/data/sessions";

const { session } = await createAgentSession({
  cwd: worktreePath,
  sessionManager: SessionManager.create(worktreePath, sessionRoot),
  authStorage,
  modelRegistry,
  // model, thinkingLevel, etc.
});

// Stream events to WebSocket clients
session.subscribe((event) => {
  broadcastToWebSocket(agentId, event);
});

// Send user messages
await session.prompt("Fix the failing tests");

// Resume existing session
const { session: resumed } = await createAgentSession({
  cwd: worktreePath,
  sessionManager: SessionManager.continueRecent(worktreePath, sessionRoot),
  authStorage,
  modelRegistry,
});
```

### web stack
- **Backend:** Node.js + Express (or Fastify) + ws (WebSocket)
- **Frontend:** Single-page app, vanilla TS + Tailwind CSS + base16 theming
  - No heavy framework needed — it's a chat UI
  - Could use Preact or similar if complexity grows
- **Auth:** Phase 1 relies on Tailscale network access; add Google OAuth 2.0 later if broader access is needed
- **Notifications:** Web Push API + service worker

### base16 theming
Reuse the base16-tailwind system from the personal website:
- Copy `src/base16-tailwind/` module into pirouette
- Generate CSS custom properties per scheme
- Theme picker in header (like personal website)
- Support light/dark/system mode toggle
- Persist theme choice in localStorage

### durable storage layout
Treat the container as replaceable and keep the source of truth on the mounted data volume.

Suggested layout inside the container:
- `/data/sessions/` — pi session JSONL files
- `/data/repos/` — cloned repos
- `/data/repos/.pirouette-worktrees/` — agent worktrees
- `/data/state/` — pirouette metadata (agents, projects, routing state, notification state)
- `/data/logs/` — optional server logs and exported artifacts

This matters because a resumable pi session is only useful if the corresponding `cwd` still exists. Sessions and worktrees therefore need to persist together.

### container lifecycle
1. `pru setup` launches EC2 instance, mounts the persistent EBS-backed data volume on the host, and runs Docker with that volume bound into the container as `/data`
2. Container entrypoint: fetch dotfiles, start sshd, join Tailscale (or run alongside a host-level Tailscale setup), start Caddy for TLS termination, then start pirouette server
3. pirouette server reads metadata from `/data/state/` and auto-resumes any previously running agents using session files from `/data/sessions/`
4. `pru teardown` stops EC2; the EBS volume persists, so repos, worktrees, metadata, and sessions survive
5. Next `pru setup` restarts the instance, reattaches/mounts the data volume, starts the container, and agents resume

### SSH config
`pru setup` adds an entry to `~/.ssh/config`:
```
Host pirouette
  HostName <elastic-ip>
  User neev
  Port 22
  ForwardAgent yes
  RequestTTY yes
  IdentityFile ~/.ssh/id_ed25519
```

---

## TODOs / deferred

- [ ] **Backups / disaster recovery:** Enable regular snapshots for the persistent EBS data volume; optionally also ship `/data/sessions/` + `/data/state/` backups to S3 for extra safety.
- [ ] **Middleman proxy:** All LLM API calls should go via the internal METR middleman proxy. Need to configure base URL / API key routing once we know the network setup.
- [ ] **API keys / .env:** Define what goes in `.env` (LLM keys, Tailscale/Caddy config, Google OAuth client ID/secret later, etc.). Should use `uv run --env-file .env` for Python tools agents might use.
- [ ] **GitHub auth in container:** Set up `gh auth` — likely via SSH agent forwarding (already have `ForwardAgent yes`) + `gh auth login` with a token, or just rely on SSH for git operations.
- [ ] **Google OAuth:** Add app-level Google login once Tailscale-only access is no longer sufficient.
- [ ] **Google account for agents:** Limited-permission Google account so agents can draft reports in Google Docs for review/comment.
- [ ] **Slack/Signal notifications:** Browser push is MVP; add Slack/Signal integration later.
- [ ] **Agent-to-user "ping" tool:** Custom pi tool or extension that agents can call to notify the user. Integrate with push notifications.

---

## similar project inspiration

[Orchestra](https://github.com/sydva/orchestra) (`~/repos/orchestra/`) — similar concept built for Claude SDK. Good reference for routing, agent lifecycle, web dashboard, and git workspace management. Pirouette aims to be simpler and built natively on pi's SDK.

### resources
- Pi SDK docs: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Pi RPC docs: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- Orchestra source: `~/repos/orchestra/`
- Pi mono repo: `~/repos/pi-mono/packages/coding-agent/`
- Personal website (theming): `~/repos/neevparikh.github.io/`
- Container Dockerfile: `~/devcontainer_configs/Dockerfile`
- All project repos: `~/repos/`
