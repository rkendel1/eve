---
title: Chip Independence Audit
description: Architectural audit of remaining Vercel and eve coupling in the Chip product.
---

# Chip Independence Audit

Audit-only. This document records what is coupled to Vercel and to the `eve`
identity today, how each dependency is actually reached, and what stands between
the current state and a fully independent product. No code changed to produce it.

## 1. Executive summary

**Chip is installed and runs today, but it is not yet independent.** The
packaging layer is clean; the product layer is not.

The published `@appport/chip` package declares **no** Vercel dependency at all.
Its entire runtime dependency set is `nitro` and `undici`; every `@vercel/*`
package is a `devDependency` vendored into `dist/src/compiled/` at build time.
Verified by running the real CLI from a clean install with every outbound socket
blocked:

| Command              | Vercel/eve.dev reached |
| -------------------- | ---------------------- |
| `chip --version`     | none                   |
| `chip --help`        | none                   |
| `chip init <name>`   | none                   |
| `chip info`          | none                   |
| `chip dev --help`    | none                   |
| `chip deploy --help` | none                   |
| `chip link --help`   | none                   |

So the _install and boot_ path is genuinely Vercel-free. That is a real result
and it is already done.

Three things nevertheless keep Vercel underneath the product:

1. **Model routing is Vercel-defined by default.** A bare `provider/model`
   string is _classified_ as gateway-routed, and every model — including a
   direct provider instance — requires context-window metadata that is fetched
   from `ai-gateway.vercel.sh`. Absent an explicit override, the model path
   cannot start.
2. **Telemetry is on by default and posts to Vercel.** A fresh install sends a
   persistent `installation_id` and `project_id` to
   `telemetry.vercel.com` on every command, including `chip --version`. No
   prompt, no opt-in.
3. **The provider picker offers no non-Vercel option.** The only three
   `PROVIDER_SELECTIONS` are `chatgpt`, `ai-gateway-key`, and
   `ai-gateway-project`; two of the three are Vercel.

Everything else that touches Vercel — sandbox, deployment, Blob, OIDC, Connect,

## 2. Vercel dependency inventory

Declarations across the workspace:

