---
title: Chip Telemetry Independence Audit
description: Architecture audit of whether Chip telemetry depends on Vercel, what it collects, and what contract an independent Chip should adopt.
---

# Chip Telemetry Independence Audit

Audit only. This document traces Chip's telemetry implementation, establishes
what actually depends on Vercel, documents the real payload and consent
semantics, and recommends the smallest contract that gives Chip independence.
No code changed to produce it.

Companion documents: [Chip Independence Audit](./audit-chip-independence.md)
(overall dependency inventory), [Chip Compiler Independence
Audit](./audit-chip-compiler-independence.md), and [eve Independence
Audit](./audit-independent-eve.md).

## 1. Executive finding

**Vercel-dependent by design — but the dependency is already inert.**

This is the opposite of the compiler finding, and the distinction matters. The
telemetry client posts to `telemetry.vercel.com`, and that endpoint is
hardcoded as the default. Nothing about the _event model_, _identity scheme_,
or _configuration_ is Vercel-specific, though. Vercel appears in exactly one
place: a URL constant, plus three `eve-cli` header names that are a naming
convention rather than a protocol dependency.

The independence problem is therefore **not** the transport. It is the default
value:

- Telemetry is **enabled by default** (`enabled: z.boolean().default(true)`).
- There is **no affirmative consent** — no prompt, no opt-in.
- A persistent `installation_id` and `project_id` are generated on the user's
  machine and sent on **every command**, including `chip --version`.
- The endpoint default is a Vercel hostname.

So the honest classification is: **the mechanism is already independent; only
its default is Vercel's.** That makes this a much smaller problem than the
compiler dependency, and it means the fix is a decision plus a constant, not a
rewrite.

### Is telemetry on Chip's critical path?

**No — and this is proven, not assumed.** Every telemetry call site is either
synchronous and side-effect-free, or wrapped so that a failure cannot escape.
Empirically confirmed against the built modules:

| Failure injected             | Result                                                  |
| ---------------------------- | ------------------------------------------------------- |
| Endpoint refuses connections | no throw                                                |
| Malformed payload JSON       | no throw                                                |
| Corrupted persisted config   | no throw; falls back to `{enabled:true,notified:false}` |
| `spawn` failure              | swallowed by `child.on("error", () => {})`              |

The invariant _telemetry failure ≠ Chip failure_ **already holds**. Chip runs
correctly offline; it simply phones home while doing so.

## 2. Telemetry control flow

There are **two independent telemetry systems** in this repository. They share
no code and should not be conflated.

### System A — CLI telemetry (`src/cli/telemetry/`)

This is the one with the Vercel dependency.

```
chip <any command>
  ↓
cli/run.ts:652   const telemetry = createEveCliTelemetry(version)
  ↓
cli/run.ts:667   telemetry.trackCommand(command)      → in-memory event
cli/run.ts:668   await telemetry.notify(logger)       → stderr notice ONLY
  ↓
cli/run.ts:671   await program.parseAsync(input)      ← THE ACTUAL COMMAND
  ↓
cli/run.ts:674   telemetry.trackOutcome("success"|"usage_error"|"error")
  ↓
cli/run.ts:696   finally { await telemetry.flush() }   ← never rethrows
        ↓
flush(): appends identity_kind, installation_id, project_id
        ↓
        ├─ EVE_TELEMETRY_DEBUG set → print to stderr, RETURN (no network)
        └─ otherwise → spawn(detached, EVE_TELEMETRY_DISABLED=1)
                            `chip telemetry flush <json>`
                                ↓
              flush.ts:34  fetch(EVE_TELEMETRY_ENDPOINT ?? VERCEL_DEFAULT)
                            1s timeout, all errors caught
```

The detached-child design is deliberate: it keeps telemetry off the parent's
stdout/stderr and off its exit path. `EVE_TELEMETRY_DISABLED=1` is injected
into the child so the child does **not** recursively flush another batch.

### System B — OpenTelemetry tracing (`src/tracing/`, `src/instrumentation/`)

**Not Vercel-dependent by default.** This is developer-facing tracing, and the
exporter is chosen by environment:

