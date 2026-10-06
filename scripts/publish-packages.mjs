#!/usr/bin/env node
/**
 * Builds, verifies, and publishes @appport/chip from packages/eve.
 *
 * The package is staged by prepare-chip-package.mjs, which refuses to pack a
 * non-portable artifact. A version that is already on npm is skipped, so this
 * is safe to run on every push to main; bump the version with
 * `pnpm version-packages` to release.
 *
 * Usage:
 *   npm run publish:packages -- [--dry-run] [--provenance]
 *
 * Publishing uses inherited stdio so npm can prompt for a one-time password
 * locally; CI authenticates with NODE_AUTH_TOKEN.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@appport/chip";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--dry-run" && arg !== "--provenance") throw new Error(`Unknown argument: ${arg}`);
}

function run(command, commandArgs, env = process.env) {
  console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: repositoryRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}.`);
  }
}

const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  throw new Error(
    `Publishing requires Node.js 24 or newer; running ${process.version}. Run \`nvm use\` (the repository's .nvmrc pins Node 24).`,
  );
}

const { version } = JSON.parse(
  await readFile(join(repositoryRoot, "packages", "eve", "package.json"), "utf8"),
);
const published = spawnSync("npm", ["view", `${PACKAGE_NAME}@${version}`, "version"], {
  encoding: "utf8",
});
const alreadyPublished = published.status === 0 && published.stdout.trim() === version;
if (alreadyPublished && !args.has("--dry-run")) {
  console.log(
    `${PACKAGE_NAME}@${version} is already on npm; run pnpm version-packages to release.`,
  );
  process.exit(0);
}

// A leftover dependency override would stamp a local path into `chip init`.
const buildEnv = { ...process.env };
delete buildEnv.EVE_MAIN_DEPENDENCY_URL;
run("pnpm", ["--filter", "eve", "build"], buildEnv);
run(process.execPath, [join("scripts", "prepare-chip-package.mjs"), "--pack"], buildEnv);

const tarball = join(repositoryRoot, ".chip-staging", `appport-chip-${version}.tgz`);
if (!existsSync(tarball)) throw new Error(`Expected the staged tarball at ${tarball}.`);
// npm rejects a dry run of a published version, so a rehearsal stops after packing.
if (alreadyPublished) {
  console.log(
    `Dry run: ${PACKAGE_NAME}@${version} is already on npm; built and verified ${tarball}.`,
  );
  process.exit(0);
}
run("npm", [
  "publish",
  tarball,
  "--access",
  "public",
  ...(args.has("--provenance") ? ["--provenance"] : []),
  ...(args.has("--dry-run") ? ["--dry-run"] : []),
]);
console.log(`${args.has("--dry-run") ? "Dry run for" : "Published"} ${PACKAGE_NAME}@${version}`);
