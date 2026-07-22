// Pirouette web dashboard — ES module.
//
// State layout:
//   - `agents` and `projects` are the source of truth (refreshed via WS)
//   - `selectedAgentId` drives the chat view
//   - `selectedProjectName` drives the "default project for @<newname> creates"
//     (always set: defaults to scratchpad if nothing else is picked)
//   - Pure rendering helpers live in render.js / transcript.js

import {
  describeToolCall,
  escHtml,
  relTime,
  shortenPath,
} from "./render.js";
import {
  initialTranscriptState,
  reduceEvent,
  renderTranscriptBlocks,
} from "./transcript.js";
import { VimMode } from "./vim.js";

// --- state ---

let agents = [];
let projects = [];
let selectedAgentId = null;
let selectedProjectName = "scratchpad"; // updated once the projects_list arrives

/** Collapsed project sections in the sidebar, persisted via localStorage. */
const collapsedProjects = new Set(
  JSON.parse(localStorage.getItem("pirouette-collapsed-projects") || "[]"),
);

/** Whether archived chats are shown in the sidebar. Archived chats are
 *  hidden by default; toggled via the "show archived" button. Persisted. */
let showArchived = localStorage.getItem("pirouette-show-archived") === "1";

/** @type {Record<string, import("./transcript.js").TranscriptState>} */
const transcriptByAgent = {};
/** @type {Record<string, boolean>} */
const historyLoaded = {};
/** Cached live stats per agent (pi footer data). @type {Record<string, object>} */
const statsByAgent = {};

/** Global "show raw markdown" toggle. When true, every assistant message
 *  renders as plain escaped source instead of rendered HTML. Persisted
 *  across reloads via localStorage `pirouette-raw-view`. */
let rawView = localStorage.getItem("pirouette-raw-view") === "1";

/** Latest global fast-mode badge state from the server's `fast_mode` WS
 *  envelope (mirrored from pi-cas-provider's `pi:fast-mode` channel), or
 *  null if no fast-mode-capable provider has reported in. Provider-wide,
 *  so it's a single global value rather than per-agent.
 *  @type {{intent: boolean, actual?: "on"|"off"|"cooldown", model?: string} | null} */
let fastModeState = null;

/** How to deliver the next message when the agent is currently streaming.
 *  "steer" = interrupt (pi's TUI default). "followUp" = queue for after
 *  the current turn ends. The toggle button only shows while streaming. */
let sendMode = /** @type {"steer" | "followUp"} */ (
  localStorage.getItem("pirouette-send-mode") === "followUp" ? "followUp" : "steer"
);
/** Tracks which tool-call / result blocks are expanded. */
const expandedItems = new Set();
/** @type {Record<string, {tool: string, subtitle?: string, since: number}>} */
const currentActivity = {};
let activityTimer = null;

let ws = null;
let reconnectTimer = null;
// Theme state is owned by localStorage (`pirouette-theme-{light,dark,mode}`)
// and applied as a class on <html>. The FOUC-preventing inline script in
// index.html sets the initial class before this module loads; we only need
// to re-apply on user action or OS-preference change.

// --- elements ---

const $agentList = document.getElementById("agent-list");
const $agentName = document.getElementById("agent-name");
const $agentTitle = document.getElementById("agent-title");
const $agentStatus = document.getElementById("agent-status");
// v0.13.8: identity (left) + tokens+model (right) live on a single
// footer row. The earlier #agent-model-line is gone; renderAgentHeader
// concatenates the stats string and the model string into
// #agent-stats-line directly.
const $agentInfo = document.getElementById("agent-info-line");
const $agentStats = document.getElementById("agent-stats-line");
const $messages = document.getElementById("messages");
const $input = document.getElementById("message-input");
const $sendBtn = document.getElementById("send-btn");
const $sendModeBtn = document.getElementById("send-mode-btn");
const $queueStrip = document.getElementById("queue-strip");
const $attachmentStrip = document.getElementById("attachment-strip");
const $newProjectBtn = document.getElementById("new-project-btn");
const $projModal = document.getElementById("new-project-modal");
const $projModalName = document.getElementById("proj-modal-name");
const $projModalRepo = document.getElementById("proj-modal-repo");
const $projModalCancel = document.getElementById("proj-modal-cancel");
const $projModalCreate = document.getElementById("proj-modal-create");
const $themeBtn = document.getElementById("theme-btn");
const $themePicker = document.getElementById("theme-picker");
const $themeSearch = document.getElementById("theme-search");
const $themeReset = document.getElementById("theme-reset");
const $themeList = document.getElementById("theme-list");
const $stopBtn = document.getElementById("agent-stop-btn");
const $resumeBtn = document.getElementById("agent-resume-btn");
const $deleteBtn = document.getElementById("agent-delete-btn");
const $forkBtn = document.getElementById("agent-fork-btn");
const $rawBtn = document.getElementById("agent-raw-btn");
const $vimLabel = document.getElementById("vim-mode-label");
const $vimToggle = document.getElementById("vim-toggle-btn");
const $fastModeBadge = document.getElementById("fast-mode-badge");
const $mentionPopup = document.getElementById("mention-popup");
const $slashPopup = document.getElementById("slash-popup");
const $modelBtn = document.getElementById("agent-model-btn");
const $modelPicker = document.getElementById("model-picker");
const $modelSearch = document.getElementById("model-search");
const $modelList = document.getElementById("model-list");
const $thinkingBtn = document.getElementById("agent-thinking-btn");
const $thinkingPicker = document.getElementById("thinking-picker");
const $thinkingList = document.getElementById("thinking-list");

// --- extension UI modal (AskUserQuestion etc.) ---
//
// Routed from server-side ExtensionUIContext primitives over WS. See
// src/server/pirouette-ui-context.ts and the extension_ui_request case
// in handleWsMessage(). One modal at a time, per-agent queue.
const $extUiModal = document.getElementById("extension-ui-modal");
const $extUiTitle = document.getElementById("ext-ui-title");
const $extUiAgentLabel = document.getElementById("ext-ui-agent-label");
const $extUiMessage = document.getElementById("ext-ui-message");
const $extUiBody = document.getElementById("ext-ui-body");
const $extUiCancel = document.getElementById("ext-ui-cancel");
const $extUiSubmit = document.getElementById("ext-ui-submit");

// --- vim mode ---
//
// VimMode is a small modal-editing layer that wraps the textarea. When
// enabled it captures keydown events before the host's keydown handler so
// it can claim hjkl / w / e / etc. in normal mode. When disabled (default)
// it's a no-op and the textarea behaves as a normal browser input.
//
// We hook it up here at module scope so the rest of `sendMessage` /
// `closeMentionPopup` can reach into it via the `vim` reference.
const vim = new VimMode($input, {
  onModeChange: (mode, pending) => {
    // v0.13.7: dropped the `-- ... --` dashes (pi-cli style is just
    // `INSERT` / `NORMAL` / `VISUAL` uppercase). When vim is off the
    // label is empty; the host element sits on the input bar's top
    // border line and the bg-cutout effect just disappears.
    if (!vim.isEnabled()) {
      $vimLabel.textContent = "";
      return;
    }
    let label = "INSERT";
    let color = "text-base16-pink";
    if (mode === "normal") {
      label = "NORMAL";
      color = "text-base16-cyan";
    } else if (mode === "visual") {
      label = "VISUAL";
      color = "text-base16-purple";
    } else if (mode === "visual_line") {
      label = "VISUAL LINE";
      color = "text-base16-purple";
    } else if (mode === "insert") {
      label = "INSERT";
      color = "text-base16-pink";
    }
    if (pending) label = `${label} [${pending}]`;
    $vimLabel.textContent = label;
    $vimLabel.className = `text-[10px] font-mono ${color}`;
  },
  onEnter: () => {
    // Insert-mode Enter — send if there's text. Returning true tells
    // VimMode to preventDefault, which also stops the existing app.js
    // keydown handler (which would call sendMessage again).
    sendMessage();
    return true;
  },
  shouldSkip: () =>
    !$mentionPopup.classList.contains("hidden") || !$slashPopup.classList.contains("hidden"),
});

/** Paint the fast-mode badge (↯) from `fastModeState`, mirroring pi-vim's
 *  glyph + color logic so both surfaces agree on intent vs. ground truth:
 *
 *    intent off                  → no glyph (hidden)
 *    intent on, actual "on"       → warning (engaged — premium pricing active)
 *    intent on, actual "off"      → dim     (API ran standard — no premium charge)
 *    intent on, actual "cooldown" → error   (extra-usage pool depleted)
 *    intent on, actual unknown    → muted   (requested, no turn yet)
 *
 *  Global (provider-wide), so it's independent of the selected agent. */
function renderFastModeBadge() {
  if (!$fastModeBadge) return;
  const st = fastModeState;
  if (!st || !st.intent) {
    $fastModeBadge.classList.add("hidden");
    $fastModeBadge.textContent = "";
    $fastModeBadge.removeAttribute("title");
    return;
  }
  let color;
  let title;
  switch (st.actual) {
    case "on":
      color = "text-base16-yellow";
      title = "Fast mode engaged — premium pricing active";
      break;
    case "off":
      color = "text-base16-500";
      title = "Fast mode requested, but the API ran standard (no premium charge)";
      break;
    case "cooldown":
      color = "text-base16-red";
      title = "Fast mode on cooldown — extra-usage pool depleted";
      break;
    default:
      color = "text-base16-600";
      title = "Fast mode requested — awaiting next turn";
  }
  $fastModeBadge.className = `text-[10px] font-mono ${color}`;
  $fastModeBadge.textContent = "\u21af";
  $fastModeBadge.title = st.model ? `${title} (${st.model})` : title;
}

function applyVimToggleStyle() {
  const on = vim.isEnabled();
  $vimToggle.textContent = `vim: ${on ? "on" : "off"}`;
  $vimToggle.className = on
    ? "px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer bg-base16-blue/20 text-base16-blue"
    : "px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer text-base16-500 hover:text-base16-700";
}

function setVimEnabled(enabled) {
  if (enabled) vim.enable();
  else vim.disable();
  localStorage.setItem("pirouette-vim-mode", enabled ? "1" : "0");
  applyVimToggleStyle();
}

$vimToggle.addEventListener("click", () => setVimEnabled(!vim.isEnabled()));

// Restore preference on load. Default off so first-time users get a
// vanilla textarea. On narrow viewports (phones) we ignore a saved-on
// preference and force vim off — the modal editor is actively hostile on
// touch keyboards (no Esc, no easy modifiers, hjkl tiny). The user can
// still re-enable explicitly via the vim toggle button if they want.
function isMobileViewport() {
  return window.matchMedia("(max-width: 767.98px)").matches;
}

// --- browser notifications ---
//
// Standard Notification API (NOT Web Push). Fires while the dashboard
// tab is open (foreground or background). Doesn't fire when the tab is
// closed or the browser is killed — that requires Web Push + a service
// worker + server-side push delivery, which is its own project.
//
// Trigger: agent transitions from a running-ish state to `waiting_input`
// (the agent has produced its response and is waiting for you), OR to
// `error`. We don't fire if the tab is currently visible AND focused
// because the user can already see what's happening.
//
// Mobile note: iOS Safari only delivers notifications when the page is
// added to the home screen as a PWA. In a regular Safari tab the API
// exists but doesn't reliably fire. Android Chrome works in regular
// tabs.
const NOTIFY_PREF_KEY = "pirouette-notifications";
const $notifyBtn = document.getElementById("notify-btn");

function notificationsAvailable() {
  return typeof window !== "undefined" && "Notification" in window;
}

function notificationsEnabled() {
  return (
    notificationsAvailable() &&
    Notification.permission === "granted" &&
    localStorage.getItem(NOTIFY_PREF_KEY) === "1"
  );
}

function applyNotifyToggleStyle() {
  // Single-word label ("notify") with state expressed through color
  // and the title attribute. The earlier multi-word "notify: off" /
  // "notify: blocked" labels varied enough in width that, combined with
  // "pirouette" + "theme" in the same row, the group could overflow the
  // 256-px sidebar. Matches the pattern of the `raw` action pill.
  $notifyBtn.textContent = "notify";

  // Reset state classes each time — simpler than tracking what was
  // previously applied. We toggle between three visual states: blue
  // (enabled), red (blocked at browser level), default-gray (off).
  $notifyBtn.classList.remove(
    "bg-base16-blue/20", "text-base16-blue",
    "bg-base16-red/20", "text-base16-red",
    "bg-base16-300/40", "text-base16-500",
    "opacity-50", "cursor-not-allowed",
  );

  if (!notificationsAvailable()) {
    $notifyBtn.title = "Notification API not supported in this browser";
    $notifyBtn.classList.add("bg-base16-300/40", "text-base16-500", "opacity-50", "cursor-not-allowed");
    $notifyBtn.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    $notifyBtn.title =
      "Browser blocked notifications. Re-enable in your browser settings, then click again.";
    $notifyBtn.classList.add("bg-base16-red/20", "text-base16-red");
    return;
  }
  const enabled = notificationsEnabled();
  $notifyBtn.title = enabled
    ? "Notifications enabled. Click to disable."
    : "Click to enable browser notifications when an agent finishes its turn.";
  if (enabled) {
    $notifyBtn.classList.add("bg-base16-blue/20", "text-base16-blue");
  } else {
    $notifyBtn.classList.add("bg-base16-300/40", "text-base16-500");
  }
}

async function toggleNotifications() {
  if (!notificationsAvailable()) return;
  if (Notification.permission === "denied") {
    // Browsers don't show the prompt again once denied — user must clear
    // the site setting in browser preferences. Tell them.
    alert(
      "Notifications were blocked for this site. To enable, open your browser's site settings for this URL and reset the notification permission.",
    );
    return;
  }
  const currentlyEnabled = notificationsEnabled();
  if (currentlyEnabled) {
    localStorage.setItem(NOTIFY_PREF_KEY, "0");
    applyNotifyToggleStyle();
    return;
  }
  // Not enabled yet — either need permission or already have it.
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      applyNotifyToggleStyle();
      return;
    }
  }
  localStorage.setItem(NOTIFY_PREF_KEY, "1");
  applyNotifyToggleStyle();
  // Confirm-fire so the user can see what notifications will look like.
  try {
    const n = new Notification("pirouette notifications enabled", {
      body: "You'll get a ping when an agent finishes its turn.",
      tag: "pirouette-test",
    });
    setTimeout(() => n.close(), 3000);
  } catch {
    /* some platforms throw if not in a secure context, etc. */
  }
}