- `instrumentation/providers.ts:55` registers the Vercel agent-runs exporter
  **only** when `VERCEL_ENV` is `preview` or `production`.
- Otherwise local dev writes spans to `.eve/traces/` on disk, controlled by
  `EVE_TRACES` (default on, `EVE_TRACES_CONTENT` default off).

So a Chip user running locally with no Vercel environment writes traces to
their own disk and contacts nothing. This system needs no work for independence;
it should be documented so the two are not mistaken for one dependency.

## 3. Vercel dependency map

```
Chip
 ├── agent runtime / compiler / channels
 │      └── no telemetry dependency at all
 │
 ├── System A: CLI telemetry (src/cli/telemetry/)
 │    ├── event model      index.ts      — generic {id, event_time, key, value}
 │    ├── event vocabulary index.ts:23-66 — generic (command, setup_step, …)
 │    ├── identity         identity.ts   — generic UUID + salted SHA-256
 │    ├── configuration    preference.ts — generic local JSON config
 │    ├── consent/notice   index.ts:221  — generic
 │    └── TRANSPORT        flush.ts:1    — VERCEL-SPECIFIC
 │         ├── DEFAULT_ENDPOINT = https://telemetry.vercel.com/api/eve-cli/v1/events
 │         ├── header client-id: eve-cli
 │         ├── header x-eve-cli-topic-id
 │         └── header x-eve-cli-session-id
 │
 └── System B: OTEL tracing (src/tracing/, src/instrumentation/)
      ├── span model / processors       — generic (OTEL standard)
      ├── local disk exporter           — generic (.eve/traces/)
      └── Vercel exporter               — OPTIONAL, requires VERCEL_ENV
```

**Vercel-specific:** exactly one constant and three header names.
**Generic:** the event model, vocabulary, identity scheme, consent model, and
CLI surface. There is no Vercel SDK, no Vercel auth, no Vercel identity
provider, and no Vercel event format.

This is a well-factored seam that simply has the wrong default pointed at it.

## 4. Data collection

Captured from a live run against a local sink (`EVE_TELEMETRY_ENDPOINT`), not
from documentation.

**Wire format**

```
POST /api/eve-cli/v1/events
content-type: application/json
client-id: eve-cli
x-eve-cli-topic-id: generic
x-eve-cli-session-id: <per-process uuid>

[{"id":"<uuid>","event_time":<epoch ms>","key":"...","value":"..."}, ...]
```

**Fields actually sent**

| Key                                             | Class                 | Value observed                           |
| ----------------------------------------------- | --------------------- | ---------------------------------------- |
| `version`                                       | version               | package version                          |
| `command`                                       | command               | canonical subcommand name                |
| `outcome`                                       | outcome               | `success` / `usage_error` / `error`      |
| `target`                                        | environment           | `local` / `remote`                       |
| `ui`                                            | environment           | `tui` / `headless`                       |
| `setup_flow`                                    | setup step            | `init` / `extension_init` / `onboarding` |
| `setup_step`                                    | setup step            | bounded enum (12 values)                 |
| `setup_terminal_step` / `setup_terminal_result` | setup outcome         | bounded enums                            |
| `setup_failure_code`                            | error                 | **bounded enum** (15 values)             |
| `registry_selected_count`                       | count                 | integer only                             |
| `identity_kind`                                 | identity              | `persistent` / `ephemeral`               |
| `installation_id`                               | installation identity | random UUID v4, generated locally        |
| `project_id`                                    | project identity      | salted SHA-256 hex                       |

**Deliberately absent** — this is the privacy-positive finding:

- No filesystem paths (the `cwd` used for `project_id` is hashed, never sent raw)
- No agent names, instructions, prompts, or model ids
- No git remote URL (hashed into `project_id`)
- No error messages, stack traces, or exception text
- No environment variables
- No OS/platform, no username, no hostname
- No user-entered values

The `setup_failure_code` enum is the clearest signal of intent: failures are
reduced to one of 15 bounded categories before they leave the machine. The
comment at `index.ts:38` says so explicitly — "a bounded, non-sensitive reason
for a failed setup terminal event."