| Location                                   | Declaration                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/eve/package.json` (dev)          | `@vercel/blob`, `@vercel/detect-agent`, `@vercel/oidc`, `@vercel/otel`, `@vercel/sandbox`, `@vercel/sandbox-drives`, `@vercel/sdk`, `@workflow/world-vercel` |
| `packages/eve/package.json` (peer)         | **none**                                                                                                                                                     |
| `packages/eve/package.json` (dependencies) | **none**                                                                                                                                                     |
| root `package.json` (dev)                  | `vercel@59.5.0` — build/CI only                                                                                                                              |
| `apps/docs`                                | `@vercel/geistdocs`, `@vercel/analytics`, `@vercel/speed-insights`, `@vercel/connect` — docs site                                                            |
| `apps/benchmarks`                          | `@vercel/agent-eval` — benchmarking                                                                                                                          |
| `apps/package-artifacts`                   | `@vercel/blob` — packaging sample                                                                                                                            |

Because these are devDependencies, the published manifest carries no Vercel
requirement. `scripts/check-bin-runtime-dependencies.mjs` enforces this for the
`bin/` entrypoints: every bare import in a shipped bin file must resolve from
`dependencies`. That guard is why `nitro` is the only real runtime dependency.

Vendored Vercel code that ships inside the artifact (available, never required):
`dist/src/compiled/@vercel/{blob,oidc,otel,sandbox,sandbox-drives,detect-agent,sdk}/`
and `dist/src/compiled/@workflow/world-vercel/`.

### Classification table

| Location                                        | Dependency                      | Class                       | Reachable?                               | Default          | If unavailable                                 | User can avoid?                                            | Action                                     |
| ----------------------------------------------- | ------------------------------- | --------------------------- | ---------------------------------------- | ---------------- | ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `src/internal/gateway.ts:6`                     | `ai-gateway.vercel.sh`          | **DEFAULT BUT REPLACEABLE** | yes, on model resolution                 | on               | model cannot resolve without explicit override | yes, via `modelContextWindowTokens`                        | add a catalog interface; do not remove     |
| `src/shared/default-agent-model.ts:5`           | default model is a gateway slug | **FOUNDATIONAL (config)**   | yes, every new project                   | on               | new projects route to Vercel                   | yes, author edits `model`                                  | change default to a direct provider        |
| `src/setup/provider-settings.ts:12`             | 3 provider options, 2 Vercel    | **DEFAULT BUT REPLACEABLE** | yes, during setup                        | on               | user must pick one of three                    | yes                                                        | add provider options                       |
| `src/cli/telemetry/flush.ts:1`                  | `telemetry.vercel.com`          | **DEFAULT BUT REPLACEABLE** | yes, every command                       | **on, silently** | telemetry just fails                           | yes, `chip telemetry disable` / `EVE_TELEMETRY_DISABLED=1` | make opt-in, or make endpoint configurable |
| `src/cli/commands/registry.ts:112`              | `eve.dev/r` registry            | **OPTIONAL ADAPTER**        | only on `registry`/`add` commands        | on when used     | registry features unavailable                  | yes, `EVE_DEV_OFFICIAL_REGISTRY_URL`                       | leave; document                            |
| `src/sandbox/backends/default.ts:54`            | Vercel Sandbox backend          | **OPTIONAL ADAPTER**        | only when `VERCEL` env set               | **last**         | nothing — chain falls through                  | yes, pin a backend                                         | no action                                  |
| `src/public/sandbox/vercel-sandbox.ts:33`       | `vcr.vercel.com` image          | **OPTIONAL ADAPTER**        | only via `vercel()`                      | off              | nothing                                        | yes                                                        | no action                                  |
| `src/public/sandbox/microsandbox-sandbox.ts:20` | `ghcr.io/vercel/eve`            | **OPTIONAL ADAPTER**        | via `microsandbox()`                     | 3rd in chain     | falls to `just-bash`                           | yes                                                        | no action                                  |
| `src/internal/workflow/world-target.ts:9`       | `@workflow/world-vercel`        | **OPTIONAL ADAPTER**        | only when target is Vercel               | off              | local world used                               | yes, `experimental.workflow.world`                         | no action                                  |
| `src/cli/commands/deploy.ts`                    | Vercel deploy                   | **OPTIONAL ADAPTER**        | only on `chip deploy`                    | off              | nothing                                        | yes, don't run it                                          | no action                                  |
| `src/public/vercel/index.ts:91`                 | `withEve`                       | **OPTIONAL ADAPTER**        | author-invoked, isolated at `eve/vercel` | off              | nothing                                        | yes                                                        | no action                                  |
| `src/public/channels/auth.ts`                   | `vercelOidc()`                  | **OPTIONAL ADAPTER**        | returns an `AuthFn` to author            | off              | nothing                                        | yes                                                        | no action                                  |
| `src/setup/flows/provider.ts:249`               | Vercel login in wizard          | **OPTIONAL ADAPTER**        | only if `ai-gateway-project` chosen      | off              | choose another                                 | yes                                                        | no action                                  |

## 3. Eve identity inventory

Separating the package-compatibility surface from the product identity:

| Reference                       | Where                                       | Why it exists                                               | User-facing?                 |
| ------------------------------- | ------------------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| `eve` (package name)            | `packages/eve/package.json`                 | install compatibility; `eve/...` imports resolve through it | no — only via install alias  |
| `eve/...` (75 exports)          | same                                        | the public import namespace                                 | yes — authors import from it |
| `eve/...` (protocol ids)        | routes, schema versions                     | wire compatibility with running apps                        | indirectly                   |
| `EVE_TELEMETRY_DISABLED`        | `cli/telemetry/index.ts:81`                 | opt-out                                                     | yes — documented             |
| `EVE_DEV_OFFICIAL_REGISTRY_URL` | `cli/commands/registry.ts:114`              | registry override                                           | yes                          |
| `EVE_SANDBOX_IMAGE_TAG`         | `public/sandbox/microsandbox-sandbox.ts:20` | sandbox template override                                   | yes                          |
| `.eve/` (project dir)           | scaffold                                    | project metadata, `provider.json`, logs                     | yes                          |
| `eve.dev`                       | `registry.ts:112`, `telemetry/index.ts:235` | registry host + telemetry docs link                         | yes — docs link              |
| `eve` in CLI text               | `help`, scaffolded agent template           | not fully rebranded                                         | yes                          |
| `@vercel/eve`                   | docker image repo only                      | sandbox template                                            | no                           |

`eve/...` is load-bearing and must not be renamed. Everything else is cosmetic or
operational and can move independently. Notably, `.eve/` is the on-disk project
directory, so renaming it is a migration, not a cosmetic change.

## 4. Runtime reachability

Traced empirically by loading the real `runCli` from an installed tarball with
`globalThis.fetch` instrumented and sockets blocked, then by reading the spawn
graph.

- **`chip --version` / `chip --help`** — `bin/eve.js` → `dist/src/cli/run.js`.
  Loads Commander, registers commands, prints. No network. The one side effect
  is the telemetry flush (below).

## 5. Model routing analysis

This is the substantive finding.

**Classification** (`src/internal/classify-model-routing.ts:28-55`):

- a bare `string` → `{ kind: "gateway" }`, by definition. The doc comment is
  explicit: _"A bare string id is defined as gateway-routed."_
- an instance whose `provider` top-level segment is `gateway` → gateway.
- anything else → `{ kind: "external", provider }`.

So a direct provider instance (`openai("gpt-5.4")`) _is_ recognized as external,
and `resolveProviderHeaders` (`internal/gateway.ts:28-31`) attaches no gateway
headers for it. **Model classification itself is not the problem.**

**Metadata is the problem.** `resolveSelectionMetadata`
(`src/runtime/agent/resolve-model.ts:233-259`) resolves context-window tokens
before returning, and:

```ts
if (input.contextWindowTokens !== undefined) { /* no catalog */ }
...
const resolved = await input.load(input.catalog);
if (resolved === null) {
  throw new Error(`Cannot select model "…" because AI Gateway did not provide
    context window metadata. Return modelContextWindowTokens with this selection
    for an unlisted or custom model.`);
}
```

`createRuntimeModelCatalog` (`runtime/agent/model-catalog.ts:23-24`) defaults
`fetchCatalog` to `vercelGatewayFetch` against `AI_GATEWAY_MODELS_CATALOG_URL`
= `https://ai-gateway.vercel.sh/v1/models/catalog`.