$notifyBtn.addEventListener("click", toggleNotifications);
applyNotifyToggleStyle();

/** Decide whether to suppress a notification. We don't notify if the
 *  user is actively viewing the dashboard — they can already see what
 *  happened. "Actively viewing" means tab is visible AND window has
 *  focus (a backgrounded-but-focused tab still counts as "watching"
 *  because the user could be looking at the OS notifications instead). */
function shouldFireNotification() {
  if (!notificationsEnabled()) return false;
  if (document.visibilityState === "visible" && document.hasFocus()) return false;
  return true;
}

// --- extension UI requests (AskUserQuestion bridge) ---
//
// Server pushes `extension_ui_request` envelopes when a pi extension
// (today: pi-cas-provider's AskUserQuestion handler) calls
// ctx.ui.select / .confirm / .input. We maintain a FIFO queue per
// agent, render the head of the queue for the currently-focused agent
// in a modal, and post back `extension_ui_response` (submit) or
// `extension_ui_cancel` (esc/close) over the same WS.
//
// Replay-on-reconnect: server re-broadcasts every still-open request
// when a WS connection joins, so a refresh recovers the modal.
// Multi-client / first-response-wins: server broadcasts
// `extension_ui_cancel { requestId }` once any tab answers, so the
// modal closes elsewhere via dropExtensionUIRequest().
const extUiQueueByAgent = Object.create(null);
let extUiActive = null; // { agentId, request } currently rendered, or null

function enqueueExtensionUIRequest(agentId, request) {
  const queue = (extUiQueueByAgent[agentId] ||= []);
  // De-dupe: replay-on-reconnect can deliver the same requestId twice
  // (once on initial connect, once if the server emits another broadcast
  // mid-session). Drop the dup.
  if (queue.some((r) => r.requestId === request.requestId)) return;
  if (extUiActive && extUiActive.request.requestId === request.requestId) return;
  queue.push(request);
  // Reflect "needs your attention" in the agent list. Cheap to call
  // here since renderAgentList re-reads state.
  renderAgentList();
  maybeShowNextExtensionUIRequest();
}

function dropExtensionUIRequest(agentId, requestId) {
  const queue = extUiQueueByAgent[agentId];
  if (queue) {
    extUiQueueByAgent[agentId] = queue.filter((r) => r.requestId !== requestId);
    if (extUiQueueByAgent[agentId].length === 0) delete extUiQueueByAgent[agentId];
  }
  if (extUiActive && extUiActive.request.requestId === requestId) {
    closeExtensionUIModal();
    maybeShowNextExtensionUIRequest();
  }
  renderAgentList();
}

function agentHasPendingExtensionUI(agentId) {
  if (extUiActive && extUiActive.agentId === agentId) return true;
  const queue = extUiQueueByAgent[agentId];
  return !!(queue && queue.length > 0);
}

function maybeShowNextExtensionUIRequest() {
  if (extUiActive) return;
  // Prefer the focused agent's queue; if it has nothing, take the head
  // of any agent's queue (avoids stranding requests forever when the
  // user is focused on a different agent).
  let pickAgent = null;
  let request = null;
  if (selectedAgentId && extUiQueueByAgent[selectedAgentId]?.length) {
    pickAgent = selectedAgentId;
    request = extUiQueueByAgent[selectedAgentId][0];
  } else {
    for (const [agentId, queue] of Object.entries(extUiQueueByAgent)) {
      if (queue.length > 0) {
        pickAgent = agentId;
        request = queue[0];
        break;
      }
    }
  }
  if (!pickAgent || !request) return;
  // Pop the head — it's now "active". Cancel/submit handlers move on
  // to the next via the same maybeShowNext call.
  extUiQueueByAgent[pickAgent].shift();
  if (extUiQueueByAgent[pickAgent].length === 0) delete extUiQueueByAgent[pickAgent];
  // Pull focus to the asking agent so the user has context for the
  // question. selectAgent is async (fetches history); we fire and
  // forget — the modal renders independently.
  if (pickAgent !== selectedAgentId) void selectAgent(pickAgent);
  extUiActive = { agentId: pickAgent, request };
  renderExtensionUIModal();
}

function renderExtensionUIModal() {
  if (!extUiActive) return;
  const { agentId, request } = extUiActive;
  const agent = agents.find((a) => a.id === agentId);
  $extUiTitle.textContent = request.title || "question";
  $extUiAgentLabel.textContent = agent ? `agent: ${agent.name}` : `agent: ${agentId}`;
  $extUiBody.innerHTML = "";
  $extUiMessage.classList.add("hidden");

  let getValue;
  if (request.method === "select") {
    const multi = !!request.multi;
    const inputType = multi ? "checkbox" : "radio";
    const groupName = `ext-ui-opt-${request.requestId}`;
    (request.options ?? []).forEach((opt, i) => {
      const id = `${groupName}-${i}`;
      const wrap = document.createElement("label");
      wrap.className =
        "flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-base16-100 cursor-pointer";
      wrap.htmlFor = id;
      const input = document.createElement("input");
      input.type = inputType;
      input.name = groupName;
      input.value = opt.label;
      input.id = id;
      input.className = "mt-1";
      if (!multi && i === 0) input.checked = true;
      const text = document.createElement("div");
      text.className = "text-sm text-base16-700 flex-1 min-w-0";
      const label = document.createElement("div");
      label.textContent = opt.label;
      text.appendChild(label);
      if (opt.description) {
        const desc = document.createElement("div");
        desc.className = "text-[10px] text-base16-500 mt-0.5";
        desc.textContent = opt.description;
        text.appendChild(desc);
      }
      wrap.appendChild(input);
      wrap.appendChild(text);
      $extUiBody.appendChild(wrap);
    });
    getValue = () => {
      const inputs = $extUiBody.querySelectorAll(`input[name="${groupName}"]:checked`);
      if (multi) return [...inputs].map((el) => el.value);
      return inputs[0]?.value ?? null;
    };
  } else if (request.method === "confirm") {
    if (request.message) {
      $extUiMessage.textContent = request.message;
      $extUiMessage.classList.remove("hidden");
    }
    const groupName = `ext-ui-confirm-${request.requestId}`;
    for (const [label, val, defaultChecked] of [
      ["yes", true, true],
      ["no", false, false],
    ]) {
      const id = `${groupName}-${label}`;
      const wrap = document.createElement("label");
      wrap.className =
        "flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-base16-100 cursor-pointer";
      wrap.htmlFor = id;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = groupName;
      input.id = id;
      input.dataset.value = String(val);
      if (defaultChecked) input.checked = true;
      const text = document.createElement("span");
      text.className = "text-sm text-base16-700";
      text.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(text);
      $extUiBody.appendChild(wrap);
    }
    getValue = () => {
      const checked = $extUiBody.querySelector(`input[name="${groupName}"]:checked`);
      return checked ? checked.dataset.value === "true" : false;
    };
  } else if (request.method === "input") {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = request.placeholder ?? "";
    input.className =
      "w-full bg-base16-100 text-base16-700 border border-base16-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-base16-blue";
    $extUiBody.appendChild(input);
    getValue = () => input.value;
    // Focus the field once the modal is on screen.
    queueMicrotask(() => input.focus());
  } else {
    // Unknown method — close & cancel rather than risk a permanently
    // stuck modal.
    console.warn(`[ws] unknown extension UI method: ${request.method}`);
    sendExtensionUIDecision(false, null);
    return;
  }
  $extUiModal.classList.remove("hidden");
  if (request.method === "select" || request.method === "confirm") {
    // For pickers, focus the modal container so Enter / Esc keys work
    // even before the user clicks an option.
    queueMicrotask(() => $extUiSubmit.focus());
  }

  // Wire single-shot handlers; replace on every render so stale state
  // from a previous request can't fire.
  $extUiSubmit.onclick = () => sendExtensionUIDecision(true, getValue());
  $extUiCancel.onclick = () => sendExtensionUIDecision(false, null);
}

function sendExtensionUIDecision(submit, value) {
  if (!extUiActive) return;
  const { agentId, request } = extUiActive;
  if (submit) {
    // Reject obvious "no choice" cases (e.g. select with nothing
    // checked) by routing them through cancel — keeps the server's
    // contract clean.
    const empty =
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0);
    if (empty && request.method === "select") {
      submit = false;
    }
  }
  const envelope = submit
    ? {
        kind: "extension_ui_response",
        agentId,
        requestId: request.requestId,
        value,
      }
    : { kind: "extension_ui_cancel", agentId, requestId: request.requestId };
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    } else {
      console.warn("[ws] cannot send extension UI decision: socket closed");
    }
  } catch (err) {
    console.error("[ws] failed to send extension UI decision", err);
  }
  closeExtensionUIModal();
  // The server will broadcast its own extension_ui_cancel in response,
  // which is a no-op when the modal's already closed. Move on to the
  // next queued request, if any.
  maybeShowNextExtensionUIRequest();
}

function closeExtensionUIModal() {
  extUiActive = null;
  $extUiModal.classList.add("hidden");
  $extUiSubmit.onclick = null;
  $extUiCancel.onclick = null;
  $extUiBody.innerHTML = "";
  $extUiMessage.classList.add("hidden");
}

