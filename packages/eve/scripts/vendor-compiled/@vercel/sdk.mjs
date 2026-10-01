import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

/**
 * Vendors the two `@vercel/sdk` trusted-source helpers.
 *
 * A bare `@vercel/sdk/...` specifier is not externalized, so rolldown inlines a
 * relative path into the workspace pnpm store. That path does not exist in an
 * installed package, so the dev TUI's Vercel auth flow throws
 * ERR_MODULE_NOT_FOUND once the tarball is unpacked. Vendoring keeps the import
 * external and ships a self-contained copy under `dist/src/compiled/`.
 */
const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/sdk.mjs", new URL("../", import.meta.url)),
);

export default {
  packageName: "@vercel/sdk",
  compiledPath: "@vercel/sdk",
  bundling: "standalone",
  // Its own chunk group: env-runner's node worker is patched by source match in
  // the shared `node` group, so a module that doesn't need to share it gets its
  // own group to keep that patch deterministic.
  chunkGroup: "vercel-sdk",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/sdk.d.ts"),
    },
  ],
};
