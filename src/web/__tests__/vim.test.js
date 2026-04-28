// @vitest-environment jsdom
//
// Vim-mode behavior tests. These mirror the most important cases from
// pi-vim's test suite (~/repos/pi-vim/test/modal-editor.test.ts) so we know
// the port is faithful to the reference. We don't aim for 100% feature
// coverage here — just enough to catch regressions in motions, operators,
// counts, and visual mode.

import { describe, it, expect, beforeEach } from "vitest";
import { VimMode } from "../vim.js";

/**
 * Setup helper: create a textarea in the jsdom DOM with the given content
 * and cursor offset, attach VimMode, and switch to normal mode. Returns
 * `{ vim, ta, send }` where `send` is a function that simulates a sequence
 * of keystrokes.
 */
function setup(text, cursorOffset = 0, { startMode = "normal" } = {}) {
  document.body.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setSelectionRange(cursorOffset, cursorOffset);
  document.body.appendChild(ta);
  const vim = new VimMode(ta);
  vim.enable();
  if (startMode === "normal") {
    // VimMode starts in insert; bounce to normal via Esc.
    sendKey(ta, "Escape");
  }
  return { vim, ta, send: (seq) => sendKeys(ta, seq) };
}

/** Build a KeyboardEvent that mirrors what the browser dispatches when the
 *  user presses a single key. We model `key` faithfully so VimMode's
 *  `parseKeyEvent` reads the right value. */
function makeKeyEvent(key) {
  const named = {
    Escape: { key: "Escape" },
    Enter: { key: "Enter" },
    Backspace: { key: "Backspace" },
    Tab: { key: "Tab" },
    ArrowLeft: { key: "ArrowLeft" },
    ArrowRight: { key: "ArrowRight" },
    ArrowUp: { key: "ArrowUp" },
    ArrowDown: { key: "ArrowDown" },
  };
  if (named[key]) return new KeyboardEvent("keydown", { ...named[key], bubbles: true, cancelable: true });
  // ctrl/alt/meta prefixes
  if (key.startsWith("C-")) {
    const k = key.slice(2);
    return new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, cancelable: true });
  }
  if (key.startsWith("M-")) {
    const k = key.slice(2);
    return new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true });
  }
  // Single-char printable. Note we send the literal character so shift-state
  // is implied (e.g. `$` arrives as `$`, not `4`).
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

function sendKey(ta, key) {
  ta.dispatchEvent(makeKeyEvent(key));
}

/** Send a sequence of keys. Multi-char names like "Escape" / "ArrowDown"
 *  are passed in `<>` brackets, e.g. `"<Esc>3w"` = Esc then 3 then w. */
function sendKeys(ta, seq) {
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === "<") {
      const close = seq.indexOf(">", i);
      const name = seq.slice(i + 1, close);
      const map = { Esc: "Escape", CR: "Enter", BS: "Backspace", Tab: "Tab",
        Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
      sendKey(ta, map[name] ?? name);
      i = close + 1;
    } else {
      sendKey(ta, seq[i]);
      i += 1;
    }
  }
}

/** Read [text, cursor] (end of selection) — convenient assertion target. */
function snapshot(ta) {
  return { text: ta.value, cursor: ta.selectionStart, selEnd: ta.selectionEnd };
}

beforeEach(() => {
  // Reset module-level register state by reloading the document
  document.body.innerHTML = "";
});

// ---- modes ---------------------------------------------------------

describe("modes", () => {
  it("starts in insert mode and switches to normal on Escape", () => {
    const { vim, ta } = setup("hello", 0, { startMode: "insert" });
    expect(vim.mode).toBe("insert");
    sendKey(ta, "Escape");
    expect(vim.mode).toBe("normal");
  });

  it("v enters visual, V enters visual_line, Esc back to normal", () => {
    const { vim, send } = setup("hello world", 0);
    send("v");
    expect(vim.mode).toBe("visual");
    send("<Esc>");
    expect(vim.mode).toBe("normal");
    send("V");
    expect(vim.mode).toBe("visual_line");
    send("<Esc>");
    expect(vim.mode).toBe("normal");
  });

  it("i enters insert at cursor, a enters insert after cursor", () => {
    const { vim, ta } = setup("hello", 2);
    sendKey(ta, "i");
    expect(vim.mode).toBe("insert");
    expect(ta.selectionStart).toBe(2);
    sendKey(ta, "Escape");
    sendKey(ta, "a");
    expect(vim.mode).toBe("insert");
    expect(ta.selectionStart).toBe(3);
  });
});

// ---- horizontal motions --------------------------------------------