**Classification:** pseudonymous. `installation_id` is a random local UUID and
`project_id` is `SHA-256(projectSalt ‖ gitRemote ?? repositoryUrl ?? cwd)`. The
salt is a separate local UUID, so `project_id` is not reversible without it and
is not stable across machines. No field is directly identifying, and nothing is
derived from server-side state — identity is generated locally.

## 5. Consent and configuration

**Default state: enabled. Consent: none required.** Measured on a fresh `HOME`
with no config file:

```
default_preference = {"enabled":true,"notified":false}
isEnabled()        = true          ← the sending gate, with zero user action
config exists      = false         ← not even a config file yet
```

**Does Chip require an affirmative action before sending? No.** `flush()`
consults exactly three conditions (`index.ts:78-84`):

```
NODE_ENV !== "test"  &&  !EVE_TELEMETRY_DISABLED  &&  preference.enabled
```

With none of them set by the user, the batch is sent. Verified controls:

| Control                    | Effect on `isEnabled()`                                    |
| -------------------------- | ---------------------------------------------------------- |
| (nothing)                  | **true**                                                   |
| `EVE_TELEMETRY_DISABLED=1` | false                                                      |
| `NODE_ENV=test`            | false                                                      |
| `chip telemetry disable`   | false                                                      |
| `chip telemetry enable`    | true                                                       |
| `CI=1`                     | does **not** disable — only switches identity to ephemeral |
| non-TTY                    | does **not** disable                                       |

**The notice is purely informational.** `notify()` (`index.ts:221-242`) writes
one string to stderr and returns. It never writes a preference that `flush()`
reads, so it cannot gate sending. The `notified` flag exists only to avoid
reprinting the notice.

Confirmed empirically: `isEnabled()` is `true` with `notified:false`.

**The prior audit's observation reproduces exactly.** `EVE_TELEMETRY_DEBUG=1`
prints the batch and returns _without sending_ — so a fresh environment with
that variable sees no `telemetry.vercel.com` traffic. But that is a debug
affordance. Without it, the same fresh environment sends. The earlier reading
was right that the _notice_ is TTY-gated while the _sending_ is not.

**Config file** — `~/.config/eve/config.json` (Linux),
`~/Library/Preferences/eve/config.json` (macOS), `%APPDATA%\eve\config.json`
(Windows). Written atomically (temp file + rename) with mode `0600`. A malformed
file degrades to defaults rather than throwing.

## 6. Failure behavior

Telemetry cannot break Chip. Each mechanism, by construction:

| Site                           | Protection                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `flush()` identity resolution  | `try { … } catch { return; }` (`index.ts:256`)                               |
| `flush()` spawn                | `child.on("error", () => {})` + `unref()` + `try/catch` (`index.ts:274-278`) |
| `flushEveCliTelemetry` parse   | `try/catch` returning early (`flush.ts:26-31`)                               |
| `flushEveCliTelemetry` network | `try/catch` around `fetch`, 1s `AbortSignal.timeout` (`flush.ts:45-47`)      |
| `markEveTelemetryNotified`     | wrapped; comment says "must not affect the command"                          |
| `readEveTelemetryPreference`   | `try/catch` returning `{enabled:true,notified:false}`                        |
| `resolveEveTelemetryProjectId` | `getGitRemote` has a 1s timeout and swallows errors                          |

Empirically confirmed: unreachable endpoint, malformed payload, and corrupted
config all returned without throwing.

**Two caveats worth recording, both non-fatal but user-visible:**

1. `notify()` is awaited _before_ `program.parseAsync` (`run.ts:668`). It does
   a config read and, on a TTY, a config **write**. A slow or hung filesystem
   adds latency to every command's startup, and the notice can interleave with
   the command's own output. Non-fatal, but telemetry is technically on the
   startup path.
2. `flush()` is awaited in a `finally` block (`run.ts:696`), so it runs on the
   exit path of every command. It is bounded (one config read, one git call at
   1s timeout, one detached spawn) and never rethrows, but it is not zero-cost.

Neither contradicts the "failure ≠ Chip failure" invariant; both are latency
rather than correctness. A future change should still move `notify()` after
command dispatch.

## 7. Identity lifecycle