// Esc / Enter inside the modal. Capture-phase so it beats the editor's
// own keydown wiring.
document.addEventListener(
  "keydown",
  (e) => {
    if ($extUiModal.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      sendExtensionUIDecision(false, null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      // Enter submits unless the focus is inside a text input that
      // wants a real newline — but our input flavor uses a single-line
      // <input>, where Enter naturally submits the form. Safe to
      // intercept.
      e.preventDefault();
      $extUiSubmit.click();
    }
  },
  true,
);

function maybeNotifyStateChange(agent, prevState, newState) {
  // Only the meaningful transitions. Filter out boot/startup runs of
  // "running" -> "waiting_input" that happen before we have a prevState
  // (e.g. on first-load WS replay).
  if (!prevState) return;
  if (prevState === newState) return;

  let title = null;
  let body = null;
  if (newState === "waiting_input") {
    title = `${agent.name} — your turn`;
    body = "Agent finished its turn and is waiting for input.";
  } else if (newState === "error") {
    title = `${agent.name} — error`;
    body = agent.errorMessage || "Agent hit an error. Open the dashboard to see details.";
  }
  if (!title) return;
  if (!shouldFireNotification()) return;

  try {
    const n = new Notification(title, {
      body,
      tag: `pirouette-agent-${agent.id}`, // collapses repeated notifs for the same agent
    });
    n.onclick = () => {
      window.focus();
      selectAgent(agent.id);
      n.close();
    };
  } catch {
    /* ignore — notifications can fail in non-secure contexts, etc. */
  }
}
if (localStorage.getItem("pirouette-vim-mode") === "1" && !isMobileViewport()) {
  setVimEnabled(true);
} else {
  applyVimToggleStyle();
}

// --- mobile sidebar drawer ---
//
// v0.13.0 dropped the desktop left sidebar in favor of a footer below the
// input bar. v0.13.10 brings back *mobile* drawers: below the `md`
// breakpoint, #agent-footer slides in from the left (hamburger button
// at the bottom-left of the screen) and #header-actions slides in from
// the right (kebab button in the header). Above `md` everything stays
// inline and the toggle buttons + backdrop are hidden via CSS.
//
// `closeSidebar()` / `openSidebar()` are called from a handful of
// places (selectAgent, resize handler) and now close/open the LEFT
// drawer. The right drawer has its own toggle path. The shared
// #mobile-backdrop dims the page and closes whichever drawer is open
// on tap.
const $mobileMenuBtn = document.getElementById("mobile-menu-btn");
const $mobileActionsBtn = document.getElementById("mobile-actions-btn");
const $mobileBackdrop = document.getElementById("mobile-backdrop");
const $headerActions = document.getElementById("header-actions");
const $agentFooter = document.getElementById("agent-footer");
// The left chat sidebar is the element that slides in as a drawer on
// mobile. On desktop it's a persistent column (CSS handles that).
const $chatSidebar = document.getElementById("chat-sidebar");
// Aliases kept for legacy call-sites:
const $sidebar = $chatSidebar;
const $sidebarBackdrop = $mobileBackdrop;
const $sidebarToggle = $mobileMenuBtn;
function _setBackdrop() {
  if (!$mobileBackdrop) return;
  const anyOpen =
    ($chatSidebar && $chatSidebar.classList.contains("drawer-open")) ||
    ($headerActions && $headerActions.classList.contains("drawer-open"));
  $mobileBackdrop.classList.toggle("hidden", !anyOpen);
}
function openSidebar() {
  if ($chatSidebar) $chatSidebar.classList.add("drawer-open");
  // Mutual exclusion: opening the left drawer closes the right one.
  if ($headerActions) $headerActions.classList.remove("drawer-open");
  _setBackdrop();
}
function closeSidebar() {
  if ($chatSidebar) $chatSidebar.classList.remove("drawer-open");
  _setBackdrop();
}
function openActionsDrawer() {
  if ($headerActions) $headerActions.classList.add("drawer-open");
  if ($chatSidebar) $chatSidebar.classList.remove("drawer-open");
  _setBackdrop();
}
function closeActionsDrawer() {
  if ($headerActions) $headerActions.classList.remove("drawer-open");
  _setBackdrop();
}
function closeAllDrawers() {
  closeSidebar();
  closeActionsDrawer();
  closeAllPickers();
}
// v0.13.13: pickers (model / thinking / theme) become bottom-sheet
// modals on mobile. Dismissing the backdrop or pressing Esc should
// close any open picker too. Implementations close-safely if the
// picker functions aren't hoisted yet (they're declared further
// down in the file).
function closeAllPickers() {
  if ($modelPicker && !$modelPicker.classList.contains("hidden")) {
    $modelPicker.classList.add("hidden");
  }
  if ($thinkingPicker && !$thinkingPicker.classList.contains("hidden")) {
    $thinkingPicker.classList.add("hidden");
  }
  if ($themePicker && !$themePicker.classList.contains("hidden")) {
    $themePicker.classList.add("hidden");
  }
}
if ($mobileMenuBtn) {
  $mobileMenuBtn.addEventListener("click", () => {
    if ($chatSidebar && $chatSidebar.classList.contains("drawer-open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });
}
if ($mobileActionsBtn) {
  $mobileActionsBtn.addEventListener("click", () => {
    if ($headerActions && $headerActions.classList.contains("drawer-open")) {
      closeActionsDrawer();
    } else {
      openActionsDrawer();
    }
  });
}
if ($mobileBackdrop) {
  $mobileBackdrop.addEventListener("click", closeAllDrawers);
}
// Esc closes any open drawer.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllDrawers();
});
window.addEventListener("resize", () => {
  updateInputPlaceholder();
});

// --- pi-md ResizeObserver ---
//
// Pi-tui's markdown renderer pre-wraps lines at a column width that
// we measure from the bubble width. When that width changes (window
// resize, sidebar opening/closing, orientation flip), the box-drawing
// tables and wrapped paragraphs need to be re-rendered against the
// new width or they'll either look truncated or have ragged trailing
// space.
//
// We observe `#messages` (the container that owns the bubble width)
// and trigger a full `renderMessages()` only when the COLUMN COUNT
// actually changes -- most resize events on the window don't change
// the column count by a meaningful amount (pixel-level jitter from
// scrollbar appearing/disappearing, etc).
const _piMdResizeObserver = new ResizeObserver(() => {
  // Skip the very first tick (the observer fires once on attach with
  // the initial size; renderMessages will already have used that
  // width via its own measureBubbleWidthCols call).
  const cols = measureBubbleWidthCols();
  if (_lastRenderWidthCols !== null && cols === _lastRenderWidthCols) return;
  _lastRenderWidthCols = cols;
  // Skip when there's nothing useful to render.
  if (!selectedAgentId) return;
  renderMessages();
});
_piMdResizeObserver.observe($messages);

// --- model picker ---
//
// Click `model ▾` in the agent header → popup with all available models
// (sorted by provider). Click an entry to switch this agent. The change
// persists on the agent config (so resumes pick it up) and reconfigures
// the live session via pi's `setModel()` if it's running.

/** @type {{ qualifiedId: string, provider: string, id: string, contextWindow: number, reasoning: boolean }[]} */
let modelList = [];
let modelPickerCurrent = "";

async function fetchModels() {
  if (!selectedAgentId) return;
  try {
    const res = await fetch(`/api/agents/${selectedAgentId}/models`);
    if (!res.ok) return;
    const data = await res.json();
    modelList = Array.isArray(data.models) ? data.models : [];
    modelPickerCurrent = data.current || "";
  } catch (err) {
    console.error("failed to fetch models:", err);
  }
}

function renderModelList(filter = "") {
  const f = filter.toLowerCase();
  const matches = modelList.filter((m) => m.qualifiedId.toLowerCase().includes(f));
  if (matches.length === 0) {
    $modelList.innerHTML =
      '<div class="px-3 py-2 text-xs italic text-base16-500">no matches</div>';
    return;
  }
  // Group by provider so the dropdown is easier to scan.
  /** @type {Record<string, typeof matches>} */
  const grouped = {};
  for (const m of matches) {
    if (!grouped[m.provider]) grouped[m.provider] = [];
    grouped[m.provider].push(m);
  }
  let html = "";
  for (const provider of Object.keys(grouped).sort()) {
    html += `<div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-bold text-base16-500">${escHtml(provider)}</div>`;
    for (const m of grouped[provider]) {
      const isCurrent = m.qualifiedId === modelPickerCurrent;
      const reasoning = m.reasoning ? ' <span class="text-[9px] text-base16-purple ml-1">reasoning</span>' : "";
      const ctx = m.contextWindow > 0 ? ` <span class="text-[9px] text-base16-500">${formatTokens(m.contextWindow)}</span>` : "";
      const checkmark = isCurrent ? '<span class="text-base16-green mr-1">✓</span>' : '<span class="mr-1"> </span>';
      const activeClass = isCurrent
        ? "bg-base16-green/10 text-base16-700"
        : "hover:bg-base16-200 text-base16-600";
      html += `
        <button
          class="w-full text-left px-3 py-1.5 text-sm font-mono cursor-pointer ${activeClass}"
          data-model-id="${escHtml(m.qualifiedId)}"
        >${checkmark}${escHtml(m.id)}${ctx}${reasoning}</button>`;
    }
  }
  $modelList.innerHTML = html;
}

function openModelPicker() {
  if (!selectedAgentId) return;
  $modelPicker.classList.remove("hidden");
  $modelSearch.value = "";
  renderModelList();
  // Lazy fetch / refresh — list might be empty on first open or stale
  // after the agent's resolved model changed.
  void fetchModels().then(() => renderModelList($modelSearch.value));
  setTimeout(() => $modelSearch.focus(), 0);
}
function closeModelPicker() {
  $modelPicker.classList.add("hidden");
}

$modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if ($modelPicker.classList.contains("hidden")) openModelPicker();
  else closeModelPicker();
});
$modelSearch.addEventListener("input", () => renderModelList($modelSearch.value));
$modelList.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-model-id]");
  if (!target) return;
  const qualifiedId = target.getAttribute("data-model-id");
  if (!qualifiedId || !selectedAgentId) return;
  closeModelPicker();
  try {
    const res = await fetch(`/api/agents/${selectedAgentId}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: qualifiedId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Failed to set model: ${data.error || res.statusText}`);
    }
    // The server broadcasts a state_change so the header re-renders.
  } catch (err) {
    alert(`Failed to set model: ${err}`);
  }
});
// Click outside the picker to close.
document.addEventListener("click", (e) => {
  if (
    !$modelPicker.classList.contains("hidden") &&
    !$modelPicker.contains(e.target) &&
    e.target !== $modelBtn
  ) {
    closeModelPicker();
  }
  if (
    !$thinkingPicker.classList.contains("hidden") &&
    !$thinkingPicker.contains(e.target) &&
    e.target !== $thinkingBtn
  ) {
    closeThinkingPicker();
  }
});

// --- thinking-level picker ---
//
// Mirror of the model picker but for reasoning effort. Five fixed
// options. Click `thinking ▾` -> popup -> click a level. Server
// persists on agent config + reconfigures live session via pi's
// `setThinkingLevel()`. UI re-renders via the broadcast state-change.

const THINKING_LEVELS = /** @type {const} */ (["off", "minimal", "low", "medium", "high", "xhigh"]);

function renderThinkingList() {
  // `agents` is a flat array (not a map) -- mirroring how every other
  // dashboard handler looks up the current agent. Earlier draft mistakenly
  // referenced `agentsById`, which doesn't exist.
  const agent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;
  const current = (agent && agent.thinkingLevel) || "off";
  let html = "";
  for (const level of THINKING_LEVELS) {
    const isCurrent = level === current;
    const checkmark = isCurrent
      ? '<span class="text-base16-green mr-1">✓</span>'
      : '<span class="mr-1"> </span>';
    const activeClass = isCurrent
      ? "bg-base16-green/10 text-base16-700"
      : "hover:bg-base16-200 text-base16-600";
    html += `
      <button
        class="w-full text-left px-3 py-1.5 text-sm font-mono cursor-pointer ${activeClass}"
        data-thinking-level="${level}"
      >${checkmark}${level}</button>`;
  }
  $thinkingList.innerHTML = html;
}

function openThinkingPicker() {
  if (!selectedAgentId) return;
  $thinkingPicker.classList.remove("hidden");
  renderThinkingList();
}
function closeThinkingPicker() {
  $thinkingPicker.classList.add("hidden");
}

$thinkingBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if ($thinkingPicker.classList.contains("hidden")) openThinkingPicker();
  else closeThinkingPicker();
});
$thinkingList.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-thinking-level]");
  if (!target) return;
  const level = target.getAttribute("data-thinking-level");
  if (!level || !selectedAgentId) return;
  closeThinkingPicker();
  try {
    const res = await fetch(`/api/agents/${selectedAgentId}/thinking-level`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Failed to set thinking level: ${data.error || res.statusText}`);
      return;
    }
    // Optimistically reflect the change in our cached agent state so the
    // header label updates immediately. The server's state_change broadcast
    // also triggers a re-render shortly after.
    const cached = agents.find((a) => a.id === selectedAgentId);
    if (cached) {
      cached.thinkingLevel = level;
      renderAgentHeader();
    }
  } catch (err) {
    alert(`Failed to set thinking level: ${err}`);
  }
});

// --- helpers ---

function stateFor(agentId) {
  if (!transcriptByAgent[agentId]) {
    transcriptByAgent[agentId] = initialTranscriptState();
  }
  return transcriptByAgent[agentId];
}

function maybeStartActivityTicker() {
  if (activityTimer) return;
  activityTimer = setInterval(() => {
    if (Object.keys(currentActivity).length === 0) {
      clearInterval(activityTimer);
      activityTimer = null;
      return;
    }
    renderAgentList();
    if (selectedAgentId && currentActivity[selectedAgentId]) {
      renderAgentHeader();
    }
  }, 1000);
}

async function fetchHistory(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/messages`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.messages)) {
      transcriptByAgent[agentId] = {
        messages: data.messages,
        streamingText: "",
        streamingThinking: "",
      };
      historyLoaded[agentId] = true;
      if (agentId === selectedAgentId) renderMessages();
    }
  } catch (err) {
    console.error("failed to fetch history:", err);
  }
}

/** Fetch the pi-style footer stats (tokens, context, cost, thinking) for
 *  an agent and re-render the header if it's the currently-selected one.
 *  No-op on stopped / errored agents (server returns null stats). */
