/** Content-addressed store for images in chat history.
 *
 *  History used to inline every image as a base64 data URL. Screenshot-heavy
 *  chats spent most of their history payload on them (a 2 MB response was
 *  1.7 MB of images), and history is refetched at the end of every turn.
 *  Now history carries a URL per image (`/api/agents/<id>/images/<hash>`),
 *  served from here, which the browser fetches once and caches for good.
 *
 *  Entries hold the session's own base64 strings (no copy) and are evicted
 *  least-recently-used past a byte budget. A miss isn't fatal: the image
 *  route rebuilds the agent's history, which puts its images back. */

import { createHash } from "node:crypto";

export interface StoredImage {
  mimeType: string;
  /** Base64 bytes, as stored in the session. */
  data: string;
}

/** Raster types the dashboard renders. Anything else stays a data URL and
 *  goes through the client's own checks. */
const SERVABLE_MIME = /^image\/(png|jpeg|gif|webp|bmp|x-icon)$/;

export class ImageStore {
  private images = new Map<string, StoredImage>();
  private bytes = 0;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  static canStore(mimeType: string): boolean {
    return SERVABLE_MIME.test(mimeType);
  }

  /** Store an image and return its key (a hash of type + bytes). */
  put(mimeType: string, data: string): string {
    const key = createHash("sha256").update(mimeType).update("\0").update(data).digest("hex").slice(0, 32);
    const existing = this.images.get(key);
    if (existing) {
      this.images.delete(key);
      this.images.set(key, existing);
      return key;
    }
    this.images.set(key, { mimeType, data });
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.images.size > 1) {
      const [oldestKey, oldest] = this.images.entries().next().value as [string, StoredImage];
      this.images.delete(oldestKey);
      this.bytes -= oldest.data.length;
    }
    return key;
  }

  get(key: string): StoredImage | undefined {
    const image = this.images.get(key);
    if (image) {
      this.images.delete(key);
      this.images.set(key, image);
    }
    return image;
  }
}
