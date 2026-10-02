---
"eve": patch
---

Make the published Chip artifact self-contained. `chip init` now writes the framework dependency under the name of the package that is actually running (`@appport/chip` for the published artifact), so a generated project no longer installs the unrelated public `eve` package, and the staged runtime's bare `eve` self-imports are retargeted to the published name so they resolve through Node's package self-reference instead of the registry.

Project discovery no longer keys on a single package name. A directory counts as an agent project when it declares the framework under either identity _and_ carries agent structure, so a `@appport/chip` install resolves its own project root (`chip dev` works straight after `chip init`) while an ordinary host that merely installed the framework is still not mistaken for one.
