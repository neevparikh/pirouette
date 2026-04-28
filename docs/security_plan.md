# Security plan: 0.2.1 + open questions for later

Working plan for the next security-focused release. The goal of 0.2.1 is
to ship every fix from `docs/security_review.md` that **doesn't require
devops/admin involvement** — no new IAM policies, no Tailscale ACL
changes, no Okta client registrations, no auth-flow design decisions
that aren't already settled.

Decisions that need devops or auth-architecture work — bearer-token auth,
Okta JWT validation, OIDC, Tailscale binding for the dashboard — are
deferred to a later release (0.3.0+). They're tracked at the bottom of
this doc as "open decisions for next round".

---

## What 0.2.1 closes (and what it doesn't)

Be clear-eyed about the scope. After 0.2.1:

| attack | closed? | how |
|---|---|---|
| **DNS-rebinding from a malicious browser tab** while the tunnel is open | ✅ | Host validation rejects requests where the `Host` header doesn't match `localhost:<port>` / `127.0.0.1:<port>` |
| **Cross-origin read of API responses** by a browser tab | ✅ | Removed wildcard `Access-Control-Allow-Origin`; same-origin only |
| **JSON-content-type cross-origin POST** (preflight-required) | ✅ | No CORS allow → preflight rejected → request never sent |
| **CDN supply-chain compromise** (Tailwind, marked, DOMPurify, hljs) | ✅ | Self-hosted at `dist/web/vendor/` |
| **Static-server path traversal** (HTTP-side) | ✅ | Fixed `startsWith(webDir + path.sep)` check |
| **`git clone` of attacker-supplied URL** that starts with `-` | ✅ | `--` separator + URL prefix regex |
| **Self-RCE via `pru logs --lines '200; rm -rf ~'`** | ✅ | Numeric coercion + range check |
| **Log injection via control-char-bearing agentId / name** | ✅ | Input validation regexes |
| **Lateral access from another process on your laptop** in dev mode | ✅ | `pirouette server` defaults to `127.0.0.1` (not `0.0.0.0`) |
| **EDITOR shell metacharacter parsing** | ✅ | `spawnSync` with arg array, no shell |
| | | |
| **Anyone reachable on `:7777` has RCE** (the C1 finding) | ❌ | Bearer auth deferred to 0.3.0+ |
| **Stolen SSH key → container shell** | ❌ | Out of scope; SSH layer owns this |
| **Compromised tailnet member** (when we add Tailscale) | ❌ | Out of scope until Tailscale lands |

The single critical attack from the security review (C1: zero auth on
the API) is **explicitly not addressed in 0.2.1**. The mitigation
relies on the existing layers below us (SG only allows `:22`, SSH key
required to reach the tunnel, no public exposure). Those layers are
holding today; we're tightening everything around them.

If your threat model changes — new instance gets exposed to a wider
network, you start sharing access with anyone, etc. — bearer auth
becomes urgent and we need 0.3.0+ first.

---

## 0.2.1 fix list (concrete)

### 1. Drop wildcard CORS

**File:** `src/server/index.ts` (the `Access-Control-Allow-*` headers
in the response writers).

Remove all of these:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: ...`
- `Access-Control-Allow-Headers: ...`

The dashboard is same-origin (served from the same `:7777`); CORS isn't
needed at all. Removing it makes browsers block cross-origin reads (they
already do without the headers, but the wildcard was actively granting
permission).

Side effect: any external tooling that was hitting our API from a
different origin in a browser will break. We don't know of any.

### 2. Validate `Host` on HTTP and `Origin` on WebSocket

**File:** `src/server/index.ts`.

Build a `getAllowedHosts()` helper:

```ts
function getAllowedHosts(): Set<string> {
  const port = String(getConfig().container.pirouette_port);
  return new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    // For container path: also accept the bind IP if 0.0.0.0
    // (Docker port-mapping clients send Host: <docker-internal-ip>:port
    // sometimes; we need to allow at least the canonical names)
  ]);
}
```

In the request handler, before any routing:

```ts
const host = req.headers.host ?? "";
if (!getAllowedHosts().has(host)) {
  res.statusCode = 421; // Misdirected Request
  res.end("host not allowed");
  return;
}
```

For WebSocket upgrades, supply `verifyClient`:

```ts
new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info, cb) => {
    const host = info.req.headers.host ?? "";
    if (!getAllowedHosts().has(host)) {
      cb(false, 421, "host not allowed");
      return;
    }
    cb(true);
  },
});
```

Origin validation is belt-and-suspenders for cases where Host alone
doesn't catch a misconfigured proxy. For 0.2.1 we'll do Host validation
on HTTP and Origin validation on WebSocket (browsers always set Origin
on WS upgrades; proxies don't usually rewrite it).

### 3. Bind `127.0.0.1` by default in `pirouette server`

**File:** `src/server/index.ts` (the bind logic in `runServer`).

```ts
const host = process.env.PIROUETTE_HOST
  ?? cfg.network?.bind_host
  ?? "127.0.0.1";  // was "0.0.0.0"
