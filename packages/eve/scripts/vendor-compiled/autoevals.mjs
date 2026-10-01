import { fileURLToPath } from "node:url";

import { buildOpaqueTypesStub, createDeclarationCopier } from "./_shared.mjs";

/**
 * Vendors `autoevals` so the built-in eval scorers ship with the package.
 *
 * A bare `autoevals` specifier is neither in the bundler's EXTERNAL_PACKAGES
 * set nor routed through `#compiled/*`, so rolldown inlines a relative path
 * into the workspace pnpm store (`../node_modules/.pnpm/autoevals@…/…`). That
 * path does not exist in an installed package, so `chip eval` throws
 * ERR_MODULE_NOT_FOUND once the tarball is unpacked. Vendoring keeps the import
 * external and ships a self-contained copy under `dist/src/compiled/`.
 *
 * Declarations are copied verbatim from the installed package so the scorer
 * types stay the real ones rather than a stub that drifts on version bumps.
 */
const wrapperEntry = fileURLToPath(new URL("./entries/autoevals.mjs", import.meta.url));

export default {
  packageName: "autoevals",
  compiledPath: "autoevals",
  // Its own chunk group: env-runner's node worker is patched by source match in
  // the shared `node` group, so a module that doesn't need to share it gets its
  // own group to keep that patch deterministic.
  chunkGroup: "autoevals",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
    },
  ],
  // autoevals publishes its build as `jsdist/`, not the conventional `dist/`.
  // Its scorer options are typed with OpenAI request shapes, but eve drives the
  // scorers through a provider-agnostic client, so those four shapes are opaque
  // here and `openai` stays an optional peer rather than a hard install.
  copyDeclarations: createDeclarationCopier({
    declarationRoot: "jsdist",
    rewrites: {
      "openai/resources": {
        kind: "stub",
        stubBaseName: "_openai_resources",
        build: (names) => buildOpaqueTypesStub(names, "openai/resources"),
      },
      "openai/resources/shared": {
        kind: "stub",
        stubBaseName: "_openai_resources_shared",
        build: (names) => buildOpaqueTypesStub(names, "openai/resources/shared"),
      },
      // Bare `openai` only appears in doc-comment examples, but the copier
      // scans them too, so it needs a rule as well.
      openai: { kind: "external" },
      // Point at the vendored zod copy rather than the workspace's, so the
      // emitted types resolve against what actually ships.
      zod: { kind: "vendored", compiledPath: "zod" },
      "zod/v4": { kind: "vendored", compiledPath: "zod" },
      "zod/v4/core": { kind: "vendored", compiledPath: "zod" },
    },
  }),
};