async function fetchStats(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/stats`);
    if (!res.ok) return;
    const data = await res.json();
    statsByAgent[agentId] = data.stats;
    if (agentId === selectedAgentId) renderAgentHeader();
  } catch (err) {
    console.error("failed to fetch stats:", err);
  }
}

function persistCollapsed() {
  localStorage.setItem(
    "pirouette-collapsed-projects",
    JSON.stringify([...collapsedProjects]),
  );
}

// --- websocket ---

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  ws.onmessage = (evt) => handleWsMessage(JSON.parse(evt.data));
  ws.onclose = () => {
    reconnectTimer = setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();
}

function handleWsMessage(envelope) {
  switch (envelope.kind) {
    case "agents_list":
      agents = envelope.agents;
      renderAgentList();
      break;

    case "projects_list":
      projects = envelope.projects;
      // Default selection: keep whatever was selected if it still exists,
      // otherwise fall back to scratchpad.
      if (!projects.find((p) => p.name === selectedProjectName)) {
        selectedProjectName = projects[0]?.name ?? "scratchpad";
      }
      renderAgentList();
      break;

    case "project_created":
      projects.push(envelope.project);
      selectedProjectName = envelope.project.name;
      renderAgentList();
      break;

    case "project_removed":
      projects = projects.filter((p) => p.name !== envelope.projectName);
      if (selectedProjectName === envelope.projectName) {
        selectedProjectName = projects[0]?.name ?? "scratchpad";
      }
      renderAgentList();
      break;

    case "agent_created":
      agents.push(envelope.agent);
      renderAgentList();
      selectAgent(envelope.agent.id);
      break;

    case "agent_removed":
      agents = agents.filter((a) => a.id !== envelope.agentId);
      delete transcriptByAgent[envelope.agentId];
      delete currentActivity[envelope.agentId];
      delete statsByAgent[envelope.agentId];
      if (selectedAgentId === envelope.agentId) {
        selectedAgentId = null;
        renderAgentHeader();
        renderMessages();
      }
      renderAgentList();
      break;

    case "agent_updated": {
      // A metadata-only update (e.g. archive/unarchive). Merge the new
      // fields into the local agent record and re-render the list.
      const idx = agents.findIndex((a) => a.id === envelope.agentId);
      if (idx !== -1 && envelope.agent) {
        agents[idx] = { ...agents[idx], ...envelope.agent };
      }
      renderAgentList();
      if (selectedAgentId === envelope.agentId) renderAgentHeader();
      break;
    }

    case "agent_session_reset":
      // The server discarded this agent's session and started a fresh one
      // (in response to /new). Clear local transcript caches so the next
      // render shows the empty-state placeholder; tool-expansion state
      // for this agent's old keys also goes stale, so wipe it too.
      delete transcriptByAgent[envelope.agentId];
      delete currentActivity[envelope.agentId];
      historyLoaded[envelope.agentId] = true; // empty server history; skip refetch
      // expandedItems is keyed by `<agentId>:<idx>` style messageKeys, so
      // entries from the old session can stay — they just won't match any
      // new keys. Cheap enough to leave; no reason to scan-and-prune.
      if (selectedAgentId === envelope.agentId) renderMessages();
      break;

    case "agent_state_change": {
      const agent = agents.find((a) => a.id === envelope.agentId);
      const prevState = agent?.state;
      if (agent) {
        agent.state = envelope.state;
        renderAgentList();
        if (selectedAgentId === envelope.agentId) renderAgentHeader();
      }
      if (envelope.state === "idle" || envelope.state === "waiting_input") {
        historyLoaded[envelope.agentId] = false;
        if (selectedAgentId === envelope.agentId) {
          fetchHistory(envelope.agentId);
          fetchStats(envelope.agentId);
        }
        // First agent to come up: extension commands are now readable on
        // the server side. Refresh the manifest so the slash popup picks
        // up `/cas-fast`, `/cas-okta`, etc. Only when empty -- once we
        // have any commands, every running agent's runner has the same
        // set, so further state changes don't move the needle.
        if (commandsManifest.length === 0) void loadCommandsManifest();
      }
      // Browser notification: agent just transitioned from "running" (or
      // similar in-progress state) to "waiting_input" (turn complete).
      // Or to "error". The notify helper itself decides whether to fire
      // based on permission + visibility — see app.js notification block.
      if (agent) maybeNotifyStateChange(agent, prevState, envelope.state);
      break;
    }

    case "agent_event":
      handleAgentEvent(envelope.agentId, envelope.event);
      break;

    case "extension_ui_request":
      enqueueExtensionUIRequest(envelope.agentId, envelope.request);
      break;

    case "extension_ui_cancel":
      // Server told us this request is no longer active (another tab
      // answered, AbortSignal fired, or the agent was stopped). Drop it
      // from the queue and close the modal if it's the one on screen.
      dropExtensionUIRequest(envelope.agentId, envelope.requestId);
      break;

    case "extension_ui_notify":
      // Fire-and-forget toast from an extension. We don't have a toast
      // system yet — log to console for now so we don't drop the signal.
      console.log(
        `[extension:${envelope.agentId}] ${envelope.notifyType ?? "info"}: ${envelope.message}`,
      );
      break;

    case "extension_ui_status":
      // Per-agent persistent status (footer/header badge). Not yet
      // wired into a UI slot; logged so the data isn't lost during
      // development. TODO: surface in agent header.
      console.log(
        `[extension:${envelope.agentId}] status[${envelope.statusKey}]=${envelope.statusText ?? "(cleared)"}`,
      );
      break;

    case "fast_mode":
      // Global fast-mode badge state (pi-cas-provider's `pi:fast-mode`).
      // `state` may be null (no fast-mode provider has reported in).
      fastModeState = envelope.state;
      renderFastModeBadge();
      break;

    case "error":
      console.error("[server]", envelope.message);
      break;
  }
}

function handleAgentEvent(agentId, event) {
  const prev = stateFor(agentId);
  transcriptByAgent[agentId] = reduceEvent(prev, event);

  if (event.type === "tool_execution_start") {
    const desc = describeToolCall(event.toolName, event.args);
    currentActivity[agentId] = {
      tool: desc.header,
      subtitle: desc.subtitle,
      since: Date.now(),
    };
    maybeStartActivityTicker();
    renderAgentList();
    if (agentId === selectedAgentId) renderAgentHeader();
  } else if (event.type === "tool_execution_end") {
    delete currentActivity[agentId];
    renderAgentList();
    if (agentId === selectedAgentId) renderAgentHeader();
  } else if (event.type === "compaction_start") {
    // Mirror compaction into the header's activity strip so the user sees
    // "▶ compacting…" next to the agent name as well as the inline block.
    const reason = typeof event.reason === "string" ? event.reason : null;
    currentActivity[agentId] = {
      tool: "compact",
      subtitle: reason ? `(${reason})` : "",
      since: Date.now(),
    };
    maybeStartActivityTicker();
    renderAgentList();
    if (agentId === selectedAgentId) {
      renderAgentHeader();
      renderMessages();
    }
  } else if (event.type === "compaction_end") {
    // Drop the activity entry. The transcript already shows the result
    // line via the COMPACTION_KEY block. Pi has just rewritten the
    // session messages (replaced history with a summary) so refetch the
    // canonical history; otherwise our local transcript stays stale
    // until the next idle/waiting_input transition.
    delete currentActivity[agentId];
    renderAgentList();
    if (agentId === selectedAgentId) {
      renderAgentHeader();
      renderMessages();
      // The fetched history will arrive shortly and reconcile the
      // messages list. We leave `historyLoaded` at true so other code
      // paths don't double-fetch; fetchHistory itself overwrites the
      // cached transcript.
      void fetchHistory(agentId);
      void fetchStats(agentId);
    }
  }

  // Incremental path for text/thinking streaming: touch only the live bubble
  // instead of rebuilding the whole messages container. Falls back to a full
  // render if the element doesn't exist yet (first delta of a turn).
  //
  // Element IDs must match what transcript.js emits for streaming=true
  // messages: `streaming-body` (assistant) and `streaming-thinking-body` (thinking).
  if (event.type === "message_update" && event.updateType === "text_delta") {
    if (agentId === selectedAgentId) {
      updateStreamingElement(
        "streaming-body",
        transcriptByAgent[agentId].streamingText,
        "text",
      );
    }
  } else if (event.type === "message_update" && event.updateType === "thinking_delta") {
    if (agentId === selectedAgentId) {
      updateStreamingElement(
        "streaming-thinking-body",
        transcriptByAgent[agentId].streamingThinking,
        "thinking",
      );
    }
  } else {
    if (agentId === selectedAgentId) renderMessages();
  }
}

/** Update the contents of a live streaming bubble in place using
 *  append-only DOM mutations — we never call `innerHTML = ...` here.
 *  Instead we keep the existing text node + cursor span in the DOM and
 *  just insert new text right before the cursor. That avoids the flash
 *  caused by tearing down and rebuilding every child of the bubble on
 *  every delta (the previous implementation re-ran marked + DOMPurify +
 *  highlight.js per chunk).
 *
 *  Both `kind = "text"` and `kind = "thinking"` are now plain-text
 *  streaming. Markdown is applied once when `message_complete` swaps the
 *  streaming bubble for a finalized one (see transcript.js renderMessage
 *  for the streaming branch and the reconciler in renderMessages).
 *
 *  If the element doesn't exist yet (first delta of a turn), fall back
 *  to a single full render that creates it. */
function updateStreamingElement(elementId, text, kind) {
  const el = document.getElementById(elementId);
  if (!el) {
    renderMessages();
    return;
  }

  // Append-only fast path: the new full text is the previous text plus
  // some suffix. Insert just the suffix as a text node before the cursor
  // span. This is the common case during normal streaming.
  const last = el.__pirStreamText ?? "";
  if (text.startsWith(last) && text.length > last.length) {
    const suffix = text.slice(last.length);
    const cursorSpan = el.querySelector(".streaming-cursor, .animate-pulse");
    const node = document.createTextNode(suffix);
    if (cursorSpan) {
      el.insertBefore(node, cursorSpan);
    } else {
      el.appendChild(node);
    }
    el.__pirStreamText = text;
  } else if (text !== last) {
    // Replacement (e.g. server resent text out of order, or initial paint).
    // One-time rewrite is acceptable here — happens at most once per turn.
    const cursorClass =
      kind === "thinking"
        ? "animate-pulse text-base16-500 streaming-cursor"
        : "animate-pulse text-base16-green streaming-cursor";
    el.textContent = ""; // wipe, then rebuild
    el.appendChild(document.createTextNode(text));
    const cursor = document.createElement("span");
    cursor.className = cursorClass;
    cursor.textContent = "▊";
    el.appendChild(cursor);
    el.__pirStreamText = text;
  }

  if (kind === "thinking") {
    el.scrollTop = el.scrollHeight;
  }

  // Outer scroll follow: only if the user is already near the bottom of
  // the messages list. Avoids yanking scroll if they scrolled up to read.
  const $m = document.getElementById("messages");
  if ($m) {
    const nearBottom = $m.scrollHeight - $m.scrollTop - $m.clientHeight < 200;
    if (nearBottom) $m.scrollTop = $m.scrollHeight;
  }
}

// --- rendering ---

function statusColor(state) {
  switch (state) {
    case "running":
    case "cloning":
    case "starting":
      return "bg-base16-green";
    case "waiting_input":
      return "bg-base16-orange";
    case "idle":
      return "bg-base16-yellow";
    case "stopped":
    case "shutdown": // stopped by server shutdown; auto-resumes on restart
      return "bg-base16-400";
    case "error":
      return "bg-base16-red";
    default:
      return "bg-base16-300";
  }
}

function isActiveState(state) {
  return state === "running" || state === "cloning" || state === "starting";
}

/** Compact agent chip (pi-cli-style horizontal footer entry).
 *
 *  v0.13.0: redesigned from a full-width sidebar row into a small
 *  horizontal pill. Same `data-agent-id` so click handling stays the
 *  same. Shows: status dot + agent name. The forked-from / model /
 *  state info still surfaces via the button's `title` (hover) so we
 *  don't lose discoverability. Forks just stack inline like any other
 *  agent -- the visual indent tree only made sense in a vertical list. */
function renderAgentRow(a, _depth = 0) {
  const dot = isActiveState(a.state)
    ? `${statusColor(a.state)} pulse-dot`
    : statusColor(a.state);
  const activity = currentActivity[a.id];
  const stateLabel =
    a.state === "cloning" ? "cloning"
    : a.state === "error" ? `error: ${(a.errorMessage || "").slice(0, 40)}`
    // "shutdown" must win over any stale activity: an agent aborted
    // mid-tool won't emit tool_execution_end, so `activity` can linger
    // and otherwise show "▶ <tool>" instead of "restarting".
    : a.state === "shutdown" ? "restarting"
    : activity ? `▶ ${activity.tool}`
    : a.state === "waiting_input" ? "your turn"
    : a.state;
  const titleParts = [
    a.name,
    a.model || "default",
    `state: ${stateLabel}`,
    a.parentAgentId ? `forked from ${a.parentAgentId}` : null,
  ].filter(Boolean);
  const isActive = a.id === selectedAgentId;
  // Active state: very subtle colored tint + bold colored text.
  // Earlier `bg-base16-cyan/25` looked like a saturated sage-green
  // block on light themes (user said "too bright"). Pi-cli's
  // emphasis convention is mostly TYPOGRAPHY (color + weight) rather
  // than fills, so the active chip leans on the same: cyan bold
  // text + a small ~10% color wash that's just enough to mark the
  // chip as a selection without dominating the footer.
  const activeClass = isActive
    ? "bg-base16-cyan/10 text-base16-cyan font-semibold"
    : "text-base16-600 hover:bg-base16-300/40";
  // "?" glyph: an extension fired AskUserQuestion (or similar) for this
  // agent and is waiting for the user to answer. Pulses to draw the eye.
  const needsAnswer = agentHasPendingExtensionUI(a.id);
  // Vertical row: full-width, chat name on its own line, with an
  // archive/unarchive toggle that appears on hover. Archived chats are
  // dimmed so it's clear they're tucked away.
  const archiveLabel = a.archived ? "unarchive" : "archive";
  const archiveGlyph = a.archived ? "↩" : "✕";
  const dimClass = a.archived ? "opacity-50" : "";
  return `
    <div class="group flex items-center gap-1 rounded ${activeClass} ${dimClass}" data-agent-row="${a.id}">
      <button
        class="flex items-center gap-1.5 px-2 py-1 flex-1 min-w-0 cursor-pointer text-sm font-mono text-left"
        data-agent-id="${a.id}"
        title="${escHtml(titleParts.join(" — ") + (needsAnswer ? " — waiting on you" : ""))}"
      >
        <span class="w-2 h-2 rounded-full flex-none ${dot}"></span>
        ${a.parentAgentId ? '<span class="text-base16-500 text-xs flex-none">↳</span>' : ""}
        <span class="truncate">${escHtml(a.name)}</span>
        ${needsAnswer ? '<span class="text-base16-yellow text-xs pulse-dot flex-none">?</span>' : ""}
      </button>
      <button
        class="flex-none px-1.5 py-1 text-xs text-base16-500 hover:text-base16-orange cursor-pointer md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
        data-agent-archive="${a.id}"
        data-archived="${a.archived ? "1" : "0"}"
        title="${archiveLabel} this chat"
        aria-label="${archiveLabel} chat"
      >${archiveGlyph}</button>
    </div>
  `;
}

/** Build a depth-first ordering of agents grouped as parent → forked
 *  children, with depth annotations. Top-level (no parent) agents come
 *  first, sorted by name; each one is followed immediately by its
 *  children (also sorted by name), recursively. Cycles can't happen
 *  because pirouette never re-parents agents — `parentAgentId` is set
 *  once at fork time and never mutated. */
function orderAgentsAsTree(projectAgents) {
  const childrenOf = new Map();
  for (const a of projectAgents) {
    const key = a.parentAgentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(a);
  }
  for (const arr of childrenOf.values()) arr.sort((x, y) => x.name.localeCompare(y.name));
  const out = [];
  function walk(parentId, depth) {
    const kids = childrenOf.get(parentId) ?? [];
    for (const a of kids) {
      out.push({ agent: a, depth });
      walk(a.id, depth + 1);
    }
  }
  walk(null, 0);
  // Orphans (parent agent was deleted) — still render at root.
  const knownIds = new Set(projectAgents.map((a) => a.id));
  for (const a of projectAgents) {
    if (a.parentAgentId && !knownIds.has(a.parentAgentId) && !out.some((e) => e.agent === a)) {
      out.push({ agent: a, depth: 0 });
    }
  }
  return out;
}

function renderAgentList() {
  if (projects.length === 0) {
    $agentList.innerHTML =
      '<div class="text-base16-500 text-sm italic px-1 py-1.5">no projects yet</div>';
    return;
  }

  // Group agents by project. Projects with no agents still render so the
  // user can see them and click `@name` in the input to add one.
  const agentsByProject = new Map();
  for (const p of projects) agentsByProject.set(p.name, []);
  for (const a of agents) {
    if (!agentsByProject.has(a.projectName)) agentsByProject.set(a.projectName, []);
    agentsByProject.get(a.projectName).push(a);
  }

  // Vertical layout: each project is a section stacked top-to-bottom.
  // The project name header is a clickable "select project" affordance
  // (also a collapse toggle via the chevron); its chats are listed
  // vertically beneath it. Archived chats are hidden unless the global
  // `showArchived` toggle is on.
  const sections = projects
    .slice()
    .sort((a, b) => {
      // scratchpad always last; others alphabetical
      if (a.name === "scratchpad") return 1;
      if (b.name === "scratchpad") return -1;
      return a.name.localeCompare(b.name);
    })
    .map((p) => {
      const allAgents = (agentsByProject.get(p.name) ?? []);
      const archivedCount = allAgents.filter((a) => a.archived).length;
      // Filter archived chats out unless the toggle is on.
      const visible = allAgents.filter((a) => showArchived || !a.archived);
      const isSelected = selectedProjectName === p.name;
      const isCollapsed = collapsedProjects.has(p.name);
      const subtitle = p.repoUrl
        ? p.repoUrl.replace(/^https?:\/\//, "")
        : p.name === "scratchpad"
          ? "default (bare)"
          : "bare";
      const rowsHtml = visible.length > 0
        ? orderAgentsAsTree(visible)
            .map(({ agent }) => renderAgentRow(agent))
            .join("")
        : `<div class="text-xs text-base16-500 italic px-2 py-1">no chats — type <code class="text-base16-orange">@name</code></div>`;
      const delBtn =
        p.name === "scratchpad"
          ? ""
          : `<button class="flex-none text-base16-500 hover:text-base16-red text-xs cursor-pointer px-1" data-project-delete="${escHtml(p.name)}" title="delete project">×</button>`;
      const chevron = isCollapsed ? "▸" : "▾";
      const archivedNote =
        !showArchived && archivedCount > 0
          ? `<span class="text-[10px] text-base16-500 whitespace-nowrap">(${archivedCount} archived)</span>`
          : "";
      return `
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-1 px-1 py-1 rounded ${isSelected ? "bg-base16-cyan/8" : "hover:bg-base16-300/20"}">
            <button
              class="flex-none text-base16-500 hover:text-base16-700 text-xs cursor-pointer w-4"
              data-project-toggle="${escHtml(p.name)}"
              title="collapse/expand"
            >${chevron}</button>
            <button
              class="flex items-baseline gap-1.5 cursor-pointer flex-1 min-w-0 text-left"
              data-project-select="${escHtml(p.name)}"
              title="${escHtml(subtitle + " · " + visible.length + " chat" + (visible.length === 1 ? "" : "s"))}"
            >
              <span class="text-base16-700 font-bold font-mono text-sm truncate">${escHtml(p.name)}</span>
              ${archivedNote}
            </button>
            ${delBtn}
          </div>
          ${isCollapsed ? "" : `<div class="flex flex-col gap-0.5 pl-1">${rowsHtml}</div>`}
        </div>
      `;
    })
    .join("");

  $agentList.innerHTML = sections;

  $agentList.querySelectorAll("[data-agent-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectAgent(btn.dataset.agentId));
  });
  $agentList.querySelectorAll("[data-agent-archive]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.agentArchive;
      const nextArchived = btn.dataset.archived !== "1";
      setAgentArchived(id, nextArchived);
    });
  });
  $agentList.querySelectorAll("[data-project-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleProjectCollapsed(btn.dataset.projectToggle);
    });
  });
  $agentList.querySelectorAll("[data-project-select]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectProject(btn.dataset.projectSelect);
    });
  });
  $agentList.querySelectorAll("[data-project-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProject(btn.dataset.projectDelete);
    });
  });
}

/** Toggle a chat's archived flag via the server. Optimistically updates
 *  the local record so the UI reacts immediately; the WS `agent_updated`
 *  broadcast keeps other tabs in sync. */
async function setAgentArchived(id, archived) {
  const agent = agents.find((a) => a.id === id);
  if (agent) agent.archived = archived;
  renderAgentList();
  try {
    const res = await fetch(`/api/agents/${id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to update archive state");
      // Revert optimistic change on failure.
      if (agent) agent.archived = !archived;
      renderAgentList();
    }
  } catch (err) {
    if (agent) agent.archived = !archived;
    renderAgentList();
    alert("Failed to update archive state: " + err.message);
  }
}

