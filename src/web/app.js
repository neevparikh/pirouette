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
const $agentStatus = document.getElementById("agent-status");
const $agentInfo = document.getElementById("agent-info");
const $agentStats = document.getElementById("agent-stats");
const $messages = document.getElementById("messages");
const $input = document.getElementById("message-input");
const $sendBtn = document.getElementById("send-btn");
const $sendModeBtn = document.getElementById("send-mode-btn");
const $queueStrip = document.getElementById("queue-strip");
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
const $mentionPopup = document.getElementById("mention-popup");
const $slashPopup = document.getElementById("slash-popup");
const $modelBtn = document.getElementById("agent-model-btn");
const $modelPicker = document.getElementById("model-picker");
const $modelSearch = document.getElementById("model-search");
const $modelList = document.getElementById("model-list");
const $thinkingBtn = document.getElementById("agent-thinking-btn");
const $thinkingPicker = document.getElementById("thinking-picker");
const $thinkingList = document.getElementById("thinking-list");

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
    if (!vim.isEnabled()) {
      $vimLabel.textContent = "";
      return;
    }
    let label = "-- INSERT --";
    let color = "text-base16-500";
    if (mode === "normal") {
      label = "-- NORMAL --";
      color = "text-base16-cyan";
    } else if (mode === "visual") {
      label = "-- VISUAL --";
      color = "text-base16-purple";
    } else if (mode === "visual_line") {
      label = "-- VISUAL LINE --";
      color = "text-base16-purple";
    } else if (mode === "insert") {
      label = "-- INSERT --";
      color = "text-base16-green";
    }
    if (pending) label = label.replace(/\s--$/, ` [${pending}] --`);
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
// Below `md` (768px) the sidebar is an off-canvas drawer: hidden by default,
// slid in via the hamburger button in the agent header, dismissed by tapping
// the backdrop or pressing Escape. At md+ this is all a no-op — the sidebar
// is a regular flex child and these controls don't affect it.
const $sidebar = document.getElementById("sidebar");
const $sidebarBackdrop = document.getElementById("sidebar-backdrop");
const $sidebarToggle = document.getElementById("sidebar-toggle");

function openSidebar() {
  $sidebar.classList.remove("-translate-x-full");
  $sidebarBackdrop.classList.remove("hidden");
}
function closeSidebar() {
  $sidebar.classList.add("-translate-x-full");
  $sidebarBackdrop.classList.add("hidden");
}
$sidebarToggle?.addEventListener("click", openSidebar);
$sidebarBackdrop?.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$sidebarBackdrop.classList.contains("hidden")) {
    closeSidebar();
  }
});
// If the user resizes from mobile to desktop with the drawer open, drop the
// drawer's transform/backdrop so we don't have phantom state at md+ widths.
// Also re-run the placeholder logic so the long/short variant matches the
// current viewport (rotating a phone or resizing the browser window
// otherwise leaves a stale string).
window.addEventListener("resize", () => {
  if (!isMobileViewport()) closeSidebar();
  updateInputPlaceholder();
});

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

const THINKING_LEVELS = /** @type {const} */ (["off", "minimal", "low", "medium", "high"]);