**Consequence:** a direct-provider model still triggers a request to
`ai-gateway.vercel.sh` for metadata, and **throws** if that request fails or the
model is unlisted — unless the author supplies `modelContextWindowTokens`.

So, precisely:

- Does a direct `provider/model` cause traffic to `ai-gateway.vercel.sh`?
  **Yes** — one catalog request, for metadata, on both routing kinds.
- Does it route _inference_ through Vercel? **No.**
- Can it fail without Vercel? **Yes**, unless `modelContextWindowTokens` is set.

There is an escape hatch (the error message even documents it), so this is a
poor-default rather than a hard dependency. It is also the single most important
thing to fix.

Compounding it: `DEFAULT_AGENT_MODEL_ID = "openai/gpt-5.6-luna-fast"`
(`src/shared/default-agent-model.ts:5`) is a gateway-shaped slug, and it is what
`chip init` bakes in.

## 6. Sandbox analysis

`defaultSandbox` (`src/sandbox/backends/default.ts:68-70`) picks by
availability, in documented priority order:

1. **Vercel Sandbox** — only when `process.env.VERCEL` is set (i.e. _already
   deployed on Vercel_, where local container runtimes cannot run)
2. **Docker** — when a Linux Docker daemon is reachable
3. **microsandbox** — macOS/Apple Silicon or glibc Linux with KVM
4. **just-bash** — dependency-free fallback

