---
"eve": patch
---

Stop requiring Vercel AI Gateway model metadata when compiling agents that use a direct or local provider. Compiling an agent with a model eve already knows about no longer makes a catalog request, and an agent whose provider has no catalog entry now compiles instead of failing — the runtime's existing fallback supplies a compaction threshold when the context window is unknown. AI Gateway routing is unchanged: a gateway model whose metadata cannot be resolved still fails at compile time with the same actionable error.
