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
