/**
 * Vim-style modal editor for the pirouette message input.
 *
 * Ports the essential behavior of `~/repos/pi-vim/` to a vanilla-JS layer
 * over a `<textarea>`. Like pi-vim, this implements:
 *
 *   - 4 modes: normal, insert, visual, visual-line
 *   - Counts (e.g. `2dd`, `3w`)
 *   - Motions: h j k l 0 ^ $ w W b B e E ge gE gg G % ( ) { } ; , f F t T<char>
 *   - Editing: i I a A o O x X J ~ r<char> dd D cc C yy Y p P
 *   - Operators + motion (dw, c$, y2j, >ip, gUaw, etc.)
 *   - Text objects: iw aw i" a" i' a' i` a` i(/) a(/) i{/} a{/} i[/] a[/]
 *   - Yank / paste with charwise + linewise register semantics
 *   - Undo / redo via u / Ctrl+r (multi-level snapshot stack)
 *
 * The vim layer doesn't own the textarea \u2014 it's just a keydown handler that
 * calls `preventDefault()` when it consumes a key. When disabled, every
 * keystroke flows through to the textarea unchanged.
 *
 * Cursor visualization:
 *   - normal mode  \u2192 select 1 char to render a block-style cursor; if EOL,
 *                  fall back to selecting nothing (caret remains visible)
 *   - visual mode  \u2192 textarea selection from anchor to cursor (inclusive)
 *   - insert mode  \u2192 caret-only (browser default)
 *
 * Registers:
 *   - The "yanked" register is module-local. We also write to the system
 *     clipboard via `navigator.clipboard.writeText` when available, so
 *     yanks are accessible to other apps.
 */

// ---------- char classification ----------------------------------------

/** Match vim's whitespace definition (space, tab, newline). */
function isWS(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Classify a character for small-word boundaries:
 *   0 = whitespace
 *   1 = word char (alnum + underscore)
 *   2 = punctuation / everything else printable
 *
 * `w b e` motions advance/retreat over runs of the same class. This matches
 * vim's default behavior with `iskeyword` set to its standard value.
 */
function smallWordClass(ch) {
  if (isWS(ch)) return 0;
  // Match `[A-Za-z0-9_]` plus common identifier code points (we keep this
  // narrow so that punctuation like `.`, `(`, `-` is class 2).
  if (/[A-Za-z0-9_]/.test(ch)) return 1;
  return 2;
}

/** Big-word: only whitespace breaks the word. Returns 0 (ws) or 1 (word). */
function bigWordClass(ch) {
  return isWS(ch) ? 0 : 1;
}

// ---------- text / cursor helpers --------------------------------------

/**
 * Convert a flat character offset into `{ line, col }`. Lines are 0-indexed,
 * `col` counts UTF-16 code units within the line (which is what textarea
 * APIs use).
 */
function offsetToLineCol(text, offset) {
  let line = 0;
  let lastBreak = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, col: offset - lastBreak - 1 };
}

/** Inverse of offsetToLineCol. Clamps oversized line/col to text bounds. */
function lineColToOffset(text, line, col) {
  const lines = text.split("\n");
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
  let off = 0;
  for (let i = 0; i < clampedLine; i++) off += lines[i].length + 1;
  const lineLen = lines[clampedLine].length;
  return off + Math.max(0, Math.min(col, lineLen));
}

/** Return the [start, end) of the line containing `offset` (excluding the
 *  trailing `\n`). End-of-buffer with no trailing newline returns to
 *  text.length. */
function lineRange(text, offset) {
  let start = offset;
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start -= 1;
  let end = offset;
  while (end < text.length && text.charCodeAt(end) !== 10) end += 1;
  return { start, end };
}

/** Last cursor column on a line in normal/visual mode. Vim places the cursor
 *  *on* the last char of a non-empty line, not after it. For an empty line
 *  the cursor sits at col 0. */
function lastColOnLine(lineText) {
  return lineText.length === 0 ? 0 : lineText.length - 1;
}

// ---------- key parsing -----------------------------------------------

/**
 * Map a `KeyboardEvent` to a normalized token used by the dispatch table.
 *
 * Returns one of:
 *   - a single printable character: `"a"`, `"$"`, `"7"`, etc.
 *   - a special key name: `"Escape"`, `"Enter"`, `"Backspace"`, `"Tab"`,
 *     `"ArrowLeft"`, `"ArrowRight"`, `"ArrowUp"`, `"ArrowDown"`
 *   - `"C-x"`, `"M-x"` for ctrl/alt + key
 *   - `null` if the event isn't useful (modifier-only, or composing IME)
 */
export function parseKeyEvent(e) {
  if (e.isComposing) return null;
  // Modifier-only presses produce key === "Shift"/"Control"/...; ignore.
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
    return null;
  }
  const isCtrl = e.ctrlKey;
  const isMeta = e.metaKey;
  const isAlt = e.altKey;

  // Named keys.
  const namedKeys = new Set([
    "Escape", "Enter", "Backspace", "Tab",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "Home", "End", "PageUp", "PageDown", "Delete",
  ]);
  if (namedKeys.has(e.key)) {
    if (isCtrl) return `C-${e.key}`;
    if (isMeta) return `M-${e.key}`;
    return e.key;
  }

  // Single-char keys. `e.key` is already shifted (`A`, `$`, etc.) so just
  // forward it for printables.
  if (e.key.length === 1) {
    if (isCtrl) return `C-${e.key.toLowerCase()}`;
    if (isMeta) return `M-${e.key.toLowerCase()}`;
    if (isAlt) return `A-${e.key.toLowerCase()}`;
    return e.key;
  }

  return null;
}

// ---------- VimMode class ---------------------------------------------

/**
 * Attach a vim-style modal editing layer to a `<textarea>`. The class owns
 * the keydown handler and a tiny state machine. Public API:
 *
 *   const vim = new VimMode(textarea, { onModeChange, onEnter });
 *   vim.enable();   // start in normal mode
 *   vim.disable();  // remove handler, restore caret
 *   vim.isEnabled()
 *
 * `onModeChange(mode, pendingLabel)` fires after every state transition so
 * the host UI can update a status indicator.
 *
 * `onEnter(text)` fires when the user presses plain Enter in *insert* mode.
 * The host should call this instead of the textarea's own send-on-Enter
 * handler so the message-send semantics are the same regardless of mode.
 * Returning `true` means the host consumed the event (clear the textarea);
 * `false` means leave the newline. (Pirouette always returns true.)
 */
