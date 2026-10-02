/**
 * Package identities the eve framework is installed under.
 *
 * `eve` is the name in this repository and the public import namespace; the
 * published npm artifact installs as `@appport/chip`. Code that identifies its
 * own package — self-referencing through `require.resolve`, or recognizing an
 * installed copy — must accept both, otherwise the published package cannot find
 * itself and every command fails at startup.
 *
 * Primary name first, because most call sites use it to build a resolution
 * specifier and the source tree is where those run.
 *
 * This module is intentionally free of side effects and heavy imports so that
 * any layer can reference the package identity without pulling in filesystem
 * or module-resolution code.
 */
export const EVE_PACKAGE_NAME = "eve";

/** The name the published npm artifact installs under. */
export const PUBLISHED_PACKAGE_NAME = "@appport/chip";

/** Every name this framework may be installed under, source tree first. */
export const EVE_PACKAGE_NAMES = [EVE_PACKAGE_NAME, PUBLISHED_PACKAGE_NAME] as const;

/** Whether `name` identifies this framework under any published identity. */
export function isEvePackageName(name: unknown): name is (typeof EVE_PACKAGE_NAMES)[number] {
  return typeof name === "string" && (EVE_PACKAGE_NAMES as readonly string[]).includes(name);
}
