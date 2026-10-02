import { dirname, join, resolve } from "node:path";

import { getDirectoryEntryType, isDiscoverableAgentRootEntry } from "#discover/filesystem.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { EVE_PACKAGE_NAMES } from "#internal/package-name.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a directory looks like an agent project rather than a bare package.
 *
 * The dependency name cannot establish ownership on its own: `npm install
 * @appport/chip` records the framework in whatever ordinary host directory it
 * ran in, so treating that as project ownership makes every consumer host
 * indistinguishable from a generated agent project. Agent structure is what
 * actually separates the two.
 */
async function hasAgentStructure(root: string, source: ProjectSource): Promise<boolean> {
  // The generated layout, plus `agents/` for a workspace root.
  if (
    (await source.stat(join(root, "agent"))) === "directory" ||
    (await source.stat(join(root, "agents"))) === "directory"
  ) {
    return true;
  }
  const entries = await source.readDirectory(root);
  return entries.some((entry) =>
    isDiscoverableAgentRootEntry(entry.name, getDirectoryEntryType(entry)),
  );
}

/**
 * Whether a package boundary owns an agent project.
 *
 * Requires both a framework dependency and agent structure. Either alone is
 * insufficient: the dependency is present in ordinary consumer hosts, and
 * structure alone would claim an unrelated package that happens to contain an
 * `agent/` directory.
 */
async function ownsAgentProject(root: string, source: ProjectSource): Promise<boolean> {
  const packageJsonPath = join(root, "package.json");
  if ((await source.stat(packageJsonPath)) !== "file") return false;

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await source.readTextFile(packageJsonPath));
  } catch (error) {
    throw new Error(`The package.json at ${packageJsonPath} is not valid JSON.`, { cause: error });
  }

  if (!isJsonObject(packageJson)) return false;
  const dependencies = packageJson.dependencies;
  if (
    !isJsonObject(dependencies) ||
    !EVE_PACKAGE_NAMES.some((name) => typeof dependencies[name] === "string")
  ) {
    return false;
  }

  return await hasAgentStructure(root, source);
}

export async function isEveProjectRoot(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<boolean> {
  const source = options.source ?? createDiskProjectSource();
  return await ownsAgentProject(resolve(root), source);
}

/** Find the nearest package boundary and return it only when it owns an agent project. */
export async function findEveProjectRoot(
  startPath: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<string | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const resolvedStartPath = resolve(startPath);
  let currentDirectory =
    (await source.stat(resolvedStartPath)) === "directory"
      ? resolvedStartPath
      : dirname(resolvedStartPath);

  while (true) {
    if ((await source.stat(join(currentDirectory, "package.json"))) === "file") {
      return (await ownsAgentProject(currentDirectory, source)) ? currentDirectory : undefined;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return undefined;
    currentDirectory = parentDirectory;
  }
}
