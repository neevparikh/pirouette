// URL boundaries for untrusted message content. Attribute escaping is still
// required after validation; HTML entities must never get a second decode.
export function safeLinkUrl(value) {
  if (typeof value !== "string" || !value || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value, "https://relative.invalid/");
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

// Attachments are raster bytes, not arbitrary URLs or SVG/HTML documents.
export function isRasterDataUrl(value) {
  return typeof value === "string" &&
    /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon);base64,[a-z0-9+/]+={0,2}$/i.test(value);
}

// History images are served by the dashboard's own server, by content hash
// (see src/server/image-store.ts). Only that exact same-origin shape.
export function isHistoryImageUrl(value) {
  return typeof value === "string" &&
    /^\/api\/agents\/[a-z0-9][a-z0-9-]{0,63}\/images\/[a-f0-9]{32}$/.test(value);
}
