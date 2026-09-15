// Synchronous head script: apply saved theme/sidebar width before first paint.
// Kept external so CSP can forbid all inline scripts and event handlers.
(function () {
  const light = localStorage.getItem("pirouette-theme-light") || "base24-softstack-light";
  const dark = localStorage.getItem("pirouette-theme-dark") || "base24-softstack-dark";
  const mode = localStorage.getItem("pirouette-theme-mode") || "system";
  const isDark = mode === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark";
  document.documentElement.classList.add(isDark ? dark : light);
  const width = parseInt(localStorage.getItem("pirouette-sidebar-width"), 10);
  if (width > 0) document.documentElement.style.setProperty("--sidebar-width", width + "px");
})();

// Local Nerd Font first, then webfonts and system monospace fallbacks.
const mono = [
  "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", "JetBrains Mono NF",
  "JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "ui-monospace",
  "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace",
];
const colors = {};
for (const name of [100, 200, 300, 400, 500, 600, 700, 800, "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"]) {
  colors[name] = `rgb(var(--color-base16-${name}))`;
}
for (const name of ["red", "orange", "yellow", "green", "cyan", "blue"]) {
  colors[`${name}-bright`] = `rgb(var(--color-base16-${name}-bright, var(--color-base16-${name})))`;
}
tailwind.config = {
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
};