```

Container path explicitly passes `PIROUETTE_HOST=0.0.0.0` via `docker
run -e` (necessary because Docker's port mapping needs to listen on the
container's `0.0.0.0` to be reachable via `-p`). Add this to
`src/cli/commands/setup.ts` where the `env` object is built.

This is purely a footgun-prevention fix for `npm run dev` and any future
"someone runs `pirouette server` directly" path. Doesn't affect the
container which is already gated by SG.

### 4. Path-traversal check fix

**File:** `src/server/index.ts` (the static-file serving block).

Replace:

```ts
const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
const filePath = path.join(webDir, safePath === "/" ? "index.html" : safePath);
if (!filePath.startsWith(webDir)) return false;
```

with:

```ts
const requested = urlPath === "/" ? "/index.html" : urlPath;
const resolved = path.resolve(webDir, "." + requested);
// `webDir + path.sep` so /srv/web2/foo doesn't match /srv/web prefix
if (resolved !== webDir && !resolved.startsWith(webDir + path.sep)) {
  return false;
}
```

Same intent, correct check. Drop the cosmetic `replace(/^(\.\.[/\\])+/, "")`
since `path.resolve` handles `..` properly.

### 5. `git clone` URL hygiene

**File:** `src/server/git.ts`.

Two changes:

```ts
// Add `--` separator before user-controlled URL so it can't be
// interpreted as a flag.
const args = ["clone", "--depth", "1"];
if (branch) args.push("--branch", branch);
args.push("--", url, dest);
```

```ts
// Reject URLs that look like flags. Modern git rejects these too,
// but defense in depth.
if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
  throw new Error(`repoUrl must start with https://, git@, or ssh:// (got: ${url})`);
}
```

Also set `GIT_TERMINAL_PROMPT=0` env on `git` invocations so a malformed
URL doesn't hang waiting for credentials:

```ts
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
```

### 6. Input validation: `agentId`, `name`, `--lines`

**Files:** `src/server/index.ts`, `src/cli/commands/logs.ts`.

```ts
// agentId in URL paths
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
if (!AGENT_ID_RE.test(agentId)) {
  error(res, 404, "Agent not found");
  return;
}
```

```ts
// agent name in POST /api/agents body
function validateAgentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("name cannot be empty");
  if (trimmed.length > 200) throw new Error("name too long (max 200 chars)");
  // Reject control characters (incl. newlines) — these would corrupt
  // server logs and have no legitimate use in an agent name.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error("name contains control characters");
  }
  return trimmed;
}
```

```ts
// pru logs --lines validation
const linesRaw = opts.lines ?? "200";
const n = Number(linesRaw);
if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
  throw new Error(`--lines must be a positive integer up to 100000 (got: ${linesRaw})`);
}
const lines = String(Math.floor(n));  // pass the canonical form to the shell
```

### 7. EDITOR launched via `spawnSync` (no shell)

**File:** `src/cli/commands/config.ts`.

```ts
const editorRaw = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
// Allow values like "code -w" or "vim --noplugin"
const parts = editorRaw.split(/\s+/);
const result = spawnSync(parts[0], [...parts.slice(1), target.path], {
  stdio: "inherit",
  shell: false,
});
if (result.status !== 0) {
  throw new Error(`editor exited with ${result.status ?? "signal"}`);
}
```

### 8. Self-host CDN dependencies

**Files:** `src/web/index.html`, `scripts/post-build.mjs`, `package.json`.

Currently `src/web/index.html` pulls from CDN:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked-highlight@2/lib/index.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/common.min.js"></script>
```

Plan:

- Add real npm deps:
  - `marked` (already a devDep for tests, promote to dep)
  - `marked-highlight`
  - `dompurify` (the browser bundle is what we want; the npm package
    `dompurify` ships both)
  - `highlight.js`
  - `tailwindcss` (for the build-time tooling)

- `scripts/post-build.mjs` step: after copying `src/web/`, also copy:
  - `node_modules/marked/marked.min.js` → `dist/web/vendor/marked.min.js`
  - `node_modules/marked-highlight/lib/index.umd.min.js` → `dist/web/vendor/marked-highlight.umd.min.js`
  - `node_modules/dompurify/dist/purify.min.js` → `dist/web/vendor/purify.min.js`
  - `node_modules/highlight.js/lib/common.js` → bundle? Hmm.

  Actually highlight.js doesn't ship a single common bundle anymore;
  the CDN's `lib/common.min.js` is built. We have two options:
    a. Run `rollup` / `esbuild` to bundle `highlight.js/lib/common`
       at build time. ~30 LOC of build script.
    b. Copy the un-bundled core + register the languages we need
       client-side. More HTML script tags, less convenient.

  (a) is cleaner. Let's do it.