function toggleProjectCollapsed(name) {
  if (collapsedProjects.has(name)) collapsedProjects.delete(name);
  else collapsedProjects.add(name);
  persistCollapsed();
  renderAgentList();
}

function selectProject(name) {
  selectedProjectName = name;
  renderAgentList();
  updateInputPlaceholder();
}

/** Format token counts like pi's footer: 0–1k raw, 1–10k `1.2k`, 10k–999k
 *  `42k`, 1M+ `1.2M`. */
function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Left side of the pi-cli stats line: tokens + cost + context %.
 *  Same ordering / glyphs as pi's TUI footer:
 *    ↑input ↓output R<cacheRead> W<cacheWrite> $cost  <ctx%>/<ctxWindow>
 *  Context is omitted if we don't know the window; individual token parts
 *  are omitted when zero. The model + thinking-level used to live at the
 *  end of this line; v0.13.6 split them out to a separate right-aligned
 *  span (`formatModelLine`). */
/** Build the parts list for the stats line. v0.13.12: returns an array
 *  of small strings (one per logical group) so the renderer can emit
 *  them as separate `<span class="info-part">` elements. On desktop
 *  CSS joins them inline with `·` separators; on mobile (drawer) each
 *  part lands on its own line. */
function formatStatsParts(stats) {
  const parts = [];
  const t = stats.tokens;
  const toks = [];
  if (t.input) toks.push(`↑${formatTokens(t.input)}`);
  if (t.output) toks.push(`↓${formatTokens(t.output)}`);
  if (t.cacheRead) toks.push(`R${formatTokens(t.cacheRead)}`);
  if (t.cacheWrite) toks.push(`W${formatTokens(t.cacheWrite)}`);
  if (toks.length) parts.push(toks.join(" "));
  if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
  if (stats.contextWindow) {
    const pct = stats.contextPercent;
    const pctStr = pct == null ? "?" : `${pct.toFixed(1)}%`;
    parts.push(`${pctStr}/${formatTokens(stats.contextWindow)}`);
  }
  return parts;
}

/** Right-side parts: `(provider) model` and (optionally) `thinking: level`.
 *  Two items so the model id and reasoning effort land on different
 *  lines on mobile. */
function formatModelParts(stats) {
  if (!stats.model) return [];
  const provider = stats.model.provider ? `(${stats.model.provider}) ` : "";
  const name = stats.model.id || "";
  const modelStr = `${provider}${name}`;
  const out = [];
  if (modelStr) out.push(modelStr);
  if (
    stats.thinkingLevel &&
    stats.thinkingLevel !== "off" &&
    stats.model.reasoning
  ) {
    out.push(`thinking: ${stats.thinkingLevel}`);
  }
  return out;
}

/** Legacy string formatters (kept for tests + any plain-text fallback).
 *  Identical output to the pre-0.13.12 implementations. */
function formatStatsLine(stats) {
  return formatStatsParts(stats).join("  ");
}
function formatModelLine(stats) {
  return formatModelParts(stats).join(" · ");
}

/** Render a list of strings as `<span class="info-part">` elements.
 *  Used for the identity line and the stats+model line. The `info-part`
 *  CSS handles inline-vs-block layout and the dot separator. */
function renderInfoParts(parts) {
  return parts
    .filter((p) => p != null && p !== "")
    .map((p) => `<span class="info-part">${escHtml(String(p))}</span>`)
    .join("");
}

/** Matches pi's color bands: error > 90%, warning > 70%, neutral otherwise. */
function statsColorClass(pct) {
  if (pct == null) return "text-base16-500";
  if (pct > 90) return "text-base16-red";
  if (pct > 70) return "text-base16-orange";
  return "text-base16-500";
}

function renderAgentHeader() {
  const agent = agents.find((a) => a.id === selectedAgentId);
  // v0.13.8: agent name + status hidden in the header. $agentName /
  // $agentStatus DOM nodes still exist (display: hidden) so existing
  // code that touches their textContent stays a no-op rather than a
  // crash; we just don't visually render the values anywhere.
  if (!agent) {
    if ($agentTitle) $agentTitle.textContent = "";
    $agentInfo.textContent = "";
    $agentStats.textContent = "";
    // Hide every action pill when no agent is selected.
    $stopBtn.classList.add("hidden");
    $resumeBtn.classList.add("hidden");
    $deleteBtn.classList.add("hidden");
    $rawBtn.classList.add("hidden");
    $forkBtn.classList.add("hidden");
    $modelBtn.classList.add("hidden");
    $thinkingBtn.classList.add("hidden");
    return;
  }

  // Header title: currently-selected chat name (with project).
  if ($agentTitle) $agentTitle.textContent = agent.name;

  // Re-show the always-applicable pills now that we have an agent.
  // (stop/resume/delete still toggle below based on agent state.)
  $rawBtn.classList.remove("hidden");
  $forkBtn.classList.remove("hidden");
  $modelBtn.classList.remove("hidden");
  $thinkingBtn.classList.remove("hidden");

  // Build the footer's left-side identity line: project · branch ·
  // worktree · thinking · id. Model lives on the right side (next
  // to the token stats) so it's intentionally omitted here.
  // v0.13.12: emitted as `<span class="info-part">` elements so CSS
  // can lay them out inline (desktop) or stacked (mobile drawer).
  const parts = [];
  parts.push(agent.projectName);
  if (agent.branchName) parts.push(agent.branchName);
  parts.push(shortenPath(agent.worktreePath));
  if (agent.thinkingLevel && agent.thinkingLevel !== "off") {
    parts.push(`thinking: ${agent.thinkingLevel}`);
  }
  if (agent.createdAt) parts.push(relTime(new Date(agent.createdAt).getTime()));
  parts.push(`id: ${agent.id}`);
  $agentInfo.innerHTML = renderInfoParts(parts);
  $agentInfo.title = `project: ${agent.projectName}\nworktree: ${agent.worktreePath}`;

  // Build the footer's right-side combined stats+model parts list.
  // v0.13.12: emitted as separate spans (one per logical group:
  // token counters, cost, context %, model, thinking) so they wrap
  // cleanly on mobile.
  const stats = statsByAgent[agent.id];
  let rightParts;
  if (stats) {
    rightParts = [...formatStatsParts(stats), ...formatModelParts(stats)];
    $agentStats.className = `truncate flex-none ${statsColorClass(stats.contextPercent)}`;
  } else {
    rightParts = agent.model ? [agent.model] : [];
    $agentStats.className = "text-base16-500 truncate flex-none";
  }
  $agentStats.innerHTML = renderInfoParts(rightParts);

  const running = agent.state !== "stopped" && agent.state !== "shutdown";
  $stopBtn.classList.toggle("hidden", !running);
  $resumeBtn.classList.toggle(
    "hidden",
    agent.state !== "stopped" && agent.state !== "shutdown" && agent.state !== "error",
  );
  $deleteBtn.classList.remove("hidden");

  // Send-mode toggle visibility tracks the agent's state. Done here (rather
  // than only on event arrival) so every header refresh keeps the input
  // bar in sync — e.g. switching to a streaming agent shows the toggle
  // immediately.
  renderSendModeButton();
}

// Sentinel keys for the placeholder "select an agent" / "no messages yet"
// states. Treated like normal blocks during reconciliation so they slot in
// without rebuilding the container.
const PLACEHOLDER_SELECT_KEY = "placeholder:select";
const PLACEHOLDER_EMPTY_KEY = "placeholder:empty";
const PLACEHOLDER_LOADING_KEY = "placeholder:loading";

// --- pi-md width measurement ---
//
// The pi-tui-style markdown renderer takes a character-column count
// and produces pre-wrapped text with literal box-drawing chars. To
// match the rendered output to the actual bubble width we measure
// the monospace character width once, then divide the bubble's
// inner pixel-width by it.
//
// The bubble is `max-w-[90%]` of the `#messages` container, minus
// the bubble's own px-4 padding (16 px each side). We probe by
// rendering a hidden `<pre class="pi-md">` with 80 `x` characters
// and reading getBoundingClientRect().
//
// Memoized; reset whenever theme/font changes (handled via the
// ResizeObserver triggering on the messages container, which fires
// on any layout-relevant change).
let _piMdCharWidthPx = null;
function piMdCharWidthPx() {
  if (_piMdCharWidthPx !== null) return _piMdCharWidthPx;
  const probe = document.createElement("pre");
  probe.className = "pi-md";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.whiteSpace = "pre";
  probe.textContent = "x".repeat(80);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 80;
  probe.remove();
  // Fallback when the font is still loading and the probe measured
  // a fallback font (often ~7.2px for 14px text). Keep going; the
  // ResizeObserver will rerender once the webfont swaps in and the
  // probe gives a different value next time.
  _piMdCharWidthPx = w > 0 ? w : 8;
  return _piMdCharWidthPx;
}

/** Char-capacity of the assistant bubble at the current width.
 *
 *  Bubble is `max-w-[90%]` of the messages column. Subtract the
 *  bubble's px-4 padding (16 px) on each side. Then divide by char
 *  width. Floor for safety.
 *
 *  Returns at least 20 (very narrow phones); cap at 200 so a huge
 *  desktop window doesn't force tables to draw extra-wide just
 *  because they can — pi's TUI gets clamped by the terminal so
 *  matching the typical 80–120 range feels right. */
function measureBubbleWidthCols() {
  const containerWidth = $messages.clientWidth;
  if (!containerWidth) return 80;
  const bubblePx = containerWidth * 0.9 - 16 * 2;
  const charPx = piMdCharWidthPx();
  if (charPx <= 0) return 80;
  const cols = Math.floor(bubblePx / charPx);
  return Math.min(200, Math.max(20, cols));
}

/** Last-rendered width-cols, so the ResizeObserver below can no-op
 *  on layout reshuffles that don't actually change the column count. */
let _lastRenderWidthCols = null;
const _tmpl = document.createElement("template");

function renderMessages() {
  // Build the desired list of blocks (key + html) for the current state.
  // Placeholders share the same shape so the diff loop below has a single
  // path — no special-cased innerHTML rewrites that would force a flash.
  let blocks;
  if (!selectedAgentId) {
    // v0.13.12: dropped the verbose "select an agent from the footer..."
    // placeholder. The chip strip / drawer is self-explanatory.
    blocks = [];
  } else {
    const state = stateFor(selectedAgentId);
    const isEmpty =
      state.messages.length === 0 && !state.streamingText && !state.streamingThinking;
    if (isEmpty) {
      // Distinguish two empty cases:
      //   - history is still being fetched -> "loading..." so the user
      //     gets immediate feedback that their tap landed (matters on
      //     mobile where REST roundtrips can be a few seconds);
      //   - history is loaded and genuinely empty -> the original
      //     "send one below" prompt.
      // historyLoaded[id] is set to true by fetchHistory on success and
      // by agent_session_reset for a freshly-emptied session.
      const loaded = !!historyLoaded[selectedAgentId];
      if (!loaded) {
        blocks = [{
          key: PLACEHOLDER_LOADING_KEY,
          html: '<div data-msg-key="placeholder:loading" class="text-base16-500 text-xs italic text-center mt-8">loading conversation…</div>',
        }];
      } else {
        blocks = [{
          key: PLACEHOLDER_EMPTY_KEY,
          html: '<div data-msg-key="placeholder:empty" class="text-base16-500 text-xs italic text-center mt-8">no messages yet — send one below</div>',
        }];
      }
    } else {
      // `agentId` enables `enhanceImagePaths` in transcript.js to
      // rewrite relative image refs in assistant markdown to
      // /api/agents/<id>/file?path=...
      //
      // `widthCols` is the current char-capacity of the assistant
      // bubble. Passing it triggers the pi-tui box-drawing renderer
      // (renderMarkdownPi) instead of the flow-layout marked HTML.
      // Width is re-measured on resize via the ResizeObserver below.
      const cols = measureBubbleWidthCols();
      _lastRenderWidthCols = cols;
      blocks = renderTranscriptBlocks(state, expandedItems, {
        rawAssistant: rawView,
        agentId: selectedAgentId,
        widthCols: cols,
      });
    }
  }

  // Snapshot scroll state before mutating. We auto-scroll to the new
  // bottom only if the user was already pinned there (within ~40px). This
  // keeps the view stable when they've scrolled up to read history while
  // the agent is still working.
  const wasNearBottom =
    $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 40;

  reconcileBlocks($messages, blocks);

  if (wasNearBottom) $messages.scrollTop = $messages.scrollHeight;

  // Refresh the queue strip + send-mode UI now that state has potentially
  // changed (queue_update events flow through reduceEvent into
  // transcriptByAgent[agentId].queue).
  renderQueueStrip();
  renderSendModeButton();
}