Vercel is selected **only on Vercel**, and is otherwise last. Four separate
backends exist behind the `SandboxBackend` interface
(`src/shared/sandbox-backend.ts`), each independently pinnable.

**A clean local installation executes work without `ghcr.io/vercel/eve`.** That
image is the microsandbox template — third in the chain — and is skipped
whenever Docker or just-bash is available. Verified structurally; not exercised
end-to-end here because it requires a Docker daemon.

This area is already correct. No action.

## 7. Workflow/world analysis

`resolveWorkflowWorldImport` (`src/internal/workflow/world-target.ts:8-9`):

```ts
if (targetWorld === "local") return "@workflow/world-local";
if (targetWorld === "vercel") return "@workflow/world-vercel";
```

The default argument is `"local"` at every call site, e.g.
`development-world-protocol.ts:17` passes `configuredWorld ?? "local"`. Local
execution is the default; `@workflow/world-vercel` requires explicit opt-in, and
`@workflow/world-postgres` is a user-installed third-party world referenced only
in docs and e2e fixtures.

**Local workflow execution is the default and requires no Vercel.** No action.

## 8. Registry analysis

`DEFAULT_OFFICIAL_REGISTRY_URL = "https://eve.dev/r"`
(`src/cli/commands/registry.ts:112`), overridable via
`EVE_DEV_OFFICIAL_REGISTRY_URL` with strict validation (HTTP(S) only, no
credentials) — a deliberate trust boundary, since the registry supplies setup
commands.

Reachability:

- **Required?** No.
- **Optional?** Yes.
- **Configurable?** Yes, via environment only (by design).
- **Reached during normal local operation?** **No.** Verified: `chip --version`,
  `--help`, `init`, `info`, `dev --help` all made zero attempts. It is fetched
  only by registry/add commands (`registry.ts:213`).

Per instructions, unchanged. Worth noting only that it is the one place a
`eve.dev` host is load-bearing, and it is a fetch of an extension catalog, not a
control-plane dependency.

## 9. Environment variable analysis

**Required for local operation: none.** Confirmed by running the CLI under
`env -i` with a stripped PATH and no credentials.

**Optional integration only:** `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`,
`VERCEL`, `VERCEL_OIDC_ISSUER`, `VERCEL_OIDC_AUDIENCE_PREFIX`,
`VERCEL_DEPLOY_ENV`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`,
`VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_APP_CLIENT_ID`,
`VERCEL_APP_CLIENT_SECRET`, `VERCEL_EVE_SANDBOX_IMAGE{,_REPOSITORY}`,
`EVE_SANDBOX_IMAGE_TAG`.

**Opt-out / override:** `EVE_TELEMETRY_DISABLED`, `EVE_TELEMETRY_DEBUG`,
`EVE_DEV_OFFICIAL_REGISTRY_URL`.

**Development/test only:** `EVE_E2E_MODEL`, `EVE_E2E_*`, `NODE_ENV=test`.

**Compatibility:** `VERCEL_BUILDS_FILE_NAME`, `VERCEL_JSON_FILE_NAME`,
`VERCEL_HOST_FRAMEWORK_PRESETS`, `VERCEL_NOT_FOUND_MESSAGE`,
`VERCEL_AUTH_CHALLENGE_MARKERS`, `VERCEL_CALLBACK_HOST_ENVS`,
`VERCEL_AUTOMATION_BYPASS_SECRET` — read to interoperate with the Vercel build
environment when deployed there. Never set locally.

The naming split is itself a finding: the gateway key is `AI_GATEWAY_API_KEY`
(Vercel-neutral), while `VERCEL_*` variables are all Vercel-platform-scoped. No
`AI_GATEWAY_*` variable exists that is Vercel-branded, so no rename is needed
there — but `AI_GATEWAY_API_KEY` is named after a Vercel product.

## 10. Dependency graph

````
Chip CLI (chip)
 |
 +-- startup / help / version ...... REQUIRED   (no Vercel; telemetry only)
 +-- init (project creation) ....... REQUIRED   (no Vercel; bakes gateway model)
 |
 +-- local runtime .................. REQUIRED   (local nitro host)
 +-- workflow / world ............... DEFAULT    world-local; vercel OPTIONAL
 +-- sandbox ....................... DEFAULT    docker|just-bash;
## 11. Local-operation answer

**Yes.**

```sh
npm install @appport/chip
chip --help
chip --version
````

