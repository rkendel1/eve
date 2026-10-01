import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

describe("package identity", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
  });

  it("resolves package identity from the installed package metadata", () => {
    const installedPackageInfo = resolveInstalledPackageInfo();

    expect(EVE_PACKAGE_NAME).toBe(installedPackageInfo.name);
    expect(installedPackageInfo.version).toMatch(/\S/);
  });

  it("falls back to bundled package metadata when runtime chunks have no package root", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("Unexpected package.json read.");
      },
      realpathSync: (path: string) => path,
    }));
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Package self-resolution unavailable.");
        },
      }),
    }));

    const { resolveInstalledPackageInfo: resolveBundledPackageInfo } =
      await import("#internal/application/package.js");
    const installedPackageInfo = resolveBundledPackageInfo();

    expect(installedPackageInfo.name).toBe(EVE_PACKAGE_NAME);
    expect(installedPackageInfo.version).toMatch(/\S/);
  });

  it("publishes the chip executable without renaming the package or imports", async () => {
    // The executable, the npm package name, and the import namespace are three
    // separate identities. Renaming the bin must not disturb the other two.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");
    const manifest = JSON.parse(
      await readFile(join(fileURLToPath(new URL("..", import.meta.url)), "package.json"), "utf8"),
    ) as {
      name: string;
      bin: Record<string, string>;
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.bin)).toEqual(["chip"]);
    // Points at the existing bootstrap entrypoint rather than a second copy.
    expect(manifest.bin.chip).toBe("./bin/eve.js");
    // The import namespace is unchanged by the executable rename.
    expect(manifest.name).toBe(EVE_PACKAGE_NAME);
    for (const subpath of ["./tools", "./sandbox/docker", "./vercel"]) {
      expect(manifest.exports).toHaveProperty(subpath);
    }
  });
});
