// Defense in depth for browser content, not isolation from an attacker who
// can modify the dashboard's installed JavaScript or the server itself.
export function dashboardCsp(validatedHost: string): string {
  // 'self' alone does not cover WebSockets in every browser. Pin ws/wss to
  // the already allowlisted request authority (including TLS proxy access).
  const authority = new URL(`http://${validatedHost}`).host;
  const sockets = authority === validatedHost ? ` ws://${authority} wss://${authority}` : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    // Layout libraries need inline CSS, but message HTML/styles are escaped.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self'${sockets}`,
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

// Worktree images are untrusted documents when opened in a tab. In
// particular, SVG must have neither scripts nor same-origin API access.
// Keep inline plot styling and embedded raster data, not remote resources.
export const IMAGE_DOCUMENT_CSP = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
