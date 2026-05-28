# pirouette changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [SemVer](https://semver.org).

---

## 0.14.0 — bridge `AskUserQuestion` (and other extension UI prompts) to the web dashboard

### Added

- Pirouette now hosts a real `ExtensionUIContext` for every agent
  session, so pi extensions that prompt the user (most prominently
  `pi-cas-provider`'s `AskUserQuestion` handler) reach the browser
  instead of silently being denied. Before this release, the SDK
  fell back to `noOpUIContext`, `ctx.hasUI` was `false`, and
  extensions short-circuited with a `"no-ui-available"` deny — the
  model just saw `"User declined to answer questions"` and no
  picker ever appeared.
- New `createPirouetteUIContext(agentId, host)` in
  `src/server/pirouette-ui-context.ts` implements `select`,
  `confirm`, `input`, `notify`, and `setStatus` on top of a small
  `UIContextHost` surface. `AgentManager` wires it via
  `session.bindExtensions(...)` and owns the pending-request map.
  TUI-only primitives (`custom`, `editor`, `setFooter`, etc.) stub
  out — `custom` returns `undefined` synchronously, which is the
  signal pi-cas uses to fall back to `ctx.ui.select`.
- New web-side modal in `src/web/index.html` + `src/web/app.js`
  renders inbound `extension_ui_request` envelopes: radios for
  single-select, checkboxes for multi-select, yes/no for confirm,
  and a text input for `input`. Enter submits, Esc cancels. A
  pulsing `?` badge appears on the asking agent's chip in the
  footer when a question is on screen for a non-focused agent.
- Replay-on-reconnect: the server snapshots all in-flight requests
  on every new WS connection and re-broadcasts them, so a refresh
  — or the case where the user has zero browsers open at the
  instant an extension fires `AskUserQuestion` — recovers the
  modal automatically. No server-side timeout (users genuinely
  walk away for hours).
- Multi-client = broadcast + first-response-wins: when one tab
  answers, the server broadcasts an `extension_ui_cancel
  { requestId }` so any other open tab closes its modal.

### Changed

- `WsEnvelope` (in `src/server/types.ts`) gained four server→client
  variants (`extension_ui_request`, `extension_ui_cancel`,
  `extension_ui_notify`, `extension_ui_status`). New
  `ClientWsEnvelope` union covers client→server messages
  (`extension_ui_response`, `extension_ui_cancel`), validated and
  size-capped on the server's new `ws.on("message")` handler.
- `AgentManager` cancels every pending extension UI request for an
  agent on `stopAgent` / `removeAgent`, so the SDK's `canUseTool`
  Promise unblocks with the cancel sentinel instead of hanging
  forever on a session that's gone. `AbortSignal` from the per-
  tool callback wires to the same path.

### Coordinated change in pi-cas-provider

This release works in concert with `pi-cas-provider` v0.2.0, which
adds a portable `ctx.ui.select`-based fallback path to
`askUserQuestionDialog` so it degrades cleanly from `ui.custom`
(pi-tui) to `ui.select` on hosts that don't render a TUI overlay.
Pirouette v0.14.0 with an older pi-cas still won't surface the
modal; pi-cas v0.2.0+ with an older pirouette is unaffected (the
TUI path is preserved exactly — see `pi-cas-provider`'s release
notes for details). Recommend upgrading both together.

258 tests pass (added 19: 11 for `pirouette-ui-context`, 8 for
`AgentManager`'s pending-request lifecycle).

---

## 0.13.16 — preserve indentation in tool-call edit diffs

### Fixed

- Diff view for Edit tool calls in the web dashboard collapsed
  leading whitespace and tabs, so indentation in the `-`/`+`
  lines was invisible. The diff renderer emits each line inside
  a `<span class="diff-line">`, but the stylesheet did not set a
  whitespace-preserving rule, so the browser collapsed runs of
  spaces and dropped tabs. Added `white-space: pre-wrap` to
  `.diff-line` so indentation renders verbatim while long lines
  still wrap inside the message bubble.
- Added regression tests: one pins the HTML side (renderDiff must
  emit leading spaces/tabs verbatim), one pins the CSS side (the
  `.diff-line` rule must keep `white-space: pre` or `pre-wrap`),
  so a future edit that drops either half fails loudly.

239 tests pass.

---

## 0.13.15 — vim label centered on the input border; drop drawer hairlines

### Changed

- Vim mode label (`INSERT` etc.) on the input bar's top border
  line: switched from a fixed `-top-3` offset (which left the
  label slightly above the line) to `top-0 -translate-y-1/2`, so
  the label's midline sits exactly on the border at any
  font-size.
- Removed the 1px `base16-300` hairline borders on the mobile
  drawers (left drawer's right edge; right drawer's bottom + left
  edges). The drop-shadow alone is enough visual separation; the
  hairline read as a stray pale stripe on cream themes.

237 tests pass.

---

## 0.13.14 — hamburger glyph: smaller, lighter, baseline-aligned with message text

### Changed

- Hamburger glyph bumped down from `text-2xl` to `text-base` and
  given `font-normal` + `text-base16-500` so it visually matches
  the placeholder/message text weight.
- Moved the button from `position: fixed` (bottom-left of the
  viewport) into the input bar's textarea flex row as the first
  child (`md:hidden flex-none`). It now baselines naturally with
  the textarea content and the send button on the right, instead
  of floating slightly above and to the left.
- Dropped the `pl-14 md:pl-6` left padding on the input bar that
  was reserving space for the previously-floating button.
- The old absolute-positioned button is removed from the DOM; the
  inline button keeps the same `id="mobile-menu-btn"` so the
  existing toggle JS works unchanged.

237 tests pass.

---

## 0.13.13 — polished mobile drawers + bottom-sheet pickers

### Changed

- **Hamburger button stripped of its FAB chrome.** Was a 40×40
  rounded-full button with bg + shadow. Now just a bare `☰` glyph
  in `text-base16-600` with a hover rect for visibility. Tap
  target preserved.
- **Right drawer buttons no longer stretch full-width.** Switched
  `align-items: stretch` → `flex-start` and dropped the
  `width: 100%` overrides. Buttons sit at their natural content
  width (drawer auto-sizes between 140px min and 80vw max), so the
  drawer looks like a contextual menu rather than a stack of
  banners. The colored pills (fork purple, stop yellow, delete
  red) read correctly at their natural widths.
- **Model / thinking / theme pickers are now bottom-sheet modals
  on mobile.** Below the `md` breakpoint, when one of
  `#model-picker` / `#thinking-picker` / `#theme-picker` is shown,
  CSS repositions it as a full-width sheet anchored to the bottom
  of the viewport (`position: fixed; bottom: 0; left/right: 0;
  max-height: 75vh; border-radius: 0.75rem 0.75rem 0 0`). Full
  model names visible without truncation; native iOS feel.
- **Drawers animate via `left` / `right` instead of `transform`.**
  `transform` on an ancestor creates a containing block for
  `position: fixed` descendants, which was trapping the bottom
  sheets inside the drawer (the picker was showing up as a
  cramped dropdown anchored to the model button, not as a sheet).
  Switched to `left: -100vw → 0` (left drawer) and
  `right: -100vw → 0` (right drawer); fixed-position descendants
  now escape correctly.
- **Backdrop tap + Esc also close any open picker** (new
  `closeAllPickers()` called from `closeAllDrawers()`).

237 tests pass.

---

## 0.13.12 — mobile drawer polish; one-per-line info; drop placeholder text

### Changed

- **Left drawer restored to full-height + squared corners.** v0.13.11's
  fit-content + rounded variant didn't feel right; we're back to the
  v0.13.10 full-height shape (just a flat slide-in panel with a
  hairline right border).
- **Right drawer narrower + squared corners.** 280px → 220px;
  rounded bottom-left corner removed.
- **Project `×` button placement fixed.** Was getting cross-axis
  centered below the chips in the mobile drawer because the project
  section's flex container flips to `flex-direction: column;
  align-items: stretch`. Now the project name + `×` are wrapped in a
  `flex justify-between md:contents` container so on mobile they sit
  on the same row (name left, `×` right) and on desktop the wrapper
  is `display: contents` so the desktop layout (name, chips…, `×`)
  is unchanged.
- **Identity + stats info, one item per line on mobile.**
  `formatStatsLine` / `formatModelLine` refactored into
  `formatStatsParts` / `formatModelParts` array-returning variants.
  Each part renders as a `<span class="info-part">`; CSS lays them
  out inline with `·` separators on desktop and as block-per-part
  on mobile inside the drawer. Result:
  ```
  scratchpad
  agent/default-9a799314
  /data/.../scratchpad/default-9a799314
  3d ago
  id: 9a799314

  ↑7 ↓260 R7.2k W8.6k
  $0.064
  ?/1.0M
  (hawk) claude-opus-4-7
  ```
  String-returning legacy formatters kept for tests + plain-text
  fallbacks.
- **Dropped the "select an agent from the footer…" placeholder.**
  It was visual clutter on every fresh load; the chip strip / drawer
  is self-explanatory.

237 tests pass.

---

## 0.13.11 — mobile drawers: fit content, anchor to their toggle buttons

### Changed

The v0.13.10 drawers were full-height (`top: 0; bottom: 0`) which
left a lot of empty space below the actual menu items. Reworked
to have each drawer "grow from" its toggle button:

- **Left drawer**: `top: auto; bottom: 0; height: auto;
  max-height: 80vh; border-top-right-radius: 0.75rem`. The panel
  is anchored at the bottom-left (where the `☰` hamburger lives)
  and grows upward to fit content.
- **Right drawer**: `top: 0; bottom: auto; height: auto;
  max-height: 80vh; border-bottom-left-radius: 0.75rem`. The panel
  is anchored at the top-right (where the `⋮` kebab lives) and
  grows downward to fit content.
- Soft drop-shadows added (`0 ±4px 16px rgb(0 0 0 / 0.15)`) so the
  panels feel like overlays rather than chrome.

Makes the drawers feel contextual -- like a menu popping out of
the button you tapped, not a full-height sidebar.

237 tests pass.

---

## 0.13.10 — mobile: bring back slide-in drawers (projects + actions)

### Added

The v0.13.0 desktop refactor (footer-as-chip-strip + actions inline
in the header) made the mobile layout awkward: chip strip wrapped
awkwardly, action button row spilled to a second line, identity
info cramped into ~390px width.

v0.13.10 restores **mobile-only slide-in drawers** -- the
elements that work fine on desktop become CSS-driven drawers below
the `md` breakpoint (<768px).

- **Left drawer (`#agent-footer`)**: opens via a fixed `☰`
  hamburger button at the bottom-left of the screen. Contains the
  same project + agent chips + new-project button + identity
  line + stats line, but flowing vertically (each project section
  is a column with its agents stacked beneath).
- **Right drawer (`#header-actions`)**: opens via a `⋮` kebab
  button in the top-right of the header. Contains the same
  raw / model / thinking / fork / stop / resume / delete / vim /
  notify / theme buttons stretched to full width and stacked
  vertically.
- **Shared `#mobile-backdrop`** dims the rest of the page and
  closes whichever drawer is open on tap. Esc also closes both.
- **Mutually exclusive**: opening one drawer closes the other.

Desktop layout is unchanged -- the drawers use
`@media (max-width: 767px)` CSS that toggles
`position: fixed + transform: translateX(±100%)`. Above `md` the
elements stay in their inline positions and the toggle buttons +
backdrop are `display: none`.

### Changed

- Input bar gains `pl-14` on mobile (was `pl-3`) so the floating
  hamburger doesn't sit on top of the textarea text.
- Footer's "identity (left) | tokens+model (right)" row
  whitespace-wraps + stacks on mobile so neither line gets
  truncated to nothing by the other.
- Reanimated the previously-stubbed `openSidebar()` /
  `closeSidebar()` helpers in app.js to drive the left drawer
  (callers in `selectAgent` and the resize handler now do the
  right thing again on mobile).

237 tests pass.

---

## 0.13.9 — move vim toggle to the top action row; restore some header breathing room

### Changed

- **Vim toggle button moved to the top action row**, alongside
  `raw / model / thinking / fork / stop / delete / notify /
  theme`. Uses the same pill styling (`text-xs px-2 py-1 rounded
  bg-base16-300/40`). The bottom-border position from 0.13.7 and
  the top-border-right position from 0.13.8 are gone; INSERT label
  on the top border is unchanged.
- **Header padding restored** from `py-1.5` to `py-2.5`. v0.13.8
  squashed the top bar too aggressively; this puts a little
  breathing room back without going all the way to the old
  `py-2 md:py-3 + h-[88px]`.

237 tests pass.

---

## 0.13.8 — mono everywhere, drop agent name + status, fold stats next to model

### Changed

Multiple bundled tweaks toward a fully pi-cli-style look.

- **Mono everywhere**: replaced the last `font-display` (slab-serif)
  hold-outs with `font-mono`. Brand `pirouette`, agent chips,
  project labels are all in JetBrains Mono Nerd Font Mono now.
- **Agent name + status removed from the top header**. The header
  is just brand + per-agent action buttons. `#agent-name` and
  `#agent-status` are kept as `display: none` shells so the
  existing renderAgentHeader code can still write into them
  without crashing -- they just have no visible output. Identity
  lives in the footer.
- **"your turn" status text gone**. The state-classification
  switch in renderAgentHeader is unused now (no `#agent-status`
  to render into).
- **Header tightened**: dropped fixed `md:h-[88px]`, switched
  vertical padding from `py-2 md:py-3` to `py-1.5`.
- **Stats + model on one line**. v0.13.6 had a 3-row footer
  (chips, identity, stats+model). v0.13.8 collapses to 2 rows:
  row 1 = chips, row 2 = identity (left) + tokens-and-model
  (right). `formatStatsLine` and `formatModelLine` outputs are
  concatenated into `#agent-stats-line`; `#agent-model-line` is
  gone.
- **Vim controls moved to the top border line**. INSERT label is
  on the top-left (was), `vim: on/off` toggle is on the top-right
  (was on the bottom border). Both at `text-sm` to match the
  body font size, instead of the old `text-[10px]`.

237 tests pass; typecheck + build clean. Verified on the live
gpu dashboard: brand + chips + identity + stats all in the same
mono stack, footer is 2 rows, header is just brand + actions.

---

## 0.13.7 — pi-cli-style input bar (horizontal border lines, vim label on top)

### Changed

Input bar redesigned to match pi-cli's terminal input strip:

- **Horizontal border lines** top + bottom (`border-y border-base16-
  pink/40`). Theme-aware via the `pink` token (resolves to a
  peachy orange on the softstack-light theme).
- **Vim mode label sits ON the top border line**, absolutely-positioned
  at `-top-2` with `bg-base16-100` so the line visually "breaks" for
  the label. Empty when vim is off; invisible cutout disappears.
- **Vim toggle button** mirrors the label on the bottom border line
  (right side instead of left). Same bg-cutout trick.
- **Textarea stripped** of its colored fill, rounded box, and field
  border. Just text on the page surface, no outline, no focus ring.
  `bg-transparent text-base16-700 border-0 outline-none focus:
  outline-none`.
- **Send button** stripped of its colored fill -- now a quiet text
  button (`text-base16-blue hover:text-base16-700`). Pi-cli has no
  send button at all (Enter sends), but mobile web users still need
  an obvious affordance.
- **Mode labels** changed from `-- INSERT --` / `-- NORMAL --` to
  bare `INSERT` / `NORMAL` / `VISUAL` (pi-cli convention). Pending
  operator now appended as `[2d]` instead of inside the dashes.

237 tests pass; typecheck + build clean.

---

## 0.13.6 — unindent tool name; move usage info to a pi-cli-style footer

### Changed

- **Unindent tool name**: dropped `px-1` from the inner header div
  of the tool / tool_result rows. Tool name now aligns with the
  tool body (16 px from the left), instead of being 4 px more
  indented than the body. Matches the prose `.pi-md` indent.

- **Move agent identity + usage stats to the footer**, in a pi-cli-
  style three-row layout:
    - Row 1 (existing): horizontal agent chips grouped by project.
    - Row 2 (new `#agent-info-line`): identity line
      (project · model · branch · worktree · thinking · id),
      mirroring pi-cli's `~/repos/... (main) · session-title`.
    - Row 3 (new `#agent-stats-line` + `#agent-model-line`):
      tokens / cost / context% on the left (color-banded by
      context fill, same as pi's TUI), `(provider) model ·
      thinking` right-aligned. Same shape as pi-cli's
      `↑4.0k ↓1.2M R630M ... 92.4%/1.0M (auto)    (hawk)
      claude-opus-4-7 · high`.
  Removed `#agent-info` + `#agent-stats` from the agent header --
  the top now just shows agent name + status + action buttons.

- `formatStatsLine` no longer appends model + thinking-level;
  added `formatModelLine` for the right-aligned model span.
  `renderAgentHeader` populates `$agentInfo` / `$agentStats` /
  `$agentModel` in their new footer slots.

Probe on a running agent: info line shows the identity tuple,
stats line shows `↑7 ↓260 R7.2k W8.6k $0.064 ?/1.0M`, model line
shows `(hawk) claude-opus-4-7`. Stopped agents get an empty stats
line but still show the model on the right (falls back to
`agent.model`).

237 tests pass; typecheck + build clean.

---

## 0.13.5 — drop ▶ / ✓ / ✗ glyphs; bigger gaps between turns

### Changed

Further pi-cli aesthetic cleanup per user direction:

- **Tool call rows**: dropped the leading `▶` triangle. The cyan-
  accented tool name is sufficient signal; the glyph was extra
  visual noise.
- **Tool result rows**: dropped the success `✓` / error `✗` icon.
  Error signal moved from the icon to the tool-name color
  (red for errors, cyan for success) so the failure cue isn't
  lost.
- **`.pi-row` margin-top**: 0.375 rem (6 px) -> 0.875 rem (14 px).
  Bigger gap so two same-class blocks (e.g. two consecutive
  tool_result → tool_call pairs, or two user messages) read as
  clearly-separated operations instead of touching. The
  `.pi-row-tool-call + .pi-row-tool-result` fusion rule still
  collapses the gap inside a single call/result pair.

Tests updated: `tool result uses summary label` and `tool result
error renders tool name in red instead of cyan` now assert the
no-glyph + colored-name shape.

---

## 0.13.4 — tone down block tint to 3 %

### Changed

v0.13.3's `0.10` alpha on the green tint was still too saturated;
user asked to drop to `0.03`. Single-line change in index.html.

---

## 0.13.3 — colored translucent tint on tool/user blocks

### Changed

The `.pi-row-user` + `.pi-row-tool` bg was `rgb(var(--color-
base16-300))` -- a slightly different surface token. User asked
to try a translucent COLOR ACCENT instead, so the block reads
as a tinted surface rather than a tinted lighter shade.

- `.pi-row-user`, `.pi-row-tool`:
  `rgb(var(--color-base16-300))`
  → `rgb(var(--color-base16-green) / 0.10)`.
  10 % green over the page bg. On light themes (e.g. softstack
  light) this reads as a subtle olive/khaki block; on dark
  themes it'd be a sage-green wash. Theme-aware via the `green`
  token; switch to `orange` (warmer terracotta) or any other
  accent token in one line if you want a different cast.

Probe: pageBg `rgb(251, 247, 232)`, blockBg `rgba(108, 120, 46,
0.1)`. Visibly distinct olive cast over the cream surface.

---

## 0.13.2 — quieter active-chip highlight (typography + subtle wash)

### Changed

v0.13.1's `bg-base16-cyan/25` highlight on the active chip read
as a saturated sage-green block on light themes -- user said
"too bright compared to pi-cli". Pi-cli's emphasis convention is
mostly TYPOGRAPHY (color + weight) rather than fills, so the
active chip now leans on the same.

- Active agent chip: `bg-base16-cyan/25 text-base16-700`
  → `bg-base16-cyan/10 text-base16-cyan font-semibold`.
  Bold cyan text does most of the visual work; the 10 % wash
  is just enough to outline the selection.
- Selected project label: `bg-base16-cyan/15`
  → `bg-base16-cyan/8`. Even subtler since it's a group
  indicator, not the actual selected item.

Probe: active bg = `rgba(76, 122, 93, 0.1)`, color =
`rgb(76, 122, 93)`, weight 600.

---

## 0.13.1 — colored translucent highlight on active footer chip

### Changed

v0.13.0 used `bg-base16-300/70` for the active-agent chip --
effectively a lighter shade of the page bg. On the
softstack-light theme that comes out almost white (the surface
token lightens, not darkens, the chip). User asked for a colored
translucent tint instead, so the chip reads as "selected" with a
clear color cast on any theme.

Fix in `renderAgentRow` + `renderAgentList`:
  - Active agent chip: `bg-base16-300/70` → `bg-base16-cyan/25`.
    Theme's cyan accent at 25 % opacity over the footer
    surface. On light themes the result is a sage-green tinted
    block; on dark themes it'll be a cyan-tinted dark block.
    Same accent already used for tool names + chevrons.
  - Selected project label: `bg-base16-300/40` →
    `bg-base16-cyan/15`. Subtler than the active chip so the
    hierarchy stays readable (project label is the group; agent
    chip is the selection).

Probe on softstack-light: active bg = `rgba(76, 122, 93, 0.25)`,
inactive = transparent. Visibly distinct on the cream footer.

---

## 0.13.0 — sidebar → footer (pi-cli-style multi-agent picker)

### Changed

Layout restructure to mimic pi-cli's terminal shape: instead of a
left sidebar listing agents/projects, the picker now lives in a
footer strip BELOW the input bar.

  - **Removed `<aside id="sidebar">`** entirely. The old vertical
    project sections + agent rows are gone. Mobile drawer
    backdrop and hamburger toggle also gone (no drawer to open).
  - **Added `<footer id="agent-footer">`** below the input bar.
    Contains `#agent-list` (same ID, same event handlers) +
    `#new-project-btn`. Overflow-x-auto so many projects scroll
    horizontally.
  - **Brand + notify + theme buttons** moved into the agent
    header at the top right.
  - **renderAgentList** refactored: each project becomes a
    horizontal group (project label, then agent chips inline,
    then optional project-delete `×`). Projects flow
    left-to-right separated by a 1 px vertical divider.
  - **renderAgentRow** redesigned from full-width sidebar rows
    into compact chips: status dot + agent name, with `↳` glyph
    on forks. Active agent gets the `base16-300/70` highlight.
    The agent's model / state / fork-from info still surfaces via
    the button's `title` (hover tooltip) so we don't lose
    discoverability.
  - **`<body>` from `flex` to `flex-col`** because main is no
    longer a side-by-side child of an aside.
  - **app.js stubs** the old `openSidebar` / `closeSidebar` /
    `$sidebar` references as no-ops so existing call sites in
    selectAgent + resize handler don't crash. (Those call sites
    only fired on mobile drawer state; they're now harmless.)
  - Placeholder text "select an agent from the sidebar"
    updated to "… from the footer".

Verified on the live gpu dashboard: 4 agent chips visible, all
three projects (interaction-models / nla-reproduction / scratchpad)
grouped with their agents, vertical dividers between groups, `+
new project` button at the right end. Tool blocks + bg-tinting +
gaps from v0.12.10 all still in place.

237 tests pass; typecheck + build clean.

---

## 0.12.10 — darker block tint + drop chrome borders

### Changed

  - **Block bg tint**: `var(--color-base16-200)` →
    `var(--color-base16-300)`. One step darker on light themes,
    one step lighter on dark themes. Still uses a theme-aware
    token; just a stronger version. On softstack-light the tint
    moves from `rgb(248, 242, 219)` to `rgb(244, 235, 209)` --
    against the page bg `rgb(251, 247, 232)` that's a 7–23 unit
    difference per channel instead of the previous 3–13, so the
    blocks now read as clearly distinct surfaces.
  - **Removed all chrome borders** between major regions:
      - sidebar's right border (`border-r border-base16-300`)
      - sidebar's internal header bottom border
      - sidebar's internal input-bar top border
      - agent header bottom border (`border-b border-base16-300`)
      - main input bar top border (`border-t border-base16-300`)
    Borders on popovers/modals (model picker, theme picker,
    skill autocomplete) are kept -- they need a delimiting edge
    against the page content underneath. The textarea's own
    border + focus outline is also kept (form-field cue).

Visually the dashboard now looks like one continuous surface
with bg-tone variation between turn types -- no lines or panels
separating regions, matching the user's reference.

237 tests pass; typecheck + build clean.

---

## 0.12.9 — pi-cli block layout: bg-tinted blocks + gaps, no hairline, no opacity

### Changed

Fully restructure the transcript layout to match what pi-cli
actually does in the user's reference screenshots:

  - **Background-tinted blocks** for non-prose turn types (user
    input, tool calls, tool results). All three share the same
    surface tint (`base16-200`), so the visual category is "this
    is not assistant prose".
  - **Assistant rows have no tint** -- they sit on the page's
    default surface (`base16-100` via the body class).
  - **Small gaps between blocks** (`margin-top: 6 px`) so user can
    see each block as its own logical turn, even when two blocks
    share the same color.
  - **Tool call + tool result fuse** into one block: the rule
    `.pi-row-tool-call + .pi-row-tool-result { margin-top: 0 }`
    collapses the gap between them, so a (call, result) pair
    reads as one operation -- but the NEXT call gets a fresh gap.
  - **Hairline border removed.** `.pi-row + .pi-row { border-top }`
    was the "weird thin line" the user kept seeing.
  - **Opacity nudge removed.** v0.12.8's `opacity: 0.7` on tool
    bodies was a band-aid for the missing bg distinction; with
    bg-tinted blocks, the surface separation does the work and
    opacity is unnecessary.

New sub-classes `pi-row-tool-call` and `pi-row-tool-result` added
on top of the existing `pi-row-tool` color hook so CSS can
distinguish call from result for the call+result fusion rule.

### Tokens

The tint uses `var(--color-base16-200)` -- the standard base16
spec slot for "slightly different surface". Theme-aware: light
themes get a slightly darker block surface, dark themes get a
slightly lighter one. Probed on `base24-softstack-light`: body
bg `rgb(251, 247, 232)`, block bg `rgb(248, 242, 219)` -- visibly
distinct.

### Verified

Screenshot on the live gpu dashboard shows the layout matching
the user's pi-cli reference: prose flows on the page bg, tool
blocks sit on a tinted surface with visible gaps between them,
tool call+result fuse into single blocks.

237 tests pass; typecheck + build clean.

---

## 0.12.8 — fix: tool bodies blend with prose on themes that share a hue family

### Fixed

v0.12.7 colored tool bodies at `base16-500` (muted) and assistant
prose at `base16-600` (body). On most themes that's a clear gray-
vs-darker-gray separation. On `base24-softstack-light` (and
likely other themes where the designer chose a single hue family
for the muted/body slots) the two colors are both shades of
brown -- the tool body reads as "slightly different shade of
prose" rather than a different category of content. User caught
this live.

Fix: theme-independent dimming via `opacity: 0.7` on tool bodies.
Whatever color the theme assigns to `base16-500`, this nudges it
further from prose by blending it with the page bg. The tool-call
header (icon + name + summary) stays at full opacity so the
accent colors (green/red icon, cyan name) keep their pop.

```css
.pi-row-tool > pre,
.pi-row-tool > div.mt-1 {
  opacity: 0.7;
}
```

Probe on `base24-softstack-light` confirms:
  - prose color = `rgb(60, 54, 49)` at opacity 1.0
  - tool body color = `rgb(101, 82, 68)` at opacity 0.7
  - effective tool-body luminance ≈ `rgb(146, 132, 117)` after
    blending with the cream bg -- clearly lighter than the
    `rgb(60, 54, 49)` prose.

No color hard-coding: all tokens still come from the theme. The
opacity is the theme-independent equalizer.

237 tests pass; typecheck + build clean.

---

## 0.12.7 — always-expanded inline tool calls + no chevrons (full pi-cli match)

### Changed

Pi-cli renders tool calls and results inline at full content, with
no chevron and no fold mechanic. The only thing distinguishing
tools from prose is color: the tool name carries a cyan accent,
the body / args / output text is muted (`base16-500`), and the
surrounding prose stays at the body color.

v0.12.5 / v0.12.6 had me adding spatial cues (`.pi-row-tool`
left-bar, collapsible chevrons) to compensate for low color
contrast on certain themes. The user requested I drop those
entirely and rely on color alone, matching pi-cli's terminal.

Fix in `transcript.js`:
  - **Tool row**: dropped chevron, `data-toggle`, `cursor-pointer`,
    and `hidden` body gating. Body always renders. `bodyIsRich`
    branch and plain-pre branch both unconditionally include
    `mt-1 text-base16-500 whitespace-pre-wrap`. No `max-h-*` or
    `overflow-*` overrides -- long output relies on the page
    scroll, same as pi-cli's terminal scrollback.
  - **Tool result row**: same treatment. Icon (green/red) + name
    (cyan) + summary (muted) still split into three spans so each
    carries its own theme color. Image attachments still render
    always-visible below the text body.

Fix in `index.html`:
  - **`.pi-row-tool` left-bar removed.** The 2 px cyan border-left
    added in v0.12.5 came back out. Tool rows now look identical
    to assistant rows structurally; differentiation is purely via
    color on the row's children.

237 tests pass; typecheck + build clean.

### Verified

Live on gpu with the `interaction` agent: every tool row is
fully expanded inline with no chevron, body in muted color, name
in cyan. Compare with pi-cli reference: same flow.

---

## 0.12.6 — drop tool-call grouping widget (match pi-cli's inline flow)

### Changed

Pi-cli doesn't group consecutive tool calls into a `▸ N tool calls`
collapsible widget -- each tool call renders inline in the flow,
with the tool name in cyan and the body in dim text. Pirouette was
showing a collapsed group widget after the turn ended, which (a)
hid which tools actually ran without expanding, and (b) on dark
themes where 500-tier and 600-tier shades are close together,
made collapsed widgets visually indistinguishable from prose.

Fix: `renderTranscriptBlocks` now emits per-message rows for every
tool / tool_result, always. No grouping wrapper, no fold. The
widget rendered the same content in a collapsed shell anyway; we
just skip the shell.

  - Loop simplified: was `if (isToolRow) { walk-forward, group,
    emit run:i:j }` + `else { emit msg:i }`; now just `for each
    msg: emit messageKey(msg, idx)`. Same per-message rendering
    machinery (renderMessage) handles tool/tool_result rows as
    before. Per-row chevron still lets the user expand/collapse a
    single long body.
  - Helpers `isToolRow`, `summarizeToolRun`, `renderToolRun`
    removed (nothing calls them anymore).
  - `.pi-row-tool` gets a 2 px cyan left-bar in `index.html` so
    the tool block is spatially distinct from prose, in addition
    to the inline cyan tool-name accent. Helps on themes where
    color tiers shade together.

Updated `transcript.test.js`: the "completed run -> `run:0:1`"
assertion now expects per-row keys `tc:c1:tool`, `tc:c1:tool_result`,
`msg:2`.

### Verified

On the live gpu dashboard with the `interaction` agent (737
tool/tool_result rows visible), DOM check confirms 0 `run:*` widgets
and 737 inline `.pi-row-tool` blocks. Screenshot shows each `▶ bash
<args>` and `✓ bash` row sitting inline with assistant prose above
and below, matching pi-cli's terminal flow.

237 tests pass; typecheck + build clean.

---

## 0.12.5 — tool calls and prose now visually distinct (color hierarchy)

### Changed

In pi-cli, tool calls and assistant prose use different colors:
the tool name renders in a clear accent color (cyan in the default
dark theme) so you can scan the transcript and spot tool
boundaries instantly. The tool output body is dim text on the
page bg with no "code-block" framing.

Pirouette was rendering the tool name in `base16-600 font-semibold`
-- the same color as prose body, only bold -- which made tool
calls blend into the surrounding text. Tool output bodies were
in a `bg-base16-100 rounded p-2` tinted box that added visual
noise without communicating "this is tool output" via color.

Fixes in `transcript.js`:

  - **Tool call header**: tool name now `text-base16-cyan font-
    semibold` (was `text-base16-600 font-semibold`). Same accent
    as the chevron, so both share a visual identity. Subtitle
    (path / args) stays `base16-500` muted -- secondary but
    legible.
  - **Tool result label**: split into three runs so the success
    icon (`✓` / `✗`) keeps its own green/red color, the tool
    name uses cyan accent, and the summary text (`— 3 lines`)
    sits in muted gray. Previously all three were in the same
    `${color} font-semibold` span, which dragged the tool name
    into the success-indicator green/red.
  - **Tool output body**: drop the `bg-base16-100 rounded p-2`
    tinted-box framing. Body now sits inline on the page bg with
    `text-base16-500` muted color -- matches pi-cli where tool
    output is just dimmer text on the same surface, not a
    boxed code block. Same change for the tool-call body branch.

Probe on the live dashboard with the `interaction` agent
(opus-4-7 base16 light theme) confirms three distinct colors:
  - tool name: `rgb(76, 122, 93)` (cyan accent)
  - subtitle / body: `rgb(101, 82, 68)` (muted)
  - assistant prose: `rgb(60, 54, 49)` (full body)

All color choices go through `base16-cyan` / `base16-500` etc.
palette tokens, so dark/light themes pick up the right accents
automatically -- no hard-coded colors.

### Tests

Updated two existing tests in `transcript.test.js` that asserted
the old single-span `✓ read` shape. They now assert the three
separate spans (icon, tool name in cyan, summary in muted gray)
and check that the icon carries the right success/error color.
237 tests still passing.

---

## 0.12.4 — restore inline image thumbnails (broken since v0.11.0 pi-md switch)

### Fixed

v0.9.0 introduced thumbnails for `<code>plots/foo.png</code>` inline
code mentions in assistant prose. v0.11.0 switched the markdown
renderer to `pi-markdown.js`, which emits `<span class="pi-code">`
instead of `<code>` -- the `enhanceImagePaths` regex no longer
matched anything, so thumbnails silently stopped rendering.

Fix: `enhanceImagePaths` now matches BOTH source spans:
  - `<span class="pi-code">...</span>` (pi-md output)
  - `<code>...</code>` (legacy marked output, `.md` fallback path)
It also tolerates compound classes (e.g. `<span class="pi-strong
  pi-code">`).

More important: thumbnails no longer get injected INLINE into the
HTML. Pi-md's `<pre class="pi-md">` uses `white-space: pre`, so an
`<a><img>` tile inside would push subsequent lines out of column
alignment. Instead, `enhanceImagePaths` now returns
`{ html, thumbnails }`. The transcript renderer drops `html` into
the `<pre>` block as before, then renders the `thumbnails` strip
separately BELOW the block. Empty when no paths found.

Unique paths are deduplicated (mentioning the same file twice
yields one tile). Each tile is a clickable `<a><img>` with
`loading="lazy"` and `onerror="this.parentNode.style.display='none'"`
so a path the agent proposed-but-never-created just disappears
instead of leaving a broken-image icon.

`pi-cli` itself doesn't render thumbnails for code-referenced paths
-- it shows the inline code as styled text. This is a pirouette
enhancement specific to the browser dashboard. The actual file is
served by the existing `GET /api/agents/:id/file?path=...` endpoint
(v0.9.0); no new server surface.

### Tests

Updated `render.test.js` for the new `{ html, thumbnails }` return
shape; added cases for compound class names, deduplication, and
pi-md `<span class="pi-code">` matching. 237 total tests pass.

---

## 0.12.3 — render markdown on user messages (blockquotes, bold, code spans)

### Fixed

Pi-cli renders user input through the same markdown pipeline it
uses for assistant output -- so a `> quoted line` in user input
draws with the `│ ` blockquote bar + italic body. Pirouette was
stripping all markdown from user text and just escaping HTML, so
the raw `>` survived verbatim.

Fix: route `msg.role === "user"` through `renderMarkdownPi(...)`
the same way assistant messages are when `widthCols` is supplied.
Blockquotes, bold, italic, codespan, links, lists, hr, and tables
all now render in user input the way they do for the assistant.
Fallback path (no widthCols, tests/preview) still uses the plain
escaped `<pre>` so unit tests don't need a width measurement.

234/234 tests pass; no test changes needed since the existing
user-message tests use plain text (no widthCols).

---

## 0.12.2 — match pi-cli more closely: user-input section breaks, unified row density, list breathing room

### Changed

Comparing the dashboard to a pi-cli screenshot surfaced four
layout/density issues; this release closes the gap (colors stay
theme-driven; only structural/typographic changes here).

**1. User-input section break.** Pi-cli prints user input as a
paragraph-block with vertical padding around it -- visibly a
"section break" in the transcript. v0.12.0/0.12.1 had the user row
at the same compact `py-1.5` as assistant rows, which read as a
column-of-thin-strips instead. Bumped the user row to `py-3` (12px
vertical) so it visually fills like the CLI's input-recall band.
The band already runs the full container width because
`#messages` has `px-0` and the row wrapper spans 100 % -- probe
confirms width 1144 == #messages clientWidth.

**2. Unified row density.** Thinking, tool, tool_result, and
system rows were all rendering at `text-[11px]` (11 px) with a
`text-[10px]` heading and `text-[9px]` chevrons -- a different
typographic scale than the 14 px transcript body. Pi-cli renders
all of these at the same size as surrounding prose. Each role
now uses a `pi-row pi-row-<role>` wrapper that inherits the page
default 14 px / 20 px / JetBrains Mono Nerd Font Mono. Probe
confirms all four row types report identical computed font-size
(14px) and line-height (20px).

**3. List-item breathing room.** Pi-cli puts a blank line between
top-level list items (mirrors marked's `space` token between
block-level children). The pi-md renderer was emitting items
with no separator, producing a wall of dashes. `renderList` now
appends an empty line after each top-level item (`depth === 0`)
except the last; nested lists stay tight to avoid fragmenting
from their parent item.

**4. New row CSS classes** in index.html: `.pi-row-thinking`,
`.pi-row-tool`, `.pi-row-system` (siblings of the existing
`.pi-row-user` / `.pi-row-assistant`). All map onto the active
base16 theme via existing palette tokens, so dark/light schemes
stay coherent without per-theme overrides.

### Tests

234/234 still passing; transcript.test.js's flat-row assertions
(introduced in v0.12.0) still hold.

### Verified

Live on the gpu dashboard with `interaction-qa`: thinking lines
now render at 14 px (matching surrounding prose); tool-call
summaries (`▸ 2 tool calls · edit · bash`) sit at the same
density as everything else; the `[context compacted]` system row
gets its own row-level tint. Same probe reports identical
`font-size: 14px`, `line-height: 20px` across user / assistant /
thinking / tool rows.

---

## 0.12.1 — fix: user + assistant rows now share font-size, line-height, padding

### Fixed

v0.12.0 introduced the flat pi-cli transcript layout but didn't
equalise typography between user and assistant rows. Probing the
live dashboard with playwright found three mismatches:

| | user | assistant |
|---|---|---|
| row padding | `py-2` = 8 px | `py-1.5` = 6 px |
| text font-size | 14 px | **12.88 px** (from `.pi-md { font-size: 0.92em }`) |
| text line-height | 20 px | 18.68 px |

Same font family, but user text was ~9 % larger and rows were 2 px
taller per side. Visible as inconsistent vertical rhythm when
scrolling through the transcript.

Fix:

  - `transcript.js` user row: `px-4 py-2` → `px-4 py-1.5` to match
    the assistant row.
  - `index.html` `.pi-md` and `.md`: drop the `font-size: 0.92em`
    override; use `font-size: inherit` instead so both inherit the
    page-default 14 px / 1.43 line-height the user row uses.

Verified with the playwright probe: all four cells (user row, user
`<pre>`, assistant row, assistant `<pre class="pi-md">`) now
report identical computed `font-size: 14px`, `line-height: 20px`,
`padding: 6px 16px`, `font-family: JetBrainsMono Nerd Font Mono`.
234/234 tests still pass.

---

## 0.12.0 — flat pi-cli transcript layout (no more left/right bubbles)

### Changed

The dashboard now renders the chat the way pi-cli does in your
terminal: one continuous vertical stream where user input and
assistant output share the same column. No more right-aligned blue
bubble for user messages or left-aligned bordered bubble for
assistant content -- just flat rows that flow into each other, with
a subtle bg-tint band marking user input (the CSS analogue of
pi-tui's input-recall band).

Specifically:

  - `transcript.js` user-message branch: `flex flex-col items-end` +
    `max-w-[80%] bg-base16-blue/15 border ... rounded-xl` →
    `pi-row pi-row-user flex flex-col gap-1 px-4 py-2 bg-base16-200/60`.
    No bubble, no right-alignment, no rounded corners.
  - `transcript.js` assistant-message branch: `flex justify-start` +
    `max-w-[90%] bg-base16-200 border ... rounded-xl` →
    `pi-row pi-row-assistant px-4 py-1.5`. The `<pre class="pi-md">`
    block (or `.md` fallback) sits inline in the column.
  - Streaming assistant bubble follows the same shape so the
    streaming → finalized transition doesn't re-shuffle layout.
  - `renderInlineImages`: was `justify-end max-w-[80%]` (right-edge
    of the old user bubble), now left-aligned so pasted images sit
    at the left edge of the flat row.
  - `index.html`: `#messages` container drops `space-y-3` and the
    horizontal padding (`px-3 md:px-6` → `px-0`) so adjacent rows
    abut directly and the bg-tint strip runs full-width.

### Added

CSS rules in `index.html` for the new flat-row classes:

  - `.pi-row` — shared structural class for all message rows;
    `min-width: 0` so wide pi-md tables can scroll horizontally
    inside without breaking the outer column flow.
  - `.pi-row + .pi-row` — 1px hairline separator in muted gray
    (the trick a terminal uses to break up scrollback).
  - `.pi-row-user` — subtle `rgba(128,128,128,0.06–0.08)` bg tint
    with a 2px blue left bar; inner `<pre>` color bumped up to
    `base16-700` so user utterances stand out without being jarring.
  - `.pi-row-assistant` — no bg; inherits color from the inner
    `.pi-md` / `.md` / rawAssistant `<pre>`.

### Tests

Updated two existing tests in `transcript.test.js` that asserted
the old right-aligned bubble shape (`items-end`) and left-aligned
flex (`justify-start`); they now assert the new `pi-row-user` /
`pi-row-assistant` classes and explicitly verify the old alignment
classes are absent. 234 tests total, all passing.

### Verified

On the live gpu-devpod dashboard with the `interaction` agent
(43b6e485), a user message ("can you download this blogpost and
read it in context: …") renders as a full-width row with the bg
tint and blue left bar; the assistant's response flows directly
below in the same column with bold/italic markdown, bullet lists
with `- ` markers, and pi-md box-drawing for tables and quotes.
Matches the pi-cli terminal reference screenshot.

---

## 0.11.0 — pi-tui box-drawing markdown renderer (the real thing)

### Added

`src/web/pi-markdown.js` — a browser port of
`@earendil-works/pi-tui`'s `Markdown` component. Tokenises markdown
via `marked`, then renders **plain-text lines with literal
box-drawing characters** the same way pi-cli does in a terminal:

  - **Tables**: `┌─┬─┐` / `├─┼─┤` / `└─┴─┘` borders with `│` cell
    separators. Column widths computed by the same algorithm pi-tui
    uses (longest-word minimums, proportional distribution of extra
    space, oversize-cell wrapping). Cells wrap inside their column;
    too-narrow tables fall back to raw text.
  - **Blockquotes**: every wrapped line gets a literal `│ ` prefix in
    cyan (pi-tui paints this with `theme.quoteBorder`).
  - **HR**: literal `─` characters across the available width.
  - **Headings**: h1/h2 styled (yellow + bold + underline), h3+ get
    an explicit `### ` / `#### ` / etc. prefix in the rendered text
    (no `::before` pseudo-element).
  - **Lists**: `- ` / `1. ` bullets in cyan, continuation lines
    indented under bullet text. Nested lists indented by two spaces
    per depth.
  - **Code blocks**: ``` fence markers + 2-space indent on each
    body line + hljs colorization when an explicit language is set.
  - **Inline**: bold / italic / strikethrough / inline code each
    wrap descendant text in a `<span class="pi-strong">` etc.
  - **Links**: real `<a target="_blank">` inside the `<pre>`; when
    link text differs from href, ` (href)` is appended in muted color
    (same convention as pi-tui's terminal fallback when OSC 8 isn't
    available).

The renderer output is a single string (the body of a `<pre
class="pi-md">`). `transcript.js` swaps to it whenever
`renderTranscriptBlocks` receives `opts.widthCols`; without a width
we fall back to the old flow-layout marked HTML.

### Wiring

`app.js`:

  - `piMdCharWidthPx()` — measures the monospace cell width by
    rendering a hidden `<pre class="pi-md">` with 80 `x` chars and
    reading `getBoundingClientRect()`.
  - `measureBubbleWidthCols()` — divides the `#messages` container
    width (× 0.9 for `max-w-[90%]` − 32 px bubble padding) by the
    char width to get a column count. Clamps to 20…200 cols.
  - `ResizeObserver` on `#messages` — re-runs `renderMessages()`
    only when the COLUMN COUNT actually changes (pixel-level resize
    jitter is no-op'd via the `_lastRenderWidthCols` cache).

CSS in `index.html`:

  - `.pi-md` — single `<pre>` block, `white-space: pre`,
    `overflow-x: auto` so wide tables scroll instead of breaking
    layout.
  - `.pi-strong / .pi-em / .pi-del / .pi-code / .pi-link / .pi-h1…6
    / .pi-list-bullet / .pi-quote-bar / .pi-quote / .pi-hr /
    .pi-table-border / .pi-th / .pi-code-fence / .pi-codeblock /
    .pi-image-ref` — each maps onto the existing base16 palette so
    every theme in the picker gets coherent colors automatically.

### Tests

`src/web/__tests__/pi-markdown.test.js` — 32 tests:

  - `cellWidth` (ASCII, combining marks, surrogate pairs)
  - `wrapRuns` (fit, wrap-on-whitespace, class preservation across
    wraps, char-by-char break for oversize tokens, no
    leading-whitespace lines)
  - `inlineToRuns` (nested style stacks, codespan, links with/
    without paren-href suffix)
  - `linesToHtml` (HTML entity escaping, classed span wrapping,
    `<a target="_blank">`, multi-line join)
  - `renderMarkdownPi` end-to-end: h1/h3 styling, table box-drawing,
    blockquote bar, hr, lists, code blocks, plain-text fallback
    when marked is missing, width clamping, table reflow on width
    change.

234 total tests pass (was 202).

### Verified

Live on the gpu dashboard with the `interaction` agent: an
existing assistant message with a real markdown table now renders
the table with `┌─┬─┐` borders and aligned columns, headings with
the `### ` prefix, nested bullet lists indented properly, inline
code in cyan, links as real `<a>` tags inside the `<pre>`. Computed
`font-family` resolves to `JetBrainsMono Nerd Font Mono`,
`white-space: pre`, font-size 12.88 px — exactly the kitty-terminal
look the user wanted.

---

## 0.10.0 — JetBrains Mono Nerd Font + pi-terminal-style markdown

### Changed

The whole dashboard now feels like pi-cli in a browser.

**Font** — swapped Roboto Slab / Fira Code for a single mono stack:

```
JetBrainsMono Nerd Font Mono → JetBrainsMono NFM → JetBrains Mono NF
  → JetBrainsMono Nerd Font → JetBrains Mono (webfont) → Fira Code
  → ui-monospace → SFMono → Menlo → Monaco → Consolas → monospace
```

Users with `JetBrainsMono Nerd Font Mono` installed locally (kitty
users especially) get the patched-glyph version; everyone else falls
back to the Google-Fonts JetBrains Mono webfont (loaded via
`@import`, `display=swap`). Tailwind's `font-sans` is repointed at
the same stack so the change covers every un-classed element, not
just prose. The `font-display` slot for the "pirouette" wordmark
keeps its slab-serif identity.

Ligatures enabled globally via
`font-feature-settings: "calt" 1, "zero" 1` -- contextual alternates
(`->`, `=>`, `!=`, `>=`, `<=`, `|>`, `===`, etc. ligate) plus the
slashed zero from the kitty config the user pasted.

**Markdown CSS** rewritten to mimic pi-tui's terminal renderer:

  - **Headings**: bold yellow + same font-size for all levels (pi's
    convention -- hierarchy comes from prefix + spacing). H1 also
    underlined. H3–H6 get an explicit `### ` / `#### ` / … prefix
    via `::before content` so the visual matches pi's literal
    rendering of the markdown marker.
  - **Blockquotes**: 2px left bar in cyan, italic body, faint bg
    tint -- the CSS analogue of pi-tui's per-line `│ ` prefix.
  - **Tables**: compact cells (0.2rem / 0.55rem padding), outer
    frame + 1px inner borders that visually approximate pi-tui's
    box-drawing (`┌─┬─┐ / ├─┼─┤ / └─┴─┘`). Header row gets
    a heavier `border-bottom` for the `├─┼─┤` separator pi draws.
    Width fits content, scrolls horizontally on overflow.
  - **Inline code + code blocks**: use the same mono stack as the
    surrounding prose (no font swap), faint bg, no border -- in a
    fully-mono UI the bg-color IS the cue.
  - **HR**: 1px border-top.
  - **Lists**: cyan markers (matches pi's `mdListBullet`).

The CSS is wired so the whole dashboard — sidebar, header buttons,
model picker, placeholders, slash popup, input bar, transcript —
shares the same mono stack. Ligatures kick in everywhere monospace
would have rendered them in pi-cli.

Verified with playwright on the live gpu-devpod dashboard:
  - Computed `font-family` on `.md` resolves to `"JetBrainsMono Nerd
    Font Mono", ...`.
  - `font-feature-settings` resolves to `"calt", "zero"`.
  - A real assistant transcript (interaction agent) renders bullet
    lists, bold inline labels, and ligatured operators in the new
    mono style.
  - Mobile (390 px viewport) header buttons and placeholders all
    pick up the mono stack.

---

## 0.9.0 — inline images for path-referenced files in assistant output

### Added

**Best-effort inline rendering of agent-referenced images.** When an
assistant message mentions a file by relative path — either via a
markdown image `![alt](plots/foo.png)`, a raw `<img src="plots/foo.png">`,
or just an inline-code reference like ``the chart is in `plots/foo.png` `` —
the dashboard now renders the actual image inline so you don't have
to open a tool result and click through.

New server endpoint: **`GET /api/agents/:id/file?path=<rel>`**.

  - Resolves `path` against the agent's `worktreePath` and refuses to
    serve anything outside it (path-traversal protection with the
    standard resolve + prefix check).
  - Whitelists image MIME types only (`png`, `jpg`, `jpeg`, `gif`,
    `webp`, `svg`, `bmp`, `ico`); everything else returns 415.
  - 25 MB size cap; oversize files return 413.
  - 400 for absolute paths or null bytes; 404 for missing files or
    unknown agents; 403 for `../`-style escapes.
  - `cache-control: private, max-age=30` so a single page-load doesn't
    refetch the same image but a regenerated plot picks up within 30s.

New client helpers in `src/web/render.js`:

  - `looksLikeImagePathRef(s)` — conservative path-shape check (relative,
    image extension, no quotes/spaces/URLs).
  - `enhanceImagePaths(html, agentId)` — takes sanitized markdown HTML
    and (1) rewrites `<img src>` for relative image paths to the
    `/file` endpoint, (2) appends a small clickable thumbnail after
    any `<code>plots/foo.png</code>` inline-code span whose text
    matches the image-path shape. Skips `<pre><code class="hljs">`
    code blocks so listings of many filenames don't flood the view.
    Each generated `<img>` has `onerror="this.parentNode.style.display='none'"`
    so paths the assistant proposed but didn't actually create just
    disappear instead of leaving broken-image icons.

`renderTranscriptBlocks` now accepts `opts.agentId`, plumbed through
from `app.js`'s `renderMessages`. Without it, the markdown render is
unmodified (safe fallback for tests / preview).

### Tests

  - 7 unit tests for `looksLikeImagePathRef` + `enhanceImagePaths`
    covering positive cases, URL rejection, prose rejection, and the
    no-`agentId` fallback.
  - 9 server integration tests in `file-endpoint.test.ts` that boot a
    real `runServer` against a tmp dataDir, seed a fake agent +
    worktree, and exercise: happy path PNG / SVG, missing file (404),
    non-image ext (415), `../` traversal (403), absolute path (400),
    missing `path` query (400), unknown agent (404), and a documented
    behaviour-test for symlinks (currently followed; flagged as a
    known limitation since pirouette controls the worktree).

  202 total tests pass.

### Verified end-to-end

On the live gpu-devpod dashboard, an old transcript that mentioned
``the chart is in `specaugment_demo.png` `` rendered 3 inline
thumbnail links + the browser fired 3 actual `/file` fetches. The
training-curves PNG served by the endpoint round-trips at
`Content-Type: image/png`, `Cache-Control: private, max-age=30`,
416 KB body.

---

## 0.8.4 — fix: stopped agents keep their transcript; mobile selection is instant

### Fixed

**Stopped agents now show their conversation history.**

Previously, when an agent transitioned to `stopped` (via the Stop button
or `/stop`), `AgentManager.getMessages` returned `[]` because
`handles.get(id)` was `undefined` (we tear the live `AgentSession` down
on stop to free memory). The UI then showed the empty-state
placeholder, making it look like the conversation had been deleted.
This differs from the pi CLI, where Ctrl+C-interrupting an agent
leaves the transcript intact.

Fix: when no live handle exists, `getMessages` falls back to loading
the most-recent session JSONL from disk via
`SessionManager.continueRecent(worktreePath, sessionDir)` and runs the
same transcript-extraction pipeline. The on-disk session is the source
of truth anyway, so this is a pure read with no state-mutation risk.
Verified end-to-end with `curl /api/agents/<stopped-id>/messages`:
0 messages → 1039 messages after the fix.

**Mobile: tapping an agent now feels instant.**

`selectAgent(id)` used to `await fetchHistory(id)` before closing the
sidebar drawer and rendering messages. On a slow mobile connection,
that meant the drawer stayed open for several seconds after the tap,
covering the chat view -- so the user saw their tap highlight the
agent in the sidebar but no actual chat content for the whole fetch
duration. Felt like a freeze or a missed tap.

Fix: close the sidebar and call `renderMessages()` BEFORE awaiting
`fetchHistory`. The cached transcript (or a new "loading…" placeholder
for agents whose history hasn't been fetched yet) renders immediately;
the fetch updates the view when it lands.

Verified on a throttled 1.5 Mbps / 200 ms-latency emulated iPhone:
129 ms after tap, drawer is closed and "loading…" placeholder is
visible, vs. previously waiting for the full multi-second fetch.

**New `placeholder:loading` block** in the transcript pane,
distinguishing "history fetch in flight" from "actually-empty agent".

---

## 0.8.3 — fix: Enter on `/compact` (and other args-taking slash commands) now dispatches

### Fixed

`applySlashSelection` had a hidden trap: for commands declared with
`takesArgs: true` (`/compact`, `/skill:foo`), pressing Enter while the
slash-popup was open just filled the input with `/compact ` (with a
trailing space) and closed the popup. It did **not** POST to the
`/compact` endpoint. The user saw the popup vanish and a stale
`/compact ` sitting in the input, gave up, and assumed the command was
broken. Real-world consequence: a stuck agent that needed compaction
couldn't be compacted via the UI at all.

Fix: split Tab and Enter on the popup.

  - **Tab**: fill `/<name> ` so the user can type args before sending.
    Same as before.
  - **Enter**: dispatch the command immediately. Args come from whatever
    is currently in the input after the command name (empty is fine
    -- `/compact` works without instructions).
  - Skills (`/skill:foo`) now route through `sendMessage` so pi's
    server-side `_expandSkillCommand` resolves them, instead of falling
    through the old client-side branch.
  - Click on a popup item still dispatches immediately (intuitive --
    you clicked it, so do it).

Verified end-to-end with the playwright harness against the live
gpu-devpod dashboard: Enter on `/compact` POSTs `/api/agents/:id/
compact`; Tab on `/comp` fills the input without firing; Enter on
`/compact keep arch decisions` POSTs with the instructions in the body.

---

## 0.8.2 — fix: steering during a turn no longer behaves like follow-up

### Fixed

When the user typed a message mid-turn with `mode: "steer"`, the message
was not delivered to pi via `session.steer()` -- it was waiting on the
per-agent lock until the in-flight `prompt()` resolved, then dispatched
as a new turn (functionally identical to follow-up). The steering chip
in the UI would sit there until the turn ended, and the agent never saw
the message at a turn boundary the way it does in pi's TUI.

Root cause: `AgentManager.sendMessage` held the per-agent serialization
lock across `await session.prompt()`, which doesn't resolve until pi's
agent loop emits `agent_end`. Any subsequent sendMessage on the same
agent blocked behind that lock; by the time it ran, `isStreaming` was
false and the code took the `prompt()` branch (= new turn).

Fix: only hold the lock for the brief critical section that decides
which pi API to dispatch (and starts the prompt). The long-lived
`prompt()` promise is awaited outside the lock so subsequent
steer/followUp calls race in, see `isStreaming=true`, and enqueue via
pi's own internal queue. Also fixed the subtle `Promise<Promise<T>>`
auto-flattening trap by boxing the prompt promise in `{ promptPromise }`
so the lock chain doesn't unintentionally await it.

Added 3 regression tests in `src/server/__tests__/agent-manager-steer.test.ts`
that install a fake `AgentSession` and assert (a) the first send on an
idle agent dispatches via `prompt()`, (b) a mid-prompt steer dispatches
via `steer()` and resolves promptly (NOT waiting for prompt to finish),
(c) same for followUp.

---

## 0.8.1 — fix: tool-result images shouldn't be hidden behind the chevron

### Fixed

v0.8.0 rendered tool-result images inside the same expand wrapper as
the text body (hidden until the user clicked the chevron). For
`read` on an image file, the text body is just the placeholder
`"Read image file [image/png]"` -- so the chevron was hiding the
only content that mattered (the image), and the user had to drill
two levels of expand (run → tool_result chevron) to see anything.

Fix: render images ALWAYS-VISIBLE on tool_result rows; the chevron
gates the text body only. Images are bounded (`max-h-48`) so they
won't blow up the timeline.

Also added a `· N image(s)` suffix to the tool_result label so the
row is self-describing without having to look at the body.

---

## 0.8.0 — image attachments (paste + view) in the dashboard

### Added

The dashboard now supports image attachments end-to-end, mirroring pi's
TUI Ctrl+V flow:

  - **Send images**: paste an image (png/jpeg/webp/gif) into the message
    input. A preview pill with thumbnail + mime label + remove (×)
    button appears above the input. On send, the bytes are forwarded
    as part of the user message and the agent's model sees them in
    the same turn.
  - **View images**: inline `<img>` rendering in the transcript for
    user messages with attachments. Click to open the full-size image
    in a new tab.
  - **Tool-result images**: tool results that include image content
    blocks (e.g. a screenshot tool) render the images alongside the
    tool's text output, gated by the existing expand chevron so they
    don't blow up the timeline.

Wire flow:

  - `POST /api/agents/:id/message` body extends with `images: [{ data:
    <base64>, mimeType }]`. Server validates: max 8 images per message,
    max ~12MB binary per image, mime allowlist (png/jpeg/webp/gif).
  - `AgentManager.sendMessage(id, message, { images })` forwards to
    pi's `session.prompt({images})` / `session.steer(message, images)`
    / `session.followUp(message, images)`. (Pi's API quirk: prompt
    takes an options object, but steer/followUp take a positional
    images arg -- both forms handled.)
  - `ChatMessage` shape extends with optional `images?: { dataUrl,
    mimeType }[]`. `getMessages` extracts pi's image content blocks
    into ready-to-use `data:<mime>;base64,...` URIs so the dashboard
    has no extra fetches.
  - `transcript.js` renderMessage gains a `renderInlineImages` helper
    used by both user and tool_result branches.

### Limits

Server-side caps:
  - 8 images max per message
  - ~12MB binary max per image (16MB base64-encoded chars)
  - Allowed mime: image/png, image/jpeg, image/webp, image/gif

These mirror typical model-provider limits (Anthropic: 5MB/image; we
are generous) and exist so a misbehaving client can't dump 100MB into
a session.

### Tests

+3 renderMessage tests for: user-with-image, user-image-only-no-text,
tool_result-with-images. +1 update to the existing user-message test
for the new flex layout (`items-end` instead of `justify-end`, since
images stack above the text bubble now).

Total: 178/178 passing.

### Verified end-to-end via playwright

Using the new `scripts/check-dashboard.mjs` harness: loaded the live
deployment, dispatched a synthetic paste event with a 1x1 PNG, asserted
the preview pill rendered, asserted no JS errors on the page. The
smoke check sequence has been added to the dev loop.

---

## 0.7.0 — multi-config support (`--config <path>` / `$PIROUETTE_CONFIG`)

### Added

The CLI now accepts a global `--config <path>` flag (or
`$PIROUETTE_CONFIG` env var) so users with multiple deployments can
keep one TOML per host and switch between them per-invocation:

```
pru --config ~/.pirouette/ec2.toml status
pru --config ~/.pirouette/gpu.toml sync

# or via env var:
export PIROUETTE_CONFIG=~/.pirouette/ec2.toml
pru sync --npm
```

State files automatically derive from the config path, so each
deployment's `host.json` stays separate:

  - Default `~/.pirouette/config.toml`  -> `~/.pirouette/host.json` (unchanged)
  - Custom `~/.pirouette/ec2.toml`      -> `~/.pirouette/ec2.host.json`
  - Custom `~/cfgs/gpu.toml`            -> `~/cfgs/gpu.host.json`

`pru config edit` now opens whichever path is active. If the path
doesn't exist yet, it's seeded as an empty file so the editor has
something to open.

`$PIROUETTE_STATE` is also honoured for cases where you want the
state file somewhere completely independent of the config dir
(e.g. ephemeral state in `/tmp` for tests).

Resolution precedence:

  config: --config flag > $PIROUETTE_CONFIG > ~/.pirouette/config.toml
  state:  $PIROUETTE_STATE > <stem-of-config>.host.json > legacy ~/.pirouette/host.json

### Compatibility

Fully backward-compatible. With no `--config` and no `$PIROUETTE_*`
set, behaviour is byte-identical to v0.6.x: same config path, same
state path, same legacy `ec2.json` migration on first read.

### Use case

The immediate motivation was "I have a long-running EC2 deployment
*and* a byo-host devpod and want to push releases to either without
fiddling with `provider.kind`." With separate configs, you alias:

```
alias pru-ec2='pru --config ~/.pirouette/ec2.toml'
alias pru-gpu='pru --config ~/.pirouette/gpu.toml'

pru-ec2 sync --npm     # upgrade the EC2 deployment
pru-gpu sync           # push local build to the gpu devpod
pru-gpu open           # dashboard for the gpu devpod
```

State stays cleanly partitioned (each TOML's `.host.json` lives next
to it).

---

## 0.6.7 — fix: agent-header button row overflows on mobile

### Fixed

Adding the `thinking ▾` picker in v0.6.3 brought the visible-button
count up to six (raw / model / thinking / fork / stop / delete). With
the hamburger + agent name on the same flex row, the total width
exceeds a 375px-wide phone viewport, so `delete` (rightmost) clips
off the edge.

Fix: add `flex-wrap md:flex-nowrap` to the `<header id="agent-header">`.
On mobile the buttons drop to a second row below the name. On desktop
(md+) the single-row layout is preserved -- plenty of horizontal
space there, no wrap needed.

---

## 0.6.6 — fix: thinking-picker referenced non-existent agentsById

### Fixed

The v0.6.3 thinking-picker code looked up the current agent via
`agentsById[selectedAgentId]`, but the dashboard uses a flat `agents`
array (not a map keyed by id). On click, `renderThinkingList()` threw
`ReferenceError: agentsById is not defined`, which crashed before the
popup was shown -- the dropdown silently failed to open with no
visible feedback.

Fix: use `agents.find((a) => a.id === selectedAgentId)`, mirroring
the pattern used everywhere else in the dashboard for the same
lookup.

Didn't catch this earlier because v0.6.3 / 0.6.5 typechecks pass
(app.js isn't covered by tsc; it's plain JS) and the existing test
suite doesn't exercise the picker. Going forward, the smoke-test of
any new dashboard UI should include actually clicking the new
elements and watching DevTools console.

---

## 0.6.5 — fix: missing xhigh thinking level; dashboard cache-control

### Added

`xhigh` joins the thinking-level picker. Pi's `ThinkingLevel` is
`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` per
`@earendil-works/pi-agent-core`, but v0.6.3's picker hard-coded the
first five and rejected `xhigh` from the API as invalid. Now both UI
(picker shows all six) and server endpoint accept it.

### Fixed

The dashboard's static-asset responses now set `Cache-Control:
no-cache` so the browser revalidates on each load. Without this, an
aggressive cache (especially Safari on the laptop) could leave you
with a freshly-synced `index.html` but a stale `app.js` -- the new
UI elements would render but their event handlers wouldn't be wired
(no JS bindings for the new DOM ids). The user-visible symptom was
"button is there but clicking it does nothing." The new header makes
the browser send `If-Modified-Since` on every request; the server
still 304s when nothing has changed, so the cost is minimal.

If you hit this on v0.6.3/0.6.4, a one-time hard refresh
(`Cmd+Shift+R`) is the fix.

---

## 0.6.4 — fix: byo-host restartServer drops env vars; project-creation UX

### Fixed (the urgent one)

Byo-host's `restartServer()` (called by `pru sync` / `pru sync --npm`)
spawned the new tmux session with only `PIROUETTE_DATA_DIR / PORT /
HOST` set. Missing: `PIROUETTE_DEFAULT_MODEL`,
`PIROUETTE_DEFAULT_THINKING_LEVEL`, and `PIROUETTE_ALLOWED_HOSTS`.
The bootstrap script DOES pass all of these on initial start (v0.6.2),
but byo-host's restartServer maintained its own duplicated tmux
command line that didn't.

Result: any `pru sync` (or any other path through restartServer)
resurrected the server with empty allowlist + no default model:

  - Tailscale URL (`pirouette-<host>.<tailnet>.ts.net`) -> 421
    "misdirected request" from the Host-header check
  - SSH tunnel (`http://localhost:7777`) -> still worked
    (loopback is always allowed)
  - `@default` agent launches in the UI -> "No model specified"

The EC2 provider doesn't have this bug because docker passes env at
container-start via `-e`, and tmux inherits the container env.
Byo-host has no docker layer, so the env vars have to be re-passed at
every tmux start.

Fix: `restartServer()` now builds the same env prefix the bootstrap
script does, including reading the tailscale FQDN sentinel
(`<data_dir>/tailscale-fqdn`, written by the tailscale block) and
merging it with `server.allowed_hosts` from config. Field names +
formatting kept in lock-step with `build_server_env()` in
`scripts/pirouette-bootstrap.sh`; if one changes, the other has to.

Manual recovery for an existing v0.6.3-or-earlier deployment that
lost its env via a recent `pru sync`: either re-run `pru setup`
(bootstrap fast-paths and restarts tmux with full env), or restart
tmux by hand with the env vars set (recipe in the v0.6.2 entry).

### Fixed: project-creation feedback + concurrent-clone race

### Fixed

Clicking "create" in the new-project modal fired off a POST and waited
for the response with zero visual feedback while the clone ran (1–30s
for a typical repo). Easy to assume nothing happened and double-click,
which raced two concurrent POSTs for the same name; whichever lost the
race tripped the empty-dir check on the half-cloned target and
surfaced as `repo path /…/repos/<name> is not empty; refusing to
clone/init into it`.

**UI side**: the create button now flips to `creating…` (or
`cloning…` when a repo URL was provided), goes disabled, and the name
/ repo inputs go disabled too. Re-enabled on success or failure. An
in-flight flag also short-circuits Enter-key submits + re-click
attempts, so the user can't queue a second request even if they try.

**Server side**: `ProjectManager.createProject` now tracks names
currently being created in a small in-memory set; a concurrent POST
for the same name (e.g. from curl or two browser tabs) gets a
`PROJECT_IN_FLIGHT`-tagged error which the API maps to a `409
Conflict` with a clear "already in progress" message, rather than
racing into the empty-dir failure.

The empty-dir error message itself also got slightly more helpful —
includes the exact `rm -rf <path>` command to clear leftover state.

### Added

On server boot, the project manager scans `<dataDir>/repos/` for
subdirectories without a matching project entry in state and logs a
warning if it finds any. Most likely cause: a previous
`createProject` that errored after the clone but before
`putProject` ran (e.g. server crashed mid-clone). Non-fatal — we
don't auto-clean because the user might want to inspect / recover
the contents — just surfaces the situation in `pru logs` so future
"name is not empty" errors are easier to diagnose.

---

## 0.6.3 — thinking-level picker in the dashboard

### Added

A `thinking ▾` button in the agent header, next to the existing
`model ▾` picker. Opens a five-option popup
(`off / minimal / low / medium / high`); clicking a level persists it
on the agent config and — if the session is live — reconfigures pi's
reasoning settings via `AgentSession.setThinkingLevel()` so the next
turn uses the new level.

New server endpoint:

  POST /api/agents/:id/thinking-level
  body: { "level": "off" | "minimal" | "low" | "medium" | "high" }

New AgentManager method `setAgentThinkingLevel(id, level)` mirrors
`setAgentModel`'s shape: takes the agent lock, updates persisted
state first (so resumes pick the new level up), then mutates the
live session if one exists, then emits a state-change broadcast so
the UI re-renders.

Levels above `off` only have effect on models with reasoning support;
pi silently ignores them on non-reasoning models, so the picker is
shown for every agent regardless of model.

Before this, thinking level was settable only at agent creation
(`pru launch --thinking <level>` or `container.default_thinking_level`
in config) and read-only after that. Now it's editable mid-conversation,
including mid-streaming-turn.

---

## 0.6.2 — fix: forward server-runtime env vars on byo-host

### Fixed

The byo-host bootstrap script started the pirouette server tmux
session with only `PIROUETTE_DATA_DIR / PIROUETTE_PORT /
PIROUETTE_HOST` set in its env. Critically missing:
`PIROUETTE_DEFAULT_MODEL`, `PIROUETTE_DEFAULT_THINKING_LEVEL`, and
`PIROUETTE_ALLOWED_HOSTS`. The EC2 path passes these via
`docker run -e`; byo-host has no docker layer so they have to thread
through the bootstrap.

User-visible symptom: launching an agent via `@<name>` in the UI
failed with `Could not create @default: No model specified` even
when `container.default_model` was set in `~/.pirouette/config.toml`
on the laptop. The remote server had no `config.toml` of its own
and no env-var override, so it ended up with no default.

Fix:
  - byo-host's `provision()` now copies `container.default_model`,
    `container.default_thinking_level`, and (comma-joined)
    `server.allowed_hosts` into the bootstrap env.
  - The bootstrap script wraps tmux launch in a `build_server_env`
    helper that emits each var only when non-empty (avoids
    explicit-empty-string-overrides-fallback foot-gun), used by
    both the initial start and the tailscale-block restart.
  - The tailscale restart now MERGES the new FQDN onto the existing
    `allowed_hosts` list rather than replacing it (so config-level
    hostnames like `pirouette-neev.koi-moth.ts.net` survive).

### Manual recovery for v0.6.0 / v0.6.1 users

For a running byo-host server that's missing the env vars, the
fastest fix is to restart the tmux session by hand (idempotent):

```
ssh <alias> 'tmux kill-session -t pirouette; tmux new-session -d -s pirouette \
  "PIROUETTE_DATA_DIR=/data/pirouette/data \
   PIROUETTE_PORT=7777 \
   PIROUETTE_HOST=127.0.0.1 \
   PIROUETTE_DEFAULT_MODEL=<your-model> \
   PIROUETTE_ALLOWED_HOSTS=<tailscale-fqdn> \
   pirouette server"'
```

Or upgrade to 0.6.2 and re-run `pru setup` (the idempotent fast
path will hit the new build_server_env code).

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