All succeed with no Vercel credentials, no network, and no Vercel packages
installed. Verified against the staged tarball with outbound sockets blocked:
zero attempts, exit 0.

Two caveats that do not prevent operation:

- Telemetry fires and posts to `telemetry.vercel.com` unless disabled. It fails
  silently offline, so the commands still succeed — but "operate without
  Vercel" currently means "operate while phoning home to Vercel."
- The CLI is verified working from an install; the full source-repo `pnpm build`
  toolchain still expects Node >= 24 and the dev dependency set.

## 12. Normal-project-operation answer

**Partially.** Breaking it down per the question:

| Requirement           | Works without it?                                              |
| --------------------- | -------------------------------------------------------------- |
| Vercel account        | Yes                                                            |
| Vercel token          | Yes                                                            |
| Vercel deployment     | Yes — `chip deploy` is optional                                |
| Vercel-hosted service | Yes                                                            |
| Vercel AI Gateway     | **Only with explicit configuration** — see below               |
| Vercel Blob           | Yes — adapter, unused by default                               |
| Vercel Sandbox        | Yes — last in the chain, and only when `VERCEL` is already set |

A user can create a project, run it locally, use a direct provider, use Docker
or just-bash for sandboxing, and run workflows on the local world — with no
Vercel account.

The catch is the model path. To do so today a user must either:

- author `model` as a provider instance **and** supply
  `modelContextWindowTokens`, or
- reach `ai-gateway.vercel.sh` for metadata.

Without one of those, model resolution throws. So: **operable without Vercel,
but not _smoothly_ without it, and not _by default_ without it.**

## 13. Remaining blockers to true independence

Ordered by how much they block a real user.

**B1 — Model metadata is fetched from AI Gateway regardless of routing.**
`resolveSelectionMetadata` throws when the catalog returns null, and the catalog
is always `ai-gateway.vercel.sh`. A direct-provider model therefore makes a
Vercel request and can fail without it.
_Affects every project that runs an agent._ Fix: make the catalog an injectable
interface with a local/derived source, and treat "no metadata" as a warning
rather than a hard error when the model is a direct provider.

**B2 — Telemetry defaults on and posts to Vercel.** Persistent
`installation_id` + `project_id` leave the machine on every command, with no
opt-in. Only the _notice_ is TTY-gated, not the sending.
_Affects every command a user ever runs._ Fix: make the endpoint configurable and
either default the destination off or require explicit consent before sending
identifiers.

**B3 — Default model is a gateway slug.** `chip init` bakes
`openai/gpt-5.6-luna-fast` into every new project.
_Affects every new project._ Fix: default to a direct provider or to the local
model, keeping gateway ids opt-in.

**B4 — No non-Vercel provider option in the picker.** Only `chatgpt`,
`ai-gateway-key`, `ai-gateway-project`.
_Affects interactive setup only._ Fix: add provider options (direct OpenAI /
Anthropic / OpenAI-compatible `baseURL`, local Ollama).

**B5 — Unbranded identity leaks to users.** `eve.dev` telemetry doc link,
`eve` in CLI help (`eve dev https://example.com`), scaffolded agent templates

## 14. Recommended implementation order

1. **Decouple model metadata (B1).** Highest value; unblocks direct-provider
   projects. Introduce a `ModelCatalog` interface with a Vercel implementation
   and a local/derived default, and stop failing hard when metadata is absent
   for a direct provider. Add a test asserting that a direct-provider model
   resolves with no gateway request.
