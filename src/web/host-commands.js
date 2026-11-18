// Host commands: the sidebar's `host` button and its modal.
//
// The host's config lists shell commands (`[[defaults.host_commands]]`)
// that can be run from here without going through an agent, e.g. renewing
// a login the agents' model provider depends on. The server runs them and
// keeps the output; this module starts/stops them and polls for output
// while the modal is open. See src/server/host-commands.ts.

const POLL_MS = 1000;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Split command output into text and link segments. Only http(s) URLs
 *  become links; punctuation that ends a sentence rather than the URL is
 *  left as text.
 *  @param {string} text
 *  @returns {Array<{ text: string } | { url: string }>} */
export function linkifyOutput(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?]+$/, "");
    // A closing bracket belongs to the prose unless the URL opened one.
    while (/[)\]]$/.test(url)) {
      const [open, close] = url.endsWith(")") ? ["(", ")"] : ["[", "]"];
      if (url.split(open).length > url.split(close).length - 1) break;
      url = url.slice(0, -1);
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** One-line summary of a command's last run.
 *  @returns {{ text: string, tone: "idle" | "running" | "ok" | "error" }} */
export function describeRun(status) {
  if (!status || status.state === "idle") return { text: "not run yet", tone: "idle" };
  if (status.state === "running") return { text: "running…", tone: "running" };
  if (status.timedOut) return { text: "timed out", tone: "error" };
  if (status.stopped) return { text: "stopped", tone: "error" };
  if (status.exitCode === 0) return { text: "finished", tone: "ok" };
  return {
    text: status.exitCode == null ? "failed" : `failed (exit ${status.exitCode})`,
    tone: "error",
  };
}

const TONE_CLASS = {
  idle: "text-base16-500",
  running: "text-base16-blue",
  ok: "text-base16-green",
  error: "text-base16-red",
};

async function api(path, method = "GET") {
  const res = await fetch(path, {
    method,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

/** Wire up the button and modal. The button stays hidden unless the host
 *  has commands configured. */
export function initHostCommands(doc = document) {
  const $btn = doc.getElementById("host-commands-btn");
  const $modal = doc.getElementById("host-commands-modal");
  const $list = doc.getElementById("host-commands-list");
  const $outputLabel = doc.getElementById("host-commands-output-label");
  const $output = doc.getElementById("host-commands-output");
  const $close = doc.getElementById("host-commands-close");
  if (!$btn || !$modal || !$list || !$output || !$close) return;

  /** @type {Array<any>} */
  let commands = [];
  /** Command whose output is shown. */
  let selectedId = null;
  let pollTimer = null;
  let lastOutput = null;

  const isOpen = () => !$modal.classList.contains("hidden");

  function renderList() {
    $list.replaceChildren(
      ...commands.map((c) => {
        const row = doc.createElement("div");
        row.className =
          "flex items-center gap-3 px-3 py-2 rounded-lg bg-base16-100 border " +
          (c.id === selectedId ? "border-base16-blue/60" : "border-base16-300");

        const info = doc.createElement("div");
        info.className = "flex-1 min-w-0 cursor-pointer";
        info.title = "Show this command's output";
        info.addEventListener("click", () => select(c.id));
        const name = doc.createElement("div");
        name.className = "text-sm text-base16-700 truncate";
        name.textContent = c.name;
        info.append(name);
        if (c.description) {
          const desc = doc.createElement("div");
          desc.className = "text-xs text-base16-500";
          desc.textContent = c.description;
          info.append(desc);
        }
        const cmd = doc.createElement("div");
        cmd.className = "text-[10px] text-base16-500 font-mono truncate";
        cmd.textContent = `$ ${c.command}`;
        cmd.title = c.command;
        info.append(cmd);

        const run = describeRun(c);
        const state = doc.createElement("span");
        state.className = `flex-none text-xs font-mono ${TONE_CLASS[run.tone]}`;
        state.textContent = run.text;

        const running = c.state === "running";
        const action = doc.createElement("button");
        action.className =
          "flex-none px-3 py-1 rounded text-xs cursor-pointer " +
          (running
            ? "bg-base16-orange/20 text-base16-orange hover:bg-base16-orange/30"
            : "bg-base16-green/20 text-base16-green hover:bg-base16-green/30");
        action.textContent = running ? "stop" : c.state === "exited" ? "run again" : "run";
        action.addEventListener("click", () => act(c.id, running ? "stop" : "run"));

        row.append(info, state, action);
        return row;
      }),
    );
  }

  function renderOutput(status) {
    const text = status?.output ?? "";
    const shown = status && status.state !== "idle";
    $output.classList.toggle("hidden", !shown);
    $outputLabel?.classList.toggle("hidden", !shown);
    if ($outputLabel && status) $outputLabel.textContent = `output: ${status.name}`;
    const key = `${status?.id}:${status?.startedAt}:${status?.outputTruncated}:${text}`;
    if (!shown || key === lastOutput) return;
    lastOutput = key;
    const atBottom = $output.scrollHeight - $output.scrollTop - $output.clientHeight < 24;
    const nodes = [];
    if (status.outputTruncated) nodes.push(doc.createTextNode("[earlier output dropped]\n"));
    for (const seg of linkifyOutput(text || "(no output yet)")) {
      if ("url" in seg) {
        const a = doc.createElement("a");
        a.href = seg.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "text-base16-blue underline";
        a.textContent = seg.url;
        nodes.push(a);
      } else {
        nodes.push(doc.createTextNode(seg.text));
      }
    }
    $output.replaceChildren(...nodes);
    if (atBottom) $output.scrollTop = $output.scrollHeight;
  }

  function showError(err) {
    lastOutput = null;
    $output.classList.remove("hidden");
    $output.textContent = `✗ ${err instanceof Error ? err.message : err}`;
  }

  function update(status) {
    commands = commands.map((c) => (c.id === status.id ? { ...c, ...status, output: undefined } : c));
    renderList();
    if (status.id === selectedId) renderOutput(status);
  }

  async function refreshSelected() {
    if (!selectedId) return;
    try {
      update((await api(`/api/host-commands/${selectedId}`)).command);
    } catch (err) {
      showError(err);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!isOpen() || !commands.some((c) => c.state === "running")) return;
    pollTimer = setTimeout(async () => {
      await refreshAll();
      schedulePoll();
    }, POLL_MS);
  }

  async function refreshAll() {
    try {
      const fresh = (await api("/api/host-commands")).commands;
      commands = fresh;
      $btn.classList.toggle("hidden", commands.length === 0);
      if (!isOpen()) return;
      if (!selectedId || !commands.some((c) => c.id === selectedId)) {
        // Prefer whatever is running, then whatever ran last.
        const ran = commands.filter((c) => c.state !== "idle");
        const pick =
          ran.find((c) => c.state === "running") ??
          ran.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
        selectedId = pick?.id ?? null;
      }
      renderList();
      if (selectedId) await refreshSelected();
      else renderOutput(null);
    } catch (err) {
      if (isOpen()) showError(err);
    }
  }

  function select(id) {
    selectedId = id;
    lastOutput = null;
    renderList();
    void refreshSelected();
  }

  async function act(id, action) {
    selectedId = id;
    lastOutput = null;
    try {
      update((await api(`/api/host-commands/${id}/${action}`, "POST")).command);
    } catch (err) {
      showError(err);
      await refreshAll();
    }
    schedulePoll();
  }

  async function open() {
    $modal.classList.remove("hidden");
    renderList();
    await refreshAll();
    schedulePoll();
  }

  function close() {
    $modal.classList.add("hidden");
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  $btn.addEventListener("click", () => void open());
  $close.addEventListener("click", close);
  $modal.addEventListener("click", (e) => {
    if (e.target === $modal) close();
  });
  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !isOpen()) return;
      e.stopPropagation();
      close();
    },
    true,
  );

  void refreshAll();
}
