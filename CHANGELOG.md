# pirouette changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org).

---

## 0.2.6 — Tailscale (and other non-loopback) access

### Added

- **`server.allowed_hosts` config** + `PIROUETTE_ALLOWED_HOSTS` env var
  for extending the HTTP `Host` and WS `Origin` allowlist beyond the
  default loopback set. Each entry is `<host>` (port appended
  automatically using `container.pirouette_port`) or `<host>:<port>`
  (explicit). Comma-separated for the env-var form.
- **`pru setup` threads `server.allowed_hosts`** through to the
  container's `docker run -e PIROUETTE_ALLOWED_HOSTS=...` so the
  setting persists across container restarts.

### Why

Until 0.2.6 the only sanctioned access path to the dashboard was the
SSH tunnel from `pru open` (laptop:7777 → container:7777). Reaching
the dashboard via any other hostname (e.g. a Tailscale MagicDNS
hostname like `pirouette-neev:7777`) hit `421 Misdirected Request`
because our DNS-rebinding-defense allowlist only included
`localhost:<port>` and `127.0.0.1:<port>`.

### Recipe (Tailscale on EC2)

On the EC2 host:

```bash
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up --ssh --hostname=pirouette-<you>
# follow the auth URL it prints; admin approval may be required
```

On the laptop, in `~/.pirouette/config.toml`:

```toml
[server]
allowed_hosts = ["pirouette-<you>"]
```

Then `pru setup` (idempotent — just rewrites docker run env). You can
now reach the dashboard at `http://pirouette-<you>:7777` from any
device on your tailnet, no SSH tunnel needed. The SSH-tunnel path
(`pru open`) keeps working in parallel.

### Trust note

This broadens the access surface from "laptop's SSH key" to "anyone
on the tailnet ACL'd to reach the host." pirouette still has no
application-layer auth, so anyone who can reach `:7777` has shell
through the agents. Make sure your tailnet ACL doesn't expose this
box to people you wouldn't share `~/.ssh/` with.

---

## 0.2.5 — `pru rm` accepts agent name (was silent no-op)

### Fixed

- `pru rm <name>` (and any HTTP API call referencing an agent by
  human-friendly name rather than 8-char id) now actually removes the
  agent. Previously `DELETE /api/agents/smoketest` returned `200 OK`
  with `{removed: true}`, broadcast `agent_removed`, and did nothing,
  because the underlying state-manager calls keyed by id silently
  no-oped when the ref was a name. The same bug affected `pru stop`,
  `pru send`, model switching, forking — anything that took an agent
  ref. They all happened to look like they worked because the live
  session in memory still served subsequent reads.
- Unknown agent refs now return `404` instead of `200` (the silent
  success that hid the original bug).
- Ambiguous name refs (multi-project name collision) return `409` with
  the list of candidate ids and project names; use the id in that
  case.

### Added

- `agentManager.resolveAgentRef(ref)` — single canonical place that
  turns a CLI/URL agent reference into either an agent, an ambiguity
  marker, or null.
- 6 new tests in `src/server/__tests__/agent-ref.test.ts` covering the
  unknown-ref / control-chars / oversize-ref / wrong-method paths.
  Total tests now 133 (was 127).

---

## 0.2.4 — SSH ControlMaster + `pru tunnel`

### Added

