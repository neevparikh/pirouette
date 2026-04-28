# pirouette — todos

Tracking remaining work, grouped by phase and priority. Check off as they land.

---

## recently shipped (since last todo refresh)

These all landed during the iteration sessions; backfilling them so this
doc reflects reality before we plan the next bites.

### UI polish
- [x] **Vim modal editing** in the message input (~1100 LOC `vim.js` + 42 tests, full pi-vim feature parity: hjkl/wbeWBE/0$%fF/text-objects/operators/visual/undo)
- [x] **Streaming flash eliminated** — assistant bubble streams as plain text (`<pre>`), morphs to rendered markdown only on `message_complete`. Cursor span stable across deltas.
- [x] **Per-block DOM reconciliation** in the messages list — no more whole-transcript rebuild on every event. `data-msg-key` attributes + `reconcileBlocks()` helper, click handlers delegated.
- [x] **Auto-scroll only when at bottom** — scrolling up to read history is no longer interrupted by streaming events.
- [x] **Raw markdown toggle** (global, persisted via localStorage) — flips every assistant message to plain source.
- [x] **Pi-matching markdown styling** — yellow headings, accent-cyan inline code, green code blocks, list markers in cyan, tables sized to content; mirrors pi-coding-agent's `dark.json` semantics.
- [x] **Pi-style live footer data** in the agent header — `↑input ↓output Rcache Wcache $cost  ctx%/window  thinking: level`. `GET /api/agents/:id/stats` endpoint + warning/error coloring at 70%/90% context.
- [x] **Theme picker** — full base16 set (449 themes generated from neevparikh.github.io/src/base16-tailwind/schemes), search + scrollable list, FOUC-preventing inline script, light/dark/system slots persisted.
- [x] **Sidebar font + button styling** — uniform one-step bump on all type, theme button restyled to match the action-button pill pattern.
- [x] **Header alignment** — sidebar top + agent header both `h-[88px]` so bottom borders line up regardless of content lines.
- [x] **Markdown rendering parity with pi** — `StrictStrikethroughTokenizer`, explicit-language-only highlighting via `marked-highlight` + `highlight.js@11`, `.hljs-*` mapped to base16 tokens.
- [x] **Streaming thinking** rendered inline with stable `streaming-thinking-body` id + auto-scrolling pre block; finalized thinking gets first-line preview + expand/collapse.

### Server / agents
- [x] **Live stats endpoint** (`GET /api/agents/:id/stats`) — pulls `session.getSessionStats()` + `session.getContextUsage()` so the UI footer matches pi's TUI footer.
- [x] **Multi-level vim undo** in input — server is unaffected, but worth noting the chat ergonomics.

### Infrastructure
- [x] **Region migration** — provisioned in the same VPC as the LLM proxy so the EC2 container can reach it via private routing (no Tailscale gymnastics inside container).
- [x] **`Project` tag in IAM-required tag set** — `aws.tags.Project` now configurable; matches the Researcher role's tag-conditioned `RunInstances` policy. Reverse-engineered from `~/repos/metr/devpod/devpod/ec2_client.py`.
- [x] **`importKeyPair()` fallback** — first attempts with tag-specifications, retries without when `ec2:CreateTags` is blocked but `ec2:ImportKeyPair` is allowed (which is the METR Researcher role's actual shape).
- [x] **`pru sync --secrets`** — push laptop's `~/.pi/agent/auth.json` + `~/.cache/pi-agent/hawk-access-token` into container's bind-mounted home without a redeploy. Idempotent. New `secrets.ts` module.
- [x] **Auto-secrets push at `pru setup`** — secrets are pushed inline after `startContainer()`. Manual `scp` no longer needed for fresh boxes.
- [x] **`checkLocalAuth()` precheck** — `pru setup` warns loudly *before* spending 5 minutes provisioning if no `auth.json` exists locally; suggests both `/login hawk` on laptop OR ssh into container after setup.
- [x] **`pru sync` install correctness** — added `sudo` + `set -o pipefail` so `npm install -g` failures aren't silently masked by the `tail -3` filter.
- [x] **`initRepo()` self-configures git identity** — sets `user.email` / `user.name` locally per-repo so first-boot `scratchpad` project init doesn't depend on host git config (which the container doesn't have).
- [x] **`container.entrypoint_script` config override** — users can ship their own entrypoint script (e.g. chezmoi/stow instead of yadm) without forking the package.
- [x] **Middleman proxy (remote) — works** — was deferred. The us-west-2 instance reaches middleman natively via VPC private routing; `pi-hawk-provider` discovers ~85 hawk models on startup.

