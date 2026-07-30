// src/web/keys.js
//
// Keyboard-arbitration helpers for the dashboard. Extracted from app.js so
// the precedence rules are a pure function that can be unit-tested without
// standing up the whole page.

/**
 * Decide what the Escape key means right now.
 *
 * Escape is heavily overloaded in the dashboard, so exactly one consumer
 * gets it per press. The rule, in order:
 *
 *   1. A modal is up (extension UI, new-project) — Escape cancels the modal.
 *   2. An autocomplete popup is open (`@mention` / slash) — Escape closes it.
 *   3. A mobile drawer or a picker (model / thinking / theme) is open —
 *      Escape closes that.
 *   4. Otherwise, if the selected agent is mid-turn, Escape interrupts it.
 *   5. Otherwise Escape belongs to whoever else wants it (notably vim's
 *      insert → normal transition).
 *
 * Note what is deliberately absent: vim's mode. While a turn is in flight
 * the interrupt outranks vim, mirroring pi's TUI, where the editor never
 * sees Escape while the session is streaming — the abort handler takes it
 * first. Letting insert mode win instead produced the worst of both worlds:
 * the agent kept running *and* the composer dropped into normal mode, so
 * the key appeared to do nothing except make the box unusable. Vim users
 * mid-turn can still reach normal mode with `Ctrl+[`, which this handler
 * ignores.
 *
 * @param {object} state
 * @param {boolean} [state.extUiModalOpen]   extension-UI modal is showing
 * @param {boolean} [state.projectModalOpen] new-project modal is showing
 * @param {boolean} [state.mentionPopupOpen] `@mention` autocomplete is open
 * @param {boolean} [state.slashPopupOpen]   slash-command autocomplete is open
 * @param {boolean} [state.drawerOpen]       a mobile drawer is open
 * @param {boolean} [state.pickerOpen]       model / thinking / theme picker is open
 * @param {boolean} [state.canInterrupt]     selected agent has an in-flight turn
 * @returns {"interrupt" | "defer"} `"interrupt"` when this press should
 *   abort the current turn (and be swallowed so nothing else reacts to it),
 *   `"defer"` when Escape belongs to another consumer.
 */
export function escapeAction(state = {}) {
  if (state.extUiModalOpen) return "defer";
  if (state.projectModalOpen) return "defer";
  if (state.mentionPopupOpen) return "defer";
  if (state.slashPopupOpen) return "defer";
  if (state.drawerOpen) return "defer";
  if (state.pickerOpen) return "defer";
  if (state.canInterrupt) return "interrupt";
  return "defer";
}
