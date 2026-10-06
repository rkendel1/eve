---
"eve": patch
---

`chip init` no longer writes a `file:` path from the publisher's machine into generated `package.json` files, and it now starts the dev server with the `chip` binary instead of trying to run a nonexistent `eve` binary (which made `npm exec`/`bun x` fetch the unrelated public `eve` package). The generated `AGENTS.md` and coding-agent guidance now point at the installed package's docs (`node_modules/@appport/chip/docs`).
