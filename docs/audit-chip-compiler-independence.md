---
title: Chip Compiler Independence Audit
description: Architecture audit of whether the Chip compiler requires Vercel AI Gateway metadata for direct and local model providers.
---

# Chip Compiler Independence Audit

Audit-only. This document traces the compiler's model-metadata path, establishes
what actually depends on Vercel AI Gateway data, and separates intentional
gateway dependencies from accidental ones. No code changed to produce it.

Companion documents: [Chip Independence Audit](./audit-chip-independence.md)
(runtime model resolution) and [eve Independence Audit](./audit-independent-eve.md).

## 1. Executive finding

**Vercel-dependent due to accidental coupling.**

The compiler does not require AI Gateway metadata for correctness. Every
consumer of the compiled value treats it as optional, the generated manifest
schema declares it `.optional()`, and the runtime has always had a working
fallback for its absence. The throw in `withCompiledRuntimeModelLimits` is an
inherited assumption, not a derived requirement.

The coupling is worse than a missing fallback, though. Direct and local
providers reach `ai-gateway.vercel.sh` **before** eve's own built-in table is
consulted, so an offline or firewalled build fails on a model eve already knows
about. That is an accidental dependency in the strongest sense: the compiler
contacts a third party to learn data it ships.

Two specific defects, both confirmed by execution rather than inspection:

1. `getByProviderModelId` — the direct-provider lookup — has no built-in
   short-circuit, while `getModelLimits` does. A known built-in reached through
   a provider instance performs a network round-trip that can fail the build.
   Measured: `openai.responses/gpt-5.4` compiles at 1 catalog request, while the
   same model authored as the gateway string `"openai/gpt-5.4"` compiles at 0.
2. The error message asserts "compaction" for a value that only ever tunes a
   compaction threshold percentage — an optimization, not a correctness
   constraint.

The correct end state is not "remove Vercel." Gateway-routed models should keep
their strict, actionable compile-time error. It is the _implicit_ reach of
Vercel from unrelated direct and local models that must go.

## 2. Compiler control-flow map

```
author config (agent/agent.ts)
  model: "openai/gpt-5.4"            (string → gateway routing)
  |  model: openai("gpt-5.4")        (instance → provider-based routing)
  |  modelContextWindowTokens: N     (optional explicit override)
        ↓
normalizeAuthoredModelReference()            compiler/normalize-agent-config.ts
  classifyModelRouting()                     internal/classify-model-routing.ts
    string ................................. → { kind: "gateway", target }
    provider === "gateway" .................. → { kind: "gateway", target }
    any other provider ..................... → { kind: "external", provider }
        ↓
  contextWindowTokens defined? ──yes──→ use override, return   (no catalog access)
        │ no
        ↓
  ChatGPT/Codex routing? ──yes──→ contextWindowTokens: 200_000  (no catalog access)
        │ no
        ↓
  modelCatalog.getByProviderModelId(provider, modelId)
        │                     ↑ NO built-in check — may reach the network
        ├─ hit ──→ rewrite id to catalog slug, attach limits
        └─ miss/throw ──→ swallowed, fall through
        ↓
withCompiledRuntimeModelLimits()             compiler/normalize-agent-config.ts
  modelCatalog.getModelLimits(id)
        │                     ↑ built-in check FIRST, then cache, then network
        ├─ null ──→ THROW "does not have known AI Gateway context window metadata"
        └─ throw ─→ THROW "Failed to load AI Gateway model metadata"
        ↓
compiledRuntimeModelReferenceSchema         compiler/manifest.ts:552-563
  contextWindowTokens: z.number().int().positive().optional()   ← optional
        ↓
CompiledAgentManifest (generated artifact)
        ↓
resolveAgent()                               runtime/resolve-agent.ts
  passes contextWindowTokens through verbatim, no requirement
        ↓
createCompactionConfig()                     execution/session.ts:39-43
  undefined → FALLBACK_COMPACTION_THRESHOLD (100_000)
```

