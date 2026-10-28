// Tailwind config for the dashboard's stylesheet, compiled at build time by
// scripts/vendor.mjs into src/web/vendor/tailwind.css.
//
// The dashboard used to ship Tailwind's in-browser runtime (the "play CDN"),
// which compiled CSS on every page load and then rescanned every element's
// classes on each DOM mutation — a cost paid per streamed token on a long
// chat. Classes are now found by scanning the sources below, so a class name
// must appear literally in them (no `bg-${color}` string building). In dev
// (`npm run dev`), re-run `npm run vendor` after using a class that's new to
// the codebase.

import forms from "@tailwindcss/forms";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Local Nerd Font first, then webfonts and system monospace fallbacks.
const mono = [
  "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrains Mono NF",
  "JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "ui-monospace",
  "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace",
];

// Theme colours are CSS variables (space-separated RGB) set per theme in
// themes.css. Tailwind still applies opacity modifiers (`bg-base16-blue/15`)
// to these `rgb(var(...))` values.
const colors = {};
for (const name of [100, 200, 300, 400, 500, 600, 700, 800, "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]) {
  colors[name] = `rgb(var(--color-base16-${name}))`;
}
for (const name of ["red", "orange", "yellow", "green", "cyan", "blue"]) {
  colors[`${name}-bright`] = `rgb(var(--color-base16-${name}-bright, var(--color-base16-${name})))`;
}

export default {
  content: [
    path.join(repo, "src/web/**/*.{html,js}"),
    path.join(repo, "src/server/**/*.ts"),
    `!${path.join(repo, "src/web/vendor/**")}`,
    `!${path.join(repo, "src/web/__tests__/**")}`,
    `!${path.join(repo, "src/server/__tests__/**")}`,
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: mono,
        mono,
        display: ["Zilla Slab", "Roboto Slab", "ui-serif", "Georgia", "serif"],
      },
      colors: { base16: colors },
    },
  },
  plugins: [forms],
};
