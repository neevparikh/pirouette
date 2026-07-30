import { describe, expect, it } from "vitest";
import { escapeAction } from "../keys.js";

describe("escapeAction", () => {
  it("does nothing when there's no in-flight turn", () => {
    expect(escapeAction({})).toEqual({ action: "defer", reason: "nothing-in-flight" });
    expect(escapeAction({ canInterrupt: false })).toEqual({
      action: "defer",
      reason: "nothing-in-flight",
    });
  });

  it("interrupts a running turn", () => {
    expect(escapeAction({ canInterrupt: true })).toEqual({
      action: "interrupt",
      reason: "interrupt",
    });
  });

  it("yields to anything with a better claim on the key", () => {
    const claims = {
      extUiModalOpen: "extension-ui-modal",
      projectModalOpen: "project-modal",
      mentionPopupOpen: "mention-popup",
      slashPopupOpen: "slash-popup",
      drawerOpen: "drawer-open",
      pickerOpen: "picker-open",
      vimInsertMode: "vim-insert-mode",
    };
    for (const [claim, reason] of Object.entries(claims)) {
      expect(escapeAction({ canInterrupt: true, [claim]: true })).toEqual({
        action: "defer",
        reason,
      });
    }
  });

  it("keeps vim's insert -> normal press, then interrupts from normal mode", () => {
    const running = { canInterrupt: true };
    expect(escapeAction({ ...running, vimInsertMode: true }).action).toBe("defer");
    expect(escapeAction({ ...running, vimInsertMode: false }).action).toBe("interrupt");
  });

  it("reports the highest-priority claim when several are open", () => {
    expect(
      escapeAction({
        canInterrupt: true,
        extUiModalOpen: true,
        slashPopupOpen: true,
        drawerOpen: true,
      }).reason,
    ).toBe("extension-ui-modal");
  });

  it("treats every overlay independently (one open is enough to defer)", () => {
    expect(
      escapeAction({
        canInterrupt: true,
        extUiModalOpen: false,
        projectModalOpen: false,
        mentionPopupOpen: false,
        slashPopupOpen: true,
        drawerOpen: false,
        pickerOpen: false,
        vimInsertMode: false,
      }),
    ).toEqual({ action: "defer", reason: "slash-popup" });
  });
});
