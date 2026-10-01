import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectWorkspaceRelativeImports } from "./check-portable-artifact.mjs";
import {
  buildPublishedManifest,
  PUBLISHED_PACKAGE_NAME,
  SOURCE_PACKAGE_NAME,
  stagePublishedPackage,
} from "./prepare-chip-package.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const builtPackageRoot = join(repositoryRoot, "packages", "eve");
const builtDistRoot = join(builtPackageRoot, "dist");

/**
 * The dist tree only exists after `pnpm build`. Without it there is nothing to
 * assert on, and failing loudly beats a false green.
 */
const hasBuiltDist = existsSync(join(builtDistRoot, "src"));

/** Minimal manifest shaped like the real one: a name plus the eve/... exports. */
function sourceManifest(overrides = {}) {
  return {
    name: "eve",
    version: "9.9.9",
    license: "Apache-2.0",
    bin: { eve: "./bin/eve.js" },
    exports: {
      ".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
      "./tools": {
        types: "./dist/src/public/tools/index.d.ts",
        import: "./dist/src/public/tools/index.js",
      },
      "./sandbox/docker": { import: "./dist/src/public/sandbox/docker.js" },
      "./vercel": { import: "./dist/src/public/vercel/index.js" },
    },
    ...overrides,
  };
}

async function writeSourcePackage(root, manifest = sourceManifest()) {
  const packageDir = join(root, "source");
  await mkdir(join(packageDir, "dist", "src"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageDir, "dist", "src", "index.js"), "export const marker = 1;\n");
  return packageDir;
}

test("rewrites only the published name, leaving the exports map byte-identical", () => {
  const source = sourceManifest();
  const published = buildPublishedManifest(source);

  assert.equal(published.name, PUBLISHED_PACKAGE_NAME);
  assert.deepEqual(published.exports, source.exports, "exports map must survive unchanged");
  assert.deepEqual(published.bin, source.bin);
  assert.equal(published.version, source.version);
});

test("fails closed when the source package is not named eve", () => {
  // The import namespace is derived from this name, so a rename upstream must
  // stop the release instead of publishing a mismatched artifact.
  assert.throws(
    () => buildPublishedManifest(sourceManifest({ name: "chip-framework" })),
    /Expected the source package to be named "eve"/u,
  );
});

test("fails closed when the source package has no exports map", () => {
  assert.throws(() => buildPublishedManifest({ name: "eve", version: "1.0.0" }), /no exports map/u);
});

test("fails closed when the source package has no version", () => {
  assert.throws(() => buildPublishedManifest({ name: "eve", exports: {} }), /no version/u);
});

test("staging never mutates the source working tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chip-package-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const packageDir = await writeSourcePackage(root);
  const before = await readFile(join(packageDir, "package.json"), "utf8");

  await stagePublishedPackage({ packageDir, out: join(root, "staging") });

  const after = await readFile(join(packageDir, "package.json"), "utf8");
  assert.equal(after, before, "source package.json must be untouched by staging");
  assert.equal(JSON.parse(after).name, SOURCE_PACKAGE_NAME);
});

test("the staged package is named chip-framework and keeps the eve/... exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chip-package-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const packageDir = await writeSourcePackage(root);
  const { stagingPackageDir, publishedManifest } = await stagePublishedPackage({
    packageDir,
    out: join(root, "staging"),
  });

  assert.equal(publishedManifest.name, PUBLISHED_PACKAGE_NAME);

  const staged = JSON.parse(await readFile(join(stagingPackageDir, "package.json"), "utf8"));
  assert.equal(staged.name, PUBLISHED_PACKAGE_NAME);
  for (const subpath of [".", "./tools", "./sandbox/docker", "./vercel"]) {
    assert.ok(subpath in staged.exports, `${subpath} must remain an export`);
  }
  // The compiled file the rewritten name still points at must have been copied.
  await readFile(join(stagingPackageDir, "dist", "src", "index.js"), "utf8");
});

test("resolves pnpm catalog: specifiers so npm can install the artifact", () => {
  // npm has no `catalog:` protocol and fails with EUNSUPPORTEDPROTOCOL, so the
  // published manifest must carry concrete versions.
  const catalog = new Map([
    ["ai", "^7.0.93"],
    ["zod", "4.5.4"],
  ]);
  const published = buildPublishedManifest(
    sourceManifest({
      devDependencies: { ai: "catalog:", zod: "catalog:", commander: "14.0.3" },
      peerDependencies: { ai: "catalog:" },
    }),
    catalog,
  );

  assert.equal(published.devDependencies.ai, "^7.0.93");
  assert.equal(published.devDependencies.zod, "4.5.4");
  assert.equal(published.peerDependencies.ai, "^7.0.93");
  assert.equal(published.devDependencies.commander, "14.0.3", "non-catalog ranges are untouched");
  assert.doesNotMatch(JSON.stringify(published), /catalog:/u);
});

test("fails closed when a catalog: specifier has no catalog entry", () => {
  assert.throws(
    () =>
      buildPublishedManifest(
        sourceManifest({ devDependencies: { "not-in-catalog": "catalog:" } }),
        new Map(),
      ),
    /Cannot resolve catalog entry "not-in-catalog"/u,
  );
});

test("the real workspace package is still named eve after staging", async (t) => {
  // Guards the release boundary end to end: the repository keeps the `eve`
  // name (and therefore the `eve/...` import namespace) even though what gets
  // published is `chip-framework`.
  const root = await mkdtemp(join(tmpdir(), "chip-package-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const { publishedManifest } = await stagePublishedPackage({
    packageDir: join(repositoryRoot, "packages", "eve"),
    out: join(root, "staging"),
  });

  assert.equal(publishedManifest.name, PUBLISHED_PACKAGE_NAME);
  const source = JSON.parse(
    await readFile(join(repositoryRoot, "packages", "eve", "package.json"), "utf8"),
  );
  assert.equal(source.name, SOURCE_PACKAGE_NAME);
  assert.ok("./tools" in source.exports);
  assert.ok("./sandbox/docker" in source.exports);
  assert.ok("./vercel" in source.exports);
});

/**
 * Regression guard for the defect that shipped in eve@0.54.3: dependencies
 * imported by a bare specifier that the bundler neither externalizes nor routes
 * through `#compiled/*` got inlined as a relative path into the workspace pnpm
 * store, so the packed tarball threw ERR_MODULE_NOT_FOUND the first time a
 * consumer ran the CLI.
 *
 * Asserted against the built dist rather than source import syntax, because the
 * broken path only exists in emitted output — a correct-looking source import
 * can still inline one. Package peer dependencies are supplied by an installer,
 * so this only rules out references into the repository's own node_modules.
 */
test("built runtime code has no workspace-relative imports", { skip: !hasBuiltDist }, async () => {
  const findings = await collectWorkspaceRelativeImports(join(builtDistRoot, "src"));
  assert.deepEqual(
    findings,
    [],
    `packed runtime code imports through the workspace pnpm store:\n${findings
      .map(({ file, specifier }) => `  ${file} -> ${specifier}`)
      .join("\n")}`,
  );
});