- For Tailwind: switch from runtime CDN to **build-time** generation:
  - Add `tailwind.config.js` scanning `src/web/**/*.{html,js}`
  - Build step: `npx tailwindcss -i src/web/style.css -o dist/web/style.css --minify`
  - This produces a ~50KB CSS file (vs ~300KB CDN runtime), only
    classes actually used.
  - Replace the CDN script tag with `<link rel="stylesheet" href="style.css">`.

- Update `src/web/index.html` to reference `vendor/` paths.

**Tarball impact:** roughly +60-90 KB compressed. Acceptable.

**Testing:** the existing 109 tests should still pass since `marked` is
already a real dep used in tests. Add one smoke test that loads
`dist/web/index.html` in jsdom and verifies the script tags resolve.

### 9. README "Trust model" section

**File:** `README.md`.

Add near the top (after the install section):

```markdown
## Trust model

Pirouette today relies on the layers _below_ the application for
access control:

- **AWS security group**: only port 22 inbound, only from your
  Tailscale subnet router's SG (or equivalent in your VPC).
- **SSH key**: required to open the port-forward to the container.
- **Same-origin web app**: the dashboard runs at `localhost:<port>`
  via the SSH tunnel; cross-origin requests are rejected by
  Origin/Host validation in 0.2.1+.

This means: **anyone who can establish a TCP connection to
`<container-ip>:7777` has shell access on your container**, because
the agents have full bash/edit/write tools by design. The SG + SSH
tunnel are what keeps that perimeter narrow today.

Things you're trusting (the supply chain):

- The npm package `@neevparikh/pirouette` (or whatever
  `container.npm_package` points at)
- The dotfiles repo at `dotfiles.clone_url`
- The keys served at `dotfiles.authorized_keys_url`
- Your AWS account's network isolation
- Trust-on-first-use SSH host keys (`StrictHostKeyChecking=accept-new`)

A future release will add an application-layer auth boundary
(bearer token or Okta-issued JWT) so a network-level breach doesn't
immediately mean RCE.

If you need stronger guarantees today, the operational mitigations are:
1. Don't broaden the SG.
2. Never bind the dashboard to a public IP.
3. Treat anyone with read access to your laptop's `~/.ssh/` as
   having full pirouette access.
```

---

## Implementation order

Single focused sitting, ~half a day:

1. Bug-class fixes first (independent, safe to batch):
   - 4 (path traversal)
   - 5 (git clone hygiene)
   - 6 (input validation)
   - 7 (EDITOR shell)
2. CORS / Host / Origin (1 + 2). Touch the same file (`server/index.ts`).
3. Bind `127.0.0.1` default (3).
4. Self-host CDN (8) — the biggest piece. Save for last because it
   has the most surface area (build script changes, dep additions,
   runtime verification).
5. README trust-model section (9).
6. Bump version to 0.2.1, add CHANGELOG entry, `pru sync` to verify
   live, publish.

---

## Tests to add

- `__tests__/server-host-validation.test.js` (new): boots the server,
  verifies that requests with bad `Host` get 421, requests with the
  right `Host` succeed, WS upgrades with mismatched `Origin` reject.
- `__tests__/path-traversal.test.js` (new): hits the static-file
  serving with `../../etc/passwd`-style URLs, asserts they fall
  through to the API 404 path rather than reading outside `webDir`.
- `__tests__/transcript.test.js` etc: unchanged.
- Smoke check: `dist/web/index.html` references only relative paths
  (no `cdn.*`, no `https://`).

---

## Release shape — 0.2.1

CHANGELOG entry skeleton:

```markdown
## 0.2.1 — security hardening (no-devops-needed pass)

This release closes every issue from the v0.2 security review that
doesn't require devops involvement or an auth-architecture decision.
Bearer-token / OIDC auth is deferred to a later release.

### Security

- **DNS-rebinding from malicious browser tabs blocked.** Removed
  wildcard `Access-Control-Allow-Origin`. Server now validates the
  `Host` header on every HTTP request and the `Origin` header on
  WebSocket upgrades against an allowlist (`localhost:<port>`,
  `127.0.0.1:<port>`).
- **Default bind narrowed.** `pirouette server` binds `127.0.0.1`
  by default; the container path explicitly passes
  `PIROUETTE_HOST=0.0.0.0`.
- **Static-server path traversal check fixed.** The `startsWith`
  guard was missing a separator (`/srv/web` would match
  `/srv/web2/...`). Now uses `path.resolve` + a separator-aware
  `startsWith`.
- **`git clone` argument hygiene.** Inserted `--` separator before
  user-controlled URL; reject URLs not matching
  `^(https?://|git@|ssh://)`. Set `GIT_TERMINAL_PROMPT=0` so
  malformed URLs don't hang on credential prompts.
- **Input validation.** `agentId` URL components, `name` body
  fields, and `pru logs --lines` are validated to prevent log
  injection and shell-metacharacter passthrough.
- **EDITOR launched without a shell.** `pru config edit` now uses
  `spawnSync` with an arg array (`shell: false`) so values like
  `EDITOR='vi -c "set syntax"'` parse safely.
- **Dashboard JS dependencies self-hosted.** Tailwind, marked,
  marked-highlight, DOMPurify, highlight.js are now copied into
  `dist/web/vendor/` at build time. Closes the CDN-compromise
  attack surface and lets the dashboard work offline.

### Documentation

- New "Trust model" section in `README.md` stating clearly what
  pirouette enforces (network layer + SSH key today) and what's
  out of scope until 0.3.0.

### What this release does NOT close

- The pirouette server still has no application-layer auth. Anyone
  who can reach `:7777` (today: SSH-tunneled by you, gated by
  AWS SG) has agent-level RCE. This is the C1 finding from the
  security review and remains open until 0.3.0+.
```

Version bump: `0.2.0` → `0.2.1`.

---

## Open decisions for next round (0.3.0+)

These are deliberately deferred. Each requires either a devops
conversation or a design call we haven't made yet.

### A. Auth model

Three viable options, in increasing complexity / capability:

1. **Random shared bearer token.** Generated on first server start,
   persisted at `~/.pirouette/server-token` (mode 600). CLI + UI
   read the same file. Simplest; ~50 LOC total.
2. **Hawk JWT as bearer + sub validation.** Reuse the user's
   existing Okta-issued JWT (already in `~/.pi/agent/auth.json`).
   Server fetches Okta's JWKS, validates signature + iss + sub.
   No new secret to manage; auto-rotates every 4h via hawk's
   refresh flow. ~50 LOC server-side, requires a JWT lib.
3. **Real OIDC client for pirouette.** New Okta application
   registration; full auth-code-with-PKCE flow; HttpOnly session
   cookies; "Sign in with Okta" button on the dashboard.
   Enables true multi-device UX. ~200 LOC and a devops touchpoint.

Reasoning for each is in `docs/security_plan.md` history (see
git log if curious).

User preference at the time of 0.2.1 cut: minimize devops hassle.
Likely path is (1) for the first auth release and (3) when
multi-device pain becomes real.

### B. Tailscale binding for stable URL

The "Step B" architecture from `docs/todos.md` § phase 2.5:
`tailscaled` runs inside the container in userspace mode,
`tailscale serve` exposes the dashboard at
`https://pirouette-<user>.<tailnet>.ts.net/` with auto-provisioned
HTTPS. Drops the SSH tunnel as the daily driver; multi-device
becomes trivial.

Requires:
- Tailscale ACL changes (a `tag:pirouette` and a scoped `accept`
  rule). User-side ask to devops; well-documented in chat history.
- Tailscale auth key at `pru setup` time (one-time, in user's
  config or env).
- HTTPS + MagicDNS enabled tailnet-wide (account-level toggle).

Pre-requisite: an auth model from (A) must be in place first.
Without it, exposing the dashboard on the tailnet means RCE for
the whole tailnet.

### C. Token rotation, multi-device flows

Once (A) lands, follow-ups:
- `pru rotate-token` to invalidate + regenerate.
- Per-device tokens with revocation list (defer until painful).
- QR code emit (`pru qr`) for fast phone onboarding.

---

## Defense-in-depth notes that didn't make 0.2.1

These were reviewed and deemed not worth the cost for our threat
model. Documented here so we don't re-litigate.

- **Per-message log redaction (M3).** Logs are on the user's EBS,
  reachable only via the user's SSH key. Within trust boundary.
- **Rate limiting / agent quota (M2).** Single-user tool. A soft
  cap (`MAX_AGENTS=200`) is the only thing worth doing if accidental
  loops become a problem; not in 0.2.1.
- **npm install pinning (H4).** Single publisher = us. Pinning
  every release with integrity hashes is friction without benefit.
- **TOFU SSH hardening (H2/H3/M6).** Private VPC; switching from
  `accept-new` to `yes` adds reinstall friction without a real
  threat in our deployment.
- **Pinning dotfiles repo to a specific SHA (H3).** Same reasoning.
