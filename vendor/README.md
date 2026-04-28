# vendor/

Third-party browser libraries committed to the repo so the dashboard
doesn't depend on CDN at runtime. Each file is pinned to a specific
version. Update by re-running the download steps documented next to
each file.

The npm-published packages we ship in the dashboard (`marked`,
`marked-highlight`, `dompurify`, `highlight.js`) are NOT here —
`scripts/post-build.mjs` copies their build artifacts from
`node_modules/` directly (bundling with esbuild for `highlight.js`,
which doesn't ship a UMD/IIFE form). That's reproducible because the
package versions are pinned in `package-lock.json`.

Only files with no equivalent npm distribution form live here.

## Files

### `tailwindcss-3.4.17.min.js`

Tailwind v3's runtime CDN script. There's no equivalent npm package
for v3 (Tailwind v4 has `@tailwindcss/browser`, but migrating to v4
changes how `tailwind.config = { theme: { extend: ... } }` is
expressed — out of scope for the security release that introduced
this vendoring).

Source: <https://cdn.tailwindcss.com/3.4.17?plugins=forms>

Re-fetch:

```bash
curl -sSL https://cdn.tailwindcss.com/3.4.17?plugins=forms \
  -o vendor/tailwindcss-3.4.17.min.js
```
