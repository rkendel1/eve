// Minimal declaration for the vendored slice of `@vercel/sdk`.
// eve only round-trips a project's trusted-source block through the CLI's JSON
// output, so these types mirror the upstream shapes that actually travel over
// the wire rather than the SDK's full model tree. Widen them if a future caller
// reads or writes a field beyond what the trusted-sources flow touches.

export interface UpdateProjectOidcProviders {
  to: UpdateProjectToProjects;
  label?: string;
  claims: Record<string, Array<string>>;
}

/** One project entry as the CLI reads it back from `vercel project ls --json`. */
export interface UpdateProjectProjectsProjects {
  label?: string;
  /** Overrides for the default same-env-by-slug matching. */
  customAllow?: Array<UpdateProjectCustomAllow>;
}

/** The SDK's `ClosedEnum`: a closed string-literal union, not an object. */
export type UpdateProjectFromProjectsPreset = "all-custom";
export type UpdateProjectFromProjectsResponsePreset = "all-custom";
export type UpdateProjectToProjectsResponsePreset = "all-custom";

/**
 * Environment slugs on one side of a trusted-source rule. Both halves expose
 * the same two optional fields upstream, and callers read them defensively
 * (`set.slugs?.includes(...)`), so a single shape covers both variants.
 */
export interface UpdateProjectEnvironmentSet {
  slugs?: Array<string>;
  preset?: UpdateProjectFromProjectsResponsePreset | UpdateProjectToProjectsResponsePreset;
}

export type UpdateProjectFrom = UpdateProjectEnvironmentSet;

export type UpdateProjectToProjects = UpdateProjectEnvironmentSet;

/** A single `from` → `to` environment rule on a project's trusted-source list. */
export interface UpdateProjectCustomAllow {
  from: UpdateProjectFrom;
  to: UpdateProjectToProjects;
}

export interface UpdateProjectTrustedSources {
  projects?: Record<string, UpdateProjectProjectsProjects>;
  oidcProviders?: Record<string, Array<UpdateProjectOidcProviders>>;
}

export type TrustedSources = UpdateProjectTrustedSources;

/** The SDK's `Result<T>`: a discriminated `{ ok, value }` / `{ ok, error }`. */
export type SafeParseResult<T, E = unknown> =
  | { ok: true; value: T; error?: never }
  | { ok: false; value?: never; error: E };

/**
 * Parses a trusted-source block out of the CLI's JSON output. Throws the
 * SDK's validation error when the payload does not match the schema.
 */
export declare function updateProjectTrustedSourcesFromJSON(
  jsonString: string,
): SafeParseResult<UpdateProjectTrustedSources, Error>;

/** Serializes a trusted-source block for `--trusted-sources`. */
export declare function trustedSourcesToJSON(trustedSources: TrustedSources): string;