export class VimMode {
  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {{
   *   onModeChange?: (mode: string, pendingLabel: string) => void,
   *   onEnter?: (text: string) => boolean,
   *   shouldSkip?: () => boolean,
   * }} opts
   */
  constructor(textarea, opts = {}) {
    this.textarea = textarea;
    this.onModeChange = opts.onModeChange ?? (() => {});
    this.onEnter = opts.onEnter ?? (() => false);
    /** Predicate: when true, the keydown listener returns immediately, so
     *  another piece of UI (e.g. the @-mention popup) can claim the keys
     *  unmodified. */
    this.shouldSkip = opts.shouldSkip ?? (() => false);

    /** @type {"normal" | "insert" | "visual" | "visual_line"} */
    this.mode = "insert";
    /** Buffered count digits (e.g. "23" while user types `2`,`3`). */
    this.pendingCount = "";
    /** @type {null | "d" | "c" | "y" | ">" | "<" | "g~" | "gu" | "gU"} */
    this.pendingOperator = null;
    /** Count captured when the operator was started (we use this to multiply
     *  with the motion count: `2d3w` deletes 6 small-words). */
    this.pendingOperatorCount = 1;
    /** @type {null | "f" | "F" | "t" | "T"} */
    this.pendingFind = null;
    /** True after `g` is pressed and we expect `g`/`e`/`E`/`U`/`u`/`~`. */
    this.pendingG = false;
    /** True after `r` is pressed; next char replaces. */
    this.pendingReplace = false;
    /** @type {null | "i" | "a"} */
    this.pendingTextObject = null;
    /** @type {null | { type: "f"|"F"|"t"|"T", char: string }} */
    this.lastFind = null;
    /** Anchor offset for visual / visual-line. */
    this.visualAnchor = null;
    /** Internal cursor offset. We can't trust `selectionStart` in visual
     *  mode because the rendered selection range goes anchor<->cursor and
     *  `selectionStart` always reports the smaller end -- the cursor's
     *  actual position would be lost. Track it explicitly so motions like
     *  `vlld` work. */
    this._cursor = 0;
    /** Yank register. `linewise` text always ends with `\n`. */
    this.register = { text: "", type: "charwise" };
    /** @type {{ text: string, cursor: number, mode: string }[]} */
    this.undoStack = [];
    /** @type {{ text: string, cursor: number, mode: string }[]} */
    this.redoStack = [];
    /** Vertical-motion preferred column (vim's "want column"). */
    this.preferredCol = null;

    this._enabled = false;
    this._handler = (e) => this._onKeyDown(e);
    this._selectionHandler = () => this._enforceCursorRendering();
    /** Re-snap cursor to a valid offset whenever the mode requires it. */
    this._mouseUpHandler = () => {
      if (!this._enabled) return;
      // Mouse-click in normal/visual modes \u2014 honor the new caret position
      // but reset modal preferred col (column re-anchors).
      this.preferredCol = null;
      this._syncCursorFromTextarea();
      this._enforceCursorRendering();
    };
  }

