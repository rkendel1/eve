import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { EVE_PACKAGE_NAME, PUBLISHED_PACKAGE_NAME } from "#internal/package-name.js";

/**
 * Resolves the absolute path to the installed eve binary from the app's
 * perspective.
 *
 * Uses module resolution rather than assuming an app-local `node_modules/eve`:
 * npm workspaces hoist eve to the workspace root, so the app-local path does
 * not exist there, while pnpm symlinks it app-locally. eve does not export
 * `./bin/eve.js`, but it does export `./package.json`, so we resolve that and
 * derive the bin path from the package root. The framework installs as
 * `@appport/chip` from npm and as `eve` in this repository. The published name
 * goes first: an unrelated `eve` package can be resolvable from an app that
 * installed `@appport/chip` (hoisted, or through NODE_PATH). Falls back to the conventional app-local path when neither resolves (e.g.
 * before install).
 */
export function resolveEveBinaryPath(appRoot: string): string {
  const require = createRequire(join(appRoot, "package.json"));
  for (const name of [PUBLISHED_PACKAGE_NAME, EVE_PACKAGE_NAME]) {
    try {
      return join(dirname(require.resolve(`${name}/package.json`)), "bin", "eve.js");
    } catch {
      // Try the next identity.
    }
  }
  return join(appRoot, "node_modules", "eve", "bin", "eve.js");
}
