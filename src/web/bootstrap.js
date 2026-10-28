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

// Tailwind's config (fonts, base16 colours) lives in scripts/tailwind.config.mjs;
// the stylesheet is compiled at build time.
