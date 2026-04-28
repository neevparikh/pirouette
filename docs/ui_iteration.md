# UI iteration log

Running log of UX / rendering nits and their fixes. New issues go to the
**Pending** section at the top; fixed ones move down to **Fixed**, newest
first, with a short note on how they were solved. Keep the file living —
each pass of iteration appends here rather than resetting.

---

## Pending

_(nothing open — add new nits here as you notice them)_

## Fixed

### Assistant streaming bubble flashed on every delta
Each `text_delta` was running `el.innerHTML = renderMarkdown(text) +
cursor` on the live bubble — which:
- Re-ran marked + DOMPurify + highlight.js on the **entire growing
  buffer** (not just the delta)
- Tore down every text node, span, and hljs class inside the bubble and
  rebuilt them from scratch
- Caused the partial-markdown problem: half-formed `**bold` or unclosed
  fences would briefly flicker in/out of styled state as the LLM emitted
  characters

**Fix.**
- `src/web/transcript.js`: streaming assistant bubble now ALWAYS renders
  as a `<pre id="streaming-body" class="...font-sans whitespace-pre-wrap">`
  with plain escaped text + cursor span. No markdown during streaming.
- `src/web/app.js` `updateStreamingElement`: switched from
  `el.innerHTML = renderMarkdown(text) + cursor` to **append-only DOM
  mutations**:
  - Track `el.__pirStreamText` = last-rendered text
  - On each delta, if new text starts with old (always true for normal
    streaming), insert just the suffix as a `document.createTextNode(suffix)`
    before the cursor span
  - The cursor span stays in place across all deltas — its `animate-pulse`
    keeps blinking smoothly without restart
  - Fallback path (replacement) handles edge cases like initial paint or
    out-of-order deltas with one rebuild
- Markdown rendering kicks in once on `message_complete` when the
  reconciler swaps the streaming bubble for a finalized markdown-rendered
  one. That's a single transition at end-of-turn instead of 50–100
  rebuilds per second during streaming.
- Removed unused `renderMarkdown` import from `app.js`.

Matches the streaming UX of Claude.ai and Cursor: text appears as plain
streamable prose, formats once when the response is complete.



### Messages list re-rendered the whole transcript on every event
Every `message_complete`, `tool_execution_start`, `tool_execution_end`,
or optimistic-user-append called `renderMessages()` which did
`$messages.innerHTML = renderTranscript(...)`. Visual symptoms: a flash on
every event, scroll jumping to the bottom even when the user scrolled up,
images reloading, code blocks being re-highlighted from scratch, and
click handlers being re-attached on every render.

**Fix.** Switch to per-block reconciliation keyed by stable `data-msg-key`
attributes:
- `src/web/transcript.js`:
  - Every top-level wrapper (`<div class="message-enter ...">`) now carries
    `data-msg-key="..."`. Keys are `messageKey(msg, idx)` for finalized
    messages, `run:<firstIdx>:<lastIdx>` for collapsed tool runs, and the
    new sentinel `STREAMING_TEXT_KEY` / `STREAMING_THINKING_KEY` for the
    in-flight bubbles (so they share DOM across deltas).
  - New `renderTranscriptBlocks(state, expanded, opts)` returns an array
    of `{ key, html }` blocks instead of a single string. The original
    `renderTranscript` is now a thin `blocks.map(b => b.html).join("")`
    wrapper for back-compat with existing tests.
- `src/web/app.js` `renderMessages()`:
  - Builds blocks (or a placeholder block for the empty / no-agent
    states) and runs them through a new `reconcileBlocks($messages,
    blocks)` helper.
  - Reconciler walks existing children by `data-msg-key`, reuses any
    whose cached html (`__pirHtml` property) hasn't changed, replaces
    nodes whose html is stale, inserts new ones in order, and removes
    orphans whose key is gone. No more `$messages.innerHTML = ...`.
  - Auto-scroll to bottom only fires when the user was already near the
    bottom (`scrollHeight - scrollTop - clientHeight < 40px`). Scrolling
    up to read history is no longer interrupted by every event.
- Click handling moved to a single delegated handler on `$messages` for
  `[data-toggle]` chevrons. Previously the per-render forEach had to
  rebind every time and was implicitly tied to the rebuild. Now click
  handlers are bound exactly once at startup.
