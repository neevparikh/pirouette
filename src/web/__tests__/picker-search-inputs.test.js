// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../index.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");

// The picker search boxes filter a custom list rendered right under them.
// Browser autofill history would open its own suggestion popup on top of
// that list, so autofill (and mobile autocorrect) must stay off.
describe.each(["model-search", "theme-search"])("#%s", (id) => {
  it("disables browser autofill suggestions", () => {
    const input = doc.getElementById(id);
    expect(input).not.toBeNull();
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });
});
