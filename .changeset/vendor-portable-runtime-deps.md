---
"eve": patch
---

Fix a packaging defect that made the published CLI unrunnable from an install. Dependencies imported by bare specifier (`zod`, `autoevals`, `@vercel/sdk`) were inlined into the build as relative paths into the workspace's `node_modules/.pnpm` store, so `eve --version` and `eve --help` failed with `ERR_MODULE_NOT_FOUND` as soon as the package was installed outside the repository. They are now vendored through the existing `#compiled/*` mechanism and ship inside the package.
