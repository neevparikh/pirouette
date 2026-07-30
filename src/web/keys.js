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
 *   4. vim insert mode — Escape means "go to normal mode" first. Hit it
 *      again from normal mode to interrupt, which is the muscle memory a
 *      vim user already has.
 *   5. Otherwise, if the selected agent is mid-turn, Escape interrupts it.
 *   6. Otherwise Escape does nothing here.
 *
 * Returning a reason as well as an action isn't decoration: Escape is the
 * key most likely to be intercepted before the page ever sees it (browser
 * extensions with their own modal editing bind it), so "Esc does nothing"
 * is ambiguous between "we declined" and "we were never asked". The caller
 * records these decisions on `window.__pirouetteEsc` so the console can
 * tell the two apart.
 *
 * @param {object} state
 * @param {boolean} [state.extUiModalOpen]   extension-UI modal is showing
 * @param {boolean} [state.projectModalOpen] new-project modal is showing
 * @param {boolean} [state.mentionPopupOpen] `@mention` autocomplete is open
 * @param {boolean} [state.slashPopupOpen]   slash-command autocomplete is open
 * @param {boolean} [state.drawerOpen]       a mobile drawer is open
 * @param {boolean} [state.pickerOpen]       model / thinking / theme picker is open
 * @param {boolean} [state.vimInsertMode]    vim is on, focused, and in insert mode
 * @param {boolean} [state.canInterrupt]     selected agent has an in-flight turn
 * @returns {{ action: "interrupt" | "defer", reason: string }}
 */
export function escapeAction(state = {}) {
  if (state.extUiModalOpen) return { action: "defer", reason: "extension-ui-modal" };
  if (state.projectModalOpen) return { action: "defer", reason: "project-modal" };
  if (state.mentionPopupOpen) return { action: "defer", reason: "mention-popup" };
  if (state.slashPopupOpen) return { action: "defer", reason: "slash-popup" };
  if (state.drawerOpen) return { action: "defer", reason: "drawer-open" };
  if (state.pickerOpen) return { action: "defer", reason: "picker-open" };
  if (state.vimInsertMode) return { action: "defer", reason: "vim-insert-mode" };
  if (!state.canInterrupt) return { action: "defer", reason: "nothing-in-flight" };
  return { action: "interrupt", reason: "interrupt" };
}