- **`pru tunnel <port>`** — forward a TCP port from laptop to container.
  Primary use case: OAuth loopback-IP flows in CLI tools running inside
  the container (most notably `gws`; most other tools like `aws sso`,
  `gh`, `gcloud` use device flow and don't need this). Accepts `PORT`
  or `LOCAL:REMOTE` syntax. Foreground by default (ctrl-c to close);
  `--background` to daemonize and `--close` to remove a previously-added
  forward.
- **SSH ControlMaster** is now configured for both managed SSH aliases
  (`pirouette` and `pirouette-container`). Sockets live in
  `~/.pirouette/ssh-control/` (mode 700); `ControlPersist 10m` keeps
  the master alive 10 minutes after the last channel closes. Effect:
  every ssh-call-after-the-first to the container is ~30× faster (skips
  ProxyJump re-handshake), and `pru tunnel` adds/removes forwards via
  the master without spawning new connections.
- New `sshControl()` and `killControlMasters()` helpers in
  `src/cli/remote/ssh.ts`. The latter is invoked from `pru teardown`
  and `pru destroy` so we don't leave masters pointing at unreachable IPs.

### Changed

- `upsertSshConfig()` now writes `ControlMaster auto`, `ControlPath`,
  and `ControlPersist 10m` lines into the managed block. **Existing
  installs need to re-run `pru setup` once** to pick this up
  (idempotent; just rewrites local SSH config).
- README: new "Authenticating tools inside the container" section
  documenting both the device-flow path (most tools) and the loopback
  path (`pru tunnel`).

---

## 0.2.3 — first-boot \$HOME seed

### Fixed

- Container entrypoint now seeds `$HOME` from `/opt/home-skel/` on first
  boot (idempotent via `$HOME/.pirouette-home-seeded` sentinel). The
  pirouette container bind-mounts the host's per-user state dir over
  `/home/<user>`, which previously masked anything the image baked into
  `$HOME` — oh-my-zsh, zsh plugins, paru config, etc. all silently
  disappeared on first boot. Images that ship a snapshot at
  `/opt/home-skel/` now have those files seeded into the bind-mount
  before yadm clone runs (so dotfiles still win on overlap).

  Images without `/opt/home-skel/` see a one-line log warning and the
  entrypoint continues unchanged — fully backwards-compatible. To
  produce the snapshot in your own image, add this near the end of
  the Dockerfile:

  ```dockerfile
  USER root
  RUN cp -a /home/$username /opt/home-skel
  USER $username
  ```

  To force a re-seed (e.g. after a base image update), `rm
  $HOME/.pirouette-home-seeded` and restart the container.

---

## 0.2.2 — CLI version fix

### Fixed

- `pirouette --version` and `pru --version` now report the actual
  package version. Previously hardcoded as `"0.1.0"` in `src/cli/index.ts`,
  so the published 0.2.1 (and earlier 0.2.0) reported `0.1.0`. The CLI
  now reads `version` straight from `package.json` at startup, so the
  two can't drift again.

No other changes vs 0.2.1. If you're already on a working 0.2.1 you
lose nothing by skipping this; the install ergonomics are the same.

---

## 0.2.1 — security hardening (no-devops-needed pass)

Focused security release closing every issue from the v0.2 review that
doesn't require devops involvement or an auth-architecture decision.
Application-layer auth (bearer token / OIDC) is deliberately deferred to
a later release.

### Security

- **DNS-rebinding from malicious browser tabs blocked.** Removed wildcard
  `Access-Control-Allow-Origin`; the dashboard is same-origin and never
  needed CORS. Server now validates the `Host` header on every HTTP
  request and the `Origin` header on WebSocket upgrades against an
  allowlist (`localhost:<port>`, `127.0.0.1:<port>`, plus the configured
  bind host). Mismatches return 421 (HTTP) or 403 (WS).
- **Default bind narrowed.** `pirouette server` binds `127.0.0.1` by
  default; the container path explicitly opts into `0.0.0.0` via
  `PIROUETTE_HOST` since Docker port-mapping requires it.
- **OPTIONS preflights refused.** No CORS allow headers — returns 405,
  which the browser interprets as "not welcome" and blocks the
  follow-up POST. Removes the JSON-content-type cross-origin attack.
- **Static-server path-traversal check fixed.** The previous
  `startsWith(webDir)` guard was missing a path separator (so
  `/srv/web2/...` would have been accepted as if under `/srv/web`).
  Replaced with `path.resolve` + `startsWith(webDir + path.sep)`.
- **`git clone` argument hygiene.** Inserted `--` separator before the
  user-supplied URL; rejects URLs not matching
  `^(https?://|git@|ssh://)`. Set `GIT_TERMINAL_PROMPT=0` and
  `GIT_ASKPASS=/bin/false` so malformed remotes don't hang waiting
  for credentials.
- **Input validation.**
  - Agent IDs in URL paths are matched against `[a-z0-9][a-z0-9-]{0,63}`;
    anything else returns 404. Prevents log injection via newline-bearing
    IDs and keeps `Map` keys clean.
  - Agent and project names are rejected if they contain control
    characters, are empty, or exceed 200 chars (400 with a clear error).
  - `pru logs --lines` is parsed as a number with range check
    (1–100000); rejects `'200; rm -rf ~'`-style shell injection in
    the SSH-delivered tail command.
- **`EDITOR` launched without a shell.** `pru config edit` now uses
  `spawnSync` with an explicit arg array (`shell: false`) so values
  like `EDITOR='vi -c "set syntax"'` parse safely.
- **Dashboard JS dependencies self-hosted.** marked, marked-highlight,
  DOMPurify are copied from `node_modules/` at build time; highlight.js
  is bundled with esbuild (the npm package ships only CJS). The
  Tailwind v3 CDN runtime is committed at
  `vendor/tailwindcss-3.4.17.min.js` (no v3 npm equivalent exists).
  Closes the CDN-compromise attack surface and lets the dashboard work
  offline / inside private networks.
- **18 new tests** in `src/server/__tests__/security.test.ts` covering
  Host validation, CORS removal, WS Origin checks, path traversal,
  and input validation. 127 vitest tests total (was 109).

### Documentation

- New "Trust model" section in `README.md` stating clearly what
  pirouette enforces (network layer + SSH key today) and what's out
  of scope until a later release.

### Build / packaging

- New `scripts/vendor.mjs` (run before `dev` and `build`) writes vendor
  files into `src/web/vendor/` (gitignored) so both dev mode and
  shipped `dist/web/vendor/` see the same artifacts from one source.
- `npm run dev` and `npm run build` both implicitly re-run vendoring;
  no manual step.

### What this release does NOT close

- The pirouette server still has no application-layer authentication.
  Anyone who can reach `:7777` (today: SSH-tunneled by you, gated by
  AWS SG) has agent-level RCE. This is the C1 finding from the
  security review and remains open until a future release adds bearer
  / OIDC auth.

---

## 0.2.0 — 2026-04-28

Big iteration round on UI polish + pi feature parity in the web dashboard,
plus a much smoother first-time setup story.

### Added

- **Vim modal editing in the message input** (`vim.js`, ~1100 LOC, 42 tests).
  Toggle via the `vim:` button in the input footer; preference persists in
  `localStorage`. Full pi-vim feature parity: 4 modes, hjkl/wbeWBE/0$%, find
  motions, text objects (`iw aw i" a" i( a( …`), operators (`d c y > <`),
  visual / visual-line, multi-level undo/redo.
- **Theme picker** — full base16 set (449 themes generated from
  `neevparikh.github.io/src/base16-tailwind/schemes`). Search + scrollable
  list, FOUC-preventing inline script, light/dark/system slots persisted.
  Drives every other UI surface via base16 CSS variables.
- **Pi-style live footer data** in the agent header — `↑input ↓output Rcache
  Wcache $cost  ctx%/window  thinking: level`. New `GET /api/agents/:id/stats`
  endpoint pulls from `session.getSessionStats()` + `getContextUsage()`.
  Warning/error coloring at 70%/90% context.
- **Live message-queue display + steer/follow-up support.** `queue_update`
  events from pi flow through into the UI as queue chips above the input
  bar. Send-mode toggle (`mode: steer / mode: followUp`) appears while the
  agent is streaming; default `steer` matches pi's TUI. `POST /message`
  accepts `mode` to route through `session.steer()` or `session.followUp()`.
- **Model selector per agent.** `GET /api/agents/:id/models` returns every
  registered model grouped by provider. `POST /api/agents/:id/model` calls
  `session.setModel()` (live) and persists `config.model` (so resumes pick
  it up). UI: `model ▾` button in the agent header opens a search popup.
- **Session forking.** `agent-manager.forkAgent()` uses
  `SessionManager.forkFrom()` to copy the parent's session JSONL, creates a
  fresh worktree off the parent's branch tip, and optionally calls
  `session.navigateTree(entryId)` to truncate to a specific user message.
  `parentAgentId` recorded on every agent for tree visualization.
- **Sidebar tree visualization.** Forks render indented under their parent
  with `↳` prefix and 12px-per-level indent.
- **Raw-markdown view toggle** (global, persisted) — flips every assistant
  message to plain source.
- **Configurable container entrypoint** — new `container.entrypoint_script`
  config field. Set to a local path to ship your own bootstrap script (e.g.
  `chezmoi`, `stow`, `vcsh` instead of the bundled `yadm` flow) without
  forking the package.
- **Auto-push of laptop secrets at `pru setup`.** New `src/cli/remote/secrets.ts`
  module ships `~/.pi/agent/auth.json` + `~/.cache/pi-agent/hawk-access-token`
  into the container's bind-mounted home. Idempotent, skips silently when
  files don't exist locally.
- **`pru sync --secrets`** — re-push laptop auth state into the container
  without a redeploy. Useful after `/login`'ing a new provider locally.
- **`checkLocalAuth()` precheck** — `pru setup` warns loudly *before*
  spending 5 minutes provisioning if the laptop has no `auth.json`.
  Suggests both `/login hawk` on laptop and ssh-into-container fallback.
- **Per-block reconciliation in the messages list.** `data-msg-key`
  attributes + `reconcileBlocks()` helper diff against existing children.
  No more whole-transcript rebuild on every event. Click handlers
  delegated. Auto-scroll only fires when already at the bottom.
- **Streaming flash fix.** Assistant bubble streams as plain text (`<pre>`)
  with append-only DOM mutations; morphs to rendered markdown only on
  `message_complete`. Cursor span stable across deltas.
- **Pi-matching markdown styling** — yellow headings, accent-cyan inline
  code, green code blocks, list markers in cyan, tables sized to content.
  Uses base16 tokens so every theme gets a coherent palette.
- **`importKeyPair()` retry-without-tags fallback.** Some IAM policies (e.g.
  METR's Researcher role) grant `ec2:ImportKeyPair` but block `ec2:CreateTags`
  on key-pairs. We try with tags first, fall back to plain on `CreateTags`
  errors, surface a copy-pasteable devops ask only on full unauthorized.
- **`initRepo()` self-configures git identity** — sets `user.email` /
  `user.name` locally per-repo so first-boot `scratchpad` project init
  doesn't depend on host git config (which the container doesn't have).
- 109 vitest tests (up from 60). New coverage: vim mode, transcript
  reconciliation, queue reducer, render block contract.

### Changed

- **`pru sync` now uses `sudo` + `set -o pipefail`.** Previous npm install
  failures were silently masked by `tail -3`; now they propagate.
- **Agent header geometry.** Both the sidebar header and main agent header
  are now fixed `h-[88px]` so bottom borders line up across all UI states.
- **Sidebar font sizes** uniformly bumped one step (`text-xs` → `text-sm`,
  `text-[10px]` → `text-xs`) so the type hierarchy reads more cleanly.
- **Theme button restyled** as a pill matching the agent-header action
  buttons (`raw`, `stop`, `delete`, etc.) for visual consistency.
- **Default region** in built-in defaults flipped from `us-west-1` to
  `us-west-2`. Per-user TOML overrides still win.

### Fixed

- **`prd-developer-sg` first-time SSH ingress** — documented the SG +
  Tailscale-router-SG combination needed for a working us-west-2 setup
  (devops one-time grant). The CLI's setup error messages now point at
  the right SG ids.
- **State migration backfills `parentAgentId: null`** for pre-fork agent
  records. `errorMessage`, `usage`, `branchName` were already covered.

### Infrastructure / docs

- `docs/todos.md` overhauled to reflect actual status (most of phase 1+2
  done, phase 2.5 step A done, step B scoped).
- `docs/ui_iteration.md` accumulating per-iteration nits + their fixes.
- `pirouette.toml` documents the new `container.entrypoint_script` field.

---

## 0.1.0 — 2026-04-23

Initial public release on npm. MVP for single-user cloud-hosted pi agents
with a web UI.

### Highlights

- `pru` CLI with `setup` / `teardown` / `destroy` / `preflight` /
  `launch` / `list` / `send` / `stop` / `rm` / `status` / `open` /
  `ssh` / `logs` / `sync` / `config` commands.
- Server embeds the pi-coding-agent SDK; HTTP + WebSocket API.
- Web dashboard with markdown rendering, tool-call collapsing, smart
  tool headers (bash → description, edit → filename, grep → pattern),
  diff rendering, smart result summaries, running indicators, per-agent
  cost + token tracking, info strip in header.
- EC2 provisioning into a configurable VPC + private subnet + SG. EBS
  volume tagged `pirouette-data`, auto-reused across instance recreations.
  Docker root relocated to EBS.
- pi extensions auto-loaded at server startup (hawk-provider, etc.).
- Phase 2: projects + git worktrees + `@`-tagging routing. `scratchpad`
  default project. Worktrees at `<dataDir>/worktrees/<project>/<slug>-<id>/`.
- Tests: 60 vitest covering rendering helpers + event reducer.