/** Render the steering/follow-up queue chips above the input bar. Mirrors
 *  pi's TUI which shows pending messages so the user knows what they've
 *  already enqueued during a streaming turn. Hidden entirely when both
 *  queues are empty so the input bar stays compact. */
function renderQueueStrip() {
  if (!selectedAgentId) {
    $queueStrip.classList.add("hidden");
    $queueStrip.innerHTML = "";
    return;
  }
  const state = stateFor(selectedAgentId);
  const q = state.queue ?? { steering: [], followUp: [] };
  if (q.steering.length === 0 && q.followUp.length === 0) {
    $queueStrip.classList.add("hidden");
    $queueStrip.innerHTML = "";
    return;
  }

  // Each chip shows the message head + a short label indicating whether
  // it'll interrupt (steer) or wait (followUp). Colors mirror the
  // send-button accent: blue for steer (interrupt is the active path),
  // muted for followUp (it's deferred).
  const chip = (text, kind) => {
    const color =
      kind === "steering"
        ? "bg-base16-blue/15 text-base16-blue border-base16-blue/30"
        : "bg-base16-300/40 text-base16-500 border-base16-300";
    const label = kind === "steering" ? "steer" : "follow-up";
    const head = text.length > 80 ? text.slice(0, 78) + "…" : text;
    return `
      <div class="text-[10px] font-mono px-2 py-0.5 rounded border ${color} flex items-baseline gap-1.5 max-w-md" title="${escHtml(text)}">
        <span class="opacity-60">${label}</span>
        <span class="truncate">${escHtml(head)}</span>
      </div>`;
  };
  const html =
    q.steering.map((m) => chip(m, "steering")).join("") +
    q.followUp.map((m) => chip(m, "followUp")).join("");
  $queueStrip.innerHTML = html;
  $queueStrip.classList.remove("hidden");
}

/** Show / hide / style the send-mode toggle. Visible only while the agent
 *  is actively streaming — if it's idle, sending starts a new turn and
 *  mode is moot. */
function renderSendModeButton() {
  const agent = agents.find((a) => a.id === selectedAgentId);
  const isStreaming = agent?.state === "running";
  if (!isStreaming) {
    $sendModeBtn.classList.add("hidden");
    return;
  }
  $sendModeBtn.classList.remove("hidden");
  $sendModeBtn.textContent = `mode: ${sendMode}`;
  // Steer is the "active" path (interrupt). Follow-up is the deferred path.
  $sendModeBtn.className =
    sendMode === "steer"
      ? "text-[10px] px-1 py-0.5 rounded text-base16-blue hover:bg-base16-blue/10 cursor-pointer font-mono whitespace-nowrap"
      : "text-[10px] px-1 py-0.5 rounded text-base16-500 hover:bg-base16-300/30 cursor-pointer font-mono whitespace-nowrap";
}

function toggleSendMode() {
  sendMode = sendMode === "steer" ? "followUp" : "steer";
  localStorage.setItem("pirouette-send-mode", sendMode);
  renderSendModeButton();
}

/** Diff `blocks` (array of {key, html}) against the children of `container`,
 *  reusing nodes whose html is unchanged and replacing/inserting only what
 *  actually moved. Each block's key matches the `data-msg-key` attribute on
 *  its top-level element. The previously-rendered html is cached on the
 *  node as `__pirHtml` for cheap equality checks across renders. */
function reconcileBlocks(container, blocks) {
  // Index existing children by key.
  const existing = new Map();
  for (const el of container.children) {
    const k = el.getAttribute("data-msg-key");
    if (k) existing.set(k, el);
  }

  const newKeys = new Set();
  let prev = null; // last placed node (we walk in order)
  for (const block of blocks) {
    newKeys.add(block.key);
    let node = existing.get(block.key);
    if (node) {
      // Reuse if html is unchanged. Otherwise replace the node entirely —
      // simpler than morphdom and good enough at this granularity.
      if (node.__pirHtml !== block.html) {
        _tmpl.innerHTML = block.html.trim();
        const fresh = _tmpl.content.firstElementChild;
        if (fresh) {
          fresh.__pirHtml = block.html;
          node.replaceWith(fresh);
          node = fresh;
        }
      }
    } else {
      _tmpl.innerHTML = block.html.trim();
      node = _tmpl.content.firstElementChild;
      if (!node) continue;
      node.__pirHtml = block.html;
      // Insert after `prev`, or at the start if this is the first block.
      if (prev) prev.after(node);
      else container.prepend(node);
    }
    // Ensure ordering: if the in-DOM position drifted (rare — only happens
    // when a streaming bubble flips into a finalized message), nudge it.
    if (prev) {
      if (prev.nextElementSibling !== node) prev.after(node);
    } else if (container.firstElementChild !== node) {
      container.prepend(node);
    }
    prev = node;
  }
  // Remove anything whose key disappeared.
  for (const [key, el] of existing) {
    if (!newKeys.has(key)) el.remove();
  }
}

function updateInputPlaceholder() {
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  // Mobile gets shorter strings: the desktop versions are 50+ chars,
  // which Safari wraps inside the textarea (rows="1") and renders with
  // the first line clipped above the visible area. Shorter strings fit
  // on one line on a phone-width viewport.
  const mobile = isMobileViewport();
  if (selectedAgent) {
    $input.placeholder = mobile
      ? `message ${selectedAgent.name}…`
      : `message ${selectedAgent.name} — or @othername to redirect`;
  } else {
    $input.placeholder = mobile
      ? `@name your message…`
      : `@name your message (creates one in ${selectedProjectName} if new)`;
  }
}

// --- actions ---

async function selectAgent(id) {
  selectedAgentId = id;
  // Also pin the sidebar selection to the agent's project so subsequent
  // @<newname> creates land where the user expects.
  const agent = agents.find((a) => a.id === id);
  if (agent) selectedProjectName = agent.projectName;
  renderAgentList();
  renderAgentHeader();
  updateInputPlaceholder();
  stateFor(id);

  // Render whatever's in the local transcript cache RIGHT NOW (could be
  // empty placeholder, could be cached messages from a prior selection).
  // We do this before the await on fetchHistory below so the user gets
  // an instant visual response -- critical on mobile where the network
  // roundtrip can take a few seconds.
  renderMessages();

  // Same reasoning for the sidebar drawer on mobile: close it now so the
  // chat view is visible while we're still waiting on the history fetch.
  // Previously this happened AFTER `await fetchHistory(id)`, which meant
  // a slow connection left the drawer covering the view -- the user saw
  // their tap highlight an agent in the sidebar but no chat content,
  // then everything would jump several seconds later. Closing eagerly
  // makes the selection feel instantaneous.
  if (id && isMobileViewport()) closeSidebar();

  // Now kick off the async work. fetchHistory updates the cache and
  // re-renders if we're still on the same agent when it returns. Not
  // awaited at the top level so a slow fetch doesn't block the function.
  if (id && !historyLoaded[id]) {
    void fetchHistory(id);
  }
  if (id) void fetchStats(id);

  // Don't auto-focus the input on mobile -- it would summon the on-screen
  // keyboard the moment you tap an agent, which is jarring. Desktop users
  // expect focus.
  if (!isMobileViewport()) $input.focus();
}

/** Parse the input for an `@name ` prefix.
 *  @returns {{name: string, body: string} | null} */
function parseAtMention(text) {
  const m = text.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/);
  if (!m) return null;
  return { name: m[1], body: m[2] };
}

async function createAgentQuick(name, projectName) {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, projectName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `create failed: ${res.status}`);
  }
  return (await res.json()).id;
}

async function sendMessage() {
  const text = $input.value.trim();
  // Empty text is OK if we have images attached -- mirroring pi's TUI,
  // which lets you send an image-only message.
  if (!text && pendingImages.length === 0) return;

  // Resolve target: explicit @name overrides sidebar selection.
  const mention = parseAtMention(text);
  let targetId;
  let body = text;
  if (mention) {
    body = mention.body;
    const existing = agents.find((a) => a.name === mention.name);
    if (existing) {
      targetId = existing.id;
    } else {
      // Create a new agent with this name in the currently-selected project.
      try {
        targetId = await createAgentQuick(mention.name, selectedProjectName);
      } catch (err) {
        alert(`Could not create @${mention.name}: ${err.message}`);
        return;
      }
    }
  } else if (selectedAgentId) {
    targetId = selectedAgentId;
  } else {
    alert("No agent selected. Start your message with @name or click an agent in the sidebar.");
    return;
  }

  // Snapshot the attached images for this send. We clear pendingImages
  // before the await so a fast follow-up paste doesn't accidentally
  // double-attach (or get clobbered by the next render). The send
  // request still has the snapshot in flight; if it fails, the user
  // would need to re-paste.
  const imagesForThisSend = pendingImages.slice();
  pendingImages = [];
  renderAttachmentStrip();

  // Optimistic local append so the user sees their message immediately.
  const prev = stateFor(targetId);
  transcriptByAgent[targetId] = {
    ...prev,
    messages: [
      ...prev.messages,
      {
        role: "user",
        content: body,
        ts: Date.now(),
        ...(imagesForThisSend.length > 0
          ? { images: imagesForThisSend.map((i) => ({ dataUrl: i.dataUrl, mimeType: i.mimeType })) }
          : {}),
      },
    ],
  };
  // IMPORTANT: mark history as "loaded" so the upcoming selectAgent doesn't
  // call fetchHistory before the server has processed our POST. Otherwise
  // the empty server response would wipe this optimistic append; the next
  // `agent_state_change → idle` handler will refresh from canonical history
  // once the turn completes.
  historyLoaded[targetId] = true;
  $input.value = "";
  closeMentionPopup();
  autoResize();
  // After sending, drop back to insert mode so the user is ready to type
  // the next message without an extra `i`. No-op when vim is disabled.
  vim.enterInsertMode();

  // Snapshot the send mode at the moment of send. The agent might transition
  // out of streaming between now and the fetch landing; we want the user's
  // intent honored regardless. Defaults to "steer" for an idle agent (the
  // server ignores `mode` when not streaming, but consistency is nice).
  const modeForThisSend = sendMode;

  // Auto-focus the new agent so the chat view follows.
  if (targetId !== selectedAgentId) await selectAgent(targetId);
  else renderMessages();

  try {
    const res = await fetch(`/api/agents/${targetId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: body,
        mode: modeForThisSend,
        ...(imagesForThisSend.length > 0
          ? {
              images: imagesForThisSend.map((i) => ({
                data: i.data,
                mimeType: i.mimeType,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("send failed:", data.error || res.statusText);
    }
  } catch (err) {
    console.error("send error:", err);
  }
}

async function stopAgent() {
  if (!selectedAgentId) return;
  await fetch(`/api/agents/${selectedAgentId}/stop`, { method: "POST" });
}

/** Fork the currently-selected agent at HEAD (full session copy). The
 *  server creates a sibling agent with its own worktree + session and
 *  broadcasts `agent_created`; we then auto-select it so the UI follows.
 *  Optional `entryId` (passed by per-message fork buttons later) truncates
 *  the forked session at that user message. */
async function forkAgent(opts = {}) {
  if (!selectedAgentId) return;
  const parent = agents.find((a) => a.id === selectedAgentId);
  const defaultName = parent ? `${parent.name}-fork` : "fork";
  const name = window.prompt(`Name for the forked agent:`, defaultName);
  if (!name) return;
  try {
    const res = await fetch(`/api/agents/${selectedAgentId}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...(opts.entryId ? { entryId: opts.entryId } : {}) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Failed to fork: ${data.error || res.statusText}`);
      return;
    }
    const child = await res.json();
    // The agent_created broadcast has already added it to our list; just
    // select it so the user lands on the fork.
    await selectAgent(child.id);
  } catch (err) {
    alert(`Failed to fork: ${err}`);
  }
}

async function resumeAgent() {
  if (!selectedAgentId) return;
  await fetch(`/api/agents/${selectedAgentId}/resume`, { method: "POST" });
}

async function deleteAgent(evt) {
  if (!selectedAgentId) return;
  const agent = agents.find((a) => a.id === selectedAgentId);
  const hard = !!(evt && evt.shiftKey);
  const suffix = hard ? "AND its worktree/session files on disk" : "(files on disk will be kept)";
  if (!window.confirm(`Delete agent "${agent?.name ?? selectedAgentId}" ${suffix}?`)) return;
  const qs = hard ? "?deleteWorktree=true&deleteSessions=true" : "";
  try {
    const res = await fetch(`/api/agents/${selectedAgentId}${qs}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to delete agent");
    }
  } catch (err) {
    alert("Failed to delete agent: " + err.message);
  }
}

async function deleteProject(name) {
  if (!window.confirm(`Remove project "${name}"?\nAgents in this project must be removed first.`)) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to remove project");
    }
  } catch (err) {
    alert(err.message);
  }
}

// --- new project modal ---

function openProjectModal() {
  $projModal.classList.remove("hidden");
  $projModalName.value = "";
  $projModalRepo.value = "";
  $projModalName.focus();
}
function closeProjectModal() {
  $projModal.classList.add("hidden");
}
// Re-entrancy guard: the modal's create button used to fire a fresh
// POST on every click, and a clone takes 1-30s with no visual feedback.
// Double-clicking would race two concurrent POSTs for the same name --
// whichever lost the race tripped the empty-dir check on a half-cloned
// target and surfaced as a cryptic error. We now disable the button +
// flip its label while a request is in flight; the server also rejects
// concurrent requests for the same name with a 409, but the UI side is
// what users notice.
let projectCreateInFlight = false;

async function createProject() {
  if (projectCreateInFlight) return;
  const name = $projModalName.value.trim();
  if (!name) return;
  const body = { name };
  const repo = $projModalRepo.value.trim();
  if (repo) body.repoUrl = repo;

  projectCreateInFlight = true;
  const originalLabel = $projModalCreate.textContent;
  $projModalCreate.textContent = repo ? "cloning\u2026" : "creating\u2026";
  $projModalCreate.disabled = true;
  $projModalCreate.classList.add("opacity-60", "cursor-not-allowed");
  $projModalName.disabled = true;
  $projModalRepo.disabled = true;

  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to create project");
      return;
    }
    closeProjectModal();
  } catch (err) {
    alert("Failed to create project: " + err.message);
  } finally {
    projectCreateInFlight = false;
    $projModalCreate.textContent = originalLabel;
    $projModalCreate.disabled = false;
    $projModalCreate.classList.remove("opacity-60", "cursor-not-allowed");
    $projModalName.disabled = false;
    $projModalRepo.disabled = false;
  }
}

