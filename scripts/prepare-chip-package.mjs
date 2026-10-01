#!/usr/bin/env node
/**
 * Stages the publishable Chip package from the in-repo `eve` package.
 *
 * Chip ships as `chip-framework` on npm while the public import namespace
 * stays `eve/...`. Those are two different names on purpose: `eve/...` is the
 * established API surface consumers already import, so renaming it would be
 * pure churn. This script is the single, deterministic place where the
 * *publication* name diverges from that import namespace.
 *
 * It rewrites exactly one field in the staged `package.json` — `name`. Every
 * other field, and the whole file tree, is copied verbatim, so the `exports`
 * map, the `bin` entries, the `files` allow-list, and the generated `.d.ts`
 * import specifiers are untouched. The source working tree is never mutated:
 * the rewrite happens on a copy.
 *
 * Usage:
 *   node scripts/prepare-chip-package.mjs [--out <dir>] [--package <dir>] [--pack]
 *
 * Defaults to staging `packages/eve` into `.chip-staging/package`. With
 * `--pack` it also runs `npm pack --ignore-scripts` on the staged copy.
 *
 * `--ignore-scripts` is deliberate. The package's `prepack` hook rebuilds from
 * source and re-copies the license; staging runs *after* the normal workspace
 * build, so that work is already done and the staged tree has no `node_modules`
 * to rebuild against. The license step is performed here instead, by calling
 * the same repository script `prepack` uses, so the Apache-2.0 §4(d) NOTICE
 * requirement still holds for the published tarball.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Name the framework is published and installed under. */
export const PUBLISHED_PACKAGE_NAME = "chip-framework";

/**
 * Name the repository package keeps. It doubles as the public import
 * namespace, so it must not drift: the staged artifact is published as
 * `chip-framework` but still resolves `eve/...` for consumers that alias it.
 */
export const SOURCE_PACKAGE_NAME = "eve";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourcePackageDir = join(repositoryRoot, "packages", "eve");
const defaultStagingRoot = join(repositoryRoot, ".chip-staging");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the pnpm workspace catalog into a name -> version map.
 *
 * The published manifest must not contain `catalog:` specifiers: npm has no
 * concept of the pnpm catalog protocol and fails the install outright with
 * `EUNSUPPORTEDPROTOCOL`. pnpm substitutes these when it publishes; because we
 * pack a staged copy ourselves, we do the same substitution here.
 *
 * Line-oriented on purpose, mirroring readCatalogVersion in
 * packages/eve/src/setup/scaffold/version-tokens.ts, so there is one parsing
 * shape to keep in sync rather than two.
 */
export function parseWorkspaceCatalog(manifestText) {
  const catalog = new Map();
  let inCatalog = false;

  for (const line of manifestText.split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) continue;
    if (/^\S/u.test(line)) break;
    const match = line.match(/^\s+(?:"([^"]+)"|([\w@/.-]+)):\s*"([^"]+)"/u);
    if (match === null) continue;
    catalog.set(match[1] ?? match[2], match[3]);
  }

  return catalog;
}

/**
 * Replaces every `catalog:` specifier with its concrete version.
 *
 * Fails closed on an unknown entry: a silently-dropped version range would ship
 * a package with a wrong dependency, which is worse than a failed release.
 */
export function resolveCatalogSpecifiers(manifest, catalog) {
  const resolveField = (field) => {
    if (!isRecord(manifest[field])) return undefined;
    const resolved = {};
    for (const [dependency, range] of Object.entries(manifest[field])) {
      if (typeof range !== "string" || !range.startsWith("catalog:")) {
        resolved[dependency] = range;
        continue;
      }
      const version = catalog.get(dependency);
      if (version === undefined) {
        throw new Error(
          `Cannot resolve catalog entry ${JSON.stringify(dependency)} used by ${field}. Add it to the catalog in pnpm-workspace.yaml before packaging.`,
        );
      }
      resolved[dependency] = version;
    }
    return resolved;
  };

  const published = { ...manifest };
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const resolved = resolveField(field);
    if (resolved !== undefined) published[field] = resolved;
  }
  return published;
}

