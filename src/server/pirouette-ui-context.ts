/** ExtensionUIContext for pirouette: bridges pi extensions (notably
 *  pi-cas-provider's AskUserQuestion) to the web dashboard via the
 *  existing WebSocket.
 *
 *  # Why
 *
 *  By default `createAgentSession()` leaves the extension runner's UI
 *  slot empty, so the SDK falls back to `noOpUIContext` — every UI
 *  primitive returns `undefined` / `false` and `ctx.hasUI` is `false`.
 *  Extensions that depend on user input (most prominently
 *  `pi-cas-provider`'s `AskUserQuestion` handler) bail out with a
 *  "no-ui-available" deny, and the model never gets a real answer.
 *
 *  This module implements the prompt-the-user primitives (`select`,
 *  `confirm`, `input`), the fire-and-forget primitives (`notify`,
 *  `setStatus`, `setTitle`, `setWidget` with string-array content), and
 *  stubs the TUI-only ones (`custom`, `editor`, `setEditorComponent`,
 *  `setFooter`, `setHeader`, `pasteToEditor`, theme management) as
 *  no-ops — matching what the SDK's `rpc-mode.js` does for the same
 *  shape.
 *
 *  # Flow
 *
 *  Extension calls `ctx.ui.select(title, options)` →
 *    1. We mint a `requestId`, register a pending entry on `host` (the
 *       AgentManager), and emit `extension_ui_request` over the WS.
 *    2. Browser renders a modal, user picks → posts back
 *       `extension_ui_response` with `{ requestId, value }`.
 *    3. Server's WS message handler calls `host.resolveUIResponse(...)`
 *       which finds the pending entry and resolves the Promise.
 *
 *  Cancellation: if the caller passes a `signal` (and the SDK does pass
 *  the per-tool signal through for `canUseTool` calls), abort triggers
 *  `host.cancelUIRequest(requestId)`, which rejects the awaiting
 *  Promise (translating into `undefined` for select/input and `false`
 *  for confirm — matching the SDK's documented "user cancelled"
 *  semantics) and broadcasts an `extension_ui_cancel` so any open
 *  modal in any browser tab closes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

import type { ExtensionUIRequest, WsEnvelope } from "./types.js";

/** ExtensionUIContext.theme is a `Theme` instance — a TUI-only object
 *  that the SDK uses to render ANSI colors. Pirouette has no terminal,
 *  and the SDK's internal `theme` singleton is not exported through the
 *  package's `exports` map. We could `new Theme(...)` with explicit
 *  color tables, but every known extension that uses pirouette today
 *  (pi-cas-provider, pi-hawk-provider) doesn't read `ctx.ui.theme` at
 *  all — the field exists for TUI extensions that want to style their
 *  own custom components. So we surface a Proxy that throws on any
 *  access: extensions get a clear error rather than silent wrong
 *  rendering if some future code tries to actually use it. */
const PIROUETTE_THEME_PROXY = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `pirouette ExtensionUIContext.theme is not implemented (no TUI). ` +
          `Accessed property: ${String(prop)}`,
      );
    },
  },
) as Theme;

/** Per-pending-request bookkeeping kept inside AgentManager. The UI
 *  context closes over `host` (which exposes a small surface for
 *  registering and cancelling requests) so it never has to import the
 *  AgentManager itself — keeps the dependency direction one-way. */
export interface PendingUIRequest {
  agentId: string;
  request: ExtensionUIRequest;
  resolve: (value: string | string[] | boolean | undefined) => void;
  reject: (err: Error) => void;
  /** Cleanup hook — removes the AbortSignal listener and the pending
   *  entry from the host map. Called from both the response and cancel
   *  paths, so it MUST be idempotent. */
  cleanup: () => void;
}

/** What the UI context needs from its host (AgentManager). Keeping this
 *  narrow makes the module easy to unit-test with a fake host. */
export interface UIContextHost {
  /** Add a pending request to the host's map and broadcast an
   *  `extension_ui_request` envelope. */
  registerRequest(entry: PendingUIRequest): void;
  /** Broadcast a fire-and-forget envelope (notify / status / etc.). */
  broadcast(envelope: WsEnvelope): void;
  /** Generate a unique request id. Injected for testability. */
  newRequestId(): string;
}

/** Construct a per-agent ExtensionUIContext. The same `host` is shared
 *  across every agent; each agent's UI context only differs in the
 *  `agentId` it stamps onto outbound envelopes. */