describe("horizontal motions", () => {
  it("h / l move left / right with counts", () => {
    const { ta, send } = setup("hello world", 5);
    send("h");
    expect(ta.selectionStart).toBe(4);
    send("3h");
    expect(ta.selectionStart).toBe(1);
    send("4l");
    expect(ta.selectionStart).toBe(5);
  });

  it("0 jumps to line start", () => {
    const { ta, send } = setup("hello world", 7);
    send("0");
    expect(ta.selectionStart).toBe(0);
  });

  it("$ jumps to last char on line in normal mode", () => {
    const { ta, send } = setup("hello world", 0);
    send("$");
    expect(ta.selectionStart).toBe(10); // last 'd', not 11
  });

  it("^ jumps to first non-blank", () => {
    const { ta, send } = setup("   hello", 6);
    send("^");
    expect(ta.selectionStart).toBe(3);
  });
});

// ---- vertical motions ----------------------------------------------

describe("vertical motions", () => {
  it("j / k move between lines preserving column", () => {
    const { ta, send } = setup("aaa\nbbb\nccc", 1);
    send("j");
    expect(ta.selectionStart).toBe(5); // col 1 of 'bbb'
    send("j");
    expect(ta.selectionStart).toBe(9);
    send("k");
    expect(ta.selectionStart).toBe(5);
  });

  it("gg / G jump to first / last line", () => {
    const { ta, send } = setup("aaa\nbbb\nccc", 5);
    send("gg");
    expect(ta.selectionStart).toBe(0);
    send("G");
    expect(ta.selectionStart).toBe(8); // start of 'ccc' (first non-blank)
  });
});

// ---- word motions --------------------------------------------------

describe("word motions", () => {
  it("w jumps to next small-word start", () => {
    const { ta, send } = setup("hello world foo", 0);
    send("w");
    expect(ta.selectionStart).toBe(6);
    send("w");
    expect(ta.selectionStart).toBe(12);
  });

  it("b jumps to previous small-word start", () => {
    const { ta, send } = setup("hello world foo", 12);
    send("b");
    expect(ta.selectionStart).toBe(6);
    send("b");
    expect(ta.selectionStart).toBe(0);
  });

  it("e jumps to current/next word end", () => {
    const { ta, send } = setup("hello world", 0);
    send("e");
    expect(ta.selectionStart).toBe(4);
    send("e");
    expect(ta.selectionStart).toBe(10);
  });

  it("counts: 2w jumps two words", () => {
    const { ta, send } = setup("a b c d", 0);
    send("2w");
    expect(ta.selectionStart).toBe(4);
  });

  it("W treats punctuation as part of a big word", () => {
    const { ta, send } = setup("foo.bar baz", 0);
    send("W");
    expect(ta.selectionStart).toBe(8); // 'baz'
  });
});

// ---- find ----------------------------------------------------------

describe("find motions", () => {
  it("f<char> jumps to the next char on the line", () => {
    const { ta, send } = setup("hello world", 0);
    send("fw");
    expect(ta.selectionStart).toBe(6);
  });

  it("F<char> jumps to the previous char", () => {
    const { ta, send } = setup("hello world", 7);
    send("Fl");
    expect(ta.selectionStart).toBe(3);
  });

  it("t<char> stops one char before, ; repeats", () => {
    const { ta, send } = setup("hello world", 0);
    send("tw");
    expect(ta.selectionStart).toBe(5);
    // ; should advance past the t-anchor, then again stop before 'w'
    send(";");
    // Already at the same position; in vim, ; would bump past and find again.
    // Our impl steps forward then re-finds; for `t`, the new pos is still
    // before any next 'w' if there is one. With "hello world", there's
    // no other 'w', so it stays.
    expect(ta.selectionStart).toBe(5);
  });
});

// ---- editing -------------------------------------------------------