// --- @mention autocomplete ---

let mentionIndex = 0;
let mentionMatches = [];

function mentionContextFromInput() {
  // The mention only applies at the very start of the input. If it's in the
  // middle of the message, treat it as literal text.
  const text = $input.value;
  const m = text.match(/^@([a-zA-Z0-9_-]*)$/);
  if (!m) return null;
  return { partial: m[1] };
}

function updateMentionPopup() {
  const ctx = mentionContextFromInput();
  if (!ctx) {
    closeMentionPopup();
    return;
  }
  const partial = ctx.partial.toLowerCase();
  // Filter existing agent names by prefix (also matching the current project's
  // agents first to surface the most likely targets).
  const matches = agents
    .filter((a) => a.name.toLowerCase().includes(partial))
    .sort((a, b) => {
      const aInSel = a.projectName === selectedProjectName ? 0 : 1;
      const bInSel = b.projectName === selectedProjectName ? 0 : 1;
      if (aInSel !== bInSel) return aInSel - bInSel;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 8)
    .map((a) => ({ kind: "existing", name: a.name, project: a.projectName, state: a.state }));

  // If the user typed a non-empty partial that doesn't match any agent
  // exactly, offer to create a new one.
  const exactMatch = matches.some((m) => m.name === ctx.partial);
  if (ctx.partial && !exactMatch) {
    matches.unshift({ kind: "new", name: ctx.partial, project: selectedProjectName });
  }

  mentionMatches = matches;
  if (matches.length === 0) {
    closeMentionPopup();
    return;
  }
  if (mentionIndex >= matches.length) mentionIndex = 0;
  renderMentionPopup();
}

function renderMentionPopup() {
  if (mentionMatches.length === 0) {
    $mentionPopup.classList.add("hidden");
    return;
  }
  $mentionPopup.classList.remove("hidden");
  $mentionPopup.innerHTML = mentionMatches
    .map((m, i) => {
      const active = i === mentionIndex ? "bg-base16-300/60" : "";
      if (m.kind === "new") {
        return `<button class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-base16-300/40 cursor-pointer ${active}" data-idx="${i}">
          <span class="text-base16-green text-xs">+</span>
          <span class="text-xs text-base16-700">create <span class="text-base16-orange">@${escHtml(m.name)}</span></span>
          <span class="text-[10px] text-base16-500 ml-auto">in ${escHtml(m.project)}</span>
        </button>`;
      }
      return `<button class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-base16-300/40 cursor-pointer ${active}" data-idx="${i}">
        <span class="w-1.5 h-1.5 rounded-full flex-none ${statusColor(m.state)}"></span>
        <span class="text-xs text-base16-700"><span class="text-base16-orange">@</span>${escHtml(m.name)}</span>
        <span class="text-[10px] text-base16-500 ml-auto">${escHtml(m.project)}</span>
      </button>`;
    })
    .join("");
  $mentionPopup.querySelectorAll("[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      mentionIndex = Number(btn.dataset.idx);
      applyMentionSelection();
    });
  });
}

function applyMentionSelection() {
  const pick = mentionMatches[mentionIndex];
  if (!pick) return;
  $input.value = `@${pick.name} `;
  closeMentionPopup();
  $input.focus();
  // Put caret at end
  const len = $input.value.length;
  $input.setSelectionRange(len, len);
}

function closeMentionPopup() {
  $mentionPopup.classList.add("hidden");
  mentionMatches = [];
  mentionIndex = 0;
}

// --- slash command autocomplete -----------------------------------------
//
// Two-way overlap with `@mention`:
//   - The `^/` and `^@` regexes are disjoint, so only one popup is open
//     at a time — the input handler dispatches to whichever matches.
//   - The keydown handler handles popup nav (Up/Down/Enter/Tab/Esc) for
//     whichever popup is currently visible, identical UX in both.
//
// Three flavours of command:
//   - `client`  : pure UI action, no server roundtrip. Wraps an existing
//                 button or app.js function (fork, stop, theme, copy, …).
//   - `api`     : POSTs to a new pirouette endpoint that wraps a pi session
//                 method (compact, new). Optional args go in the body.
//   - `skill`   : passthrough — the literal text `/skill:<name> args` is
//                 sent to /api/agents/:id/message; pi's session.prompt()
//                 expands it server-side via _expandSkillCommand().
//
// Only `client` and `api` commands actually "dispatch" through this layer.
// Skill commands and unknown `/foo` input fall through to sendMessage(),
// which preserves pi's own command handling (extension commands, etc.).

let skillsManifest = []; // {name, description}[] populated by /api/skills
let skillsLoaded = false;

async function loadSkillsManifest() {
  try {
    const res = await fetch("/api/skills");
    if (!res.ok) throw new Error(`/api/skills: ${res.status}`);
    const data = await res.json();
    skillsManifest = Array.isArray(data.skills) ? data.skills : [];
    skillsLoaded = true;
  } catch (err) {
    console.error("failed to load skills manifest:", err);
    skillsManifest = [];
  }
}

// Extension-registered slash commands (e.g. /cas-fast, /cas-okta from
// pi-cas-provider). Empty when no agent is currently running on the
// server (commands are runner-scoped server-side; see
// AgentManager.getExtensionCommands). Refreshed on agent-list changes
// so newly-started extensions show up without a reload.
let commandsManifest = []; // {name, description}[] populated by /api/commands

async function loadCommandsManifest() {
  try {
    const res = await fetch("/api/commands");
    if (!res.ok) throw new Error(`/api/commands: ${res.status}`);
    const data = await res.json();
    commandsManifest = Array.isArray(data.commands) ? data.commands : [];
  } catch (err) {
    console.error("failed to load commands manifest:", err);
    commandsManifest = [];
  }
}

// Static command catalogue. `argLabel` shows in the popup as a hint about
// what comes after the command name (purely cosmetic; the dispatcher just
// passes everything after the first space through as `args`).
const SLASH_COMMANDS = [
  { name: "fork", description: "Fork this agent (copy session into a new agent)", kind: "client", takesArgs: false },
  { name: "new", description: "Discard history and start a fresh session for this agent", kind: "api", endpoint: "new", takesArgs: false },
  { name: "compact", description: "Manually compact session context", argLabel: "[instructions]", kind: "api", endpoint: "compact", takesArgs: true },
  { name: "stop", description: "Stop the running agent", kind: "client", takesArgs: false },
  { name: "resume", description: "Resume a stopped agent", kind: "client", takesArgs: false },
  { name: "copy", description: "Copy last assistant message to clipboard", kind: "client", takesArgs: false },
  { name: "raw", description: "Toggle raw markdown view", kind: "client", takesArgs: false },
  { name: "model", description: "Open model picker", kind: "client", takesArgs: false },
  { name: "theme", description: "Open theme picker", kind: "client", takesArgs: false },
  { name: "notify", description: "Toggle browser notifications", kind: "client", takesArgs: false },
];

let slashIndex = 0;
let slashMatches = [];

/** Returns `{ partial }` if the input is a single token starting with `/`
 *  (no trailing space), otherwise null. Matches the same "start-of-input,
 *  no whitespace yet" semantics as the @mention popup, and so disjointly
 *  with it. */
function slashContextFromInput() {
  const text = $input.value;
  // `^/[^\s]*$` lets the popup track e.g. `/`, `/com`, `/skill:cach` — but
  // closes once a space appears ("the user is now typing args, not a
  // command name"). The same convention pi's TUI uses.
  const m = text.match(/^\/(\S*)$/);
  if (!m) return null;
  return { partial: m[1] };
}

/** Build the full list of slash entries (static + extension + skills)
 *  annotated with which kind they are; the popup renders this list
 *  directly.
 *
 *  Extension commands (`/cas-fast`, `/cas-okta`, etc.) are surfaced for
 *  autocomplete only — there's no client-side dispatch for them, the
 *  literal text falls through to sendMessage() and pi's command handler
 *  resolves it server-side. `takesArgs: true` is conservative (we don't
 *  know the arg shape of arbitrary extension commands), so the popup
 *  keeps showing while the user types past the command name. */
function allSlashEntries() {
  const entries = SLASH_COMMANDS.map((c) => ({ ...c }));
  for (const c of commandsManifest) {
    entries.push({
      name: c.name,
      description: c.description || "(extension command)",
      argLabel: "[args]",
      kind: "extension",
      takesArgs: true,
    });
  }
  for (const s of skillsManifest) {
    entries.push({
      name: `skill:${s.name}`,
      description: s.description || "(skill)",
      argLabel: "[args]",
      kind: "skill",
      takesArgs: true,
    });
  }
  return entries;
}

function updateSlashPopup() {
  const ctx = slashContextFromInput();
  if (!ctx) {
    closeSlashPopup();
    return;
  }
  const partial = ctx.partial.toLowerCase();
  // Substring match (matches @mention's policy). Surface command-name
  // matches before skill matches; otherwise alphabetical so the order is
  // stable across renders.
  const all = allSlashEntries();
  const matches = all
    .filter((e) => e.name.toLowerCase().includes(partial))
    .sort((a, b) => {
      // Static commands above skills (skills can be many; static ones are
      // the ones the user is most likely to want).
      if (a.kind === "skill" && b.kind !== "skill") return 1;
      if (a.kind !== "skill" && b.kind === "skill") return -1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 12);

  slashMatches = matches;
  if (matches.length === 0) {
    closeSlashPopup();
    return;
  }
  if (slashIndex >= matches.length) slashIndex = 0;
  renderSlashPopup();
}

function renderSlashPopup() {
  if (slashMatches.length === 0) {
    $slashPopup.classList.add("hidden");
    return;
  }
  $slashPopup.classList.remove("hidden");
  $slashPopup.innerHTML = slashMatches
    .map((e, i) => {
      const active = i === slashIndex ? "bg-base16-300/60" : "";
      // Color-code the kind glyph so you can scan: skill=cyan,
      // api=orange (server-side action), extension=magenta (registered
      // by a pi extension, dispatched server-side), client=green (UI).
      const glyph =
        e.kind === "skill"
          ? "◆"
          : e.kind === "api"
            ? "▸"
            : e.kind === "extension"
              ? "▪"
              : "•";
      const glyphColor =
        e.kind === "skill"
          ? "text-base16-cyan"
          : e.kind === "api"
            ? "text-base16-orange"
            : e.kind === "extension"
              ? "text-base16-magenta"
              : "text-base16-green";
      const argHint = e.argLabel ? ` <span class="text-base16-500">${escHtml(e.argLabel)}</span>` : "";
      return `<button class="w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-base16-300/40 cursor-pointer ${active}" data-idx="${i}">
        <span class="text-xs ${glyphColor} flex-none">${glyph}</span>
        <span class="text-xs text-base16-700 font-mono whitespace-nowrap"><span class="text-base16-orange">/</span>${escHtml(e.name)}${argHint}</span>
        <span class="text-[10px] text-base16-500 ml-auto truncate" title="${escHtml(e.description ?? "")}">${escHtml(e.description ?? "")}</span>
      </button>`;
    })
    .join("");
  $slashPopup.querySelectorAll("[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      slashIndex = Number(btn.dataset.idx);
      applySlashSelection();
    });
  });
}

/** Apply the popup-highlighted slash entry.
 *
 *  `mode` controls what happens:
 *    - "dispatch" (Enter): immediately fire the command. Args come from the
 *      current input, after the command name. If the user just typed the
 *      command name (no args), we dispatch with empty args -- which is the
 *      right behaviour for /compact, /new, /skill:foo (skills happily run
 *      with no extra text). This matches "Enter = do the thing" intuition.
 *    - "complete" (Tab): fill the input with `/<name> ` (trailing space)
 *      and leave the popup closed, so the user can type args before hitting
 *      Enter. Bare-name commands (`takesArgs: false`) dispatch immediately
 *      under Tab too -- there's nothing to type. */