export function createPirouetteUIContext(
  agentId: string,
  host: UIContextHost,
): ExtensionUIContext {
  function awaitResponse<T extends string | string[] | boolean>(
    request: ExtensionUIRequest,
    opts: { signal?: AbortSignal; timeout?: number } | undefined,
    onTimeoutOrCancel: T | undefined,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;
      const settle = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onAbort = () => {
        // Signal-driven cancel: degrade to the dialog's "cancelled"
        // sentinel (undefined for select/input, false for confirm) so
        // the caller sees the same shape the noOp / RPC modes give.
        host.broadcast({ kind: "extension_ui_cancel", agentId, requestId: request.requestId });
        settle(onTimeoutOrCancel);
      };
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (opts?.signal) {
          try {
            opts.signal.removeEventListener("abort", onAbort);
          } catch {
            /* ignore */
          }
        }
        if (timer) clearTimeout(timer);
      };

      if (opts?.signal?.aborted) {
        // Aborted before we even registered — short-circuit. Still
        // broadcast a cancel so any racing client modal closes.
        host.broadcast({ kind: "extension_ui_cancel", agentId, requestId: request.requestId });
        settle(onTimeoutOrCancel);
        return;
      }
      if (opts?.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          host.broadcast({ kind: "extension_ui_cancel", agentId, requestId: request.requestId });
          settle(onTimeoutOrCancel);
        }, opts.timeout);
      }

      host.registerRequest({
        agentId,
        request,
        resolve: (value) => settle(value as T | undefined),
        reject: (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
        cleanup,
      });
    });
  }

  return {
    select: (title, options, opts) => {
      const req: ExtensionUIRequest = {
        requestId: host.newRequestId(),
        method: "select",
        title,
        options: options.map((label) => ({ label })),
      };
      return awaitResponse<string>(req, opts, undefined);
    },
    confirm: (title, message, opts) => {
      const req: ExtensionUIRequest = {
        requestId: host.newRequestId(),
        method: "confirm",
        title,
        message,
      };
      // confirm's cancel sentinel is `false` per SDK convention (see
      // rpc-mode.js createExtensionUIContext.confirm); return type
      // excludes undefined.
      return awaitResponse<boolean>(req, opts, false).then((v) => v ?? false);
    },
    input: (title, placeholder, opts) => {
      const req: ExtensionUIRequest = {
        requestId: host.newRequestId(),
        method: "input",
        title,
        placeholder,
      };
      return awaitResponse<string>(req, opts, undefined);
    },
    notify(message, type) {
      host.broadcast({
        kind: "extension_ui_notify",
        agentId,
        message,
        notifyType: type,
      });
    },
    setStatus(key, text) {
      host.broadcast({
        kind: "extension_ui_status",
        agentId,
        statusKey: key,
        statusText: text ?? null,
      });
    },
    setTitle(_title) {
      // No-op: pirouette's web UI doesn't have a per-agent terminal
      // title concept. If we add one, this becomes another envelope.
    },

    // ---- TUI-only no-ops -------------------------------------------------
    // These exist for type conformance; the pi-cas patch teaches its
    // AskUserQuestion path to fall back from `custom` to `select` when
    // `custom` returns undefined synchronously (the no-op signature).

    onTerminalInput() {
      return () => {};
    },
    setWorkingMessage(_message) {},
    setWorkingVisible(_visible) {},
    setWorkingIndicator(_options) {},
    setHiddenThinkingLabel(_label) {},
    setWidget(_key, _content, _options) {
      // We could surface widgets in the web UI eventually; today the
      // dashboard has no slot for them. Drop on the floor.
    },
    setFooter(_factory) {},
    setHeader(_factory) {},
    async custom() {
      // TUI-only — returning undefined here is the documented signal to
      // the pi-cas fallback path that we don't host a TUI overlay.
      return undefined as never;
    },
    pasteToEditor(_text) {},
    setEditorText(_text) {},
    getEditorText() {
      return "";
    },
    async editor(_title, _prefill) {
      return undefined;
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return PIROUETTE_THEME_PROXY;
    },
    getAllThemes() {
      return [];
    },
    getTheme(_name) {
      return undefined;
    },
    setTheme(_theme) {
      return { success: false, error: "Theme switching not supported in pirouette" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded(_expanded) {},
  };
}