Both identities are **generated locally** and stored in the same user-level
config file, **not** in `.eve`.

```
{"telemetry":{
  "enabled": true,
  "installationId": "9252e136-5e4b-46f2-a64a-22b9e405f9df",
  "projectSalt":   "7557141b-beb4-4bb4-ae21-11516677c755"
}}
```

| Property                     | Finding                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Generated where              | Locally, `crypto.randomUUID()` (`identity.ts:14-16`)                                                            |
| Server-side identity         | **None.** No server mints or validates identity.                                                                |
| Persisted where              | `~/Library/Preferences/eve/config.json` (macOS), `~/.config/eve/config.json` (Linux), `%APPDATA%` (Windows)     |
| Tied to `.eve`               | **No** — measured `tied_to_dot_eve_dir=false`. Unrelated to any project.                                        |
| Tied to a project            | `installationId` no; `project_id` is derived per-repo at send time                                              |
| Survives reinstall           | **Yes** — it lives in user config, not in the package or `.eve`                                                 |
| Deterministic                | `installationId` no (random). `project_id` is **deterministic per salt**: same salt + same git remote ⇒ same id |
| Reset                        | Delete `installationId`/`projectSalt` ⇒ both regenerate (verified `true`)                                       |
| Survives `telemetry disable` | **Yes** — verified `true`. Disabling stops sending; it does not forget the machine.                             |
| File permissions             | `0600`, written via temp-file + atomic rename                                                                   |

**Ephemeral environments.** `isEphemeralEveTelemetryEnvironment()` returns true
when `CI` is set or `/.dockerenv` exists. Then identity is generated in-memory
and `identity_kind=ephemeral` is reported, so **nothing persistent is created
or sent in CI**. Verified `ephemeral_when_CI_set=true`.

Note the asymmetry: CI environments get a _stable-per-run_ ID, not a disabled
one. CI still sends telemetry — just without a durable identifier.

**Inherited-from-Vercel identity?** No. There is no Vercel token, no Vercel
account ID, and no `VERCEL_*` read anywhere in `src/cli/telemetry/`. The
`telemetry.vercel.com` endpoint receives a random UUID the client invented.
Switching the endpoint therefore requires **no identity migration**.

## 8. Recommended architecture

**Keep the telemetry. Change the default and the constant.** Deleting telemetry
would discard a well-designed, privacy-conscious, already-decoupled system —
the opposite of what independence requires.

The smallest architecture that gives Chip independence:

1. **Make the endpoint a Chip-owned default.** Replace the hardcoded
   `telemetry.vercel.com` constant with a Chip-owned default, overridable by
   `EVE_TELEMETRY_ENDPOINT` (which already exists and already works).
2. **Decide the default state explicitly, as a product call.** Opt-out-by-default
   is the current behavior and is what makes Chip Vercel-dependent _in
   practice_ even though it is not in code. This is the one decision this audit
   deliberately does not make for you.
3. **Move `notify()` after command dispatch** so telemetry stops sitting on the
   startup path, and make the notice the last thing printed rather than the
   first.

**Do not build a new abstraction.** The seam already exists and is already
clean. Introducing a transport interface, an event bus, or a provider registry
for a single 20-line `fetch` would be adding indirection with no second
implementation to justify it (see AGENTS.md coding principle 4). If a second
sink is ever needed, extract it then.

**Should Vercel telemetry remain an adapter?** Yes, and the smallest clean
boundary already exists: `EVE_TELEMETRY_ENDPOINT`. A Vercel sink is one env
var away and requires no code. Nothing more is needed.

### Independence invariant to adopt

> Chip core operation succeeds with no Vercel credentials, no Vercel
> environment, and no network.
>
> Telemetry is never required for compilation, model resolution, agent
> execution, sandbox execution, or any CLI command. A telemetry failure is
> never observable in a command's exit status or stdout.

**Already proven:** the second paragraph is established empirically in §6 and by
the 31 passing tests in `src/cli/telemetry/`. **Not yet true:** the first
paragraph's _no-network_ clause holds, but a default-on client pointed at a
Vercel hostname means Chip still _depends on Vercel for a courtesy POST_,
which is exactly what independence should remove.