- 5 new tests in `transcript.test.js` lock in the reconciler contract:
  block keys are stable across renders, completed tool runs collapse to
  a single `run:` block, live tool rows emit per-row `tc:` blocks,
  streaming bubbles use the sentinel keys, and the joined string form
  matches `renderTranscript()` exactly.



### Vim mode in the message input
The textarea now supports modal editing styled after
[`pi-vim`](https://github.com/neevparikh/pi-vim) (also at `~/repos/pi-vim/`).
Toggle via the `vim:` button in the bottom-right of the input bar; the
preference is persisted via `localStorage.pirouette-vim-mode`.

**What's implemented (matches pi-vim's feature set):**
- 4 modes: normal, insert, visual, visual-line. Mode label below the
  textarea (`-- NORMAL [3d] --`) shows pending operator/count.
- Motions: `h j k l 0 ^ $`, `w W b B e E ge gE`, `gg G`, `% ( ) { }`,
  `f F t T<char>`, `; ,`. Counts before any motion (`3w`, `2j`).
- Editing: `i I a A o O`, `x X`, `D`, `C`, `J`, `~`, `r<char>`, `s S`,
  `dd cc yy`, `dD cC yY`.
- Operators + motion: `dw`, `c$`, `y2j`, `>ip`, `gUaw`, `g~e`. Doubled
  operator targets the current line (`dd`, `cc`, `>>`).
- Text objects: `iw aw`, `i" a"`, `i' a'`, `` i` a` ``, `i( a( i) a)`,
  `i{ a{ i} a}`, `i[ a[ i] a]`, `i< a< i> a>`. Work with `d c y` and case
  operators.
- Visual / visual-line: `v V`, then `d c y x` apply to the selection.
  `o` swaps cursor and anchor. `>/<` indent/outdent. `~/u/U` toggle/lower/
  upper-case the selection. `p` swap-pastes (replace + yank old).
- Yank / paste: `y p P Y`. Charwise vs linewise register semantics. Best-
  effort `navigator.clipboard.writeText` so yanks reach the OS clipboard.
- Multi-level undo / redo: `u` and `Ctrl+r`. Snapshot stack capped at 200.
- Insert mode is transparent: typing, browser shortcuts, the @-mention
  popup, and the existing send-on-Enter all work unchanged. `Esc` is the
  only key vim claims while in insert.

**Implementation notes:**
- New file `src/web/vim.js` (~ 1100 LOC). Pure-JS port of pi-vim's algorithms
  (word boundaries, find-pair, paragraph boundaries, text-object resolvers).
- `VimMode` is a thin keydown layer over the existing `<textarea>` — no
  `contenteditable` swap, no overlay div. Cursor visualization in normal
  mode is a 1-char selection (block-cursor effect via the browser's native
  highlight); visual mode uses the actual selection range.
- Internal cursor offset (`_cursor`) is tracked separately from
  `selectionStart`. In visual mode the textarea's selectionStart always
  reports the smaller end of the rendered selection, which would lose the
  active cursor side; tracking it explicitly fixes motions like `vlld`.
- Defers to host UI when needed via a `shouldSkip` predicate — specifically,
  vim never claims keys while the @-mention popup is open, so autocomplete
  navigation (Up/Down/Tab/Enter/Esc) keeps working.
- After `sendMessage()` clears the textarea, vim is forced into insert mode
  so the user is ready to type again without an extra `i`.
- 42 new tests in `src/web/__tests__/vim.test.js` (jsdom env) covering the
  high-frequency commands, counts, operators, text objects, undo/redo, and
  visual mode. 102 tests total now pass.

---

## Fixed

### Sidebar font sizes + theme button styling
Sidebar text was cramped (`text-xs` / `text-[10px]` everywhere) and the
theme button was an unstyled text link that stood out compared to the
pill-style action buttons in the agent header.

**Fix.**
- `src/web/index.html`:
  - `pirouette` heading `text-lg` → `text-xl`.
  - Theme button restyled as a pill matching the agent-header action
    buttons: `text-xs px-2 py-1 rounded bg-base16-300/40 text-base16-500
    hover:bg-base16-300/70 font-mono`. Now visually consistent with
    stop/resume/delete/raw across both headers.