/**
 * Produces the published manifest from the source manifest.
 *
 * Pure so the release boundary is unit-testable without touching disk. The
 * guard on the source name is the fail-closed part: if the workspace package
 * is ever renamed, staging must stop rather than quietly publish an artifact
 * whose import namespace no longer matches its published name.
 */
export function buildPublishedManifest(sourceManifest, catalog = new Map()) {
  if (!isRecord(sourceManifest)) {
    throw new Error("Source package.json must be a JSON object.");
  }
  if (sourceManifest.name !== SOURCE_PACKAGE_NAME) {
    throw new Error(
      `Expected the source package to be named "${SOURCE_PACKAGE_NAME}", found ${JSON.stringify(sourceManifest.name)}. ` +
        "The import namespace and the published name are derived from this value, so staging stops rather than publishing a mismatched artifact.",
    );
  }
  if (!isRecord(sourceManifest.exports)) {
    throw new Error(
      "Source package.json has no exports map. The eve/... import surface is the compatibility contract and must be present.",
    );
  }
  if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) {
    throw new Error("Source package.json has no version.");
  }

  // `name` is the only semantic change: the import namespace stays `eve`, so
  // the exports map, bin entries, and generated declarations are untouched.
  return resolveCatalogSpecifiers({ ...sourceManifest, name: PUBLISHED_PACKAGE_NAME }, catalog);
}

function parseArgs(argv) {
  const options = { out: defaultStagingRoot, packageDir: defaultSourcePackageDir, pack: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--out") {
      options.out = resolve(argv[++index] ?? "");
    } else if (flag === "--package") {
      options.packageDir = resolve(argv[++index] ?? "");
    } else if (flag === "--pack") {
      options.pack = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

/**
 * Runs the repository's license-copy script against a staged package. Reusing
 * it (rather than re-implementing) keeps one definition of which files must
 * ship with an Apache-2.0 package.
 */
function copyPackageLicense(stagingPackageDir) {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "copy-package-license.mjs"), stagingPackageDir],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      "Failed to copy LICENSE and NOTICE into the staged package. Refusing to continue: an Apache-2.0 package must ship its NOTICE.",
    );
  }
}

/**
 * Copies the package into a staging directory and rewrites only the published
 * name there. Returns the staged manifest so callers can assert on it.
 */
export async function stagePublishedPackage(options = {}) {
  const sourcePackageDir = options.packageDir ?? defaultSourcePackageDir;
  const stagingRoot = options.out ?? defaultStagingRoot;
  const stagingPackageDir = join(stagingRoot, "package");

  await rm(stagingPackageDir, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(sourcePackageDir, stagingPackageDir, {
    recursive: true,
    // node_modules is never part of a published tarball; copying it would make
    // staging slow and could leak a developer's local install into the artifact.
    filter: (source) => !source.split(/[\\/]/u).includes("node_modules"),
  });

  const stagedManifestPath = join(stagingPackageDir, "package.json");
  const sourceManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"));
  const workspaceManifestText = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const catalog = parseWorkspaceCatalog(workspaceManifestText);
  const publishedManifest = buildPublishedManifest(sourceManifest, catalog);
  await writeFile(stagedManifestPath, `${JSON.stringify(publishedManifest, null, 2)}\n`, "utf8");

  copyPackageLicense(stagingPackageDir);

  return { stagingPackageDir, publishedManifest };
}

/** Packs the staged package. Fails closed if npm cannot produce a tarball. */
function packStagedPackage(stagingPackageDir, stagingRoot) {
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", stagingRoot], {
    cwd: stagingPackageDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed for the staged Chip package:\n${result.stderr ?? result.stdout ?? "no output"}`,
    );
  }
  const tarballName = result.stdout.trim().split("\n").at(-1);
  return join(stagingRoot, tarballName);
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const { stagingPackageDir, publishedManifest } = await stagePublishedPackage(options);
  const summary = {
    stagedTo: stagingPackageDir,
    name: publishedManifest.name,
    version: publishedManifest.version,
  };
  if (options.pack) {
    summary.tarball = packStagedPackage(stagingPackageDir, options.out);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