Vercel catalog data enters at exactly one place: `getModelLimits` /
`getByProviderModelId` → `fetchAndPersistModelCatalog` →
`vercelGatewayFetch(AI_GATEWAY_MODELS_CATALOG_URL)`
(`compiler/model-catalog.ts:190`).

## 3. Metadata dependency map

Every non-test consumer of `contextWindowTokens`, classified by traced behavior:

| Consumer                                             | Class                          | Why                                           |
| ---------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `compiler/manifest.ts:554` schema                    | **Optional**                   | `.optional()`; artifact validates without it  |
| `compiler/manifest.ts:1336` clone                    | **Optional**                   | Copies only when defined                      |
| `runtime/resolve-agent.ts:294,299`                   | **Optional**                   | Pass-through of an optional field             |
| `execution/session.ts:41`                            | **Optional (fallback exists)** | `undefined` → `FALLBACK_COMPACTION_THRESHOLD` |
| `harness/tool-loop.ts:429`                           | **Optional**                   | Early-returns compaction unchanged            |
| `internal/nitro/.../build-agent-info-response.ts:58` | **Optional**                   | Informational; schema is `.optional()`        |
| `cli/dev/tui/setup-issues.ts:81`                     | **Optional**                   | Diagnostics display only                      |
| `client/agent-info-schema.ts:93`                     | **Optional**                   | `z.number().optional()`                       |
| `runtime/agent/resolve-model.ts:255`                 | **Optional**                   | Explicit override short-circuit               |
| `withCompiledRuntimeModelLimits` throw               | **Accidental**                 | Not required by any consumer                  |

**Answering "what breaks if a direct/local model has no `contextWindowTokens`?"**
— nothing. Compilation already accepts an absent value; the manifest schema is
optional; session resolution substitutes a 100,000-token threshold; the tool
loop leaves its existing compaction config alone. The only consequence is that
compaction triggers at the conservative fallback instead of at
`contextWindow × thresholdPercent`. That is a tuning difference, not a
correctness one.

The compiler needs the value to **calculate an optimization** and to **fail
loudly on typos**. It does not need it to generate correct behavior, and it does
not embed it as a value any consumer treats as mandatory.

## 4. Provider behavior matrix

Measured by executing `compileAgentManifest` against an instrumented `fetch`,
then validating the result with `validateCompiledAgentManifest`. Rows are the
authored model; columns are the three catalog conditions.

`direct` and `local` are both `kind: "external"` — eve distinguishes them only
by provider name, and both reach the catalog identically.

| Provider | Built-in                                | Catalog rejects                                | Catalog returns no match                     | Catalog returns match                 |
| -------- | --------------------------------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| direct   | yes                                     | **compiles**, ctx 400k — _but 1 network call_  | compiles via built-in fallback               | compiles, ctx 400k — _1 network call_ |
| direct   | no                                      | **throws** `Failed to load…`                   | **throws** `does not have known AI Gateway…` | compiles                              |
| local    | yes                                     | compiles only via the same fragile fallback    | throws                                       | compiles                              |
| local    | no                                      | **throws** `Failed to load…`                   | **throws** `does not have known AI Gateway…` | compiles                              |
| gateway  | yes                                     | compiles, ctx 400k — **0 network calls**       | n/a (built-in hits first)                    | compiles                              |
| gateway  | no                                      | **throws** `Failed to load…`                   | **throws** `does not have known AI Gateway…` | compiles                              |
| any      | — + explicit `modelContextWindowTokens` | compiles, ctx = override — **0 network calls** | compiles, ctx = override                     | compiles, ctx = override              |

Two distinctions the source alone obscures, both confirmed empirically:

- **Catalog rejects vs. catalog returns null produce different errors.**
  A rejection surfaces the underlying cause (`Failed to load AI Gateway
metadata for … <cause>`); an empty result produces the static "does not have
  known AI Gateway context window metadata" message. Both are terminal today.
- **Built-in metadata does not reliably prevent catalog access.** It prevents it
  on the `getModelLimits` path but _not_ on `getByProviderModelId`, so a
  direct-provider built-in still makes a request.