- `src/web/app.js` `renderAgentRow` + project row:
  - Agent name: `text-xs` → `text-sm`
  - Agent subline (state / activity): `text-[10px]` → `text-xs`
  - Project name: `text-xs` → `text-sm`
  - Project subtitle: `text-[10px]` → `text-xs`
  - Collapse arrow + delete `×`: bumped one step each
  - Placeholder states ("loading…", "no projects yet", "no agents— type
    @name") bumped in lockstep.
- Consistent one-step bump across the whole sidebar so type hierarchy is
  preserved (project names still outrank agent names by weight, not size).

### Markdown styling round 2: match pi's colors + table behavior
First pass lifted pi's marked config + hljs. Visually it still felt off —
tables forced 100% width, headings had no bottom breathing room, and
heading/code/list-marker colors didn't match pi.

**Investigation.** Pi's `dark.json` theme file (at
`node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/dark.json`)
maps markdown tokens to specific base colors:
```
mdHeading:   #f0c674   (warm yellow — `base0A` analog)
mdLink:      #81a2be   (blue)
mdCode:      accent    (teal-cyan in dark theme)
mdCodeBlock: green
mdListBullet: accent
```
And pi's TUI `Markdown` component inserts blank lines both before and
after headings — our CSS only had `margin-top`, so headings flowed
straight into the next paragraph.

