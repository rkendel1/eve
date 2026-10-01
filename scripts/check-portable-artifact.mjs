#!/usr/bin/env node
/**
 * Guards the packed artifact against workspace-relative runtime references.
 *
 * A dependency imported by bare specifier that is neither in the bundler's
 * EXTERNAL_PACKAGES set nor routed through the `#compiled/*` vendor mechanism
 * gets inlined as a relative path into the workspace's pnpm store
 * (`../node_modules/.pnpm/pkg@version/...`). That path only resolves in a source
 * checkout, so the packed tarball throws ERR_MODULE_NOT_FOUND the first time a
 * consumer runs the CLI. The same defect shipped in eve@0.54.3, where `chip
 * --version` failed on a missing zod module.
 *
 * This scans the built `dist` tree rather than source import syntax, because the
 * defect exists only in the emitted output: a correct-looking source import can
 * still inline a workspace path.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiledRoot = join(repositoryRoot, "packages", "eve", "dist", "src");

/**
 * Vendored packages legitimately inline their own pnpm-internal paths, and a
 * few call sites compare against the literal string `node_modules/.pnpm/` to
 * detect a package manager. Neither is a runtime import, so they are excluded
 * rather than treated as failures.
 */
const VENDORED_PREFIX = "dist/src/compiled/";
const LITERAL_MATCHERS = new Set([
  'node_modules/.pnpm/"',
  "node_modules/.pnpm/`",
  "node_modules/.pnpm/`)",
]);

async function walk(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

/**
 * Returns the import specifiers in a chunk that point into a pnpm store. An
 * emitted import looks like `from"../node_modules/.pnpm/pkg@1.0.0/..."` or
 * `import("../node_modules/.pnpm/...")`; a bare string comparison does not.
 */
function findWorkspaceImports(source) {
  const specifiers = [];
  const pattern = /(?:from|import\()\s*"?([^"\n]*?\.pnpm\/[^"\n]*)"?\)?/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier.includes('"') || specifier.includes("`") || specifier.includes(")")) continue;
    if (LITERAL_MATCHERS.has(specifier)) continue;
    specifiers.push(specifier);
  }
  return specifiers;
}

export async function collectWorkspaceRelativeImports(root = compiledRoot) {
  const files = await walk(root);
  const findings = [];
  for (const file of files) {
    const relPath = relative(root, file).split(sep).join("/");
    // Vendored third-party code ships its own resolved tree and is not
    // resolved through the consumer's install layout.
    if (relPath.startsWith("compiled/")) continue;
    const offenders = findWorkspaceImports(await readFile(file, "utf8"));
    for (const specifier of offenders) {
      findings.push({ file: relPath, specifier });
    }
  }
  return findings;
}

if (import.meta.main) {
  const findings = await collectWorkspaceRelativeImports();
  if (findings.length > 0) {
    process.stderr.write(
      [
        "Packed runtime code imports dependencies through the workspace pnpm store:",
        ...findings.map(({ file, specifier }) => `  ${file}\n    → ${specifier}`),
        "",
        "These paths do not exist in an installed package, so the CLI throws",
        "ERR_MODULE_NOT_FOUND on first use. Import such dependencies through the",
        "package's `#compiled/<pkg>` vendor entry so they ship with the artifact.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  process.stdout.write(
    "[chip:check-portable-artifact] ok — no workspace-relative runtime imports.\n",
  );
}