## 5. Network dependency map

Paths that can reach Vercel during compilation:

| Path                                       | Reachable for                             | Intentional?                                                                             |
| ------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `getModelLimits` after built-in miss       | any unknown model                         | **Yes** — intentional gateway metadata                                                   |
| `getModelLimits` after built-in hit        | known built-ins                           | No — correctly short-circuited                                                           |
| `getByProviderModelId`                     | **all source-backed direct/local models** | **No — accidental**                                                                      |
| `getModelLimits` retry with `forceRefresh` | any catalog miss                          | Partly — re-checks the cache, but the in-memory memo means at most one request per build |

**Intentional gateway dependency:** a bare string id, or a model whose provider
is `gateway`, genuinely routes through the AI Gateway at runtime. Consulting the
catalog for it is correct and should stay strict.

**Accidental compiler dependency:** a model instance from `openai.responses`,
`anthropic.messages`, `ollama`, or any other non-gateway provider never touches
Vercel at runtime. Reaching the catalog to learn its context window is an
implementation artifact of shared code, not a routing requirement.

Answers to the specific questions:

1. **Which model types can reach the network?** Any model that is not a known
   built-in, plus — erroneously — _all_ source-backed direct/local models via
   `getByProviderModelId`.
2. **Can direct-provider compilation reach Vercel?** Yes. Always attempted first.
3. **Can local-provider compilation reach Vercel?** Yes, identically. `ollama`
   is classified `external` and still queries the catalog.
4. **Does gateway compilation intentionally reach Vercel?** Yes.
5. **Is a catalog failure distinguishable from missing metadata?** Yes — two
   distinct error messages, both currently terminal.
6. **Does explicit `modelContextWindowTokens` prevent catalog access?** Yes,
   verified at 0 fetches.
7. **Does built-in metadata prevent catalog access?** Only on `getModelLimits`.
8. **Is there an offline mode?** No. The only offline mechanisms are the
   `.eve/cache/model-catalog.json` disk cache and an in-memory per-build cache.
   Both still let a miss attempt the network, and a direct-provider model
   cannot benefit from the built-in table on its first lookup.

A further consequence worth naming: compilation performs network I/O at all.
That is invisible in the unit tier because
`packages/eve/test/setup/mock-ai-gateway.ts` intercepts
`ai-gateway.vercel.sh` for **every** unit and integration run and synthesizes a
successful catalog from model ids scraped out of the repo. The happy path is
therefore the only path the default test harness can observe.

## 6. Test coverage

Existing coverage in
`packages/eve/test/scenarios/compiler-model-catalog.scenario.test.ts`:

- `uses fresh cached metadata when a cache-miss refresh fails` — asserts the
  "no known metadata" error and that `fetch` was called once.
- `fails clearly when compaction requires unresolved model limits` — same error
  with an empty-but-successful catalog.
- `preserves catalog request failures for models without built-in metadata` —
  asserts the rejection-surfacing error.
- `compiles source-backed models with built-in metadata when the catalog is
unavailable` — the closest existing test to independence. It passes because
  `getByProviderModelId` throws and the fallback slug lookup finds the built-in.
  It does **not** assert that no request was made.
- `uses authored modelContextWindowTokens and skips the AI Gateway lookup` (and
  the source-backed and compaction variants) — explicit override skips the
  catalog.

Unit coverage in `packages/eve/src/compiler/model-catalog.test.ts` includes
`uses built-in limits without fetching the catalog`, which asserts zero fetches
for `getModelLimits` **only**.

These tests encode the current Vercel-dependent behavior as intended. Three of
them assert on the exact "does not have known AI Gateway context window
metadata" string, so any fix must update them deliberately.

Missing regression coverage:

- No assertion that a **direct/local provider** built-in performs zero catalog
  requests — the defect in this audit is invisible to the current suite.