**Fix.** Rewrote the `.md` palette + spacing in `src/web/index.html`:
- Headings: `--color-base16-yellow`, `margin: 1.1rem 0 0.4rem` (top +
  bottom — matches pi's blank-line-around-headings).
- Inline code: `--color-base16-cyan` on the neutral alpha bg.
- Code block body text: `--color-base16-green` (hljs token classes still
  override for syntax highlighting when a language is tagged).
- List markers: `--color-base16-cyan` instead of muted gray.
- Tables: `width: auto; max-width: 100%; display: block; overflow-x: auto`
  — size to content, scroll if overflowing. Header row tinted with
  `rgba(--color-base16-cyan, 0.1)` instead of flat gray.
- List items got a tiny `margin: 0.1rem 0` for breathing room.

### Pi-style footer data in the agent header
The agent header showed only an info strip (model / path / age / id). No
context usage, token totals, cost, or thinking indicator — which are exactly
the things you watch in pi's TUI footer.

**Fix.**
- `src/server/agent-manager.ts` gained `getLiveStats(id)` which pulls from
  `session.getSessionStats()` + `session.getContextUsage()` — the same
  methods pi's own footer reads. Returns `{ model, thinkingLevel, tokens,
  cost, contextTokens, contextWindow, contextPercent, turns, sessionFile }`,
  or `null` for stopped agents (no live session).
- `src/server/index.ts` exposes it at `GET /api/agents/:id/stats`.
- `src/web/app.js` fetches stats on agent-selection and on every
  `state_change → idle|waiting_input`. Caches per-agent in `statsByAgent`.
- Agent header gained a third line below `agent-info` that renders:
  `↑12k  ↓340  R5k  W800  $0.08  45.2%/1M  thinking: high`
  — same ordering and glyphs as pi's TUI footer. Context percent colors
  follow pi's warning (>70%) / error (>90%) bands.
- Git branch is already shown in the info strip (line 2) via `agent.branchName`.

### Theme picker popup went off-screen
The `theme` button sits near the right edge of the sidebar; the popup was
`right-0 w-64` so it extended 256px LEFT from the button into negative
screen space.

**Fix.** `src/web/index.html` flips the popup to `left-0` so it extends
right into the main panel. `z-50` already handled layering over the
chat content.

### Sidebar top and agent-header top didn't align
Sidebar header was `p-4` (16px vertical, 1-line content). Main agent header
was `px-6 py-3` (12px vertical, 2–3 line content). Their bottom borders
didn't line up.

**Fix v1 (didn't hold).** Set `min-h-[72px]` on both. Worked until the
live-stats line got added to the main header, which pushed it to ~86px
while the sidebar stayed at the 72px floor — the mismatch came back.

**Fix v2.** Both headers now use `h-[88px]` (fixed, not `min-h`). 88px is
the worst-case height of three content lines (name + info-strip + live
stats) at the current font sizes, so the bottom borders line up in every
state (no agent selected, agent selected w/ stats, streaming, etc.). If
future work adds a fourth line to the main header, bump both in lockstep
— the HTML has a comment callout explaining this.

### Global raw-markdown toggle
Previous pass shipped a per-message `</>` button. On further thought a
global toggle is cleaner — when you're debugging what the model emitted,
you usually want to flip every message at once.

**Fix.**
- `src/web/transcript.js` `renderMessage` / `renderTranscript` accept an
  `opts.rawAssistant` flag. When true, every assistant message (including
  the currently-streaming one) renders as plain escaped source.
- `src/web/index.html` adds a `raw` button to the agent header action
  row (alongside stop / resume / delete).
- `src/web/app.js` owns the `rawView` state, persisted via
  `localStorage.pirouette-raw-view`. Button styling reflects active (blue
  accent) vs inactive (muted gray) so the state is obvious at a glance.
  Toggling re-renders the current transcript with the new flag.
- Per-message `</>` buttons removed — the global control makes them
  redundant and they cluttered the bubble chrome on hover.

### Match pi-coding-agent's markdown rendering
Pirouette's markdown was using `marked` with `breaks: true` (single newline
→ `<br>`) and no syntax highlighting, so assistant messages looked
different from pi's TUI / HTML export.

**Investigation.** Pi (via `@mariozechner/pi-tui`'s `Markdown` component)
uses `marked` with default options + a custom `StrictStrikethroughTokenizer`
and pipes fenced code blocks through `cli-highlight` (TUI) / `highlight.js`
(HTML export). Pi intentionally skips language auto-detection because it
misidentifies prose as AppleScript / LiveCodeServer / etc.

**Fix.**
- `src/web/render.js` — `configureMarked()` now sets up:
  - A `StrictStrikethroughTokenizer` lifted verbatim from pi-tui.
  - `marked-highlight` plugged into `highlight.js` with
    `ignoreIllegals: true`, only firing when the fence has an explicit
    language AND `hljs.getLanguage(lang)` recognises it. No auto-detect.
  - Removed `breaks: true`, so single newlines are whitespace within a
    paragraph (pi's default behavior).
- `src/web/index.html` — added `highlight.js@11/lib/common.min.js` +
  `marked-highlight@2` CDN scripts.
- `src/web/index.html` `.md` CSS rewritten to mirror pi's export template:
  - All headings `font-size: 1em` bold (no progressive sizing).
  - Paragraphs: `p + p { margin-top: 0.75rem }` instead of bottom margins.
  - Inline code uses `rgba(128, 128, 128, 0.18)` (theme-neutral alpha)
    instead of `base16-100` so it stays visible on every theme.
  - `<pre>` has subtle alpha bg, no border; monospace is the visual cue.
  - Added `table`, `hr`, `img`, `del`, and colored `li::marker` rules.
  - Added `.hljs-*` token class rules that map to the base16 palette with
    bright-variant fallbacks, same convention as neevparikh.github.io's
    Shiki setup.
- Kept the slab-serif body font for prose (user's explicit choice); pi's
  HTML export uses monospace everywhere, but the slab/mono hybrid reads
  better in a chat context and keeps consistency with the personal site.

### Full base16 theme picker (ported from neevparikh.github.io)
The UI had two hardcoded gruvbox themes toggled by a single `◐` button;
the personal site has ~450 themes via a base16/base24 picker.

**Fix.**
- `scripts/generate-themes.mjs` reads the YAMLs from `~/repos/neevparikh.github.io/src/base16-tailwind/schemes` (override via arg) and emits `src/web/themes.css` (all theme classes) and `src/web/themes.json` (picker manifest). Variable naming matches the site: `invert: true`, `prefix: "base16"`, `system: "base24"`. Both files are checked in; re-run the script to pull new schemes.
- `src/web/index.html` loads `themes.css` + inlines a FOUC-preventing `<script>` in `<head>` that reads `pirouette-theme-{light,dark,mode}` from localStorage and applies the right class before paint.
- Tailwind color palette extended to include `base16-800`, `pink`, and `*-bright` variants (with `var(..., fallback)` so base16 schemes degrade cleanly when brights are missing).
- `src/web/app.js` replaces the old `toggleTheme` with the ported picker: search box + full list + "system dark mode" reset. Honors OS appearance changes when in `system` mode via a `matchMedia` listener.
- Defaults: `base24-softstack-light` / `base24-softstack-dark`.

### Collapse tool-call runs between assistant messages
A turn is typically `user → [tool, tool_result]×N → assistant`; rendering
each pair separately blows up the chat vertically.

**Fix.** `src/web/transcript.js` `renderTranscript` now greedy-groups consecutive
tool/tool_result rows into a run. A run that's followed by a non-tool message
(completed turn) renders collapsed as `▸ 5 tool calls · bash · read · edit`
and expands on click. A run at the tail of the transcript is the **live** run
(agent still working) and stays expanded so the user can watch. Errors in the
run bubble up into the header in red (`· 2 errors`). Expand state keyed on
`run:<firstIdx>:<lastIdx>` and shares `expandedItems` with the rest of the UI.

### Chat font stack matches neevparikh.github.io
User and assistant messages used a generic system font; inconsistent with
the personal site.

**Fix.** `src/web/index.html` loads Roboto Slab + Zilla Slab + Fira Code from
Google Fonts. Tailwind's `fontFamily.extend` remaps:
- `font-sans` → Roboto Slab (the slab-serif body)
- `font-mono` → Fira Code (with `"calt" 1` contextual ligatures enabled
  globally via a `pre, code, kbd, samp` CSS rule)
- `font-display` → Zilla Slab (applied to the wordmark, project names, and
  agent names)

`body` lost its `font-mono` class so it inherits the slab-serif; agent info
strip and tool-call header rows keep `font-mono` and get Fira Code.

### Optimistic user message disappeared after @-create
Typing `@foo hello` where `foo` was new → user message flashed and vanished
until reload.

**Root cause.** `sendMessage` did: optimistic append to `transcriptByAgent`,
set `historyLoaded[id] = false`, then `selectAgent(id)` which called
`fetchHistory`. The server hadn't processed the POST yet, so history came
back empty and wiped the optimistic append. The message only reappeared
when `agent_state_change → idle` triggered another refresh.

**Fix.** `src/web/app.js` `sendMessage` sets `historyLoaded[id] = true`
after the optimistic append so `selectAgent` trusts local state. Canonical
history still refreshes automatically when the agent transitions back to
`idle`/`waiting_input`.

### Thinking wasn't visible
Reasoning-model agents never emitted thinking events because `@name`
quick-creates defaulted to `thinkingLevel: "off"`.

**Fix.** New `container.default_thinking_level` config field:
- `src/config.ts` — added to the `container` block, built-in default `""`
- `pirouette.toml` — field with empty default + comment explaining values
- `src/server/index.ts` — bridges `cfg.container.default_thinking_level` →
  `PIROUETTE_DEFAULT_THINKING_LEVEL` env (explicit env still wins)
- `src/server/agent-manager.ts` — `createAgent` uses
  `opts.thinkingLevel || process.env.PIROUETTE_DEFAULT_THINKING_LEVEL || "off"`

Set it in `~/.pirouette/config.toml` under `[container]` to turn thinking on
for all quick-creates.

### Thinking render was janky (token-by-token full-rebuild)
Every `thinking_delta` fell through to a full `renderMessages` call because
the stable element id used by `updateStreamingElement` didn't match what
`transcript.js` emitted (`streaming-text` vs `streaming-body`).

**Fix.** Unified on `streaming-body` (assistant) and `streaming-thinking-body`
(thinking). Streaming thinking renders as a `max-h-48 overflow-y-auto`
auto-scrolling `<pre>` during streaming, collapses into the
`thinking · <preview>` + expand widget at `message_end`.

### Input bar cosmetics
Sidebar `+ new agent` button and the main-panel input bar had mismatched
heights (different `text-*` sizes + no border on the sidebar button made it
~10px shorter). Fonts between user and assistant messages also didn't match.

**Fix.** Matched `text-sm` + `border border-transparent` on the sidebar button
so its intrinsic height equals the textarea + send button. Input bar flex row
uses `items-stretch` so the textarea and send button share height. (Fonts are
now unified via the slab-serif body stack above.)
