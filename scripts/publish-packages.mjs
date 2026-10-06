#!/usr/bin/env node
/**
 * Builds, verifies, and publishes the @appport packages:
 *
 * - @appport/chip, staged from packages/eve by prepare-chip-package.mjs, which
 *   refuses to pack a non-portable artifact.
 * - @appport/fx, the FX SDK, packaged from an FX checkout with FX's own
 *   sdk/scripts/package-libfx.mjs and native addons for every supported
 *   platform.
 *
 * Both packages are built and verified before either is published, so a
 * failed FX build never leaves Chip published alone. A version that is
 * already on npm is skipped. Publishing runs with inherited stdio so npm can
 * prompt for a one-time password.
 *
 * Usage:
 *   npm run publish:packages -- [--dry-run] [--only chip|fx] [--fx <dir>]
 *
 * --fx defaults to $FX_REPO, then to a sibling ../3fx checkout.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = join(repositoryRoot, ".chip-staging");

// FX package-libfx.mjs requires exactly these addon file names.
const FX_TARGETS = [
  { name: "linux-x64", target: "x86_64-linux-gnu.2.34" },
  { name: "linux-arm64", target: "aarch64-linux-gnu.2.34" },
  { name: "darwin-x64", target: "x86_64-macos" },
  { name: "darwin-arm64", target: "aarch64-macos" },
];

function parseArgs(argv) {
  const options = {
    dryRun: false,
    only: undefined,
    fxDir: process.env.FX_REPO ?? resolve(repositoryRoot, "..", "3fx"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--only") options.only = argv[++index];
    else if (flag === "--fx") options.fxDir = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.only !== undefined && options.only !== "chip" && options.only !== "fx") {
    throw new Error(`--only must be "chip" or "fx", received ${JSON.stringify(options.only)}.`);
  }
  return options;
}

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function isPublished(name, version) {
  const result = capture("npm", ["view", `${name}@${version}`, "version"]);
  return result.status === 0 && result.stdout.trim() === version;
}

function findOnPath(names, extraDirs = []) {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs];
  for (const name of names) {
    for (const dir of dirs) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return undefined;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function prepareChip() {
  const { version } = await readJson(join(repositoryRoot, "packages", "eve", "package.json"));
  const name = "@appport/chip";
  if (isPublished(name, version)) {
    console.log(
      `\n${name}@${version} is already on npm; skipping. Version the package first (pnpm version-packages).`,
    );
    return undefined;
  }

  // A leftover dependency override would stamp a local path into `chip init`.
  const env = { ...process.env };
  delete env.EVE_MAIN_DEPENDENCY_URL;
  run("pnpm", ["--filter", "eve", "build"], { cwd: repositoryRoot, env });
  run(process.execPath, [join(repositoryRoot, "scripts", "prepare-chip-package.mjs"), "--pack"], {
    cwd: repositoryRoot,
    env,
  });

  const tarball = join(stagingRoot, `appport-chip-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`Expected the staged Chip tarball at ${tarball}.`);
  return { name, version, tarball };
}

async function prepareFx(fxDir) {
  const sdkManifestPath = join(fxDir, "sdk", "package.json");
  if (!existsSync(sdkManifestPath)) {
    throw new Error(`No FX checkout at ${fxDir}. Pass --fx <dir> or set FX_REPO.`);
  }
  const status = capture("git", ["status", "--porcelain"], { cwd: fxDir });
  if (status.status !== 0 || status.stdout.trim().length > 0) {
    throw new Error(
      `The FX checkout at ${fxDir} has uncommitted changes. Publish only from committed source:\n${status.stdout}`,
    );
  }
  const { name, version } = await readJson(sdkManifestPath);
  if (isPublished(name, version)) {
    console.log(`\n${name}@${version} is already on npm; skipping.`);
    return undefined;
  }

  const nodeInclude = resolve(dirname(process.execPath), "..", "include", "node");
  if (!existsSync(join(nodeInclude, "node_api.h"))) {
    throw new Error(
      `node_api.h not found under ${nodeInclude}; run with a Node.js install that ships headers.`,
    );
  }
  const readelf = findOnPath(
    ["readelf", "llvm-readelf"],
    ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"],
  );
  if (readelf === undefined) {
    throw new Error(
      "readelf or llvm-readelf is required to verify the Linux addons' glibc baseline.",
    );
  }

  const fxStaging = join(stagingRoot, "fx");
  await rm(fxStaging, { recursive: true, force: true });
  const addonsDir = join(fxStaging, "addons");
  await mkdir(addonsDir, { recursive: true });
  // check-linux-abi.py invokes `readelf` by that exact name.
  const toolsDir = join(fxStaging, "bin");
  await mkdir(toolsDir, { recursive: true });
  await symlink(readelf, join(toolsDir, "readelf"));
  const toolEnv = { ...process.env, PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ""}` };

  const addons = [];
  for (const { name: platform, target } of FX_TARGETS) {
    const prefix = join(fxStaging, `build-${platform}`);
    run(
      "zig",
      [
        "build",
        "-Dnapi-surface=core",
        "-Doptimize=ReleaseSafe",
        `-Dtarget=${target}`,
        "-Dcpu=baseline",
        `-Dnode-include-dir=${nodeInclude}`,
        "-p",
        prefix,
      ],
      { cwd: fxDir },
    );
    const addon = join(addonsDir, `libfx.${platform}.node`);
    run("cp", [join(prefix, "lib", "libfx.node"), addon]);
    if (platform.startsWith("linux")) {
      run("python3", [join(fxDir, "sdk", "scripts", "check-linux-abi.py"), addon], {
        env: toolEnv,
      });
    }
    addons.push(addon);
  }
  run("zig", ["build", "-Dwasm-surface=core"], { cwd: fxDir });
  run("zig", ["build", "-Dwasm-surface=term"], { cwd: fxDir });

  const hostAddon = join(addonsDir, `libfx.${process.platform}-${process.arch}.node`);
  if (existsSync(hostAddon)) {
    run(process.execPath, [join(fxDir, "sdk", "tests", "test-native-model.mjs"), hostAddon], {
      cwd: fxDir,
    });
  }

  const packageDir = join(fxStaging, "package");
  run(
    process.execPath,
    [join(fxDir, "sdk", "scripts", "package-libfx.mjs"), packageDir, ...addons],
    {
      cwd: fxDir,
    },
  );
  run("npm", ["pack", "--pack-destination", fxStaging], { cwd: packageDir });
  const tarballs = (await readdir(fxStaging)).filter((entry) => entry.endsWith(`-${version}.tgz`));
  if (tarballs.length !== 1) throw new Error(`Expected one packed FX tarball in ${fxStaging}.`);
  return { name, version, tarball: join(fxStaging, tarballs[0]) };
}

const options = parseArgs(process.argv.slice(2));
const [major] = process.versions.node.split(".").map(Number);
if (major < 24)
  throw new Error(`Publishing requires Node.js 24 or newer; running ${process.version}.`);

const releases = [];
if (options.only !== "fx") releases.push(await prepareChip());
if (options.only !== "chip") releases.push(await prepareFx(options.fxDir));

const ready = releases.filter((release) => release !== undefined);
if (ready.length === 0) {
  console.log("\nNothing to publish.");
  process.exit(0);
}
for (const release of ready) {
  run("npm", [
    "publish",
    release.tarball,
    "--access",
    "public",
    ...(options.dryRun ? ["--dry-run"] : []),
  ]);
  console.log(`${options.dryRun ? "Dry run for" : "Published"} ${release.name}@${release.version}`);
}