function applySlashSelection(mode = "dispatch") {
  const pick = slashMatches[slashIndex];
  if (!pick) return;
  // For Tab on a takesArgs command, fill name + space and leave popup
  // closed. No dispatch -- user wants to type args next.
  if (mode === "complete" && pick.takesArgs) {
    $input.value = `/${pick.name} `;
    closeSlashPopup();
    $input.focus();
    const len = $input.value.length;
    $input.setSelectionRange(len, len);
    autoResize();
    return;
  }
  // Otherwise dispatch. For skills, route through sendMessage so pi's
  // server-side expansion handles them. For api/client commands, route
  // through executeSlashCommand.
  //
  // Args = whatever's after the first space in the current input value,
  // OR empty if the user only typed the command name.
  const text = $input.value;
  const spaceIdx = text.indexOf(" ");
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  closeSlashPopup();
  $input.value = "";
  autoResize();
  if (pick.kind === "skill" || pick.kind === "extension") {
    // Both skills and extension-registered commands resolve server-side:
    // skills via pi's _expandSkillCommand, extension commands via pi's
    // command-dispatch path (pi.registerCommand). Either way the client
    // just sends the literal `/name args` text and lets the server
    // route it. We share the codepath because the wire shape is
    // identical -- only the server-side handler differs.
    const body = args ? `/${pick.name} ${args}` : `/${pick.name}`;
    void (async () => {
      try {
        await fetch(`/api/agents/${selectedAgentId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: body, mode: sendMode }),
        });
      } catch (err) {
        console.error("skill dispatch failed:", err);
      }
    })();
    return;
  }
  void executeSlashCommand(pick.name, args);
}

function closeSlashPopup() {
  $slashPopup.classList.add("hidden");
  slashMatches = [];
  slashIndex = 0;
}

/** Find the literal text content of the most recent finalized assistant
 *  message in the currently-selected agent's transcript. Used by /copy. */
function lastAssistantText() {
  if (!selectedAgentId) return null;
  const state = transcriptByAgent[selectedAgentId];
  if (!state || !state.messages) return null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

async function copyLastAssistant() {
  const text = lastAssistantText();
  if (!text) {
    alert("No assistant message to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // navigator.clipboard requires a secure context (https) and a
    // user-initiated event — both of which we have here, but fall back
    // to a textarea + execCommand on truly hostile browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      alert("Copy failed: " + (err instanceof Error ? err.message : err));
    }
    ta.remove();
  }
}

/** Parse `/cmd args` (with `cmd` possibly containing `:`) and dispatch.
 *  Returns true if dispatched (and the caller should NOT fall through to
 *  sendMessage); false if the caller should treat the input as a regular
 *  message (skill commands, unknown commands).
 *
 *  The args portion is everything after the first space, with leading/
 *  trailing whitespace trimmed. */
async function tryDispatchSlash(text) {
  if (!text.startsWith("/")) return false;
  const spaceIdx = text.indexOf(" ");
  const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  // Skill passthrough: pi expands it server-side. Don't dispatch — let
  // sendMessage() ship the literal text to /api/agents/:id/message.
  if (name.startsWith("skill:")) return false;

  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return false; // unknown — let sendMessage handle it (pi may know)

  return await executeSlashCommand(name, args);
}

async function executeSlashCommand(name, args) {
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (!cmd) return false;

  if (cmd.kind === "client") {
    // Client-side commands ignore args (none of them currently take any).
    switch (name) {
      case "fork":
        await forkAgent();
        break;
      case "stop":
        await stopAgent();
        break;
      case "resume":
        await resumeAgent();
        break;
      case "copy":
        await copyLastAssistant();
        break;
      case "raw":
        $rawBtn.click();
        break;
      case "model":
        openModelPicker();
        break;
      case "theme":
        openThemePicker();
        break;
      case "notify":
        await toggleNotifications();
        break;
      default:
        return false;
    }
    return true;
  }

  if (cmd.kind === "api") {
    if (!selectedAgentId) {
      alert(`/${name} requires a selected agent.`);
      return true;
    }
    const body = cmd.takesArgs && args
      ? JSON.stringify({ instructions: args })
      : "{}";
    try {
      const res = await fetch(`/api/agents/${selectedAgentId}/${cmd.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`/${name} failed: ${data.error || res.statusText}`);
      }
    } catch (err) {
      alert(`/${name} failed: ${err}`);
    }
    return true;
  }

  return false;
}

// --- misc ---

// --- theme picker (ported from neevparikh.github.io) ----------------------
// localStorage keys:
//   pirouette-theme-light  → slug to use when resolved mode is "light"
//   pirouette-theme-dark   → slug to use when resolved mode is "dark"
//   pirouette-theme-mode   → "system" | "light" | "dark"
// When mode is "system", we follow `prefers-color-scheme`.

const DEFAULT_LIGHT = "base24-softstack-light";
const DEFAULT_DARK = "base24-softstack-dark";

/** @type {Array<{slug: string, name: string, variant: "light"|"dark", system: string}>} */
let themeManifest = [];

function savedTheme(variant) {
  return localStorage.getItem(`pirouette-theme-${variant}`) ||
    (variant === "light" ? DEFAULT_LIGHT : DEFAULT_DARK);
}

function savedMode() {
  return localStorage.getItem("pirouette-theme-mode") || "system";
}

function resolveMode() {
  const m = savedMode();
  if (m === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return m;
}

/** Switch the active theme class on <html>, removing any prior base16/base24 class. */
function applyActiveTheme() {
  const html = document.documentElement;
  const resolved = resolveMode();
  const targetSlug = resolved === "dark" ? savedTheme("dark") : savedTheme("light");
  // Remove any previous theme class (base16-* or base24-*).
  for (const cls of [...html.classList]) {
    if (cls.startsWith("base16-") || cls.startsWith("base24-")) {
      html.classList.remove(cls);
    }
  }
  html.classList.add(targetSlug);
}

/** Find the current theme class so we can highlight it in the picker. */
function currentThemeSlug() {
  for (const cls of document.documentElement.classList) {
    if (cls.startsWith("base16-") || cls.startsWith("base24-")) return cls;
  }
  return null;
}

function renderThemeList(filter = "") {
  const q = filter.toLowerCase().trim();
  const current = currentThemeSlug();
  const matches = q
    ? themeManifest.filter((t) => t.name.toLowerCase().includes(q))
    : themeManifest;
  $themeList.innerHTML = matches
    .map((t) => {
      const isActive = t.slug === current;
      return `
        <button
          class="theme-option w-full px-3 py-1.5 text-left text-xs lowercase hover:bg-base16-200 text-base16-600 flex justify-between items-center cursor-pointer ${isActive ? "bg-base16-200/70" : ""}"
          data-slug="${t.slug}"
          data-variant="${t.variant}"
        >
          <span class="mr-2 truncate">${escHtml(t.name)}</span>
          <span class="text-xs text-base16-500/70 flex-none">${t.variant}</span>
        </button>
      `;
    })
    .join("");
  $themeList.querySelectorAll(".theme-option").forEach((el) => {
    el.addEventListener("click", () => {
      const { slug, variant } = el.dataset;
      // Persist: remember this slug as the preferred variant, and pin the
      // current mode to that variant so the chosen theme actually shows.
      localStorage.setItem(`pirouette-theme-${variant}`, slug);
      localStorage.setItem("pirouette-theme-mode", variant);
      applyActiveTheme();
      closeThemePicker();
    });
  });
}

function openThemePicker() {
  $themePicker.classList.remove("hidden");
  renderThemeList($themeSearch.value);
  $themeSearch.focus();
}
function closeThemePicker() {
  $themePicker.classList.add("hidden");
  $themeSearch.value = "";
}

async function loadThemeManifest() {
  try {
    const res = await fetch("themes.json");
    if (!res.ok) throw new Error(`themes.json: ${res.status}`);
    themeManifest = await res.json();
  } catch (err) {
    console.error("failed to load theme manifest:", err);
    themeManifest = [];
  }
}

// Respond to OS appearance changes when the user is on "system" mode.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (savedMode() === "system") applyActiveTheme();
});

function autoResize() {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
}

// --- events ---

$sendBtn.addEventListener("click", sendMessage);
$sendModeBtn.addEventListener("click", toggleSendMode);
$input.addEventListener("keydown", (e) => {
  // @mention popup wins if open (and disjoint from slash by construction).
  if ($mentionPopup.classList.contains("hidden") === false && mentionMatches.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mentionIndex = (mentionIndex + 1) % mentionMatches.length;
      renderMentionPopup();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
      renderMentionPopup();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      applyMentionSelection();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMentionPopup();
      return;
    }
  }
  // Slash popup nav. Same UX as the mention popup.
  if ($slashPopup.classList.contains("hidden") === false && slashMatches.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashIndex = (slashIndex + 1) % slashMatches.length;
      renderSlashPopup();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
      renderSlashPopup();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      applySlashSelection("complete");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      applySlashSelection("dispatch");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlashPopup();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // Try slash dispatch first; on a hit, that's the whole user action and
    // we suppress sendMessage. On a miss (skill command, unknown command,
    // or non-slash input), fall through to sendMessage which handles
    // @mention parsing and pi's own /skill: expansion server-side.
    const text = $input.value.trim();
    void (async () => {
      const dispatched = await tryDispatchSlash(text);
      if (!dispatched) sendMessage();
    })();
  }
});
$input.addEventListener("input", () => {
  autoResize();
  // Disjoint regexes: at most one of these will open. Both safely close
  // when the input no longer matches their respective trigger.
  updateMentionPopup();
  updateSlashPopup();
});

// --- image attachments via paste ---
//
// Same UX as pi's TUI (Ctrl+V on a clipboard image): the bytes get pulled
// out of the paste event, base64-encoded, and shown as a preview pill
// under the input. On send, the images travel with the message body to
// POST /api/agents/:id/message and the server forwards them into pi's
// session.prompt({images}) so the model sees them as part of the user
// message.
//
// State is a plain array of {dataUrl, mimeType, data}. dataUrl is for
// the preview <img>; mimeType + data go on the wire. Cleared after
// successful send (in sendMessage()), but NOT on paste-failure so the
// user can retry.
const PASTE_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** @type {{ dataUrl: string, mimeType: string, data: string }[]} */
let pendingImages = [];

function renderAttachmentStrip() {
  if (pendingImages.length === 0) {
    $attachmentStrip.classList.add("hidden");
    $attachmentStrip.innerHTML = "";
    return;
  }
  $attachmentStrip.classList.remove("hidden");
  let html = "";
  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    html += `
      <div class="relative inline-flex items-center bg-base16-200 border border-base16-300 rounded-lg p-1 pr-2 gap-2">
        <img src="${img.dataUrl}" class="h-12 w-12 object-cover rounded" alt="attached ${img.mimeType}" />
        <span class="text-[10px] text-base16-500 font-mono">${escHtml(img.mimeType.replace("image/", ""))}</span>
        <button class="text-base16-500 hover:text-base16-red text-xs cursor-pointer px-1" data-remove-image="${i}" aria-label="remove attachment">×</button>
      </div>`;
  }
  $attachmentStrip.innerHTML = html;
}

$attachmentStrip.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-image]");
  if (!btn) return;
  const idx = Number(btn.getAttribute("data-remove-image"));
  if (Number.isInteger(idx) && idx >= 0 && idx < pendingImages.length) {
    pendingImages.splice(idx, 1);
    renderAttachmentStrip();
  }
});

$input.addEventListener("paste", (e) => {
  // Pull image items out of the clipboard payload. Browsers expose them
  // as DataTransferItems with kind="file" + image/* type. Text paste is
  // handled by the default behavior; we only intercept when image data
  // is present.
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [];
  for (const item of items) {
    if (item.kind === "file" && PASTE_ALLOWED_MIME.has(item.type)) {
      imageItems.push(item);
    }
  }
  if (imageItems.length === 0) return;
  // Block default paste so the image's filename/junk text doesn't end up
  // in the textarea alongside the attachment pill.
  e.preventDefault();
  for (const item of imageItems) {
    const blob = item.getAsFile();
    if (!blob) continue;
    // Read as base64. FileReader is async; we update the strip when each
    // load resolves so the user sees the previews appear in paste order.
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") return;
      // Strip the `data:<mime>;base64,` prefix; pi's ImageContent wants raw base64.
      const commaIdx = dataUrl.indexOf(",");
      const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      pendingImages.push({ dataUrl, mimeType: blob.type, data });
      renderAttachmentStrip();
    };
    reader.readAsDataURL(blob);
  }
});
$input.addEventListener("blur", () => {
  // Delay so a click inside either popup can fire first.
  setTimeout(() => {
    closeMentionPopup();
    closeSlashPopup();
  }, 150);
});
$newProjectBtn.addEventListener("click", openProjectModal);

// "show archived" toggle in the sidebar. Flips visibility of archived
// chats and persists the preference. The button label reflects state.
const $showArchivedBtn = document.getElementById("show-archived-btn");
function applyShowArchivedStyle() {
  if (!$showArchivedBtn) return;
  $showArchivedBtn.textContent = showArchived ? "hide archived" : "show archived";
  $showArchivedBtn.classList.toggle("bg-base16-blue/20", showArchived);
  $showArchivedBtn.classList.toggle("text-base16-blue", showArchived);
}
if ($showArchivedBtn) {
  applyShowArchivedStyle();
  $showArchivedBtn.addEventListener("click", () => {
    showArchived = !showArchived;
    localStorage.setItem("pirouette-show-archived", showArchived ? "1" : "0");
    applyShowArchivedStyle();
    renderAgentList();
  });
}

$projModalCancel.addEventListener("click", closeProjectModal);
$projModalCreate.addEventListener("click", createProject);
$projModal.addEventListener("click", (e) => {
  if (e.target === $projModal) closeProjectModal();
});
$projModalName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createProject();
});
$themeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if ($themePicker.classList.contains("hidden")) openThemePicker();
  else closeThemePicker();
});
document.addEventListener("click", (e) => {
  if (!$themePicker.contains(e.target) && e.target !== $themeBtn) closeThemePicker();
});
$themeSearch.addEventListener("input", () => renderThemeList($themeSearch.value));
$themeReset.addEventListener("click", () => {
  // Reset to "follow the OS". Keeps the saved preferred light/dark slugs.
  localStorage.setItem("pirouette-theme-mode", "system");
  applyActiveTheme();
  closeThemePicker();
});
$stopBtn.addEventListener("click", stopAgent);
$resumeBtn.addEventListener("click", resumeAgent);
$deleteBtn.addEventListener("click", deleteAgent);
$forkBtn.addEventListener("click", forkAgent);

// Global raw-view toggle — flips `rawView`, persists, re-renders so every
// assistant bubble in the current transcript updates. The button's style
// reflects the active/inactive state for discoverability.
function applyRawBtnStyle() {
  const active = "bg-base16-blue/25 text-base16-blue";
  const inactive = "bg-base16-300/40 text-base16-500 hover:bg-base16-300/70";
  $rawBtn.className = `text-xs px-2 py-1 rounded cursor-pointer font-mono ${rawView ? active : inactive}`;
  $rawBtn.title = rawView
    ? "Showing raw markdown source — click to render"
    : "Toggle raw markdown view (applies to all assistant messages)";
}
$rawBtn.addEventListener("click", () => {
  rawView = !rawView;
  localStorage.setItem("pirouette-raw-view", rawView ? "1" : "0");
  applyRawBtnStyle();
  renderMessages();
});
applyRawBtnStyle();

// Delegated click handler for `data-toggle` chevrons (tool runs, thinking
// expanders, tool-row body expanders). Attached once at startup so we
// don't have to re-bind after every reconciliation pass. Walks up from
// the click target to the first element carrying `data-toggle` since the
// toggle attribute lives on a sub-row, not the message wrapper.
$messages.addEventListener("click", (e) => {
  const target = e.target.closest("[data-toggle]");
  if (!target || !$messages.contains(target)) return;
  const key = target.getAttribute("data-toggle");
  if (!key) return;
  if (expandedItems.has(key)) expandedItems.delete(key);
  else expandedItems.add(key);
  renderMessages();
});

// Load the theme manifest in the background — the picker is populated
// lazily when it opens, but we kick off the fetch now to warm the cache.
loadThemeManifest();

// Same for the skills manifest, which feeds the slash-command popup's
// `/skill:<name>` entries. Cheap; one tiny GET on connect.
void loadSkillsManifest();

// Extension-registered slash commands (e.g. /cas-fast). Cheap; one tiny
// GET on connect. The server may return an empty list if no agent is
// running at this moment -- the agent_state_change handler re-fetches
// when one comes up, so the popup self-heals.
void loadCommandsManifest();

// --- init ---

updateInputPlaceholder();
connectWs();