function renderThinkingList() {
  const agent = selectedAgentId ? agentsById[selectedAgentId] : null;
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
    if (agentsById[selectedAgentId]) {
      agentsById[selectedAgentId].thinkingLevel = level;
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

/** Compact per-agent list row. */
function renderAgentRow(a, depth = 0) {
  const activity = currentActivity[a.id];
  const shortModel = a.model
    ? a.model.split("/").pop().replace(/^claude-|^gpt-|-2\d{7}$/g, "")
    : "default";
  let subline;
  if (a.state === "cloning") {
    subline = `<div class="text-xs text-base16-cyan truncate">↥ cloning…</div>`;
  } else if (a.state === "error" && a.errorMessage) {
    subline = `<div class="text-xs text-base16-red truncate">error · ${escHtml(a.errorMessage).slice(0, 60)}</div>`;
  } else if (activity) {
    subline = `<div class="text-xs text-base16-cyan truncate">▶ ${escHtml(activity.tool)}${activity.subtitle ? " · " + escHtml(activity.subtitle).slice(0, 40) : ""}</div>`;
  } else {
    const label = a.state === "waiting_input" ? "your turn" : a.state;
    subline = `<div class="text-xs text-base16-500 truncate">${escHtml(label)} · <span class="text-base16-500">${escHtml(shortModel)}</span></div>`;
  }
  const dot = isActiveState(a.state)
    ? `${statusColor(a.state)} pulse-dot`
    : statusColor(a.state);
  // Indent forks under their parent. Each level adds a fixed gutter (12px)
  // so trees are visually obvious without crowding the row text. The first
  // child of a fork gets a `↳` glyph; deeper levels just stack indent.
  const padLeft = 24 + depth * 12;
  const forkMark = depth > 0
    ? `<span class="text-base16-500 text-xs flex-none">↳</span>`
    : "";
  return `
    <button
      class="w-full text-left pr-4 py-2 flex items-center gap-2.5 hover:bg-base16-300/30 cursor-pointer ${a.id === selectedAgentId ? "bg-base16-300/50" : ""}"
      style="padding-left: ${padLeft}px"
      data-agent-id="${a.id}"
      title="${escHtml(a.name)} — ${escHtml(a.model || "default")}${a.parentAgentId ? " — forked from " + escHtml(a.parentAgentId) : ""}"
    >
      ${forkMark}
      <span class="w-2 h-2 rounded-full flex-none ${dot}"></span>
      <div class="min-w-0 flex-1">
        <div class="text-sm text-base16-600 truncate font-display">${escHtml(a.name)}</div>
        ${subline}
      </div>
    </button>
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
      '<div class="p-4 text-base16-500 text-sm italic">no projects yet</div>';
    return;
  }

  // Group agents by project. Projects with no agents still render so the
  // user can see them and click "+" to add one.
  const agentsByProject = new Map();
  for (const p of projects) agentsByProject.set(p.name, []);
  for (const a of agents) {
    if (!agentsByProject.has(a.projectName)) agentsByProject.set(a.projectName, []);
    agentsByProject.get(a.projectName).push(a);
  }

  const sections = projects
    .slice()
    .sort((a, b) => {
      // scratchpad always last; others alphabetical
      if (a.name === "scratchpad") return 1;
      if (b.name === "scratchpad") return -1;
      return a.name.localeCompare(b.name);
    })
    .map((p) => {
      const as = (agentsByProject.get(p.name) ?? []).sort((x, y) =>
        x.name.localeCompare(y.name),
      );
      const isCollapsed = collapsedProjects.has(p.name);
      const isSelected = selectedProjectName === p.name;
      const arrow = isCollapsed ? "▸" : "▾";
      const subtitle = p.repoUrl
        ? escHtml(p.repoUrl.replace(/^https?:\/\//, ""))
        : p.name === "scratchpad"
          ? "default (bare)"
          : "bare";
      const rowsHtml = isCollapsed
        ? ""
        : as.length > 0
          ? orderAgentsAsTree(as)
              .map(({ agent, depth }) => renderAgentRow(agent, depth))
              .join("")
          : `<div class="pl-6 pr-4 py-2 text-xs text-base16-500 italic">no agents — type <code class="text-base16-orange">@name</code> below</div>`;
      const delBtn =
        p.name === "scratchpad"
          ? ""
          : `<button class="text-base16-500 hover:text-base16-red text-sm ml-1 cursor-pointer" data-project-delete="${escHtml(p.name)}" title="delete project">×</button>`;
      return `
        <div>
          <div class="flex items-center justify-between pl-2 pr-3 py-2 ${isSelected ? "bg-base16-300/30" : ""} hover:bg-base16-300/20">
            <button class="flex-1 flex items-center gap-1.5 text-left cursor-pointer min-w-0" data-project-select="${escHtml(p.name)}">
              <span class="text-base16-500 text-xs w-3 flex-none" data-project-toggle="${escHtml(p.name)}">${arrow}</span>
              <div class="min-w-0 flex-1">
                <div class="text-base text-base16-700 font-bold truncate font-display tracking-wider">${escHtml(p.name)}</div>
                <div class="text-xs text-base16-500 truncate">${subtitle} · ${as.length} agent${as.length === 1 ? "" : "s"}</div>
              </div>
            </button>
            ${delBtn}
          </div>
          ${rowsHtml}
        </div>
      `;
    })
    .join("");

  $agentList.innerHTML = sections;

  $agentList.querySelectorAll("[data-agent-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectAgent(btn.dataset.agentId));
  });
  $agentList.querySelectorAll("[data-project-select]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // If the user clicked the arrow, toggle collapse instead of selecting.
      if (e.target.dataset.projectToggle) {
        toggleProjectCollapsed(e.target.dataset.projectToggle);
        return;
      }
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

/** One-line stats string, same ordering / glyphs as pi's TUI footer:
 *    ↑input ↓output R<cacheRead> W<cacheWrite> $cost  ·  <ctx%>/<ctxWindow>
 *  Context is omitted if we don't know the window; individual token parts
 *  omitted when zero. */
function formatStatsLine(stats) {
  const parts = [];
  const t = stats.tokens;
  if (t.input) parts.push(`↑${formatTokens(t.input)}`);
  if (t.output) parts.push(`↓${formatTokens(t.output)}`);
  if (t.cacheRead) parts.push(`R${formatTokens(t.cacheRead)}`);
  if (t.cacheWrite) parts.push(`W${formatTokens(t.cacheWrite)}`);
  if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
  if (stats.contextWindow) {
    const pct = stats.contextPercent;
    const pctStr = pct == null ? "?" : `${pct.toFixed(1)}%`;
    parts.push(`${pctStr}/${formatTokens(stats.contextWindow)}`);
  }
  if (stats.thinkingLevel && stats.thinkingLevel !== "off" && stats.model?.reasoning) {
    parts.push(`thinking: ${stats.thinkingLevel}`);
  }
  return parts.join("  ");
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
  if (!agent) {
    $agentName.textContent = "select an agent or type @name below";
    $agentStatus.textContent = "";
    $agentInfo.textContent = "";
    $agentStats.textContent = "";
    $agentStats.classList.add("hidden");
    // Hide every action pill when no agent is selected. Until now
    // raw/model/fork stayed visible and competed for layout space with
    // the placeholder agent name, which on a phone caused a 3-line wrap
    // that overlapped the buttons.
    $stopBtn.classList.add("hidden");
    $resumeBtn.classList.add("hidden");
    $deleteBtn.classList.add("hidden");
    $rawBtn.classList.add("hidden");
    $forkBtn.classList.add("hidden");
    $modelBtn.classList.add("hidden");
    $thinkingBtn.classList.add("hidden");
    return;
  }

  // Re-show the always-applicable pills now that we have an agent.
  // (stop/resume/delete still toggle below based on agent state.)
  $rawBtn.classList.remove("hidden");
  $forkBtn.classList.remove("hidden");
  $modelBtn.classList.remove("hidden");
  $thinkingBtn.classList.remove("hidden");

  $agentName.textContent = agent.name;

  const activity = currentActivity[agent.id];
  let statusText = agent.state;
  let statusColorClass = "text-base16-500";
  if (agent.state === "running" && activity) {
    const elapsed = Math.floor((Date.now() - activity.since) / 1000);
    const elapsedStr = elapsed > 1 ? ` · ${elapsed}s` : "";
    statusText = `▶ ${activity.tool}${activity.subtitle ? " · " + activity.subtitle.slice(0, 60) : ""}${elapsedStr}`;
    statusColorClass = "text-base16-cyan";
  } else if (agent.state === "running" || agent.state === "starting") {
    statusText = `${agent.state}…`;
    statusColorClass = "text-base16-green";
  } else if (agent.state === "cloning") {
    statusText = `↥ cloning…`;
    statusColorClass = "text-base16-cyan";
  } else if (agent.state === "waiting_input") {
    statusText = "your turn";
    statusColorClass = "text-base16-orange";
  } else if (agent.state === "idle") {
    statusColorClass = "text-base16-yellow";
  } else if (agent.state === "error") {
    statusText = agent.errorMessage ? `error: ${agent.errorMessage}` : "error";
    statusColorClass = "text-base16-red";
  }
  $agentStatus.textContent = statusText;
  $agentStatus.className = `text-xs font-mono truncate ${statusColorClass}`;

  const parts = [];
  parts.push(agent.projectName);
  parts.push(agent.model || "(default)");
  if (agent.branchName) parts.push(agent.branchName);
  parts.push(shortenPath(agent.worktreePath));
  if (agent.thinkingLevel && agent.thinkingLevel !== "off") {
    parts.push(`thinking: ${agent.thinkingLevel}`);
  }
  if (agent.createdAt) parts.push(relTime(new Date(agent.createdAt).getTime()));
  parts.push(`id: ${agent.id}`);
  $agentInfo.textContent = parts.join(" · ");
  $agentInfo.title = `project: ${agent.projectName}\nworktree: ${agent.worktreePath}`;

  // Live footer-style stats (matches pi's TUI footer): tokens, cost,
  // context %, thinking level. Populated by fetchStats(). Hidden for
  // stopped / errored agents where the server has no live session.
  const stats = statsByAgent[agent.id];
  if (stats) {
    $agentStats.textContent = formatStatsLine(stats);
    $agentStats.classList.remove("hidden");
    // Colorize when context fills up, matching pi's warning/error bands.
    $agentStats.className = `text-[10px] mt-0.5 font-mono truncate ${statsColorClass(stats.contextPercent)}`;
  } else {
    $agentStats.classList.add("hidden");
    $agentStats.textContent = "";
  }

  const running = agent.state !== "stopped";
  $stopBtn.classList.toggle("hidden", !running);
  $resumeBtn.classList.toggle("hidden", agent.state !== "stopped" && agent.state !== "error");
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
const _tmpl = document.createElement("template");

function renderMessages() {
  // Build the desired list of blocks (key + html) for the current state.
  // Placeholders share the same shape so the diff loop below has a single
  // path — no special-cased innerHTML rewrites that would force a flash.
  let blocks;
  if (!selectedAgentId) {
    blocks = [{
      key: PLACEHOLDER_SELECT_KEY,
      html: '<div data-msg-key="placeholder:select" class="text-base16-500 text-xs italic text-center mt-8">select an agent from the sidebar, or type <code class="text-base16-orange">@name your message</code> below</div>',
    }];
  } else {
    const state = stateFor(selectedAgentId);
    const isEmpty =
      state.messages.length === 0 && !state.streamingText && !state.streamingThinking;
    if (isEmpty) {
      blocks = [{
        key: PLACEHOLDER_EMPTY_KEY,
        html: '<div data-msg-key="placeholder:empty" class="text-base16-500 text-xs italic text-center mt-8">no messages yet — send one below</div>',
      }];
    } else {
      blocks = renderTranscriptBlocks(state, expandedItems, { rawAssistant: rawView });
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
  if (id && !historyLoaded[id]) {
    await fetchHistory(id);
  } else {
    renderMessages();
  }
  // Kick off the live footer stats fetch; renderAgentHeader will re-run
  // when the response lands.
  if (id) fetchStats(id);
  // On mobile, the sidebar drawer covers the agent view. Picking an
  // agent should immediately reveal the conversation, not leave the
  // drawer on top of it.
  if (id && isMobileViewport()) closeSidebar();
  // Don't auto-focus the input on mobile — it would summon the on-screen
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
  if (!text) return;

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

  // Optimistic local append so the user sees their message immediately.
  const prev = stateFor(targetId);
  transcriptByAgent[targetId] = {
    ...prev,
    messages: [...prev.messages, { role: "user", content: body, ts: Date.now() }],
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
      body: JSON.stringify({ message: body, mode: modeForThisSend }),
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

/** Build the full list of slash entries (static + skills) annotated with
 *  which kind they are; the popup renders this list directly. */
function allSlashEntries() {
  const entries = SLASH_COMMANDS.map((c) => ({ ...c }));
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
      // api=orange (server-side action), client=green (UI).
      const glyph = e.kind === "skill" ? "◆" : e.kind === "api" ? "▸" : "•";
      const glyphColor =
        e.kind === "skill" ? "text-base16-cyan" : e.kind === "api" ? "text-base16-orange" : "text-base16-green";
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

/** Selecting from the popup either:
 *   - executes immediately (commands with no args), or
 *   - fills the input with `/<name> ` so the user can type args + Enter.
 *  Mirrors pi's TUI behaviour. */
function applySlashSelection() {
  const pick = slashMatches[slashIndex];
  if (!pick) return;
  if (pick.takesArgs) {
    $input.value = `/${pick.name} `;
    closeSlashPopup();
    $input.focus();
    const len = $input.value.length;
    $input.setSelectionRange(len, len);
    autoResize();
  } else {
    closeSlashPopup();
    $input.value = "";
    autoResize();
    void executeSlashCommand(pick.name, "");
  }
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
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      applySlashSelection();
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
$input.addEventListener("blur", () => {
  // Delay so a click inside either popup can fire first.
  setTimeout(() => {
    closeMentionPopup();
    closeSlashPopup();
  }, 150);
});
$newProjectBtn.addEventListener("click", openProjectModal);
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

// --- init ---

updateInputPlaceholder();
connectWs();