2. **Make telemetry destination-pluggable and consent-based (B2).** Smallest
   change with the largest user-visible effect. Configurable endpoint + explicit
   opt-in before sending persistent identifiers.
3. **Change the default model (B3)** and **add provider options (B4)** together
   — they are one coherent change to model configuration.
4. **Rebrand user-facing strings (B5)** last, once behavior has settled, so the
   final diff is cosmetic. Do not touch `eve/...` imports, the `eve` package
   name, or `.eve/` in the same change.
5. **Strip `devDependencies` from the staged manifest (B6)** opportunistically.

Steps 1–3 are what stand between Chip and genuine independence. Steps 4–5 are
finish-work.

### What this audit deliberately did not do

No renames, no route changes, no dependency changes, no sandbox or model-routing
edits, no registry URL changes, no publication. Every claim above is from
reading the current source or from running the already-built artifact.
importing from `"eve"`, and the `.eve/` project directory.
_Affects polish and discoverability, not function._ Fix: rebrand user-facing
strings; keep `eve/...` imports and `.eve/` until a migration exists.

**B6 — `devDependencies` ship in the published manifest.** The staged
`package.json` still carries `devDependencies` (npm ignores them, so it is
harmless, but it advertises the vendored Vercel set and inflates the artifact).
_Cosmetic._ Fix: strip in the packaging script if desired.

Explicitly **not** blockers: sandbox chain, workflow world, registry, deployment,
Blob, OIDC, Connect, `withEve` — all already adapters.

| vercel OPTIONAL (VERCEL set only)
+-- model provider ................ DEFAULT gateway (ai-gateway.vercel.sh);
| external OPTIONAL but needs
| metadata from the gateway
+-- registry ...................... OPTIONAL eve.dev; configurable; off by default
+-- auth .......................... OPTIONAL vercelOidc() is an adapter
+-- telemetry ..................... DEFAULT telemetry.vercel.com; ON, silent
+-- deployment .................... OPTIONAL chip deploy only
|
+-- Vercel adapters: withEve (eve/vercel), vercel sandbox, vercel world,
vercel deploy, vercel oidc, vercel blob, connect

```

**Vercel is beneath Chip's default configuration, not beneath Chip's execution
path.** Every edge into the core (startup, init, dev, workflow, sandbox,
registry) is either Vercel-free or explicitly selected. The two edges that are
not are model routing and telemetry — and both are *defaults*, not
requirements.


**Local workflow execution is the default and requires no Vercel.** No action.

- **`chip init`** — scaffolds files, writes `.eve/`, runs a package-manager
  install. No Vercel network. Bakes in the default model id, which is a gateway
  slug (see §5).
- **`chip dev`** — starts a local server. Sandbox backend selection is an
  availability chain (§6). Workflow world defaults to local (§7).
- **Model resolution** — the first path that genuinely needs Vercel (§5).
- **Deployment** — `chip deploy` only; shells out to the Vercel CLI.
- **Telemetry** — see §9; reachable on *every* command.

| root `package.json` | `vercel` CLI | **DEVELOPMENT ONLY** | no | n/a | n/a | n/a | no action |
| `apps/docs`, `apps/benchmarks` | Vercel tooling | **DEVELOPMENT ONLY** | no | n/a | n/a | n/a | no action |
| `packages/eve/package.json` | `historical-eve-0-30-8` | **HISTORICAL / COMPATIBILITY** | no | n/a | n/a | n/a | keep |

Note the third sandbox row: the `ghcr.io/vercel/eve` image is the *microsandbox*
template, not the default. A clean local install never pulls it.

`withEve`, Vercel Workflow world — is a correctly isolated adapter behind an
interface, selected explicitly or by an availability probe.

The headline: **Vercel is not beneath Chip's execution path; it is beneath
Chip's default configuration.** That is a materially different problem, and a
much smaller one.

```
