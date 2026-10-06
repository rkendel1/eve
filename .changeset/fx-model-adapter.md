---
"eve": patch
---

Add `fx()` from `eve/models/fx`, which runs an agent's model through an FX model created with `createFxModel()`. Text and reasoning stream through the session, tool calls and usage map to the AI SDK, provider failures surface as `APICallError`s with FX's failure kind and retry delay, and cancelling a turn aborts the provider request.