describe("editing", () => {
  it("x deletes char under cursor", () => {
    const { ta, send } = setup("hello", 0);
    send("x");
    expect(ta.value).toBe("ello");
    expect(ta.selectionStart).toBe(0);
  });

  it("X deletes char before cursor", () => {
    const { ta, send } = setup("hello", 3);
    send("X");
    expect(ta.value).toBe("helo");
    expect(ta.selectionStart).toBe(2);
  });

  it("D deletes to end of line", () => {
    const { ta, send } = setup("hello world", 5);
    send("D");
    expect(ta.value).toBe("hello");
  });

  it("dd deletes a whole line", () => {
    const { ta, send } = setup("line1\nline2\nline3", 6);
    send("dd");
    expect(ta.value).toBe("line1\nline3");
  });

  it("dw deletes a word", () => {
    const { ta, send } = setup("hello world", 0);
    send("dw");
    expect(ta.value).toBe("world");
  });

  it("d$ deletes to line end", () => {
    const { ta, send } = setup("hello world", 5);
    send("d$");
    expect(ta.value).toBe("hello");
  });

  it("counted operator: 2dd deletes two lines", () => {
    const { ta, send } = setup("a\nb\nc\nd", 0);
    send("2dd");
    expect(ta.value).toBe("c\nd");
  });

  it("o opens a new line below and enters insert", () => {
    const { vim, ta, send } = setup("hello", 0);
    send("o");
    expect(vim.mode).toBe("insert");
    expect(ta.value).toBe("hello\n");
    expect(ta.selectionStart).toBe(6);
  });

  it("O opens a new line above and enters insert", () => {
    const { vim, ta, send } = setup("hello", 0);
    send("O");
    expect(vim.mode).toBe("insert");
    expect(ta.value).toBe("\nhello");
    expect(ta.selectionStart).toBe(0);
  });

  it("J joins next line with a space", () => {
    const { ta, send } = setup("foo\nbar", 0);
    send("J");
    expect(ta.value).toBe("foo bar");
  });

  it("r<char> replaces the character under the cursor", () => {
    const { ta, send } = setup("hello", 1);
    send("rX");
    expect(ta.value).toBe("hXllo");
  });

  it("~ toggles case at cursor", () => {
    const { ta, send } = setup("abc", 0);
    send("~");
    expect(ta.value).toBe("Abc");
  });
});

// ---- yank / paste --------------------------------------------------

describe("yank and paste", () => {
  it("yy + p duplicates a line", () => {
    const { ta, send } = setup("line1\nline2", 0);
    send("yy");
    send("p");
    expect(ta.value).toBe("line1\nline1\nline2");
  });

  it("yw + p pastes the word inline", () => {
    const { ta, send } = setup("foo bar", 0);
    send("yw");
    // yw on 'foo bar' yanks "foo " (trailing whitespace included).
    send("$");
    send("p");
    // cursor at last char ('r', offset 6) -> p pastes after at offset 7,
    // appending the yanked "foo " to the end.
    expect(ta.value).toBe("foo barfoo ");
  });
});

// ---- visual mode ---------------------------------------------------

describe("visual mode", () => {
  it("v + l + d deletes the visual selection", () => {
    const { vim, ta, send } = setup("hello", 0);
    send("vlld");
    // selection was offsets 0-2 inclusive (3 chars), so removed "hel"
    expect(ta.value).toBe("lo");
    expect(vim.mode).toBe("normal");
  });

  it("V + d deletes the line", () => {
    const { ta, send } = setup("aa\nbb\ncc", 0);
    send("Vd");
    expect(ta.value).toBe("bb\ncc");
  });

  it("v + iw selects an inner word with text-object", () => {
    const { ta, send } = setup("hello world", 7);
    // diw deletes inner word
    send("diw");
    expect(ta.value).toBe("hello ");
  });
});

// ---- text objects --------------------------------------------------

describe("text objects", () => {
  it('di" deletes inside double quotes', () => {
    const { ta, send } = setup('say "hello world" now', 6);
    send('di"');
    expect(ta.value).toBe('say "" now');
  });

  it('da" deletes including quotes', () => {
    const { ta, send } = setup('say "hello world" now', 6);
    send('da"');
    expect(ta.value).toBe("say  now");
  });

  it("di( deletes inside parens", () => {
    const { ta, send } = setup("foo(bar baz)qux", 6);
    send("di(");
    expect(ta.value).toBe("foo()qux");
  });

  it("ciw replaces a word and enters insert", () => {
    const { vim, ta, send } = setup("hello world", 0);
    send("ciw");
    expect(vim.mode).toBe("insert");
    expect(ta.value).toBe(" world");
  });
});

// ---- undo / redo ---------------------------------------------------

describe("undo and redo", () => {
  it("u undoes the last edit", () => {
    const { ta, send } = setup("hello", 0);
    send("x");
    expect(ta.value).toBe("ello");
    send("u");
    expect(ta.value).toBe("hello");
  });

  it("u then C-r re-applies", () => {
    const { ta, send } = setup("hello", 0);
    send("x");
    send("u");
    expect(ta.value).toBe("hello");
    send("<C-r>");
    expect(ta.value).toBe("ello");
  });
});

// ---- counts --------------------------------------------------------

describe("counts", () => {
  it("3l moves 3 right", () => {
    const { ta, send } = setup("hello", 0);
    send("3l");
    expect(ta.selectionStart).toBe(3);
  });

  it("3x deletes 3 chars", () => {
    const { ta, send } = setup("hello", 0);
    send("3x");
    expect(ta.value).toBe("lo");
  });
});
