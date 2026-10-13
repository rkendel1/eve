/**
 * An MCP `tools/call` result that reports a tool-level failure: `isError: true` beside a `content`
 * array. This is the MCP wire shape, distinct from a protocol error (which rejects the call).
 */
export interface McpErrorResult {
  readonly content: readonly unknown[];
  readonly isError: true;
}

export function isMcpErrorResult(value: unknown): value is McpErrorResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { content?: unknown; isError?: unknown };
  return record.isError === true && Array.isArray(record.content);
}

/** The text parts of an MCP error result joined by newlines, or `undefined` when it has none. */
export function mcpErrorText(result: McpErrorResult): string | undefined {
  const parts = result.content.flatMap((part) => {
    if (part === null || typeof part !== "object") return [];
    const { text, type } = part as { text?: unknown; type?: unknown };
    return type === "text" && typeof text === "string" && text.length > 0 ? [text] : [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}