  // ---------- public API ----------

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    // capture: true so we run before the host's Enter / @-mention handlers.
    this.textarea.addEventListener("keydown", this._handler, { capture: true });
    this.textarea.addEventListener("mouseup", this._mouseUpHandler);
    this._syncCursorFromTextarea();
    this.mode = "insert";
    this.resetPending();
    this._notifyModeChange();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this.textarea.removeEventListener("keydown", this._handler, { capture: true });
    this.textarea.removeEventListener("mouseup", this._mouseUpHandler);
    this.mode = "insert";
    this.resetPending();
    this._notifyModeChange();
  }

  isEnabled() {
    return this._enabled;
  }

  /** Force-enter normal mode (used by host on focus to hint "this is modal"). */
  enterNormalMode() {
    if (!this._enabled) return;
    this._setMode("normal");
    this._enforceCursorRendering();
  }

  /** Force-enter insert mode (used by host after a message send so the user
   *  is ready to type again -- friendlier than landing in normal mode). */
  enterInsertMode() {
    if (!this._enabled) return;
    this._setMode("insert");
    this._syncCursorFromTextarea();
    const off = this._getCursor();
    this.textarea.setSelectionRange(off, off);
    this.resetPending();
  }

  // ---------- key dispatch ----------

  _onKeyDown(e) {
    if (!this._enabled) return;
    if (this.shouldSkip()) return;

    const key = parseKeyEvent(e);
    if (key === null) return;

    // Common: Escape always returns to normal mode and clears state.
    if (key === "Escape" || key === "C-[") {
      if (this.mode === "insert") {
        this._exitInsertMode();
      } else {
        this.resetPending();
      }
      this._setMode("normal");
      this._enforceCursorRendering();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Insert mode is mostly transparent: let the textarea handle it. We
    // only intercept Enter (so the host can choose to send) and Ctrl+R for
    // redo (vim convention; rare in chat).
    if (this.mode === "insert") {
      if (key === "Enter" && !e.shiftKey) {
        const text = this.textarea.value;
        if (this.onEnter(text)) {
          // Host consumed it; cancel the newline and any browser default.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // host returned false: fall through to default newline insert
      }
      // After every keystroke in insert mode, the textarea moves the caret.
      // Sync our internal cursor so motions starting in normal mode resume
      // from the right place.
      queueMicrotask(() => this._syncCursorFromTextarea());
      return;
    }

    // From here on we're in normal / visual / visual-line mode. Suppress
    // every event so the textarea doesn't handle it.
    e.preventDefault();
    e.stopPropagation();

    if (this.pendingReplace) {
      this._handleReplaceChar(key);
      return;
    }
    if (this.pendingFind) {
      this._handleFindChar(key);
      return;
    }
    if (this.pendingTextObject) {
      this._handleTextObjectOperand(key);
      return;
    }

    if (this.mode === "normal") {
      if (this.pendingOperator) {
        this._handleOperatorPendingInput(key);
        return;
      }
      this._handleNormalInput(key);
      return;
    }

    if (this.mode === "visual" || this.mode === "visual_line") {
      this._handleVisualInput(key);
      return;
    }
  }

  // ---------- state helpers ----------

  resetPending() {
    this.pendingCount = "";
    this.pendingOperator = null;
    this.pendingOperatorCount = 1;
    this.pendingFind = null;
    this.pendingG = false;
    this.pendingReplace = false;
    this.pendingTextObject = null;
    this._notifyModeChange();
  }

  _consumeCount(defaultValue = 1) {
    const c = this.pendingCount === "" ? defaultValue : parseInt(this.pendingCount, 10);
    this.pendingCount = "";
    this._notifyModeChange();
    return c;
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode !== "visual" && mode !== "visual_line") this.visualAnchor = null;
    this._notifyModeChange();
  }

  _notifyModeChange() {
    const pending =
      (this.pendingOperator ?? "") +
      (this.pendingG ? "g" : "") +
      (this.pendingFind ?? "") +
      (this.pendingTextObject ?? "") +
      this.pendingCount +
      (this.pendingReplace ? "r" : "");
    this.onModeChange(this.mode, pending);
  }

  // ---------- cursor & selection mechanics ----------

  /** Read the current cursor offset. We track this internally because the
   *  textarea's `selectionStart` is unreliable in visual mode -- it always
   *  reports the smaller end of the rendered selection, losing the active
   *  cursor side. */
  _getCursor() {
    return this._cursor;
  }

  /** Sync the internal cursor from the textarea (call after a click /
   *  external edit so we reflect the user's actual position). */
  _syncCursorFromTextarea() {
    this._cursor = this.textarea.selectionStart;
  }

  /** Move cursor to absolute offset, clamped. Updates rendering. */
  _setCursor(offset, opts = {}) {
    const t = this.textarea.value;
    this._cursor = Math.max(0, Math.min(offset, t.length));
    if (this.mode === "visual" || this.mode === "visual_line") {
      this._renderVisualSelection(this._cursor);
    } else {
      this._renderNormalCursor(this._cursor);
    }
    if (!opts.preserveColumn) this.preferredCol = null;
  }

  /** In normal mode, render a "block cursor" by selecting 1 char to the
   *  right of the active position. This matches vim's visual feel without
   *  needing a custom overlay. EOL/EOF: select 0-width range so the caret
   *  shows. */
  _renderNormalCursor(offset) {
    const t = this.textarea.value;
    const safe = Math.max(0, Math.min(offset, t.length));
    // If we're on a `\n` or past EOF, don't select anything (selecting `\n`
    // visually highlights the line break which looks weird).
    if (safe < t.length && t.charCodeAt(safe) !== 10 /* \n */) {
      this.textarea.setSelectionRange(safe, safe + 1);
    } else {
      this.textarea.setSelectionRange(safe, safe);
    }
  }

  /** Render visual / visual-line selection from `visualAnchor` to `offset`.
   *  For visual-line, expand to whole-line ranges. */
  _renderVisualSelection(offset) {
    const t = this.textarea.value;
    const anchor = this.visualAnchor ?? offset;
    if (this.mode === "visual_line") {
      const a = lineRange(t, anchor);
      const b = lineRange(t, offset);
      const start = Math.min(a.start, b.start);
      // Include trailing newline so paste-after-line semantics work.
      let end = Math.max(a.end, b.end);
      if (end < t.length && t.charCodeAt(end) === 10) end += 1;
      this.textarea.setSelectionRange(start, end);
    } else {
      // charwise: selection is inclusive of cursor char (vim semantics).
      const lo = Math.min(anchor, offset);
      const hi = Math.max(anchor, offset);
      const endExcl = Math.min(t.length, hi + 1);
      this.textarea.setSelectionRange(lo, endExcl);
    }
  }

  /** Re-render the cursor to match the current mode + selectionStart. */
  _enforceCursorRendering() {
    const off = this._getCursor();
    if (this.mode === "normal") this._renderNormalCursor(off);
    else if (this.mode === "visual" || this.mode === "visual_line") {
      this._renderVisualSelection(off);
    }
  }

  // ---------- snapshots (undo/redo) ----------

  _snapshot() {
    return { text: this.textarea.value, cursor: this._getCursor(), mode: this.mode };
  }

  /** Save state before an edit. Subsequent edits within the same "atom"
   *  (operator+motion) can call _snapshot manually if needed. */
  _pushUndo() {
    const s = this._snapshot();
    const top = this.undoStack[this.undoStack.length - 1];
    // Coalesce no-op snapshots (text + cursor identical).
    if (top && top.text === s.text && top.cursor === s.cursor) return;
    this.undoStack.push(s);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  _undo() {
    const cur = this._snapshot();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cur);
    this.textarea.value = prev.text;
    this._setCursor(prev.cursor);
  }

  _redo() {
    const cur = this._snapshot();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cur);
    this.textarea.value = next.text;
    this._setCursor(next.cursor);
  }

  /** Apply a text edit, snapshotting first. `replace(start, endExclusive,
   *  replacement)` returns the new cursor offset (defaults to start). */
  _applyEdit(start, endExclusive, replacement, opts = {}) {
    this._pushUndo();
    const t = this.textarea.value;
    const before = t.slice(0, start);
    const after = t.slice(endExclusive);
    this.textarea.value = before + replacement + after;
    const newCursor = opts.cursor ?? (start + replacement.length);
    this._setCursor(newCursor);
    // Notify any external listeners (autocomplete) that text changed.
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---------- normal mode handler ----------

  _handleNormalInput(key) {
    // Digit prefix \u2014 builds count. `0` is a motion when no count is buffered.
    if (key.length === 1 && key >= "0" && key <= "9") {
      if (key === "0" && this.pendingCount === "") {
        this._moveToLineStart();
        return;
      }
      this.pendingCount += key;
      this._notifyModeChange();
      return;
    }

    if (this.pendingG) {
      this._handlePendingG(key);
      return;
    }

    switch (key) {
      // ---- motions
      case "h": case "ArrowLeft":  return this._moveHorizontally(this._consumeCount(), -1);
      case "l": case "ArrowRight": return this._moveHorizontally(this._consumeCount(), 1);
      case "j": case "ArrowDown":  return this._moveVertically(this._consumeCount(), 1);
      case "k": case "ArrowUp":    return this._moveVertically(this._consumeCount(), -1);
      case "0": return this._moveToLineStart();
      case "^": return this._moveToFirstNonBlank();
      case "$": return this._moveToLineEnd();
      case "w": return this._moveSmallWordForward(this._consumeCount(), false);
      case "W": return this._moveBigWordForward(this._consumeCount(), false);
      case "b": return this._moveSmallWordBackward(this._consumeCount(), false);
      case "B": return this._moveBigWordBackward(this._consumeCount(), false);
      case "e": return this._moveWordEndForward(this._consumeCount(), false, false);
      case "E": return this._moveWordEndForward(this._consumeCount(), true, false);
      case "G": return this._moveToAbsoluteLine(this._consumeCount(0), "last");
      case "g": this.pendingG = true; this._notifyModeChange(); return;
      case "%": return this._moveToMatchingPair();
      case "(": return this._moveSentenceBackward(this._consumeCount());
      case ")": return this._moveSentenceForward(this._consumeCount());
      case "{": return this._moveParagraphBackward(this._consumeCount());
      case "}": return this._moveParagraphForward(this._consumeCount());
      case "f": case "F": case "t": case "T":
        this.pendingFind = key;
        this._notifyModeChange();
        return;
      case ";": return this._repeatLastFind(false);
      case ",": return this._repeatLastFind(true);

      // ---- entering insert
      case "i": return this._enterInsertHere();
      case "I": return this._enterInsertAtFirstNonBlank();
      case "a": return this._enterInsertAfter();
      case "A": return this._enterInsertAtLineEnd();
      case "o": return this._openLineBelow(this._consumeCount());
      case "O": return this._openLineAbove(this._consumeCount());

      // ---- one-shot edits
      case "x":  return this._deleteCharsForward(this._consumeCount());
      case "X":  return this._deleteCharsBackward(this._consumeCount());
      case "D":  return this._deleteToLineEnd();
      case "C":  this._deleteToLineEnd(); return this._enterInsertHere();
      case "J":  return this._joinLines(this._consumeCount());
      case "~":  return this._toggleCaseAtCursor(this._consumeCount());
      case "r":  this.pendingReplace = true; this._notifyModeChange(); return;
      case "s":  return this._substituteChars(this._consumeCount());
      case "S": case "cc": return this._substituteLines(this._consumeCount());
      case "u":  return this._undo();
      case "C-r": return this._redo();
      case "U":  return this._redo(); // pi-vim alias

      // ---- yank / paste
      case "Y":  return this._yankLines(this._consumeCount());
      case "p":  return this._pasteAfter();
      case "P":  return this._pasteBefore();

      // ---- operators
      case "d":
        this.pendingOperator = "d";
        this.pendingOperatorCount = this._consumeCount();
        this._notifyModeChange();
        return;
      case "c":
        this.pendingOperator = "c";
        this.pendingOperatorCount = this._consumeCount();
        this._notifyModeChange();
        return;
      case "y":
        this.pendingOperator = "y";
        this.pendingOperatorCount = this._consumeCount();
        this._notifyModeChange();
        return;
      case ">":
        this.pendingOperator = ">";
        this.pendingOperatorCount = this._consumeCount();
        this._notifyModeChange();
        return;
      case "<":
        this.pendingOperator = "<";
        this.pendingOperatorCount = this._consumeCount();
        this._notifyModeChange();
        return;

      // ---- visual entry
      case "v":
        this._setMode("visual");
        this.visualAnchor = this._getCursor();
        this._enforceCursorRendering();
        this.resetPending();
        return;
      case "V":
        this._setMode("visual_line");
        this.visualAnchor = this._getCursor();
        this._enforceCursorRendering();
        this.resetPending();
        return;

      default:
        // Unrecognized: clear pending and ignore.
        this.resetPending();
        return;
    }
  }

  _handlePendingG(key) {
    this.pendingG = false;
    switch (key) {
      case "g":  this._moveToAbsoluteLine(this._consumeCount(0), "first"); break;
      case "e":  this._moveWordEndBackward(this._consumeCount(), false); break;
      case "E":  this._moveWordEndBackward(this._consumeCount(), true); break;
      case "u":  this.pendingOperator = "gu"; this.pendingOperatorCount = this._consumeCount(); break;
      case "U":  this.pendingOperator = "gU"; this.pendingOperatorCount = this._consumeCount(); break;
      case "~":  this.pendingOperator = "g~"; this.pendingOperatorCount = this._consumeCount(); break;
      default:
        this.resetPending();
        return;
    }
    this._notifyModeChange();
  }

  // ---------- visual mode handler ----------

  _handleVisualInput(key) {
    // Counts in visual mode work as motion multipliers.
    if (key.length === 1 && key >= "0" && key <= "9") {
      if (key === "0" && this.pendingCount === "") {
        this._moveToLineStart();
        return;
      }
      this.pendingCount += key;
      this._notifyModeChange();
      return;
    }

    if (this.pendingG) {
      this.pendingG = false;
      if (key === "g") this._moveToAbsoluteLine(this._consumeCount(0), "first");
      else if (key === "e") this._moveWordEndBackward(this._consumeCount(), false);
      else if (key === "E") this._moveWordEndBackward(this._consumeCount(), true);
      this._notifyModeChange();
      return;
    }

    if (this.pendingFind) {
      this._handleFindChar(key);
      return;
    }

    switch (key) {
      // motions \u2014 same set as normal mode
      case "h": case "ArrowLeft":  return this._moveHorizontally(this._consumeCount(), -1);
      case "l": case "ArrowRight": return this._moveHorizontally(this._consumeCount(), 1);
      case "j": case "ArrowDown":  return this._moveVertically(this._consumeCount(), 1);
      case "k": case "ArrowUp":    return this._moveVertically(this._consumeCount(), -1);
      case "0": return this._moveToLineStart();
      case "^": return this._moveToFirstNonBlank();
      case "$": return this._moveToLineEnd();
      case "w": return this._moveSmallWordForward(this._consumeCount(), true);
      case "W": return this._moveBigWordForward(this._consumeCount(), true);
      case "b": return this._moveSmallWordBackward(this._consumeCount(), true);
      case "B": return this._moveBigWordBackward(this._consumeCount(), true);
      case "e": return this._moveWordEndForward(this._consumeCount(), false, true);
      case "E": return this._moveWordEndForward(this._consumeCount(), true, true);
      case "G": return this._moveToAbsoluteLine(this._consumeCount(0), "last");
      case "g": this.pendingG = true; this._notifyModeChange(); return;
      case "%": return this._moveToMatchingPair();
      case "(": return this._moveSentenceBackward(this._consumeCount());
      case ")": return this._moveSentenceForward(this._consumeCount());
      case "{": return this._moveParagraphBackward(this._consumeCount());
      case "}": return this._moveParagraphForward(this._consumeCount());
      case "f": case "F": case "t": case "T":
        this.pendingFind = key;
        this._notifyModeChange();
        return;
      case ";": return this._repeatLastFind(false);
      case ",": return this._repeatLastFind(true);

      case "v":
        if (this.mode === "visual") this._setMode("normal");
        else { this._setMode("visual"); }
        this._enforceCursorRendering();
        return;
      case "V":
        if (this.mode === "visual_line") this._setMode("normal");
        else { this._setMode("visual_line"); }
        this._enforceCursorRendering();
        return;

      // operators on the current selection
      case "d": case "x": return this._visualDelete(false);
      case "c":          return this._visualChange();
      case "y":          return this._visualYank();
      case "Y":          this._setMode("visual_line"); this._enforceCursorRendering(); return this._visualYank();
      case "X":          return this._visualLineDelete();
      case "D":          return this._visualLineDelete();
      case ">":          return this._visualIndent(1);
      case "<":          return this._visualIndent(-1);
      case "~":          return this._visualToggleCase();
      case "u":          return this._visualCaseChange("lower");
      case "U":          return this._visualCaseChange("upper");
      case "p": case "P": return this._visualPaste();
      case "o":          return this._visualSwapEnds();

      default:
        return;
    }
  }

  // ---------- find char handler (f/F/t/T) ----------

  _handleFindChar(key) {
    if (key.length !== 1) {
      this.pendingFind = null;
      this._notifyModeChange();
      return;
    }
    const type = this.pendingFind;
    this.pendingFind = null;
    this.lastFind = { type, char: key };
    const count = this._consumeCount();
    this._executeFind(type, key, count);
    this._notifyModeChange();
  }

  _executeFind(type, char, count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const { start, end } = lineRange(t, cursor);
    const forward = type === "f" || type === "t";
    const stopBefore = type === "t" || type === "T";
    let pos = cursor;
    for (let n = 0; n < count; n++) {
      pos = forward ? pos + 1 : pos - 1;
      let found = -1;
      if (forward) {
        for (let i = pos; i < end; i++) {
          if (t[i] === char) { found = i; break; }
        }
      } else {
        for (let i = pos; i >= start; i--) {
          if (t[i] === char) { found = i; break; }
        }
      }
      if (found < 0) return; // no-op on miss
      pos = found;
    }
    if (stopBefore) pos += forward ? -1 : 1;
    this._setCursor(pos);
  }

  _repeatLastFind(reverse) {
    if (!this.lastFind) return;
    const original = this.lastFind.type;
    let type = original;
    if (reverse) {
      // f<->F, t<->T
      type = { f: "F", F: "f", t: "T", T: "t" }[original];
    }
    const count = this._consumeCount();
    this._executeFind(type, this.lastFind.char, count);
    // Restore the original direction so subsequent ; keeps working.
    this.lastFind.type = original;
  }

  // ---------- replace char (r<char>) ----------

  _handleReplaceChar(key) {
    this.pendingReplace = false;
    if (key.length !== 1) {
      this._notifyModeChange();
      return;
    }
    const count = this._consumeCount();
    const cursor = this._getCursor();
    const t = this.textarea.value;
    const end = Math.min(cursor + count, t.length);
    if (end <= cursor) return;
    const replacement = key.repeat(end - cursor);
    this._applyEdit(cursor, end, replacement, { cursor: cursor + replacement.length - 1 });
    this._notifyModeChange();
  }

  // ---------- operator-pending input ----------

  _handleOperatorPendingInput(key) {
    if (key.length === 1 && key >= "0" && key <= "9") {
      if (key === "0" && this.pendingCount === "") {
        this._applyOperatorWithMotion("0");
        return;
      }
      this.pendingCount += key;
      this._notifyModeChange();
      return;
    }
    if (key === "i" || key === "a") {
      this.pendingTextObject = key;
      this._notifyModeChange();
      return;
    }
    // Doubled operator = current line.
    const op = this.pendingOperator;
    if ((op === "d" && key === "d") ||
        (op === "c" && key === "c") ||
        (op === "y" && key === "y") ||
        (op === ">" && key === ">") ||
        (op === "<" && key === "<") ||
        (op === "g~" && key === "~") ||
        (op === "gu" && key === "u") ||
        (op === "gU" && key === "U")) {
      this._applyOperatorToLines();
      return;
    }
    this._applyOperatorWithMotion(key);
  }

  /** Compute the [start, endExcl) range for a motion key starting from
   *  `cursor`. Returns null if motion is unknown / no-op. */
  _rangeForMotion(motion, cursor, count) {
    const t = this.textarea.value;
    if (count <= 0) count = 1;
    switch (motion) {
      case "h": return { start: Math.max(0, cursor - count), end: cursor, linewise: false };
      case "l": return { start: cursor, end: Math.min(t.length, cursor + count), linewise: false };
      case "j": {
        // linewise: include current and next `count` lines
        const cur = lineRange(t, cursor);
        let endLine = cur.end;
        for (let i = 0; i < count; i++) {
          if (endLine >= t.length) break;
          endLine = lineRange(t, endLine + 1).end;
        }
        const endIncl = endLine < t.length ? endLine + 1 : endLine;
        return { start: cur.start, end: endIncl, linewise: true };
      }
      case "k": {
        const cur = lineRange(t, cursor);
        let startLine = cur.start;
        for (let i = 0; i < count; i++) {
          if (startLine <= 0) break;
          startLine = lineRange(t, startLine - 1).start;
        }
        const endIncl = cur.end < t.length ? cur.end + 1 : cur.end;
        return { start: startLine, end: endIncl, linewise: true };
      }
      case "0": return { start: lineRange(t, cursor).start, end: cursor, linewise: false };
      case "^": {
        const lr = lineRange(t, cursor);
        let p = lr.start;
        while (p < lr.end && isWS(t[p])) p++;
        return { start: Math.min(p, cursor), end: Math.max(p, cursor), linewise: false };
      }
      case "$": return { start: cursor, end: lineRange(t, cursor).end, linewise: false };
      case "w": case "W": {
        const big = motion === "W";
        const dest = this._findSmallWordStartForward(t, cursor, count, big);
        return { start: cursor, end: dest, linewise: false };
      }
      case "b": case "B": {
        const big = motion === "B";
        const dest = this._findSmallWordStartBackward(t, cursor, count, big);
        return { start: dest, end: cursor, linewise: false };
      }
      case "e": case "E": {
        const big = motion === "E";
        // d/c/y `e` includes the end char.
        const dest = this._findWordEndForward(t, cursor, count, big);
        return { start: cursor, end: Math.min(t.length, dest + 1), linewise: false };
      }
      case "G": {
        // d/c/y G \u2014 linewise from current line through last (or count'th) line.
        const cur = lineRange(t, cursor);
        const targetLine = this.pendingCount === "" && count === 1
          ? "last"
          : count - 1;
        if (targetLine === "last") {
          return { start: cur.start, end: t.length, linewise: true };
        }
        const lines = t.split("\n");
        const tl = Math.max(0, Math.min(targetLine, lines.length - 1));
        let off = 0;
        for (let i = 0; i < tl; i++) off += lines[i].length + 1;
        const targetEnd = off + lines[tl].length;
        const lo = Math.min(cur.start, off);
        const hi = Math.max(cur.end, targetEnd);
        const finalEnd = hi < t.length ? hi + 1 : hi;
        return { start: lo, end: finalEnd, linewise: true };
      }
      case "gg": {
        const cur = lineRange(t, cursor);
        const lines = t.split("\n");
        const tl = this.pendingCount === "" ? 0 : Math.max(0, count - 1);
        let off = 0;
        for (let i = 0; i < tl; i++) off += lines[i].length + 1;
        const targetEnd = off + (lines[tl] ?? "").length;
        const lo = Math.min(cur.start, off);
        const hi = Math.max(cur.end, targetEnd);
        const finalEnd = hi < t.length ? hi + 1 : hi;
        return { start: lo, end: finalEnd, linewise: true };
      }
      case "{": {
        const dest = this._findParagraphBoundary(t, cursor, -1, count);
        return { start: dest, end: cursor, linewise: false };
      }
      case "}": {
        const dest = this._findParagraphBoundary(t, cursor, 1, count);
        return { start: cursor, end: dest, linewise: false };
      }
      case "f": case "F": case "t": case "T":
        this.pendingFind = motion;
        this.pendingOperator = this.pendingOperator;  // keep operator
        return null;
    }
    return null;
  }

  _handleTextObjectOperand(key) {
    const prefix = this.pendingTextObject;
    this.pendingTextObject = null;
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const range = this._resolveTextObject(t, cursor, prefix, key);
    if (!range) {
      this.resetPending();
      return;
    }
    this._applyOperatorRange(range.start, range.end, range.linewise || false);
  }

  _resolveTextObject(text, cursor, around, key) {
    const inclusive = around === "a";
    if (key === "w") return this._textObjectWord(text, cursor, false, inclusive);
    if (key === "W") return this._textObjectWord(text, cursor, true, inclusive);
    if (key === '"' || key === "'" || key === "`") {
      return this._textObjectQuote(text, cursor, key, inclusive);
    }
    if ("()".includes(key) || key === "b") {
      return this._textObjectPair(text, cursor, "(", ")", inclusive);
    }
    if ("{}".includes(key) || key === "B") {
      return this._textObjectPair(text, cursor, "{", "}", inclusive);
    }
    if ("[]".includes(key)) {
      return this._textObjectPair(text, cursor, "[", "]", inclusive);
    }
    if ("<>".includes(key)) {
      return this._textObjectPair(text, cursor, "<", ">", inclusive);
    }
    return null;
  }

  _textObjectWord(text, cursor, big, around) {
    const cls = big ? bigWordClass : smallWordClass;
    if (cursor >= text.length) return null;
    let curCh = text[cursor];
    if (isWS(curCh)) {
      // start of word object on whitespace = next word
      let s = cursor;
      while (s < text.length && isWS(text[s])) s++;
      if (s >= text.length) return null;
      const c = cls(text[s]);
      let e = s;
      while (e < text.length && cls(text[e]) === c) e++;
      if (around) while (e < text.length && isWS(text[e])) e++;
      return { start: cursor, end: e, linewise: false };
    }
    const c = cls(curCh);
    let s = cursor;
    while (s > 0 && cls(text[s - 1]) === c) s--;
    let e = cursor;
    while (e < text.length && cls(text[e]) === c) e++;
    if (around) {
      // include trailing whitespace, or leading if no trailing
      let e2 = e;
      while (e2 < text.length && isWS(text[e2]) && text[e2] !== "\n") e2++;
      if (e2 > e) e = e2;
      else {
        while (s > 0 && isWS(text[s - 1]) && text[s - 1] !== "\n") s--;
      }
    }
    return { start: s, end: e, linewise: false };
  }

  _textObjectQuote(text, cursor, qChar, around) {
    const lr = lineRange(text, cursor);
    // Find the quote pair on this line that contains or starts at cursor.
    let openIdx = -1, closeIdx = -1;
    let i = lr.start;
    while (i < lr.end) {
      if (text[i] === qChar && (i === lr.start || text[i - 1] !== "\\")) {
        let j = i + 1;
        while (j < lr.end && (text[j] !== qChar || text[j - 1] === "\\")) j++;
        if (j >= lr.end) break;
        if (cursor >= i && cursor <= j) {
          openIdx = i; closeIdx = j; break;
        }
        if (i > cursor) {
          // cursor is before this pair: still take it (vim's i" with cursor
          // outside any pair)
          openIdx = i; closeIdx = j; break;
        }
        i = j + 1;
      } else {
        i += 1;
      }
    }
    if (openIdx < 0) return null;
    if (around) return { start: openIdx, end: closeIdx + 1, linewise: false };
    return { start: openIdx + 1, end: closeIdx, linewise: false };
  }

  _textObjectPair(text, cursor, open, close, around) {
    // Walk outward to find enclosing pair.
    let depth = 0;
    let openIdx = -1;
    for (let i = cursor; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open) {
        if (depth === 0) { openIdx = i; break; }
        depth--;
      }
    }
    if (openIdx < 0) return null;
    depth = 0;
    let closeIdx = -1;
    for (let i = openIdx + 1; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        if (depth === 0) { closeIdx = i; break; }
        depth--;
      }
    }
    if (closeIdx < 0) return null;
    if (around) return { start: openIdx, end: closeIdx + 1, linewise: false };
    return { start: openIdx + 1, end: closeIdx, linewise: false };
  }

  _applyOperatorWithMotion(motion) {
    const motionCount = this._consumeCount();
    const opCount = this.pendingOperatorCount;
    const cursor = this._getCursor();
    const range = this._rangeForMotion(motion, cursor, motionCount * opCount);
    if (range === null) {
      this.resetPending();
      return;
    }
    this._applyOperatorRange(range.start, range.end, range.linewise);
  }

  _applyOperatorToLines() {
    const opCount = this.pendingOperatorCount;
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const cur = lineRange(t, cursor);
    let end = cur.end;
    for (let i = 1; i < opCount; i++) {
      if (end >= t.length) break;
      end = lineRange(t, end + 1).end;
    }
    if (end < t.length) end += 1; // include trailing \n
    this._applyOperatorRange(cur.start, end, true);
  }

  _applyOperatorRange(start, end, linewise) {
    const op = this.pendingOperator;
    const t = this.textarea.value;
    const segment = t.slice(start, end);
    if (op === "d") {
      this._writeRegister(segment, linewise ? "linewise" : "charwise");
      this._applyEdit(start, end, "");
    } else if (op === "c") {
      this._writeRegister(segment, linewise ? "linewise" : "charwise");
      // For linewise change, leave the indent / drop the trailing \n so the
      // user can type the replacement in place.
      if (linewise) {
        // Replace the lines but keep one empty line for typing.
        const replacement = segment.endsWith("\n") ? "\n" : "";
        this._applyEdit(start, end, replacement, { cursor: start });
        this._enterInsertHere();
      } else {
        this._applyEdit(start, end, "");
        this._enterInsertHere();
      }
    } else if (op === "y") {
      this._writeRegister(segment, linewise ? "linewise" : "charwise");
      // Cursor stays at original position (pi-vim behavior: snap to start).
      this._setCursor(start);
    } else if (op === ">") {
      this._indentRange(start, end, 1);
    } else if (op === "<") {
      this._indentRange(start, end, -1);
    } else if (op === "g~") {
      this._applyEdit(start, end, this._toggleCase(segment), { cursor: start });
    } else if (op === "gu") {
      this._applyEdit(start, end, segment.toLowerCase(), { cursor: start });
    } else if (op === "gU") {
      this._applyEdit(start, end, segment.toUpperCase(), { cursor: start });
    }
    this.resetPending();
  }

  _toggleCase(s) {
    let out = "";
    for (const ch of s) {
      const lower = ch.toLowerCase();
      out += ch === lower ? ch.toUpperCase() : lower;
    }
    return out;
  }

  _indentRange(start, end, direction) {
    const t = this.textarea.value;
    const lines = [];
    let i = start;
    while (i < end) {
      const lr = lineRange(t, i);
      lines.push(lr);
      i = lr.end + 1;
      if (lr.end >= end) break;
    }
    const indent = "  "; // 2-space (matches most chat formatting)
    const before = t.slice(0, start);
    let body = "";
    let prev = start;
    for (const lr of lines) {
      body += t.slice(prev, lr.start);
      const lineText = t.slice(lr.start, lr.end);
      let modified;
      if (direction > 0) modified = indent + lineText;
      else {
        modified = lineText.startsWith(indent) ? lineText.slice(2) :
                   lineText.startsWith(" ") ? lineText.slice(1) : lineText;
      }
      body += modified;
      prev = lr.end;
    }
    body += t.slice(prev, end);
    const after = t.slice(end);
    this._pushUndo();
    this.textarea.value = before + body + after;
    this._setCursor(start);
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---------- motions ----------

  _moveHorizontally(count, direction) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    let next = cursor + direction * count;
    next = Math.max(lr.start, Math.min(lr.end, next));
    if (this.mode === "normal") {
      // can't sit on the trailing newline / past EOL
      const maxCol = lr.start + lastColOnLine(t.slice(lr.start, lr.end));
      next = Math.min(next, lr.end - 0);
      if (lr.end - lr.start > 0) next = Math.min(next, maxCol);
    }
    this._setCursor(next);
  }

  _moveVertically(count, direction) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    const curCol = cursor - lr.start;
    const wantCol = this.preferredCol ?? curCol;
    const lines = t.split("\n");
    const { line } = offsetToLineCol(t, cursor);
    const targetLine = Math.max(0, Math.min(lines.length - 1, line + direction * count));
    if (targetLine === line) return;
    const targetLineText = lines[targetLine];
    const maxCol = this.mode === "normal"
      ? lastColOnLine(targetLineText)
      : targetLineText.length;
    const newCol = Math.min(wantCol, maxCol);
    const newOffset = lineColToOffset(t, targetLine, newCol);
    this.preferredCol = wantCol;
    this._setCursor(newOffset, { preserveColumn: true });
  }

  _moveToLineStart() {
    const t = this.textarea.value;
    this._setCursor(lineRange(t, this._getCursor()).start);
  }

  _moveToFirstNonBlank() {
    const t = this.textarea.value;
    const lr = lineRange(t, this._getCursor());
    let i = lr.start;
    while (i < lr.end && isWS(t[i])) i++;
    this._setCursor(i);
  }

  _moveToLineEnd() {
    const t = this.textarea.value;
    const lr = lineRange(t, this._getCursor());
    if (this.mode === "normal" && lr.end > lr.start) {
      this._setCursor(lr.end - 1);
    } else {
      this._setCursor(lr.end);
    }
  }

  _moveToAbsoluteLine(count, fallback) {
    const t = this.textarea.value;
    const lines = t.split("\n");
    const lineIdx =
      count > 0 ? Math.min(count - 1, lines.length - 1)
      : fallback === "first" ? 0
      : lines.length - 1;
    let off = 0;
    for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1;
    // Move to first non-blank like vim.
    const lineText = lines[lineIdx];
    let col = 0;
    while (col < lineText.length && isWS(lineText[col])) col++;
    this._setCursor(off + col);
  }

  _moveSmallWordForward(count, _visual) {
    const t = this.textarea.value;
    const dest = this._findSmallWordStartForward(t, this._getCursor(), count, false);
    this._setCursor(dest);
  }

  _moveBigWordForward(count, _visual) {
    const t = this.textarea.value;
    const dest = this._findSmallWordStartForward(t, this._getCursor(), count, true);
    this._setCursor(dest);
  }

  _moveSmallWordBackward(count, _visual) {
    const t = this.textarea.value;
    const dest = this._findSmallWordStartBackward(t, this._getCursor(), count, false);
    this._setCursor(dest);
  }

  _moveBigWordBackward(count, _visual) {
    const t = this.textarea.value;
    const dest = this._findSmallWordStartBackward(t, this._getCursor(), count, true);
    this._setCursor(dest);
  }

  _moveWordEndForward(count, big, _visual) {
    const t = this.textarea.value;
    const dest = this._findWordEndForward(t, this._getCursor(), count, big);
    this._setCursor(dest);
  }

  _moveWordEndBackward(count, big) {
    const t = this.textarea.value;
    const dest = this._findWordEndBackward(t, this._getCursor(), count, big);
    this._setCursor(dest);
  }

  _findSmallWordStartForward(text, fromIndex, repeats, big) {
    const cls = big ? bigWordClass : smallWordClass;
    let i = Math.max(0, Math.min(fromIndex, text.length));
    for (let n = 0; n < repeats; n++) {
      if (i >= text.length) return text.length;
      const ch = text[i];
      if (isWS(ch)) {
        while (i < text.length && isWS(text[i])) i++;
      } else {
        const c = cls(ch);
        while (i < text.length && cls(text[i]) === c) i++;
        while (i < text.length && isWS(text[i])) i++;
      }
    }
    return i;
  }

  _findSmallWordStartBackward(text, fromIndex, repeats, big) {
    const cls = big ? bigWordClass : smallWordClass;
    let i = Math.max(0, Math.min(fromIndex, text.length));
    for (let n = 0; n < repeats; n++) {
      if (i <= 0) return 0;
      i -= 1;
      while (i >= 0 && isWS(text[i])) i -= 1;
      if (i < 0) return 0;
      const c = cls(text[i]);
      while (i > 0 && cls(text[i - 1]) === c) i -= 1;
    }
    return i;
  }

  _findWordEndForward(text, fromIndex, repeats, big) {
    if (text.length === 0) return 0;
    const cls = big ? bigWordClass : smallWordClass;
    let i = Math.max(0, Math.min(fromIndex, text.length - 1));
    for (let n = 0; n < repeats; n++) {
      i += 1;
      if (i >= text.length) return text.length - 1;
      while (i < text.length && isWS(text[i])) i++;
      if (i >= text.length) return text.length - 1;
      const c = cls(text[i]);
      while (i + 1 < text.length && cls(text[i + 1]) === c) i++;
    }
    return Math.min(i, text.length - 1);
  }

  _findWordEndBackward(text, fromIndex, repeats, big) {
    if (text.length === 0) return 0;
    const cls = big ? bigWordClass : smallWordClass;
    let i = Math.max(0, Math.min(fromIndex, text.length - 1));
    let result = 0;
    for (let n = 0; n < repeats; n++) {
      if (!isWS(text[i])) {
        const c = cls(text[i]);
        while (i >= 0 && cls(text[i]) === c) i--;
      }
      while (i >= 0 && isWS(text[i])) i--;
      if (i < 0) return 0;
      result = i;
      i -= 1;
    }
    return Math.max(0, result);
  }

  _moveToMatchingPair() {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    // Find the first pair on the current line at or after cursor.
    const pairs = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{" };
    let probe = cursor;
    while (probe < lr.end && !pairs[t[probe]]) probe++;
    if (probe >= lr.end) return;
    const open = t[probe];
    const close = pairs[open];
    const forward = open === "(" || open === "[" || open === "{";
    let depth = 0;
    if (forward) {
      for (let i = probe; i < t.length; i++) {
        if (t[i] === open) depth++;
        else if (t[i] === close) {
          depth--;
          if (depth === 0) { this._setCursor(i); return; }
        }
      }
    } else {
      for (let i = probe; i >= 0; i--) {
        if (t[i] === open) depth++;
        else if (t[i] === close) {
          depth--;
          if (depth === 0) { this._setCursor(i); return; }
        }
      }
    }
  }

  /** Find the offset N empty-line boundaries away from `cursor` in
   *  `direction` (1 = forward, -1 = backward). */
  _findParagraphBoundary(text, cursor, direction, count) {
    const lines = text.split("\n");
    const { line } = offsetToLineCol(text, cursor);
    let target = line;
    let remaining = count;
    while (remaining > 0) {
      target += direction;
      if (target < 0 || target >= lines.length) {
        target = direction < 0 ? 0 : lines.length - 1;
        remaining = 0;
        break;
      }
      // count empty (or whitespace-only) lines as paragraph separators.
      if (/^\s*$/.test(lines[target])) remaining--;
    }
    let off = 0;
    for (let i = 0; i < target; i++) off += lines[i].length + 1;
    return off;
  }

  _moveParagraphForward(count) {
    const t = this.textarea.value;
    this._setCursor(this._findParagraphBoundary(t, this._getCursor(), 1, count));
  }

  _moveParagraphBackward(count) {
    const t = this.textarea.value;
    this._setCursor(this._findParagraphBoundary(t, this._getCursor(), -1, count));
  }

  _moveSentenceForward(count) {
    const t = this.textarea.value;
    let i = this._getCursor();
    for (let n = 0; n < count; n++) {
      // advance past current sentence-ending punctuation, then to next
      // non-whitespace char after `.!?` followed by space/eol.
      let found = -1;
      for (let j = i + 1; j < t.length - 1; j++) {
        if (".!?".includes(t[j]) && (isWS(t[j + 1]) || t[j + 1] === "\n")) {
          let k = j + 1;
          while (k < t.length && isWS(t[k])) k++;
          if (k < t.length) { found = k; break; }
        }
      }
      if (found < 0) { i = t.length; break; }
      i = found;
    }
    this._setCursor(i);
  }

  _moveSentenceBackward(count) {
    const t = this.textarea.value;
    let i = this._getCursor();
    for (let n = 0; n < count; n++) {
      let found = -1;
      for (let j = i - 2; j >= 0; j--) {
        if (".!?".includes(t[j]) && (j + 1 >= t.length || isWS(t[j + 1]))) {
          let k = j + 1;
          while (k < t.length && isWS(t[k])) k++;
          if (k < i) { found = k; break; }
        }
      }
      if (found < 0) { i = 0; break; }
      i = found;
    }
    this._setCursor(i);
  }

  // ---------- editing ----------

  _enterInsertHere() {
    this._setMode("insert");
    const off = this._getCursor();
    this._cursor = off;
    this.textarea.setSelectionRange(off, off);
    this.resetPending();
  }

  _enterInsertAfter() {
    const t = this.textarea.value;
    const off = this._getCursor();
    const lr = lineRange(t, off);
    const next = Math.min(off + 1, lr.end);
    this._setMode("insert");
    this._cursor = next;
    this.textarea.setSelectionRange(next, next);
    this.resetPending();
  }

  _enterInsertAtFirstNonBlank() {
    this._moveToFirstNonBlank();
    this._enterInsertHere();
  }

  _enterInsertAtLineEnd() {
    const t = this.textarea.value;
    const lr = lineRange(t, this._getCursor());
    this._setMode("insert");
    this._cursor = lr.end;
    this.textarea.setSelectionRange(lr.end, lr.end);
    this.resetPending();
  }

  _exitInsertMode() {
    // Clamp cursor to last col on the line (vim semantics).
    const t = this.textarea.value;
    const off = this._getCursor();
    const lr = lineRange(t, off);
    if (off > lr.start && off === lr.end && lr.end > lr.start) {
      this._setCursor(off - 1);
    }
  }

  _openLineBelow(count) {
    const t = this.textarea.value;
    const lr = lineRange(t, this._getCursor());
    const insertion = "\n".repeat(count);
    this._applyEdit(lr.end, lr.end, insertion, { cursor: lr.end + 1 });
    this._setMode("insert");
    this.resetPending();
  }

  _openLineAbove(count) {
    const t = this.textarea.value;
    const lr = lineRange(t, this._getCursor());
    const insertion = "\n".repeat(count);
    this._applyEdit(lr.start, lr.start, insertion, { cursor: lr.start });
    this._setMode("insert");
    this.resetPending();
  }

  _deleteCharsForward(count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    const end = Math.min(cursor + count, lr.end);
    if (end <= cursor) return;
    const segment = t.slice(cursor, end);
    this._writeRegister(segment, "charwise");
    let newCursor = cursor;
    if (newCursor >= lr.end - (end - cursor) && newCursor > lr.start) {
      newCursor = Math.max(lr.start, lr.end - (end - cursor) - 1);
    }
    this._applyEdit(cursor, end, "", { cursor: newCursor });
  }

  _deleteCharsBackward(count) {
    const cursor = this._getCursor();
    const t = this.textarea.value;
    const lr = lineRange(t, cursor);
    const start = Math.max(lr.start, cursor - count);
    if (start >= cursor) return;
    const segment = t.slice(start, cursor);
    this._writeRegister(segment, "charwise");
    this._applyEdit(start, cursor, "", { cursor: start });
  }

  _deleteToLineEnd() {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    const segment = t.slice(cursor, lr.end);
    if (!segment) return;
    this._writeRegister(segment, "charwise");
    let newCursor = cursor;
    if (cursor >= lr.start && cursor > lr.start && lr.end - lr.start > segment.length) {
      newCursor = cursor - 1;
    }
    this._applyEdit(cursor, lr.end, "", { cursor: Math.max(lr.start, newCursor) });
  }

  _joinLines(count) {
    const t = this.textarea.value;
    let cursor = this._getCursor();
    const repeats = Math.max(1, count - 1) || 1;
    this._pushUndo();
    let buf = t;
    for (let i = 0; i < repeats; i++) {
      const lr = lineRange(buf, cursor);
      if (lr.end >= buf.length) break;
      // Find end of next line's leading whitespace.
      const nextStart = lr.end + 1;
      let trimEnd = nextStart;
      while (trimEnd < buf.length && (buf[trimEnd] === " " || buf[trimEnd] === "\t")) {
        trimEnd++;
      }
      const before = buf.slice(0, lr.end);
      const sep = (before.endsWith(" ") || trimEnd >= buf.length || buf[trimEnd] === "\n")
        ? "" : " ";
      buf = before + sep + buf.slice(trimEnd);
      cursor = lr.end; // cursor sits on the joined-space
    }
    this.textarea.value = buf;
    this._setCursor(cursor);
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  _toggleCaseAtCursor(count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    const end = Math.min(cursor + count, lr.end);
    if (end <= cursor) return;
    const segment = this._toggleCase(t.slice(cursor, end));
    this._applyEdit(cursor, end, segment, { cursor: Math.min(end, lr.end - 1) });
  }

  _substituteChars(count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    const end = Math.min(cursor + count, lr.end);
    if (end <= cursor) {
      this._enterInsertHere();
      return;
    }
    const segment = t.slice(cursor, end);
    this._writeRegister(segment, "charwise");
    this._applyEdit(cursor, end, "");
    this._enterInsertHere();
  }

  _substituteLines(count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    let end = lr.end;
    for (let i = 1; i < count; i++) {
      if (end >= t.length) break;
      end = lineRange(t, end + 1).end;
    }
    if (end < t.length) end += 1;
    const segment = t.slice(lr.start, end);
    this._writeRegister(segment, "linewise");
    this._applyEdit(lr.start, end, "", { cursor: lr.start });
    this._enterInsertHere();
  }

  // ---------- yank / paste ----------

  _yankLines(count) {
    const t = this.textarea.value;
    const cursor = this._getCursor();
    const lr = lineRange(t, cursor);
    let end = lr.end;
    for (let i = 1; i < count; i++) {
      if (end >= t.length) break;
      end = lineRange(t, end + 1).end;
    }
    if (end < t.length) end += 1;
    const segment = t.slice(lr.start, end);
    this._writeRegister(segment, "linewise");
    this.resetPending();
  }

  _writeRegister(text, type) {
    if (type === "linewise" && !text.endsWith("\n")) text += "\n";
    this.register = { text, type };
    if (text && navigator.clipboard?.writeText) {
      // Best-effort \u2014 some browsers reject without user gesture; ignore.
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  _pasteAfter() {
    const { text, type } = this.register;
    if (!text) return;
    const cursor = this._getCursor();
    const t = this.textarea.value;
    if (type === "linewise") {
      const lr = lineRange(t, cursor);
      const insertAt = lr.end < t.length ? lr.end + 1 : lr.end;
      const padding = lr.end >= t.length && !t.endsWith("\n") ? "\n" : "";
      this._applyEdit(insertAt, insertAt, padding + text, { cursor: insertAt + padding.length });
    } else {
      const insertAt = Math.min(t.length, cursor + 1);
      this._applyEdit(insertAt, insertAt, text, { cursor: insertAt + text.length - 1 });
    }
  }

  _pasteBefore() {
    const { text, type } = this.register;
    if (!text) return;
    const cursor = this._getCursor();
    const t = this.textarea.value;
    if (type === "linewise") {
      const lr = lineRange(t, cursor);
      this._applyEdit(lr.start, lr.start, text, { cursor: lr.start });
    } else {
      this._applyEdit(cursor, cursor, text, { cursor: cursor + text.length - 1 });
    }
  }

  // ---------- visual mode ops ----------

  _selectionRange() {
    const a = this.visualAnchor ?? this._getCursor();
    const b = this._getCursor();
    const t = this.textarea.value;
    if (this.mode === "visual_line") {
      const ar = lineRange(t, a);
      const br = lineRange(t, b);
      const start = Math.min(ar.start, br.start);
      let end = Math.max(ar.end, br.end);
      if (end < t.length) end += 1;
      return { start, end, linewise: true };
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return { start: lo, end: Math.min(t.length, hi + 1), linewise: false };
  }

  _visualDelete(_keepInsert) {
    const r = this._selectionRange();
    const t = this.textarea.value;
    this._writeRegister(t.slice(r.start, r.end), r.linewise ? "linewise" : "charwise");
    this._applyEdit(r.start, r.end, "");
    this._setMode("normal");
  }

  _visualLineDelete() {
    if (this.mode !== "visual_line") {
      this._setMode("visual_line");
      this._enforceCursorRendering();
    }
    this._visualDelete();
  }

  _visualChange() {
    const r = this._selectionRange();
    const t = this.textarea.value;
    this._writeRegister(t.slice(r.start, r.end), r.linewise ? "linewise" : "charwise");
    if (r.linewise) {
      this._applyEdit(r.start, r.end, "\n", { cursor: r.start });
    } else {
      this._applyEdit(r.start, r.end, "", { cursor: r.start });
    }
    this._enterInsertHere();
  }

  _visualYank() {
    const r = this._selectionRange();
    const t = this.textarea.value;
    this._writeRegister(t.slice(r.start, r.end), r.linewise ? "linewise" : "charwise");
    this._setMode("normal");
    this._setCursor(r.start);
  }

  _visualIndent(direction) {
    const r = this._selectionRange();
    this._indentRange(r.start, r.end, direction);
    this._setMode("normal");
  }

  _visualToggleCase() {
    const r = this._selectionRange();
    const t = this.textarea.value;
    this._applyEdit(r.start, r.end, this._toggleCase(t.slice(r.start, r.end)), { cursor: r.start });
    this._setMode("normal");
  }

  _visualCaseChange(which) {
    const r = this._selectionRange();
    const t = this.textarea.value;
    const seg = t.slice(r.start, r.end);
    const next = which === "upper" ? seg.toUpperCase() : seg.toLowerCase();
    this._applyEdit(r.start, r.end, next, { cursor: r.start });
    this._setMode("normal");
  }

  _visualPaste() {
    const r = this._selectionRange();
    const t = this.textarea.value;
    const old = t.slice(r.start, r.end);
    // Replace selection with register, but capture old to register so this
    // is swap-friendly (vim's "p in visual" exchange behavior).
    const { text, type } = this.register;
    this._applyEdit(r.start, r.end, text, { cursor: r.start });
    this._writeRegister(old, r.linewise ? "linewise" : "charwise");
    this._setMode("normal");
  }

  _visualSwapEnds() {
    if (this.visualAnchor === null) return;
    const cur = this._getCursor();
    const newCur = this.visualAnchor;
    this.visualAnchor = cur;
    this._setCursor(newCur);
  }
}
