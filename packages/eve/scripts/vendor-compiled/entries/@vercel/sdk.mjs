// Thin ESM re-export shim for the vendored `@vercel/sdk` package.
//
// Only the two trusted-source helpers the dev TUI uses are surfaced, so the
// vendor pipeline pulls a small, stable surface rather than the SDK's full
// model tree.
export { updateProjectTrustedSourcesFromJSON } from "@vercel/sdk/models/updateprojectblock.js";
export { trustedSourcesToJSON } from "@vercel/sdk/models/updateprojectprojectsbranchmatcher.js";
