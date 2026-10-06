import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

/**
 * The packed artifact has to be self-contained.
 *
 * Dependencies the bundler neither externalizes nor routes through
 * `#compiled/*` get inlined as relative paths into the monorepo's pnpm store,
 * and those paths do not exist once the tarball is installed — so the CLI
 * throws ERR_MODULE_NOT_FOUND before printing anything. That shipped in
 * eve@0.54.3, where `eve --version` died on a missing zod module.
 *
 * This tier owns the assertion because only a real install supplies the peer
 * dependencies (`ai`, `just-bash`, …) that the CLI's command graph imports. The
 * static half — no workspace-relative imports in the built output — lives in
 * `scripts/prepare-chip-package.test.mjs`, which needs no install.
 *
 * The tarball is packed once by `test/setup/pack-scenario-tarball.ts` and shared
 * read-only across workers.
 */
const TARBALL_PATH = process.env.EVE_SCENARIO_EVE_TARBALL_PATH;
const createScratchDirectory = useTemporaryDirectories();

/** Installs the shared tarball into a fresh project with no repo access. */
async function installTarballAs(packageName: string): Promise<string> {
  const projectDir = await createScratchDirectory(`packaged-artifact-${packageName}-`);
  await writeFile(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "consumer", version: "1.0.0", type: "module", private: true }, null, 2)}\n`,
  );
  // A bare `npm install <tarball>` resolves the peer set from the registry, the
  // same way a real consumer's install does.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", TARBALL_PATH as string], {
    cwd: projectDir,
    stdio: "pipe",
  });
  return projectDir;
}

describe("the packed artifact is self-contained", () => {
  it("runs the CLI from an installed tarball", async () => {
    expect(TARBALL_PATH, "set by test/setup/pack-scenario-tarball.ts").toBeTruthy();

    const projectDir = await installTarballAs("cli");
    const installedPackageRoot = join(projectDir, "node_modules", "eve");
    expect(existsSync(installedPackageRoot)).toBe(true);

    const chip = join(projectDir, "node_modules", ".bin", "chip");
    expect(existsSync(chip), "the package must expose a `chip` binary").toBe(true);

    // `--version` and `--help` are the cheapest commands that still load the
    // whole command graph, which is where an unresolvable import surfaces.
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [join(installedPackageRoot, "bin", "eve.js"), ...args], {
        cwd: projectDir,
        encoding: "utf8",
        stdio: "pipe",
      });

    expect(run("--version").trim()).toMatch(/^\d+\.\d+\.\d+/u);
    expect(run("--help")).toMatch(/Usage: chip\b/u);
  }, 600_000);

  it("serves the eve/... import surface", async () => {
    const projectDir = await installTarballAs("imports");

    const probe = join(projectDir, "probe.mjs");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      probe,
      [
        'import { defineAgent } from "eve";',
        'import { defineTool } from "eve/tools";',
        'import { docker } from "eve/sandbox/docker";',
        'import { withEve } from "eve/vercel";',
        "for (const value of [defineAgent, defineTool, docker, withEve]) {",
        '  if (typeof value !== "function") throw new Error("expected a function export");',
        "}",
        "",
      ].join("\n"),
    );

    expect(
      execFileSync(process.execPath, [probe], { cwd: projectDir, stdio: "pipe" }),
    ).toBeDefined();
  }, 600_000);
});