## 9. Implementation plan

Not implemented here. If the defaults change, the work is small and local.

**Files likely to change**

- `packages/eve/src/cli/telemetry/flush.ts` — the `DEFAULT_ENDPOINT` constant
  and the `eve-cli` header names (rename only if Chip owns the wire contract)
- `packages/eve/src/cli/run.ts` — move `notify()` after `parseAsync`
- `packages/eve/src/cli/telemetry/index.ts` — the notice text
- `packages/eve/src/cli/telemetry/preference.ts` — the `enabled` default
  (`z.boolean().default(true)`) if the default flips
- `packages/eve/src/cli/telemetry/*.test.ts` — tests asserting default-on
- `docs/reference/telemetry.md`, `docs/reference/cli.md` — user-facing contract
- `docs/audit-chip-independence.md` — the B2 finding becomes stale

**Behavior before/after**

| Case                     | Before                            | After (endpoint + default changed) |
| ------------------------ | --------------------------------- | ---------------------------------- |
| Fresh install, no config | posts to Vercel                   | posts to Chip sink (or nowhere)    |
| Endpoint unreachable     | silent                            | silent (unchanged)                 |
| `telemetry disable`      | no send                           | no send (unchanged)                |
| `CI=1`                   | ephemeral identity, still sends   | unchanged, or disabled             |
| Command latency          | notice read/write before dispatch | notice after dispatch              |

**Migration concerns**

- **Existing installs keep a persisted `enabled` preference.** Flipping the code
  default does _not_ flip machines that already have a config file. A migration
  must distinguish "user explicitly chose" from "never asked" — currently
  indistinguishable, because `enabled` is written on first telemetry contact
  without the user ever having chosen. **This is the real migration risk** and
  needs its own design; do not silently reinterpret an existing `true`.
- Users who already ran `chip telemetry disable` must stay disabled.
- `installationId`/`projectSalt` should be preserved across a default flip so a
  returning user's data is not fragmented.

**Tests required**

- Default state assertion (currently no test pins that a fresh install is
  enabled — that is why the behavior went unnoticed)
- No network is attempted when disabled, per §5's table
- `notify()` cannot enable sending (an explicit regression test for the
  "informational notice" property)
- Endpoint override still works (`EVE_TELEMETRY_ENDPOINT`)
- CI produces ephemeral identity and writes nothing persistent
- Failure isolation cases from §6, which currently have no unit coverage

**Compatibility concerns.** The wire format (`{id, event_time, key, value}`
with those three headers) is the contract the receiving server parses. Changing
the endpoint without changing the format requires a compatible receiver;
changing headers requires server support. Keep the format stable.

## 10. Explicit non-goals

Deliberately out of scope:

- Renaming `.eve` (telemetry does not use it, but System B local traces do)
- CLI rebrand work
- Packaging changes
- Model metadata / compiler independence work
- AppPort, FeltDB, Compute, and Attn integration
- Removing or rewriting the telemetry event vocabulary
- Building a transport abstraction or provider registry
- Changing System B (OTEL tracing), which is already independent
- Changing the identity scheme, which is already Vercel-free

## 11. Verification

Audit-only. All probes were temporary, lived outside the repository, and were
removed.

| Check                         | Result                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| Existing telemetry unit tests | 31/31 pass (`index`, `preference`, `identity`, `flush`, `command`) |
| Payload capture               | Exact request and body captured from a live sink                   |
| Consent gate                  | `isEnabled()` measured across 6 environment configurations         |
| Failure isolation             | 3 injected failure modes, none escaped                             |
| Identity lifecycle            | Regeneration and persistence verified                              |
| Source changes                | None                                                               |
| Test changes                  | None                                                               |
| Lockfile changes              | None                                                               |
| Probes left in repo           | None                                                               |

### Repository state note

During this audit an external commit `05d834cb` ("independence", 129 files)
appeared on `main`, containing the completed compiler/model work and the prior
audit documents. It was not created by this session. That work is preserved
inside it; this audit adds only
`docs/audit-chip-telemetry-independence.md` and one `docs/meta.json` entry.
