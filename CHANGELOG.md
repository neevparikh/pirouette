# pirouette changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org).

---

## 0.6.1 — fix: tailscale FQDN extraction in byo-host bootstrap

### Fixed

v0.6.0's tailscale block scraped the device FQDN out of
`tailscale status --json` with a regex (`"DNSName":"[^"]+"`) that
required no whitespace between `:` and `"`. Newer tailscale versions
pretty-print the JSON, putting a space there—so the regex matched
nothing, `grep -oE` returned exit 1, and `set -euo pipefail` killed
the bootstrap after the rest of the tailscale setup had already
succeeded. The dashboard ended up reachable over the tailnet but
the pirouette server didn't get restarted with
`PIROUETTE_ALLOWED_HOSTS=<fqdn>`, so requests from the tailscale URL
failed the server's Host-header allowlist.

Fix: parse the FQDN from `tailscale serve status`'s plain-text
output instead. The serve-status output prints `https://<fqdn>/` on
its own line and is stable across tailscale versions. Also added
`|| true` defensively so future parse failures here don't kill the
bootstrap — the useful work (tailscaled up, serve configured) has
already happened by the time we get here.

### Manual recovery for v0.6.0 users

If you already ran `pru setup` on v0.6.0 and the tailscale block
crashed, your tailnet is configured correctly but the pirouette
server is missing the allowed-hosts plumbing. Either:

  1. Upgrade to v0.6.1 and `pru setup` again (idempotent re-run
     adds the allowlist + restarts the tmux session).
  2. Or manually restart the tmux session with the env var:
     ```
     ssh <alias> 'tmux kill-session -t pirouette; tmux new-session -d -s pirouette \
       "PIROUETTE_DATA_DIR=<data_dir> PIROUETTE_PORT=7777 PIROUETTE_HOST=127.0.0.1 \
        PIROUETTE_ALLOWED_HOSTS=<fqdn>.<tailnet>.ts.net pirouette server"'
     ```

---

## 0.6.0 — tailscale-on-byo-host (reach the dashboard from your phone)

### Added

Optional Tailscale integration for the byo-host provider. Enable it,
run `pru setup`, approve once in a browser, then reach the dashboard
at `https://<hostname>.<your-tailnet>.ts.net` from any device on your
tailnet — phone, secondary laptop, anywhere. The trust boundary stays
the tailnet ACL; pirouette server stays bound to `127.0.0.1` on the
pod and only tailscaled (same netns) bridges traffic in.

Config:

```toml
[provider.byo-host.tailscale]
enabled         = true
hostname        = "pirouette-gpu-devpod"   # optional; default: pirouette-${ssh_alias}
state_persistent = true                     # symlink /var/lib/tailscale -> ${persistent_root}/tailscale-state
```

Mechanics added by the bootstrap script:

1. Symlinks `/var/lib/tailscale` to the persistent volume on first run
   (when `state_persistent`), so the node key + auth state survive
   pod recreate. Migrates any pre-existing dir contents into the
   symlink target before swapping, so an image-baked node key isn't
   lost.
2. Installs tailscale if not already on the image
   (`curl -fsSL https://tailscale.com/install.sh | sudo sh`).
3. Starts `tailscaled --tun=userspace-networking` in the background.
   Userspace mode means no `CAP_NET_ADMIN` needed — works inside
   stock k8s pods without privileged or special securityContext.
4. Runs `tailscale up --hostname=...` on first boot. Without an
   `--auth-key`, this prints a login URL and blocks until you approve
   in a browser. `pru setup` streams the URL to your terminal so you
   can click. Subsequent boots read the cached node key from the
   persistent volume and skip auth.
5. `tailscale serve --bg --https=443 http://localhost:$PORT` bridges
   the loopback bind onto the tailnet IP on :443 with a tailscale-
   provisioned TLS cert (LetsEncrypt via tailnet).
6. After all of the above succeeds, the pirouette server is restarted
   with `PIROUETTE_ALLOWED_HOSTS=<tailnet-fqdn>` so its Host-header
   allowlist accepts requests from the new hostname. Restart is
   sentinel-gated (`$DATA_DIR/tailscale-fqdn-active`) so it only runs
   when the FQDN changes — idempotent on re-runs.

