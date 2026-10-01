---
title: "Audit: Making eve an independent, provider-agnostic framework"
description: "A file-by-file audit of eve's coupling to Vercel, the runtime dependency map, the model and execution architecture, proposed package boundaries, an implementation plan, and the open decisions that need owner approval."
status: proposed
issue: "owner-initiated independence audit (no upstream issue)"
last_updated: 2026-10-01
---

# Audit: making eve independent of Vercel

This audit records what is structurally coupled to Vercel, what is already
independent, and what must change before this fork can be built, tested, and
published as its own distribution. It gates implementation work: no package is
published until the owner approves the names in
[Proposed package names](#e-2-proposed-package-names--requires-owner-approval).

Every claim is traced to a file at commit `3790b79c`. Paths are relative to the
repository root.

## Executive summary

**eve is already far less Vercel-coupled than its branding suggests**, but it is
coupled in one place that matters more than all the others combined.

Already correct:

- The published `eve` package has **two runtime dependencies**: `nitro` and
  `undici`. Every `@vercel/*` package is a `devDependency` vendored into build
  output by `packages/eve/scripts/vendor-compiled/`. There is no Vercel package
  in the runtime install graph.
- The default workflow world is `@workflow/world-local`, not Vercel
  (`packages/eve/src/internal/workflow/world-target.ts:8`).
- The default sandbox prefers Docker, then microsandbox, then just-bash. Vercel
  Sandbox is selected **only** when `process.env.VERCEL` is set
  (`packages/eve/src/sandbox/backends/default.ts:79`).
- `eve build` and `eve start` are Nitro-host operations with no Vercel import in
  their code path.
- `eve link` and `eve deploy` are separately registered, lazily-imported commands
  (`packages/eve/src/cli/commands/register-project-commands.ts:24`).

Genuine blockers:

- **A bare string model id is defined as meaning Vercel AI Gateway.** This is a
  type-level contract, a runtime contract, and a setup contract. Fixing it makes
  the rest of the provider story fall out naturally.
- The default model id `openai/gpt-5.6-luna-fast` is a gateway slug, so every
  `eve init` bakes in Vercel.
- The default Docker and microsandbox base image is
  `ghcr.io/vercel/eve:<version>`, which upstream will never tag for fork
  releases.
- Package identity `eve` is Vercel-owned on npm, so a new name is the owner's
  decision.

Everything else — OIDC, sandbox, deployment, blob memory, tracing — already sits
behind an interface or an optional subpath export and can stay put.

## A. Runtime dependency map

### A.1 Published runtime dependencies

`packages/eve/package.json` declares exactly two `dependencies`:

| Package                 | Purpose                          | Vercel-specific |
| ----------------------- | -------------------------------- | --------------- |
| `nitro@3.0.260903-beta` | dev/prod host and build pipeline | No              |
| `undici@8.9.0`          | fetch implementation             | No              |

There is **no `@vercel/*` runtime dependency**, which already satisfies the
repository's packaging principle (coding principle 5).

### A.2 Vendored packages

Third-party code is vendored by `packages/eve/scripts/vendor-compiled/index.mjs`
and reached through the `#compiled/*` import condition. Vercel entries:

| Vendored package         | Used by                                          | Required for core eve?                 |
| ------------------------ | ------------------------------------------------ | -------------------------------------- |
| `@vercel/sandbox`        | `src/execution/sandbox/bindings/vercel-*.ts`     | No — only `sandbox/backends/vercel.ts` |
| `@vercel/sandbox-drives` | Vercel sandbox session drives                    | No                                     |
| `@vercel/oidc`           | `src/channel/auth/oidc.ts`                       | No — only `vercelOidc()`               |
| `@vercel/otel`           | `src/tracing/vercel-runtime-span-exporter.ts`    | No                                     |
| `@vercel/blob`           | `src/public/memory/file/backends/vercel-blob.ts` | No                                     |
| `@vercel/detect-agent`   | agent detection headers                          | Advisory                               |
| `@workflow/world-vercel` | `src/internal/workflow/world-target.ts:9`        | No — `"vercel"` is opt-in              |

Non-Vercel vendored packages that matter for independence: `ai`,
`@ai-sdk/{openai,anthropic,google,provider,provider-utils,mcp,code-mode,otel}`,
and `@workflow/{core,world,world-local,builders,serde,errors,utils}`. These are
already provider-neutral and are the substrate the target architecture builds on.

### A.3 Classification of every Vercel coupling

Key: **required** means core cannot start or run without it; **optional** means
reachable only by explicit user selection; **dev-only** covers build, test, and
CI; **docs** covers prose and metadata; **accidental** means coupling with no
architectural justification.

| #   | Surface                                  | Location                                                                                                                  | Class                     | Notes                                                               |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| 1   | String model id implies AI Gateway       | `src/shared/agent-definition.ts:58`, `src/internal/classify-model-routing.ts:32`, `src/runtime/agent/resolve-model.ts:69` | **required**              | The core blocker. See section B.                                    |
| 2   | Default model id is a gateway slug       | `src/shared/default-agent-model.ts`                                                                                       | **required**              | Every `eve init` bakes in Vercel.                                   |
| 3   | Gateway model catalog for metadata       | `src/runtime/agent/model-catalog.ts:24`                                                                                   | **required (soft)**       | Context windows for string ids come from `ai-gateway.vercel.sh`.    |
| 4   | Provider picker has no non-Vercel option | `src/setup/provider-settings.ts:11`                                                                                       | **required**              | Only `chatgpt`, `ai-gateway-key`, and `ai-gateway-project`.         |
| 5   | Wizard demands a Vercel login            | `src/setup/flows/provider.ts:249`                                                                                         | **required**              | Chooses `ai-gateway-project`, then requires a login before any key. |
| 6   | `eve link`                               | `src/cli/commands/link.ts`                                                                                                | optional                  | Vercel project link plus gateway credential pull.                   |
| 7   | `eve deploy`                             | `src/cli/commands/deploy.ts`                                                                                              | optional                  | Vercel production deploy.                                           |
| 8   | `vercelOidc()`                           | `src/public/channels/auth.ts:1093`                                                                                        | optional                  | Already an `AuthFn` returned to the author.                         |
| 9   | Vercel Sandbox backend                   | `src/sandbox/backends/vercel.ts`                                                                                          | optional                  | Behind `SandboxBackend`; the default chain skips it off Vercel.     |
| 10  | `withEve`                                | `src/public/vercel/index.ts:91`                                                                                           | optional                  | Already isolated at `eve/vercel`.                                   |
| 11  | Vercel Blob file memory                  | `src/public/memory/file/vercel.ts`                                                                                        | optional                  | Behind the file-memory backend interface.                           |
| 12  | Vercel runtime span exporter             | `src/tracing/vercel-runtime-span-exporter.ts`                                                                             | optional                  | Tracing exporter choice.                                            |
| 13  | Vercel build-output config               | `src/internal/nitro/host/vercel-build-output-config.ts`                                                                   | optional                  | Only when emitting Build Output API v3.                             |
| 14  | Sandbox base image registry              | `src/execution/sandbox/bindings/eve-image.ts:3`                                                                           | **accidental**            | Docker and microsandbox default to `ghcr.io/vercel/eve`.            |
| 15  | Sandbox user name                        | `docs/sandbox.mdx:173`, e2e fixtures                                                                                      | **accidental**            | `vercel-sandbox` unix user baked into the base image.               |
| 16  | Default image constant                   | `src/execution/sandbox/bindings/eve-image.ts:21`                                                                          | **accidental**            | Couples the default self-hosted path to a Vercel registry.          |
| 17  | Root `vercel` devDependency              | root `package.json`                                                                                                       | dev-only                  | CLI shim for e2e and deploy flows.                                  |
| 18  | `AI_GATEWAY_API_KEY` in CI               | `.github/workflows/*.yml`                                                                                                 | dev-only                  | e2e credentials.                                                    |
| 19  | `VERCEL_OIDC_TOKEN`, `VERCEL_PROJECT_ID` | e2e workflow, `src/shared/vercel-project.ts`                                                                              | dev-only / optional       | Identity derivation for sandbox and routing.                        |
| 20  | `eve.dev` URLs                           | README, docs, `src/cli/commands/registry-presentation.ts:115`                                                             | **docs**                  | Roughly 1892 files mention `eve.dev`.                               |
| 21  | `pkg.eve.dev` benchmark source           | `apps/benchmarks/lib/source.mjs:3`                                                                                        | **docs**                  | Upstream artifact host.                                             |
| 22  | Upstream image analysis CI               | `.github/workflows/docker-image-size-analysis.yml`                                                                        | dev-only                  | Inspects `ghcr.io/vercel/eve`.                                      |
| 23  | npm package name `eve`                   | `packages/eve/package.json`                                                                                               | **accidental**            | Name is Vercel-owned. See section E.                                |
| 24  | `vercel` in package keywords             | `packages/eve/package.json`                                                                                               | **docs**                  | Metadata only.                                                      |
| 25  | Security contact                         | `SECURITY.md:7`                                                                                                           | **docs**                  | Points at `responsible.disclosure@vercel.com`.                      |
| 26  | Repository URLs                          | all `package.json`                                                                                                        | **docs**                  | `github.com/vercel/eve`.                                            |
| 27  | `eve/v1` route prefix                    | `src/shared/public-route-prefix.ts`                                                                                       | **accidental (cosmetic)** | The wire protocol is branded, not Vercel-specific.                  |
| 28  | Sandbox probe reads `process.env.VERCEL` | `src/sandbox/backends/default.ts:44`                                                                                      | optional                  | Correct: selects Vercel Sandbox only when actually on Vercel.       |

### A.4 The runtime dependency map

```
                        ┌──────────────────────────────────────────┐
                        │           eve (published)               │
                        │   runtime deps: nitro, undici ONLY       │
                        └───────────────────┬──────────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
   CORE PATHS                        OPTIONAL PATHS                      VENDORED (build-time)
   (no Vercel needed)                (explicit user opt-in)
        │                                   │                                   │
  ┌─────▼──────┐                   ┌────────▼─────────┐              ┌──────────▼──────────┐
  │ harness/    │                   │ sandbox/vercel   │              │ @vercel/sandbox     │
  │ tool-loop   │                   │ channels/auth    │              │ @vercel/oidc        │
  │ runtime/    │                   │   .vercelOidc()  │              │ @vercel/otel        │
  │ agent/      │                   │ public/vercel    │              │ @vercel/blob        │
  │   resolve-  │                   │   .withEve()     │              │ @workflow/world-    │
  │   model     │                   │ memory/file/     │              │   vercel            │
  └─────┬──────┘                   │   vercel         │              └─────────────────────┘
        │                          │ tracing/vercel-  │
        │  BLOCKED                 │   runtime-span-  │
        │  bare string = gateway   │   exporter       │
        ▼                          │ cli/link         │
  ┌──────────────┐                 │ cli/deploy       │
  │ AI SDK       │                 └──────────────────┘
  │ default      │
  │ provider=gw  │
  └──────┬───────┘
         │ gateway.id or LanguageModel
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │ ai-gateway.vercel.sh │ openai │ anthropic │ google │ …  │
  └──────────────────────────────────────────────────────────┘
```

## B. Model architecture

### B.1 Current path, traced end to end

```
user message
  → channels/ (eveChannel, slack, …)
  → client → POST /eve/v1/...
  → runtime/agent/bootstrap.ts        builds RuntimeModelReference {id, source, …}
  → runtime/agent/resolve-model.ts    resolveRuntimeModelReference(reference)
      ├─ BOOTSTRAP_RUNTIME_MODEL_ID?  → MockLanguageModelV3 (local, no network)
      ├─ mock model (EVE_E2E_MODEL)?   → MockLanguageModelV3
      ├─ source-backed (authored)?    → load compiled export, return its model
      └─ otherwise → return reference.id        ← RAW STRING
  → AI SDK resolves that string via globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway
  → tool calls loop in harness/tool-loop.ts
  → result streams back
```

### B.2 Exactly where Vercel is required

Four points, in decreasing severity:

1. **Type contract.** `PublicAgentStaticModelDefinition = string | LanguageModel`
   (`src/shared/agent-definition.ts:58`). The doc comment defines a string as an
   AI Gateway model id, so a string is _typed_ as gateway-routed and every
   downstream consumer relies on that.
2. **Runtime resolution.** `resolveRuntimeModelReference` ends with
   `return reference.id;` (`src/runtime/agent/resolve-model.ts:69`). The bare
   string goes to the AI SDK, whose default provider is `gateway`. The canary
   test `src/internal/aisdk-provider-contract.test.ts:22` pins this behavior, so
   **a bare string can only ever reach the gateway**.
3. **Classification.** `classifyModelRouting` hardcodes
   `typeof model === "string"` to `{kind: "gateway"}`
   (`src/internal/classify-model-routing.ts:32`). This flows into the compiled
   manifest, `eve info`, the TUI status line, and credential resolution.
4. **Metadata.** `createRuntimeModelCatalog` fetches
   `https://ai-gateway.vercel.sh/v1/models/catalog` to look up context windows
   and resolved ids (`src/runtime/agent/model-catalog.ts:24`,
   `src/internal/gateway.ts:5`). This is a **network call to Vercel on the model
   path**, even for a direct-provider id.

Two secondary points:

- `formatLanguageModelGatewayId` (`src/internal/runtime-model.ts:24`) rewrites
  `claude-opus-4-7` to `claude-opus-4.7`, a gateway-specific id format. Correct
  for the gateway, wrong as a general normalizer.
- The default model is `openai/gpt-5.6-luna-fast`, a gateway slug.

### B.3 What already works without Vercel

- A **direct provider model instance** (`anthropic("claude-opus-4-7")`,
  `openai("gpt-5.4")`, `google("gemini-2.5-pro")`) already bypasses the gateway.
  `classifyModelRouting` returns `{kind: "external"}` and `resolveProviderHeaders`
  adds no gateway headers (`src/internal/gateway.ts:27`). The canary test proves
  the provider identities.
- `@ai-sdk/openai` with a custom `baseURL` already reaches Ollama, llama.cpp,
  LM Studio, or vLLM. Nothing in eve prevents this today; it is simply
  undocumented and unreachable from `eve init`.

So **the AI SDK abstraction is the right architecture and already exists**. The
work is to make provider selection explicit and stop treating a bare string as a
gateway instruction.

### B.4 Proposed model architecture

Adapted to what this codebase already has:

```
Eve
 └── ModelProvider
      ├── openai(...)        → @ai-sdk/openai        (already vendored)
      ├── anthropic(...)     → @ai-sdk/anthropic     (already vendored)
      ├── google(...)        → @ai-sdk/google        (already vendored)
      ├── ollama(...)        → @ai-sdk/openai w/ baseURL  (no new runtime dep)
      ├── openaiCompatible({baseURL, apiKey})  → any local/compatible endpoint
      ├── custom(...)        → any AI SDK LanguageModel
      └── gateway(...)       → AI Gateway             (OPTIONAL adapter)
```

Design decisions:

- **A string model id must not imply the gateway.** Resolution order becomes:
  explicit authored provider, then a provider registry, then a configured
  default provider (env or app config), and only then the gateway, for backwards
  compatibility. The AI SDK's global default provider is never consulted
  implicitly.
- **A new `eve/models` entrypoint** exposes provider factories. `ollama()` and
  `openaiCompatible()` are thin wrappers over the already-vendored
  `@ai-sdk/openai`, so there is **no new runtime dependency**, honoring coding
  principle 5.
- **Metadata lookup becomes pluggable.** `RuntimeModelCatalog` keeps its
  interface; the gateway catalog becomes one implementation and a local one
  serves authored or declared metadata offline.
- **The default model becomes configurable**, not baked in.

## C. Execution architecture

### C.1 Trace

```
eve CLI / TUI (src/cli/run.ts)
  → host (src/internal/nitro/host/*)        Nitro dev + prod server
  → runtime (src/runtime/*)                  agent turn loop
  → workflow (compiled world plugin)         @workflow/world-local by default
  → persistence (world data dir)             local filesystem, or Postgres, or Vercel
  → sandbox (SandboxBackend interface)       docker | microsandbox | just-bash | vercel
  → tools (src/tools/*)                      provider-neutral
```

### C.2 What works outside Vercel today

| Layer          | Status                     | Evidence                                                                                                                                                                                   |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI            | **Independent**            | `run.ts` registers `build`, `start`, and `dev` with no Vercel import; `link` and `deploy` are lazy `import()` calls inside their own action bodies (`register-project-commands.ts:35,52`). |
| Host           | **Independent**            | Nitro. `eve build` and `eve start` are the canonical self-hosted path.                                                                                                                     |
| Runtime        | **Independent**            | No Vercel import in the turn loop.                                                                                                                                                         |
| Workflow world | **Independent by default** | `resolveWorkflowWorldImport("local")` returns `@workflow/world-local`; `"vercel"` is an explicit alternative.                                                                              |
| Persistence    | **Independent**            | `resolveLocalWorkflowWorldDataDirectory(process.cwd())`; `@workflow/world-postgres` is in the catalog for external persistence.                                                            |
| Sandbox        | **Independent by default** | `selectDefaultSandbox` probes Docker, then microsandbox, then just-bash; Vercel only when `process.env.VERCEL` is set.                                                                     |
| Tools          | **Independent**            | No Vercel coupling.                                                                                                                                                                        |
| Auth           | **Adapter already**        | `vercelOidc()` returns an `AuthFn`; the author chooses. `localDev()`, `none()`, http-basic, and JWT strategies all exist.                                                                  |
| Channels       | **Independent**            | `eveChannel` with an author-supplied `auth` array.                                                                                                                                         |

### C.3 What requires an adapter

Only the explicit opt-ins: `vercelOidc()`, `vercel()` sandbox, `withEve()`,
`eve link`, `eve deploy`, Vercel Blob memory, and the Vercel span exporter. All
already sit behind interfaces or separate entrypoints. Phases 5 through 8 of the
requested plan are therefore mostly _verification and documentation_, not
restructuring.

The one real gap is items 14 and 16 in section A.3: the **default** Docker and
microsandbox backends pull `ghcr.io/vercel/eve:<eve-version>`. A fork publishing
its own version numbers cannot pull its own image from a registry it does not
control, and upstream will never tag fork releases. This must be fixed for the
self-hosted default path to be genuinely independent.

## D. Deployment architecture

**`eve build` then `eve start` already operates without Vercel.** This is the
canonical independent deployment path.

- `eve build` calls `buildApplication` from `#internal/nitro/host.js`. Its
  options include `vercelServiceOutput` and `skipVercelSandboxPrewarm`, both off
  unless requested.
- `eve start` calls `startProductionHost` (`src/cli/run.ts:98`).
- Vercel Build Output API v3 emission lives in
  `src/internal/nitro/host/vercel-build-output-config.ts` and is engaged only for
  a Vercel service output.

Self-hosting needs a Node 24 or newer host, a workflow world (local disk by
default, Postgres for a real deployment), a sandbox backend (Docker by default),
and a model provider. **No Vercel project, account, OIDC token, or AI Gateway.**

## E. Package architecture

### E.1 Current packages

| Path                             | Name           | Version | Private | Purpose                                       | Vercel-specific?                    |
| -------------------------------- | -------------- | ------- | ------- | --------------------------------------------- | ----------------------------------- |
| `packages/eve`                   | `eve`          | 0.54.3  | no      | The entire framework and CLI (`bin: eve`)     | No, but branded and owned by Vercel |
| `packages/eve-catalog`           | `@eve/catalog` | —       | yes     | Registry metadata for extensions and channels | No                                  |
| `packages/eve-self-modification` | —              | —       | yes     | Built-in self-modification extension          | No                                  |
| `packages/eve-buzz-acp-adapter`  | —              | —       | yes     | Vercel Buzz ACP adapter                       | **Yes**                             |
| root                             | `eve-monorepo` | 0.0.0   | yes     | Workspace root                                | Branding only                       |

There is exactly **one publishable package**. The audit does **not** recommend
splitting it into `eve-cli`, `eve-runtime`, `eve-models`, `eve-workflow`,
`eve-sandbox`, and `eve-vercel`. Reasons:

- The existing subpath export map already provides the separation
  (`eve/sandbox/vercel`, `eve/vercel`, `eve/models/*`, `eve/channels/auth`)
  without new package boundaries, install cost, or version skew.
- Coding principle 2 says the core must stay lean; principle 4 says code is
  liability. Six packages over a shared internal core would be strictly more
  machinery for the isolation the export map already provides.
- A split would break every existing import path (`eve/tools`, `eve/skills`, and
  so on) for no decoupling gain.

**Recommendation: keep one package, keep the subpath export map, and keep Vercel
behind its existing subpaths.** The separation the plan asks for is already
achieved structurally; it needs to be _asserted by tests_ and _documented_, not
rebuilt.

### E.2 Proposed package names — REQUIRES OWNER APPROVAL

`eve` on npm is published and maintained by Vercel (verified: `eve@0.69.0`, 230
versions, `bin: eve`). This fork **cannot and must not** publish to `eve`.

Availability verified against the public registry:

| Candidate       | Status             | Risk                                                |
| --------------- | ------------------ | --------------------------------------------------- |
| `eve`           | **Taken — Vercel** | Not an option                                       |
| `eve-framework` | **Available**      | Reasonable and descriptive                          |
| `eve-runtime`   | **Available**      | Misleading; this is a framework, not just a runtime |
| `eve-agents`    | Taken (`0.1.0`)    | —                                                   |
| `eve-agent`     | Taken (`0.0.1`)    | —                                                   |

**Primary recommendation: `eve-framework`.** It is available, descriptive, keeps
brand continuity, and does not collide.

Alternatives the owner may prefer, each requiring a registry check before
commitment:

- A personal scope such as `@<owner>/eve`, which offers the cleanest ownership
  story and no collision risk, but requires the scope to exist and be configured.
- A neutral rename such as `durable-agents` or `fsagents`, the cleanest break but
  the biggest loss of continuity and of the `eve` CLI name.

Two further decisions that need the owner:

- **CLI binary name.** Keep `eve`, which is already used and reads well in
  `eve/…` import paths, or rename it? Renaming the binary is cheap; renaming
  import paths is not.
- **Docs host.** `eve.dev` is Vercel's. Where do docs and the registry
  (`https://eve.dev/r/…`, consumed by `eve add` and
  `src/cli/commands/registry.ts`) point after the fork?

**Nothing will be published until these are approved.**

## F. Proposed architecture

```
                    ┌─────────────────────┐
                    │       Eve CLI       │
                    │        + TUI        │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     Eve Runtime     │
                    └─────┬─────┬─────┬──┘
                          │     │     │
                ┌─────────▼┐ ┌──▼───┐ ┌▼─────────┐
                │  Models  │ │Tools │ │ Channels │
                └────┬─────┘ └──────┘ └──────────┘
                     │
        ┌────────────┼─────────────────────┐
        │            │          │          │
     OpenAI      Anthropic    Gemini     Local
                                          │
                                    ┌─────▼─────┐
                                    │  Ollama   │
                                    │ llama.cpp │
                                    │ vLLM      │
                                    └───────────┘
                    ┌─────────────────────┐
                    │ Workflow abstraction│
                    └──────────┬──────────┘
                               │
                  ┌────────────┼─────────────┐
                  │            │             │
                Local       Postgres       Custom
                    ┌─────────────────────┐
                    │ Sandbox abstraction │
                    └──────────┬──────────┘
                               │
                ┌──────────────┼─────────────┐
                │              │             │
              Docker      Microsandbox     Custom

Optional adapters (existing subpath exports):
                    ┌─────────────────────┐
                    │  Vercel Adapter     │
                    ├─────────────────────┤
                    │ eve/vercel          │  withEve()
                    │ eve/sandbox/vercel  │  vercel()
                    │ eve/channels/auth   │  vercelOidc()
                    │ eve/memory/file/    │
                    │   vercel            │  Blob file memory
                    │ eve link, eve deploy│
                    │ AI Gateway          │  gateway()
                    └─────────────────────┘

The Vercel adapter is NOT required by core Eve.
```

What changes versus today: only the **Models** block and the **default sandbox
image registry**. Everything else already matches this diagram.

## G. Dependency and coupling matrix

Legend: ✅ independent · ⚠️ coupled but fixable · ❌ blocker

| Concern                         | Core today               | After                        | Change required                            |
| ------------------------------- | ------------------------ | ---------------------------- | ------------------------------------------ |
| Package install                 | ✅ nitro and undici only | ✅                           | none                                       |
| CLI start                       | ✅                       | ✅                           | none                                       |
| `eve build` and `eve start`     | ✅                       | ✅                           | none                                       |
| TUI                             | ✅ no Vercel login       | ✅                           | none                                       |
| Model: direct provider          | ✅                       | ✅                           | none                                       |
| Model: string id                | ❌ implies gateway       | ✅ configurable              | **provider registry and resolution order** |
| Model: metadata catalog         | ⚠️ Vercel fetch          | ✅ pluggable                 | catalog implementation split               |
| Model: default id               | ❌ gateway slug          | ✅ configurable              | configurable default                       |
| Model: `eve init` provider list | ❌ gateway only          | ✅ includes local and direct | extend `PROVIDER_SELECTIONS`               |
| Workflow world                  | ✅ local default         | ✅                           | none                                       |
| Sandbox backend                 | ✅ availability based    | ✅                           | none                                       |
| Sandbox image registry          | ❌ `ghcr.io/vercel/eve`  | ✅ own registry              | **image resolution**                       |
| Auth                            | ✅ adapter               | ✅                           | none                                       |
| Deploy                          | ✅ self-host canonical   | ✅                           | none                                       |
| Branding and metadata           | ❌ Vercel URLs           | ✅ own                       | rename pass                                |
| npm identity                    | ❌ `eve` taken           | ✅ new name                  | owner decision                             |

## H. Implementation plan

Ordered so each step is independently verifiable. Steps 1 through 3 are the
substance; steps 4 through 6 are hygiene.

### Step 1 — Provider-independent model resolution (the blocker)

1. Add a provider registry in core: a name to `LanguageModel` factory map with
   built-in `openai`, `anthropic`, `google`, and `ollama` or `openaiCompatible`
   entries built on the **already-vendored** `@ai-sdk/*` packages. No new runtime
   dependency.
2. Change string-model resolution to consult, in order: an explicit authored
   provider, the registry, a configured default provider such as
   `EVE_DEFAULT_MODEL_PROVIDER`, and only then the gateway.
3. Update `classifyModelRouting` so a string is `gateway` **only** when it
   actually resolves to the gateway provider. Keep the existing
   `{kind: "external"}` shape.
4. Split `RuntimeModelCatalog` into a gateway-backed implementation and an
   offline implementation, so a non-gateway model never triggers a Vercel
   network call.
5. Make the default model id configurable, defaulting to a local-capable
   provider rather than a gateway slug.

### Step 2 — Local model as a first-class path

1. Add an `eve/models` entrypoint exporting the provider factories, including
   `ollama({baseURL, model})` and `openaiCompatible({baseURL, model, apiKey})`.
2. Extend `PROVIDER_SELECTIONS` and the `eve init` wizard with **Local endpoint**
   and **Direct provider** options, so `eve init` then `eve` never needs a
   Vercel login.
3. Add a setup flow that writes a provider-authored model into `agent/agent.ts`
   and persists the endpoint or base URL in app env.
4. Test against a real local OpenAI-compatible endpoint. A stub server speaking
   `/v1/chat/completions` is acceptable and deterministic; a live Ollama run is
   a manual check.

### Step 3 — Self-hosted sandbox image

1. Make the Docker and microsandbox base image registry configurable through
   `EVE_SANDBOX_IMAGE`, keeping `ghcr.io/vercel/eve` as the fallback for upstream
   compatibility.
2. Document building and publishing the fork's own sandbox image.

### Step 4 — Independence-boundary tests (Phase 12)

| Test              | Tier        | Assertion                                                                                     |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------- |
| Local startup     | integration | Host boots and serves health with no `VERCEL*` or `AI_GATEWAY_*` env                          |
| Local model       | integration | Agent completes a turn against a local OpenAI-compatible endpoint, no gateway                 |
| Direct provider   | integration | Agent uses an `@ai-sdk/*` instance directly                                                   |
| Self-hosted build | scenario    | `eve build` and `eve start` succeed with no Vercel credentials                                |
| Sandbox           | integration | Default non-Vercel sandbox path selects Docker or just-bash                                   |
| Workflow          | integration | State survives across restarts on the local world                                             |
| Vercel isolation  | unit        | Core paths contain no import of a Vercel-only module, asserted by a static import-graph check |
| CLI               | integration | `eve --help`, `eve build`, and `eve info` never trigger a Vercel login                        |

The isolation test should be a **mechanical graph check** so that
`pnpm guard:invariants` can enforce it, consistent with the repository's
existing guard.

### Step 5 — Rename and rebrand (Phase 9)

- Package description, keywords, `homepage`, `bugs`, and `repository`.
- README, `docs/`, `SECURITY.md`, and `CONTRIBUTING.md`.
- CLI help text and generated project metadata.
- `docs/meta.json` navigation for the new pages.
- **Preserve** `NOTICE` (Vercel copyright and third-party notices), `LICENSE`
  (Apache-2.0), and upstream attribution. Do not rewrite commit authorship.

### Step 6 — Documentation (Phase 13)

`docs/architecture.md`, `docs/self-hosting.md`, `docs/local-models.md`,
`docs/providers.md`, plus a release and packaging guide.

## I. Migration risks

| #   | Risk                                                                                                   | Severity                   | Mitigation                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Changing string-model resolution breaks every existing `agent.ts` using a bare slug                    | **High**                   | Keep gateway as the final fallback so existing ids keep working, and add a test pinning the fallback.              |
| 2   | The compiled manifest's `routing.kind` shape is consumed by the TUI, `eve info`, evals, and benchmarks | **High**                   | Extend the union additively; do not remove `{kind: "gateway"}`.                                                    |
| 3   | The AI SDK default-provider canary test pins gateway behavior                                          | Medium                     | Update it deliberately and document the new resolution order.                                                      |
| 4   | `ghcr.io/vercel/eve` tags do not exist for fork versions, so Docker and microsandbox sandboxes fail    | **High**                   | Step 3 makes the registry configurable **before** the first fork release.                                          |
| 5   | The `vercel-sandbox` unix user is baked into the base image and asserted in e2e                        | Medium                     | Keep the user name for image compatibility and document it as an inherited artifact, not a Vercel dependency.      |
| 6   | `eve.dev` hosts the extension registry consumed by `eve add`                                           | **High**                   | Either keep pointing at upstream as a documented default, or self-host the registry and make the URL configurable. |
| 7   | The `eve/v1` wire route prefix is branded                                                              | Low                        | Leave it. Renaming is a breaking protocol change with no decoupling benefit.                                       |
| 8   | npm name collision                                                                                     | **Blocker for publishing** | Owner decision in section E.2 before any publish.                                                                  |
| 9   | Roughly 1892 files reference `eve.dev`                                                                 | Medium                     | Prioritize published docs, README, and CLI strings; leave test fixtures where harmless.                            |
| 10  | `apps/benchmarks` fetches immutable tarballs from `pkg.eve.dev`                                        | Low                        | Benchmarks are dev-only; repoint or drop.                                                                          |
| 11  | e2e CI jobs require `AI_GATEWAY_API_KEY` and Vercel OIDC secrets                                       | Low                        | Not required for local development; fork CI can run unit, integration, and scenario tests only.                    |
| 12  | Vendored `@workflow/world-vercel` implies a Vercel runtime path exists in `dist`                       | Low                        | It is inert unless the author selects `"vercel"`. Keep it as an optional adapter.                                  |
| 13  | Renaming the CLI binary breaks muscle memory and scripts                                               | Low                        | Owner decision; keep `eve` by default.                                                                             |
| 14  | Public API changes need a research doc per repository policy                                           | Medium                     | This audit plus a research entry in `research/` should accompany the change.                                       |

## J. Decisions requiring owner approval

1. **npm package name**: `eve-framework` (recommended) versus a personal scope.
2. **CLI binary name**: keep `eve` versus rename.
3. **Docs and registry host**: keep `eve.dev` as an upstream default versus
   self-host.
4. **Sandbox image registry**: publish the fork's own image versus require
   `EVE_SANDBOX_IMAGE`.
5. **Scope of the rename**: metadata and docs only, versus also the `eve/v1`
   route prefix and `eve/…` import paths. The latter is a large breaking change
   with no decoupling benefit and is not recommended.
