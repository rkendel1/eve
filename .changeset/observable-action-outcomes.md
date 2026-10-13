---
"eve": patch
---

Tool outcomes and cancellation are now observable on the stream. Schema-invalid tool arguments emit `actions.requested` and a failed `action.result` (`ACTION_INPUT_INVALID`, naming the fields but never the values) instead of nothing. An MCP tool result with `isError: true` is reported as a failed action (`ACTION_RESULT_FAILED`) rather than `completed`, with the result kept for the model. Cancelling a turn no longer waits for an unresponsive MCP server to connect or answer. The cancel route returns `no_active_turn` for a session that is parked between turns, where it previously returned `accepted`.
