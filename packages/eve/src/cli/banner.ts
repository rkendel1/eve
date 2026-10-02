import pc from "#compiled/picocolors/index.js";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

/**
 * Executable name users invoke. The `bin` field in package.json publishes this
 * name, so the wordmark and the help/usage text stay in one place rather than
 * drifting from what npm actually installs.
 *
 * The npm package is published as `@appport/chip` and the import namespace
 * stays `eve/...`; only the executable is branded `chip`.
 */
export const CHIP_WORDMARK = "chip";

/**
 * The boot banner shared by every CLI command that announces itself: the Chip
 * badge plus the installed version. Printed only by the CLI program's
 * pre-action hook so commands never compose their own variant.
 */
export function chipCliBanner(): string {
  const { version } = resolveInstalledPackageInfo();
  return `${pc.bgBlack(pc.white(`☰${CHIP_WORDMARK} `))} ${pc.dim(`v${version}`)}`;
}

/**
 * The unstyled wordmark-and-version tag (`☰chip  v0.54.3`) — the boot banner's
 * plain-text form. The dev TUI dims it as its parting line on teardown.
 */
export function chipVersionTag(): string {
  const { version } = resolveInstalledPackageInfo();
  return `☰${CHIP_WORDMARK}  v${version}`;
}
