import { describe, expect, it } from "vitest";
import { escapeAction } from "../keys.js";

describe("escapeAction", () => {
  it("does nothing when there's no in-flight turn", () => {
    expect(escapeAction({})).toBe("defer");
    expect(escapeAction({ canInterrupt: false })).toBe("defer");
  });

  it("interrupts a running turn", () => {
    expect(escapeAction({ canInterrupt: true })).toBe("interrupt");
  });

  // The regression this file exists for: the composer is focused, vim mode
  // may or may not be on, the agent is streaming. Escape has to stop the
  // agent -- not silently flip the editor into normal mode and leave the
  // turn running. vim's mode is intentionally not an input here.
  it("interrupts regardless of the composer's editing mode", () => {
    expect(escapeAction({ canInterrupt: true, vimMode: "insert" })).toBe("interrupt");
    expect(escapeAction({ canInterrupt: true, vimMode: "normal" })).toBe("interrupt");
  });

  it("yields to anything with a better claim on the key", () => {
    const claims = [
      "extUiModalOpen",
      "projectModalOpen",
      "mentionPopupOpen",
      "slashPopupOpen",
      "drawerOpen",
      "pickerOpen",
    ];
    for (const claim of claims) {
      expect(escapeAction({ canInterrupt: true, [claim]: true })).toBe("defer");
    }
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
      }),
    ).toBe("defer");
  });
});