- No assertion that an unknown **direct/local** model compiles without metadata.
- No assertion that the compiler mirrors the runtime's direct-provider rules.
- No test covering `getByProviderModelId` against the built-in table at all.
- No test asserting an upper bound on catalog requests per model. (Measured
  behavior is one request per build, enforced by the loader's in-memory memo —
  but nothing pins that, and the direct-provider built-in case is still 1 where
  it should be 0.)
- Because the default harness always mocks a _successful_ catalog, no test can
  distinguish "catalog unavailable" from "model unknown" without the explicit
  `vi.spyOn` overrides the scenario file already uses.

## 7. Recommended implementation

Not implemented here. The smallest change that makes direct/local compilation
independent of Vercel while preserving strict gateway behavior:

**1. Short-circuit the built-in table inside the provider-instance lookup.**
In `compiler/model-catalog.ts`, normalize the provider/model pair into a
built-in lookup key before any cache or network access, mirroring what
`getModelLimits` already does and what the runtime catalog does today. This
removes the network call for every known direct/local model.

**2. Make metadata optional for non-gateway routing at the throw site.**
In `withCompiledRuntimeModelLimits`, when the lookup yields no limits, return
the model reference unchanged if `routing.kind === "external"`; keep the
existing throw for `routing.kind === "gateway"`. Routing is already classified
at this point, so no new plumbing is needed.

**3. Keep gateway strict.** A gateway-routed model with unresolvable metadata
must keep an actionable compile-time error — it genuinely routes through Vercel,
and a bad id there is a configuration mistake worth failing on.

Files likely to change:

- `packages/eve/src/compiler/model-catalog.ts`
- `packages/eve/src/compiler/normalize-agent-config.ts`
- `packages/eve/test/scenarios/compiler-model-catalog.scenario.test.ts`
  (update the three error-string assertions; add independence cases)
- `packages/eve/src/compiler/model-catalog.test.ts` (built-in coverage for
  `getByProviderModelId`)

Behavior before/after:

| Case                         | Before                           | After                       |
| ---------------------------- | -------------------------------- | --------------------------- |
| direct/local, known built-in | 1 network call; fails if offline | 0 network calls             |
| direct/local, unknown        | throws                           | compiles without metadata   |
| gateway, unknown             | throws                           | throws (unchanged)          |
| any, explicit override       | 0 network calls                  | 0 network calls (unchanged) |

Required tests:

- direct and local built-in compile with `fetch` never called
- direct and local unknown compile with no `contextWindowTokens`, and the
  artifact still passes `validateCompiledAgentManifest`
- gateway unknown still throws
- catalog rejection is tolerated for external routing and still surfaced for
  gateway routing
- the runtime 100k fallback engages for compiled-without-metadata agents

Invariants that must remain unchanged:

- `compiledRuntimeModelReferenceSchema` keeps `contextWindowTokens` optional.
- `FALLBACK_COMPACTION_THRESHOLD` and its 100,000 value are untouched.
- Gateway routing, `vercelGatewayFetch`, gateway headers, and BYOK handling are
  untouched.
- `resolveSelectionMetadata`'s runtime semantics — explicit override wins,
  external degrades, gateway strict — are untouched.
- The built-in table stays a single shared source in
  `internal/model-catalog.ts`; no second copy.

One open design question this audit cannot settle from source alone: whether the
runtime's tolerate-a-failure catalog attempt should also become a
routing-aware local-only path. That is runtime behavior and out of scope here;
the compiler fix above is independent of how it is resolved.

## 8. Explicit non-goals

Deliberately untouched by this audit:

- runtime model resolution (`runtime/agent/resolve-model.ts`)
- AI Gateway routing, `vercelGatewayFetch`, gateway headers, BYOK
- the built-in model table itself (no entries added or removed)
- telemetry, `chip init`, `.eve/`, packaging, CLI branding
- provider adapters, AppPort, FeltDB, Compute, Attn
- the `.eve/cache` catalog cache and its stale-on-error behavior

No Vercel or AI Gateway support was removed. No provider metadata API was
invented, no cache was introduced, no network fallback was added, and the
compiler's semantics were not changed — this document only establishes what they
are and what they should be.