---

## phase 1 — MVP polish (mostly done)

### rendering
- [x] Message history fetch on page load
- [x] Tool output visible in chat (collapsible)
- [x] Error surfacing to chat (API errors shown in system messages)
- [x] Markdown rendering for assistant text (code blocks, lists, links)
- [x] Smart tool headers (bash → description, read → path, edit → filename, grep → pattern)
- [x] Diff rendering for `edit`/`write` tool calls
- [x] Smart tool-result summaries ("found 12 matches", "read 523 lines")
- [x] Running indicator — show current tool + elapsed time in sidebar and main view
- [x] Persistent expand/collapse state across re-renders
- [x] Incremental streaming DOM update (don't re-render entire list on every token)
- [x] Per-block reconciliation (no whole-transcript rebuild on event arrival)
- [x] Streaming-bubble flash fix (plain text → markdown on complete)
- [x] Agent info strip (model, workdir, thinking level, age, id) in header + compact model in sidebar
- [x] Live footer data (tokens / context / cost / thinking) matching pi's TUI
- [x] Unified font stack (user + assistant both sans-serif; code blocks mono)
- [x] Aligned sidebar footer and input bar heights
- [x] Thinking blocks rendered inline with expand/collapse
- [x] Stream markdown progressively — *deferred to message_complete* (better UX than per-token markdown re-render)
- [x] Split rendering into pure, testable modules (`render.js` + `transcript.js` + `vim.js`)
- [x] Vim modal editing in input
- [x] Raw view toggle
- [x] Theme picker (449 base16 themes)
- [x] Tests for rendering helpers + reducer + vim + reconciliation (vitest, **107 tests**)

### server / agents
- [x] Load pi extensions (hawk-provider etc.) at startup
- [x] Flush pending extension provider registrations into modelRegistry
- [x] Defensive `mkdir` of worktree/session dir before every session start
- [x] Strict model resolution (fail loudly instead of falling back to Bedrock)
- [x] Bump pi-coding-agent to 0.68.1 (claude-opus-4-7 in hawk catalog)
- [x] Persist resolved model string on the agent
- [x] Default model configurable via `PIROUETTE_DEFAULT_MODEL`
- [x] Git clone on agent launch (`--repo`)
- [x] Stop/resume race-condition handling (per-agent async lock)
- [x] Fix agent name collisions (`<slug>-<id>`)
- [x] Cost + token tracking per agent (also exposed via `/stats`)
- [x] Agent deletion with optional worktree/session cleanup
- [x] State file migration on load (backfill `usage`, `errorMessage`, `projectName`, `branchName`)
- [x] Distinguish agent states: idle / waiting_input / running / starting / cloning / stopped / error
- [x] Surface git clone status in event stream
- [x] `errorMessage` persisted on agent failure, cleared on next message

### infrastructure
- [x] Layered config (`pirouette.toml` → `~/.pirouette/config.toml` → CLI flags)
- [x] `pru config show|path|edit`
- [x] `pru preflight` — read-only AWS resource discovery
- [x] `pru setup` — EC2 provision in configured VPC + private subnet
- [x] `pru teardown` — stop instance (preserve EBS)
- [x] `pru destroy [--delete-volume]`
- [x] EBS volume with `Name=pirouette-data` tag — auto-reused across instance recreations
- [x] user-data script: docker, EBS mount, docker root relocation, `StreamLocalBindUnlink`
- [x] Build step (`tsc --outDir dist`) + `post-build.mjs`
- [x] Published as `@neevparikh/pirouette` (0.1.0) on npm
- [x] `pirouette-entrypoint.sh` — yadm clone, npm install, tmux server (idempotent)
- [x] Configurable entrypoint via `container.entrypoint_script`
- [x] `pru setup` starts the container with bind mounts + env
- [x] `~/.ssh/config` managed block: `pirouette` (host) + `pirouette-container` (ProxyJump)
- [x] `pru ssh` defaults to container; `--host` for the EC2 host
- [x] `pru open` — SSH port-forward + browser open (PID-file idempotency)
- [x] `pru close` — tear down forward
- [x] `pru logs [--follow|--tmux|--entrypoint|--boot]`
- [x] `pru sync` — local pack + scp + in-container install + restart (sudo-correct)
- [x] `pru sync --npm` — upgrade from registry
- [x] `pru sync --secrets` — push auth state without redeploy
- [x] `checkLocalAuth()` precheck before provisioning

---

## phase 2 — projects + worktrees + @-tagging (done)

### projects
- [x] `ProjectConfig` data model (name, repoUrl, repoPath, worktreesDir, defaultBranch)
- [x] `scratchpad` default auto-created on server startup
- [x] `ProjectManager` create/list/remove
- [x] `GET/POST /api/projects`, `DELETE /api/projects/:name`
- [x] WebSocket: `projects_list`, `project_created`, `project_removed`
- [x] `pru project list/add/rm`
- [x] `pru launch --project <name>`
- [x] `pru list` groups by project; `--project` filter
- [x] Sidebar grouped by project + collapse arrows (localStorage)
- [x] Selected-project drives `@<newname>` placement
- [x] `+ new project` button + modal
- [x] Project delete from sidebar (scratchpad protected)

### git worktrees
- [x] Worktrees at `<dataDir>/worktrees/<project>/<slug>-<id>/`
- [x] Branch `agent/<slug>` per agent; collision suffixes
- [x] `createWorktree` / `removeWorktree` / `getDefaultBranch` / `initRepo` helpers
- [x] `initRepo` self-configures git identity (no host dependency)
- [x] Cleanup on agent removal
- [ ] **`pru push <agent>`** — push agent branch to origin (deferred; do via `pru ssh` today)
- [ ] **`pru rebase <agent>`** — rebase on default branch (deferred)

### @-tagging routing (no scoring; explicit only)
- [x] `@<existing>` routes to that agent
- [x] `@<new>` auto-creates in selected project
- [x] Autocomplete popup with arrow / Tab / Enter / click navigation
- [x] "Create new @name" entry when partial doesn't match
- [x] No `@` + no selection → hint
- [x] Auto-select target after send

### migration
- [x] State load migration (projectName, branchName, usage, errorMessage backfilled)

---

## phase 2.5 — auth + remote access (next big bite)

The original plan here was Tailscale + Caddy + Google OAuth. Based on the
arch discussion, we landed on a leaner shape: Tailscale-binding + bearer
token auth. No public ingress, no DNS changes, no cert management.

### step A — auth state automation (done)
- [x] `pushSecrets()` ships `auth.json` + token cache to container
- [x] Wired into `pru setup` and exposed as `pru sync --secrets`
- [x] `checkLocalAuth()` precheck warns before provisioning if laptop has no creds
- [x] Bind-mount based push (no `docker exec` needed)

### step B — Tailscale + bearer token (not started)
The goal: drop the SSH tunnel, get a stable URL the laptop + phone +
iPad can all hit, and gate access with a token rather than SSH key alone.

- [ ] **Bearer-token auth on the server** — `PIROUETTE_AUTH_TOKEN` env var; reject unauthorized HTTP/WebSocket requests
- [ ] **Web UI auth wiring** — first-load reads `#token=…` from URL fragment, stashes to localStorage, attaches `Authorization: Bearer …` to every fetch + WebSocket upgrade
- [ ] **Token minted at setup** — written to `~/.pirouette/config.toml`, exported into container env on `docker run`
- [ ] **`tailscaled` in container** — needs `--cap-add=NET_ADMIN` + state bind-mount; consumes `TS_AUTHKEY` on first boot
- [ ] **Bind to tailnet IP** — server binds to the tailscaled-claimed interface so it isn't exposed beyond the user's tailnet
- [ ] **`pru open` becomes "open the URL"** — no more SSH tunnel; print `https://pirouette-<user>.<tailnet>:7777/#token=<…>`
- [ ] **`pru rotate-token`** — generate fresh token, push to container, update laptop config

### bidirectional auth sync (open question)
- [ ] **Pull-newer-wins** — if container's `auth.json` has been refreshed, `pru sync --secrets` should detect and pull instead of clobbering
- [ ] Alternative: container does its own OAuth flow (`/login hawk` interactively) and laptop never has secrets

---

## phase 3 — mobile, notifications, polish

### mobile (deferred until step B)
- [ ] Responsive layout polish
- [ ] Bottom nav for mobile
- [ ] Swipe between agents
- [ ] PWA manifest + install prompt

### notifications (deferred)
- [ ] Browser push via service worker
- [ ] Notify on: agent idle + needs input, agent error, explicit ping
- [ ] Pi extension / tool for agents to call when they need the user

### pi features in the UI
- [x] **Session forking UI** — `pi.SessionManager.forkFrom()` wrapped as `POST /api/agents/:id/fork`. Header `fork` button creates a sibling agent with copied session, own worktree, and parent's branch as base. Optional `entryId` param truncates the fork to a specific user message via `session.navigateTree()`.
- [x] **Session tree visualization** — `parentAgentId` persisted on every agent; sidebar groups forks under their parent with `↳` indent prefix. State migration backfills `parentAgentId: null` for pre-fork records.
- [x] Cost tracking display (per agent, total) — done via `/stats` endpoint
- [x] Full base16 theme picker
- [x] **Model selector per agent** — `GET /api/agents/:id/models` lists all 148 registered models grouped by provider; `POST /api/agents/:id/model` calls `session.setModel()` and persists. UI: `model ▾` button in agent header opens a search + grouped list popup.
- [ ] `/login hawk` from the web UI (today must be done on laptop or via container shell). Deferred until we hit an actual auth-expiry incident.

### enhanced chat
- [x] `@name` routing from input bar
- [x] Vim modal editing
- [x] Multi-agent single input (Orchestra-style target label) via @-tagging
- [x] **Message queue display (steering / follow-up)** — `queue_update` events flow through reducer into `state.queue`. Chips render above the input bar with type-coded coloring (blue = steer, muted = follow-up). Send-mode toggle (`mode: steer` / `mode: followUp`) in the input area picks delivery semantics; default `steer` matches pi's TUI.
- [x] **Steer vs follow-up support on the server** — `POST /api/agents/:id/message` accepts optional `mode: "steer" | "followUp"`. Routes through `session.steer()` (interrupt) or `session.followUp()` (queue) when streaming; idle agents always get `prompt()`.

---

## deferred / out-of-scope

- [x] Middleman proxy (local) — done
- [x] Middleman proxy (remote) — done in us-west-2
- [x] **GitHub auth in container** — works today via SSH agent forwarding through `/agent-sock/ssh.sock`

---

## spikes / proven

- [x] **Worktree lifecycle** — proven; worktrees are created on agent launch and removed on `pru rm --worktree`
- [x] **Container git auth** — proven; `SSH_AUTH_SOCK=/agent-sock/ssh.sock` and forwarded SSH agent works for `git push` / private clones
- [x] **Container restart** — proven via `pru sync` (kills + restarts the tmux server inside the container) and via full `docker restart pirouette` (entrypoint re-runs idempotently); session state survives both
- [ ] **Tailscale ingress + TLS** — see step B above

---

## tech debt

- [x] TS build step (compiled `dist/` shipped on npm)
- [ ] **Frontend build** — Tailwind via CDN today (~300 KB unused); move to a proper Tailwind build to trim bundle. Also relevant for offline tailnet access where CDN is unreachable.
- [ ] Proper logger (`pino` or similar) instead of `console.log`
- [x] Tests — 107 vitest tests covering rendering, reducers, transcript blocks, vim mode
- [ ] **More tests** — server-side (agent-manager, project-manager) have no unit tests yet
- [ ] API versioning (`/api/v1/...`) — needed if we ever expose externally
- [ ] **Rate limiting / auth** — needed for step B
- [ ] **`pru` rename consistency** — binary is `pirouette` but everyone calls it `pru`; document or expose `pru` as an alias officially