`pru status` on byo-host gains a `tailscale  ✅ https://<fqdn>` line
when tailscale is up, sourced from the bootstrap-written sentinel
file (one ssh round-trip; same probe as the other health checks).

New SSH helper `sshStreaming()` in `src/cli/remote/ssh.ts`. Buffered
`ssh()` couldn't surface `tailscale up`'s login URL in time (output
buffered until ssh returns; ssh wouldn't return until tailscale up
returned; tailscale up wouldn't return until the user approved —
deadlock from a UX perspective). The streaming variant inherits the
parent's stdio so output is real-time. `provision()` switched to use
it for the bootstrap step regardless of tailscale state, which is
also a UX win for the slow npm install / yadm clone steps.

### Notes

- Tailscale is opt-in. Existing byo-host setups without
  `[provider.byo-host.tailscale]` configured behave identically to
  v0.5.2.
- `state_persistent = false` gives you a fresh tailnet identity per
  pod recreate (you'd re-auth in a browser each time). Useful if you
  want disposable nodes; default is on for stable hostnames.
- The EC2 provider is unaffected. Its existing
  `tailscale serve --bg --https=443 http://localhost:7777` recipe
  documented in the README continues to be a one-time manual step
  per the README's "Quick start (cloud)" section.
- If `tailscale up` fails for any reason, the server still works via
  the SSH-tunnel fallback path — `pirouette server` stays bound to
  127.0.0.1 regardless, so the tunnel route is always available.

---

## 0.5.2 — fix: yadm clone over SSH in byo-host bootstrap

### Fixed

The bootstrap's `yadm clone` step couldn't authenticate when the
user's `dotfiles.clone_url` pointed at a private repo over HTTPS
(github prompts for username; non-interactive bootstrap fails). The
workaround is to use the SSH form (`git@github.com:user/repo.git`)
so the clone uses the user's ssh-agent (forwarded via the byo-host
alias's `ForwardAgent yes`).

But SSH-form URLs hit a second problem: the devpod has never SSH'd
to `github.com` before, so the first connection wants to confirm
the host key. Non-interactive bootstrap can't answer the prompt and
the clone hangs / fails.

Fix: when `clone_url` is in SSH form (matches `^[^@]+@([^:]+):`),
extract the host and `ssh-keyscan -H <host> >> ~/.ssh/known_hosts`
before invoking yadm. Idempotent (skips if `ssh-keygen -F <host>`
already finds an entry). For HTTPS URLs the new block is a no-op.

Also added a hint in the clone-failure log message pointing at the
two most common causes (no ForwardAgent in ssh_config; ssh-agent
key not authorised on the dotfiles repo).

---

## 0.5.1 — fix: scp $HOME expansion in byo-host dir-push

### Fixed

`pushDirViaPlainSsh` (used by `pru sync --secrets` on byo-host for AWS
SSO/CLI cache pushes) constructed scp destinations as `$HOME/<rel>`.
scp does NOT shell-expand `$HOME` on the remote — the path is passed
literally and lands as a directory called "$HOME". First real exercise
of the path on a live byo-host devpod surfaced this immediately:

```
scp: dest open "$HOME/.aws/sso/cache/<hash>.json": No such file or directory
```

Fix: use `~/<rel>` instead. scp DOES expand `~` (OpenSSH feature), and
bash expands it the same way in our `ssh` commands too, so a single
form works for both. `pushFileViaPlainSsh` already used `~/` correctly
in its scp dest; this aligns `pushDirViaPlainSsh` with the same style.

Lengthy in-file comment explaining the quoting subtlety (`~` inside
double-quotes does NOT expand, so the path is deliberately unquoted;
safe because `containerHomeRelative` is config-controlled and never
contains whitespace for our standard secret specs).

File pushes (hawk OAuth, hawk cache, AWS config) were unaffected and
worked end-to-end in v0.5.0.

---

## 0.5.0 — slash commands + AGENTS.md auto-injection + AWS SSO push

All the agent-side QoL that piled up after v0.4.0 ships in one go. No
breaking config changes; existing deployments pick everything up on the
next `pru sync --npm` (or a fresh `pru setup`).

### Added

**Slash-command popup in the dashboard.** Type `/` in the message input
to open an autocomplete popup that mirrors the existing `@`-mention
popup (mutually exclusive via disjoint anchor regexes). Lists
pirouette's client + server commands plus `/skill:<name>` entries
discovered by the shared `ResourceLoader`.

Three new server endpoints back the new commands:

- `GET /api/skills` — `{ skills: [{name, description}, ...] }`. Drives
  the slash-popup autocomplete.
- `POST /api/agents/:id/compact` with optional `{instructions}` body —
  fire-and-forget manual compaction. Wraps pi's `session.compact()`;
  progress surfaces via existing `compaction_start` / `compaction_end`
  events.
- `POST /api/agents/:id/new` — discard the current session, create a
  fresh JSONL in the same worktree/branch. Broadcasts a new WS
  envelope `agent_session_reset` so clients clear cached transcripts.

**Per-worktree pivot/DVC auto-setup.** For repos that use
[pivot](https://github.com/METR/pivot) or DVC, every new agent's git
worktree gets symlinks to the source repo's cache + config so the
agent can run pipeline commands immediately instead of re-downloading
gigabytes from S3. Auto-detected from `.pivot/` / `.dvc/` in the
source repo; idempotent; non-fatal on failure. Specifically symlinks:

  - `.pivot/cache` — content-addressed, append-only
  - `.pivot/config.yaml` + `.pivot/config.lock`
  - `.pivot/locks` — cross-process locking; sharing is REQUIRED for
    correctness with concurrent worktrees
  - `.pivot/state.lmdb` — stage+params -> output hash; content-
    addressed so sharing is correct
  - `.dvc/cache`

Lives in `src/server/worktree-setup.ts`. Wired into
`AgentManager.startSession` so it runs on resume too — pre-existing
agents created before this shipped retroactively get fixed on their
next start.

**AWS SSO + CLI cred push via `pru sync --secrets`.** Agents on the
remote can now hit S3 / STS with the same credentials your laptop has.
Default `DEFAULT_SECRETS` now includes:

  - `~/.aws/config` (file)
  - `~/.aws/sso/cache/*.json` (dir, `.json`-only; `session.db` excluded)
  - `~/.aws/cli/cache/*.json` (dir, `.json`-only)

The `SecretSpec` shape becomes a discriminated union
(`SecretFileSpec` | `SecretDirSpec`) so the dir flavour can stage flat
directories with an optional include filter and replace semantics
(default: wipe stale tokens before push). Four push paths cover the
file/dir × ec2-bindmount/plain-ssh cross-product, so AWS push works
on both EC2 and byo-host. Workflow: `aws sso login` on the laptop,
then `pru sync --secrets` to refresh.

### Fixed

**Stop button now actually works.** `stopAgent()` was acquiring the
agent lock first and *then* calling `session.abort()` inside the
lock. But `sendMessage()` holds the same lock across
`await session.prompt()`, which doesn't resolve until the turn ends
naturally — so stopping a streaming agent deadlocked: the stop
waiter never ran because the holder was waiting for a turn that
would never end. Fix: call `session.abort()` *before* taking the
lock. Pi's `abort()` is explicitly designed to be called concurrently
with `prompt()`. Lengthy comment in `agent-manager.ts` explains the
invariant for future maintainers.

**AGENTS.md / CLAUDE.md context auto-injection.** Agents weren't
seeing their project's `AGENTS.md` because pirouette uses one shared
`DefaultResourceLoader` with `cwd = dataDir`. That loader's
`getAgentsFiles()` scans up from cwd, so an agent working in
`/data/worktrees/<proj>/<agent>` never saw the project's `AGENTS.md`.
Fix: per-agent `ResourceLoader` wrapper that delegates everything to
the shared loader except `getAgentsFiles()`, which we recompute on
every call against the agent's `worktreePath` via pi's own
`loadProjectContextFiles` helper. Behaviour now matches
`pi --cwd=<worktreePath>` in a fresh TUI.

### Changed

`compaction_start` / `compaction_end` events now flow through the
transcript state machine (`compaction.active` / `lastResult`), with
+42 lines of test coverage in
`src/web/__tests__/transcript.test.js`. UI rendering of the
compaction indicator badge is still a follow-up.

### Known follow-ups

- Compaction UI indicator: state is wired but the in-transcript badge
  / footer chip isn't rendered yet. State plumbing in `transcript.js`
  is ready; just needs the markup in `app.js` / `index.html`.
- End-to-end smoke test against a live container for the three new
  endpoints and the slash popup.
- First exercise of `pushDirViaPlainSsh` (AWS-on-byo-host) on the
  next `pru setup --kind byo-host` cycle. Bind-mount variants are
  battle-tested; plain-ssh dir push is new code.

---

## 0.4.0 — byo-host provider (install pirouette onto any SSH host)

### Added

A second host provider, `byo-host`, that points pirouette at any
SSH-reachable Linux box you already manage (a METR k8s devpod is the
intended use case, but any host that satisfies the existing
[container image requirements](README.md#container-image-requirements)
works). Pirouette uploads a bootstrap script over SSH; no AWS calls, no
Docker, no separate `pirouette-container` SSH alias.

Toggle via `~/.pirouette/config.toml`:

```toml
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias       = "my-devpod"
persistent_root = "/data"
user            = "me"
```

See README's "Quick start (byo-host)" for the full recipe.

Mechanics that mirror the EC2 path exactly so muscle memory carries over:

- `/home/<user>` becomes a symlink to `${persistent_root}/home/<user>`,
  seeded once from `/opt/home-skel` on first boot. Same skel pattern as
  the EC2 entrypoint (`scripts/pirouette-entrypoint.sh:46-63`); image
  bumps don't re-seed.
- `authorized_keys` is re-fetched from `dotfiles.authorized_keys_url` on
  every `pru setup` so key rotation Just Works.
- yadm dotfiles, npm prefix, pi auth secrets, tmux session for
  `pirouette server` — same as today's container entrypoint, just over
  SSH instead of `docker run`.
- Server binds `127.0.0.1` on the remote (loopback only); access from
  laptop is via SSH tunnel. The README's "Trust model" section now
  describes per-provider perimeter.

### Changed

The internals were refactored around a `HostProvider` interface so the
two providers can share `pru setup` / `teardown` / `destroy` / `status`
/ `ssh` / `logs` / `tunnel` / `sync` plumbing. Behaviour on the EC2 path
is byte-identical to 0.3.8.

State file `~/.pirouette/ec2.json` is renamed to `~/.pirouette/host.json`
and picks up a `kind` discriminator. Migration is automatic on first
read; the legacy filename will be removed in a future release.

`requireConfigured()` is now provider-aware. `kind = "byo-host"` no
longer demands AWS keys; `kind = "ec2"` is unchanged.

`pru preflight` dispatches on kind: EC2 keeps its detailed AWS resource
checks; byo-host validates the SSH alias, runs an SSH probe, confirms
`persistent_root` exists, and checks the remote has `node`, `npm`,
`git`, `tmux`.

`pru status` on byo-host now reports home-symlink health
(✅ / ⚠ next to symlink, data dir, tmux state) in one SSH round-trip,
making partial-setup states obvious.

CLI help text updated where commands referenced "EC2" only.

### Tests

+19 tests covering provider-aware `requireConfigured`, byo-host config
resolution with default vs. override paths, and `host.json` migration
from legacy `ec2.json`. Total: 159 passing.

### Design doc

Local at `docs/plans/2026-05-13-provider-abstraction.md` (gitignored
like the rest of `docs/`).

---

## 0.3.8 — Roomier chat bubbles + sidebar project names

### Changed

Chat message bubbles bumped from `text-sm` (14px) to `text-base` (16px).
Applies to user messages, assistant streaming bubbles, and finalized
assistant messages (both the rendered-markdown and raw-source views).
The previous size felt cramped relative to the bubble padding; 16px
reads as a chat app rather than a TUI shrunken into a webview.

Sidebar project names bumped to `text-base` (from `text-sm`) and got
`tracking-wider` (0.05em letter-spacing). Zilla Slab Bold runs tight at
small sizes — the extra spacing relaxes it so multi-character project
names don't read as a solid wedge of glyphs.

No behavioural changes; pure typography tuning.

---

## 0.3.7 — Readable muted text on light themes

### Fixed

Muted text was invisible on some light base16/base24 themes (notably
`base24-softstack-light`). All 31 `text-base16-400` / `placeholder-
base16-400` usages bumped to `text-base16-500` / `placeholder-base16-
500`.

The root cause: `text-base16-400` resolves to `base03` from the
source scheme, which by base16 convention is "comments" and varies a
lot between themes. Some themes (softstack-light) use it as a deeper
bg-tint that's essentially indistinguishable from `base00` (the bg)—
render any text in that color and you get an invisible row. The
`base04` slot (= our `text-base16-500`) is the conventional
"secondary foreground" and reliably contrasts with the bg across
light and dark themes.

Net effect:

- Light themes: muted text actually visible. Big improvement on
  softstack-light, gruvbox-light, and any other theme with a
  bg-tinted base03.
- Dark themes: muted text slightly more prominent than before (e.g.
  on softstack-dark, 400 was a medium gray; 500 is light cream). Still
  visibly muted relative to primary text (base16-700), just less
  recessed. If you preferred the subtler look we can introduce a
  `text-base16-muted` token with per-theme contrast checking later.

`bg-base16-400` and `border-base16-400` (2 usages) preserved — their
contrast against the bg is intentional in those contexts.

---

## 0.3.6 — Notify button fits the sidebar

### Fixed

- The 0.3.5 notify button used a multi-word label (`notify: off` /
  `notify: on` / `notify: blocked` / `notify: n/a`) that varied enough
  in width to push the sidebar header (`pirouette` heading + `notify`
  + `theme`) past the 256-px sidebar at md+ widths. Now uses a single
  `notify` label with state expressed through background color (gray
  off / blue on / red blocked / faded n/a) and the title attribute,
  matching the pattern of the other action pills.

---

## 0.3.5 — Browser notifications + mobile message wrap

### Added

- **Browser notifications** when an agent finishes its turn (transitions
  to `waiting_input`) or hits an error. Suppressed when the dashboard
  tab is currently visible-and-focused (you can already see). Same-agent
  notifications collapse via the Notification `tag` attribute. Clicking
  a notification focuses the dashboard tab and selects the agent.
  - Toggle: new `notify: off/on/blocked/n/a` button next to `theme` in
    the sidebar header. First click requests permission and fires a
    one-shot confirmation notification so you can see what they look
    like. Persists in `localStorage` (key `pirouette-notifications`).
  - Uses the standard `Notification` API — fires only while the
    dashboard tab is open (foreground or background). For "alert me
    even when the tab is closed," you'd need Web Push (service worker
    + VAPID keys + server-side delivery + iOS PWA install). That's a
    separate, larger build that we deliberately punted.

### Fixed

- **Long unbreakable strings (URLs, file paths, hashes) in messages
  no longer push the bubble past the viewport** on narrow screens.
  Added `overflow-wrap: anywhere; word-break: break-word` to `.md`
  content and the user/assistant `<pre class="whitespace-pre-wrap">`
  fallbacks. Code blocks (`pre`, `pre code`) and tables explicitly
  opt out via `overflow-wrap: normal` so they keep their existing
  inner `overflow-x: auto` behaviour rather than wrapping mid-token.

---

## 0.3.4 — Mobile UI iteration: shorter placeholder, header alignment

Follow-ups from the first round of phone testing on 0.3.3:

### Fixed

- **Textarea placeholder no longer wraps + clips** on phone-width
  viewports. The desktop strings (`@name your message (creates one in
  scratchpad if new)` / `message <agent> — or @othername to redirect`)
  are 50+ characters and Safari renders them across two lines inside a
  `rows="1"` textarea, with the first line clipped above the visible
  area. Mobile now uses short variants (`@name your message…` /
  `message <agent>…`) that fit on one line. `updateInputPlaceholder()`
  now also fires on window resize so rotating a phone switches between
  the variants.
- **Agent header alignment** below `md` was visibly off because
  `items-start` top-aligned the agent name (Zilla Slab bold) and the
  action pills (mono in pill containers), and their box-heights
  differ. Now `items-center` on mobile (`items-start` preserved at
  md+ where the multi-line info strip needs top-align). Removed the
  `mt-0.5` nudge on the hamburger button — not needed once the
  parent flex centers everything.

---

## 0.3.3 — Mobile-friendly dashboard + user-local npm prefix

### Added — mobile-friendly dashboard

The dashboard was desktop-only before this release. On a phone the
256-px sidebar consumed most of the screen, the action pills wrapped
and overlapped the agent name, and the input bar got clipped
off-screen. Now:

- **Sidebar becomes an off-canvas drawer below `md` (768 px).** Hidden
  by default; a hamburger toggle in the agent header opens it. Tapping
  the backdrop or pressing Escape closes it. Selecting an agent
  auto-closes the drawer so the conversation is immediately visible.
- **Agent header collapses on mobile.** Auto-height (no fixed 88px),
  reduced padding, the info-strip and live-stats lines hidden
  (still visible on desktop), action pills wrap to a second row when
  needed.
- **`raw` / `model ▾` / `fork` pills hidden when no agent is
  selected.** Previously they sat next to the placeholder text and
  caused a 3-line wrap on phones.
- **Modal scales:** `w-full max-w-sm md:w-96` with outer `p-4` so
  it never overflows narrow screens.
- **Theme + model dropdowns** use `max-w-[calc(100vw-…)]` so they
  don't extend past the viewport edge.
- **`h-dvh` instead of `h-screen`** — iOS Safari's URL-bar-aware
  viewport unit. The dashboard no longer gets cut off when the URL
  bar shows.
- **`viewport-fit=cover`** + `pb: max(…, env(safe-area-inset-bottom))`
  on the input bar — textarea sits above the iOS home indicator.
- **Vim mode auto-disabled below 768 px** even if `localStorage`
  said "on." The modal editor is hostile on touch keyboards (no
  Esc, no easy modifiers). Re-enable explicitly via the toggle if
  you really want it on a tablet.
- **No auto-focus on the textarea on mobile.** Tapping an agent
  used to summon the on-screen keyboard immediately, hiding most
  of the conversation.

### Fixed — pi auto-installs from `settings.packages` no longer fail

Pi auto-installs packages listed in `settings.packages` (e.g.
`pi-tmux-window-name`) at server startup. On the container, those
installs ran as the unprivileged user but tried to write to
`/usr/lib/node_modules` (the system npm prefix), failing with
`EACCES` and crashing the server.

Fix: switch the container's npm prefix to `$HOME/.npm-global`
(user-writable). All `npm install -g` calls — the entrypoint's
pirouette install, pi's runtime auto-installs, `pru sync --npm`,
and `pru sync` tarball installs — now write to the same
user-local location. No sudo required anywhere.

Mechanics:

- `scripts/pirouette-entrypoint.sh` configures `npm config set
  prefix $HOME/.npm-global`, persists `$PATH` in `.bashrc`,
  `.bash_profile`, `.zshrc`, `.zshenv`, and `.profile` so any
  shell mode picks it up, and migrates away from a previous
  system-prefix install (`sudo npm uninstall -g
  @neevparikh/pirouette` if present).
- `src/cli/commands/sync.ts` wraps every `docker exec` in
  `bash -lc "…"` so the rc-file `PATH` is sourced for tmux pane
  subshells. Drops `sudo` from the install commands.

### Migration

Fresh containers (next `pru destroy && pru setup`) get the new
flow automatically. Existing containers can migrate manually:

```bash
pru ssh
npm config set prefix "$HOME/.npm-global"
for rc in ~/.bashrc ~/.bash_profile ~/.zshrc ~/.zshenv ~/.profile; do
  [ -e "$rc" ] && grep -qF '/.npm-global/bin' "$rc" || \
    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$rc"
done
sudo npm uninstall -g @neevparikh/pirouette
npm install -g @neevparikh/pirouette@latest
```

Or just `pru destroy && pru setup` for a clean reprovision.

---

## 0.3.2 — \$HOME ownership fixes

### Fixed

Two paths that ended up creating root-owned files inside the container's
bind-mounted `$HOME`, breaking tools that expected to write under those
directories.

- **`pushSecrets()` left ancestor dirs root-owned.** When pushing
  e.g. `~/.pi/agent/auth.json` to a fresh bind-mount, `sudo mkdir -p`
  on the host created `.pi/` and `.pi/agent/` as root, and we only
  `chown`'d the leaf. The user-owned auth file lived under a
  root-owned `.pi/` (mode 755) — readable but not writable by the
  container user, so pi-coding-agent broke when it tried to create
  any sibling file/dir under `.pi/`. Same problem for `~/.cache/`.
  Now `chown -R`s the top-level segment under `$HOME` (`.pi`,
  `.cache`) so every level is `1000:1000`.
- **Container entrypoint sshd log was root-owned.** `sudo sshd -E
  $HOME/logs/sshd.log` opened the log file as root the first time,
  so the file ended up `root:root 600` in the user's home. Pre-touch
  the log file as the container user before sudo'ing sshd; sshd then
  appends to an already-existing user-owned file.

If you have an existing container with the broken state, fix it
in-place:

```bash
pru ssh
sudo chown -R neev:neev ~/.pi ~/.cache ~/logs/sshd.log
```

Fresh `pru setup` runs (and any future secrets push) on 0.3.2 land
correctly without the fixup.

---

## 0.3.1 — State file crash-consistency

### Fixed

Two interacting bugs in `src/server/state.ts` that could silently lose
all agent + project state:

- **`save()` was non-atomic.** It used `writeFile()` directly, so a
  process killed mid-save (`tmux kill-session` SIGHUP, OOM, container
  restart, host reboot) left a half-written, unparseable JSON file on
  disk.
- **`load()` swallowed every error silently** with a bare `catch {}`
  and fell back to empty state. The next `save()` then overwrote the
  corrupted file with a valid empty one — no log line, no warning,
  permanent data loss.

The interaction was the worst case: any process kill that landed
inside a save's write window erased state on the next server start,
invisibly.

### Now

- **`save()` is atomic.** Writes to `<file>.tmp`, then `rename()` into
  place. Rename is atomic on POSIX same-filesystem moves; readers see
  either the previous file or the new one, never a partial.
- **`load()` distinguishes ENOENT from corruption.** First-run
  (no file) still works fine. On parse failure or any other read
  error, the bad file is renamed to
  `pirouette-state.json.broken-<ISO-timestamp>` so its bytes are
  preserved for forensics, and `load()` throws — the server refuses
  to start with ambiguous state. The error message includes the
  quarantine path:

  ```
  state file /data/state/pirouette-state.json is corrupted:
  Expected property name or '}' in JSON at position 12.
  Quarantined copy preserved at /data/state/pirouette-state.json.broken-2026-04-30T00-06-46-450Z.
  Inspect it, or remove it to start fresh.
  ```

  If the broken file isn't recoverable, deleting it makes the next
  start a clean first-run.

### Tests

7 new tests in `src/server/__tests__/state.test.ts` covering the
ENOENT, corruption, EISDIR, atomic-rename, stale-tmp-recovery, and
round-trip paths. Total 140 (was 133).

---

## 0.3.0 — Tailscale HTTPS as the canonical path; SSH tunnel removed

Consolidates around a single dashboard URL: `server.public_url` from
config, typically a Tailscale Serve HTTPS endpoint like
`https://<host>.<tailnet>.ts.net`. The browser, the `pru` CLI, and the
web dashboard's WebSocket all use this one URL. Two redundant access
paths from earlier releases are gone.

### Breaking

- **`pru close` is removed** along with the `~/.pirouette/tunnel.pid`
  bookkeeping. The SSH tunnel approach is no longer the default;
  there's nothing to close.
- **`pru open` no longer opens an SSH tunnel.** It opens
  `server.public_url` (or `PIROUETTE_URL`) in your browser. If
  neither is set, it refuses with a clear error pointing at the
  config field. Previously, `pru open` would spawn `ssh -L
  7777:localhost:7777 -N -f pirouette` and open `http://localhost:7777`.
- **The CLI's default API base is now `server.public_url`** instead
  of `http://127.0.0.1:7777`. `pru list`, `pru launch`, etc. now
  talk to the dashboard URL directly. `PIROUETTE_URL` still
  overrides for local-dev / emergency use.
- If neither `server.public_url` nor `PIROUETTE_URL` is set, every
  CLI command that hits the API throws "No pirouette server URL
  configured" with a one-line fix.

### Added

- **`server.public_url` config field.** Canonical dashboard URL.
  See `pirouette.toml` for an annotated example.

### Why

From 0.2.6 / 0.2.7 we had three working access paths to the dashboard:

1. SSH tunnel → `http://localhost:7777` (via `pru open`)
2. Plain HTTP over tailnet → `http://<host>:7777`
3. HTTPS over tailnet via `tailscale serve` → `https://<host>.<tailnet>.ts.net/`

(2) is strictly worse than (3) once HTTPS works (same trust boundary,
worse UX). (1) is meaningfully different (uses SSH key, no tailnet
dependency) but redundant in normal operation. Maintaining all three
meant `pru open` had to keep the SSH-tunnel machinery alive for
backwards compatibility, and the CLI talked to a different URL than
the browser — confusing in failure modes.

This release picks (3) as canonical and removes the rest of the
bookkeeping. The SSH-tunnel path stays available as a manual
escape-hatch for tailnet outages — documented in README
"Troubleshooting" — but isn't a first-class CLI command anymore.

### Migration

If you've been using the SSH-tunnel access path, you'll need to:

1. Set up `tailscale serve` on the host (one command, see CHANGELOG
   for 0.2.6/0.2.7) and add the resulting URL to your config:

   ```toml
   [server]
   allowed_hosts = ["<host>", "<host>.<tailnet>.ts.net"]
   public_url    = "https://<host>.<tailnet>.ts.net"
   ```

2. Re-run `pru setup` (idempotent; rewrites the docker run env to pick
   up the new `allowed_hosts`).

3. Remove any aliases / scripts that called `pru close`. (`pru open`
   no longer maintains state, so there's nothing to clean up.)

If you're without tailnet access (laptop fell off, ACL change, etc.),
the README "Troubleshooting" section has a 2-line `ssh -L …` recipe
plus `PIROUETTE_URL=http://localhost:7777` to reach the dashboard
from your laptop browser.

---

## 0.2.7 — Portless Host header support (`tailscale serve --https`)

### Fixed

- `server.allowed_hosts` entries with no port no longer silently strip
  the bare-host variant from the allowlist. Previously a config of
  `["pirouette-neev"]` only generated the entry `pirouette-neev:7777`,
  so requests with `Host: pirouette-neev` (no port) hit `421 Misdirected
  Request`. Now bare entries generate **both** the portless and the
  `:<configured_port>` variants. Explicit `<host>:<port>` entries still
  pass through as-is.
- This makes `tailscale serve --https=443 http://localhost:7777` work
  end-to-end: the Tailscale TLS-terminating proxy forwards a Host
  header of just the FQDN (port 443 is the HTTPS default and so is
  omitted), which the server now accepts.

### Recipe (HTTPS via `tailscale serve`)

0.2.6 lets you reach the dashboard at `http://pirouette-neev:7777` over
the tailnet. 0.2.7 adds the option of proper HTTPS with a real cert
at `https://<host>.<tailnet>.ts.net/` (no port number, no warnings).

On the EC2 host:

```bash
sudo tailscale serve --bg --https=443 http://localhost:7777
```

In `~/.pirouette/config.toml`:

```toml
[server]
allowed_hosts = [
  "pirouette-<you>",                         # bare HTTP via :7777
  "pirouette-<you>.<tailnet>.ts.net",        # HTTPS via tailscale serve
]
```

Then `pru setup` (idempotent) and use the new HTTPS URL. Both access
paths stay live in parallel; nothing existing breaks. Tailscale's
CA-issued cert is browser-trusted and auto-renews — no manual cert
management.

Prereqs (verify in your tailnet admin if `tailscale cert <fqdn>`
fails): MagicDNS enabled + HTTPS Certificates enabled. Both default-on
for newer tailnets. No ACL changes needed if your tailnet ACL already
allows `:443` from your devices to this host.

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
