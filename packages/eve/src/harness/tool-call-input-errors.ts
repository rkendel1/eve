import type { ToolSet, TypedToolCall, TypedToolError } from "ai";

import {
  createPresentedRuntimeActionRequestFromToolCall,
  type RuntimeActionRequestProjection,
} from "#harness/action-presentation.js";
import { resolveToolCallInputObject } from "#harness/coordination.js";
import type { HarnessToolMap } from "#harness/types.js";

/**
 * Returns true when the AI SDK marked the tool call `invalid` (typically
 * because the model emitted unparsable JSON or targeted an unknown tool).
 *
 * Invalid calls have a raw-string or partial `input` payload that cannot
 * satisfy the runtime-action contract. The AI SDK synthesizes a tool-error
 * result for the next model step automatically; callers must skip invalid
 * calls when projecting to `RuntimeActionRequest` values or the harness
 * will throw on the JSON-object invariant.
 */
export function isInvalidToolCall(toolCall: TypedToolCall<ToolSet>): boolean {
  return toolCall.invalid === true;
}

export function createInvalidToolCallInputError(input: {
  readonly error: unknown;
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> {
  const { toolCall } = input;

  const toolError: {
    dynamic?: true;
    error: unknown;
    input: unknown;
    providerExecuted?: true;
    providerMetadata?: TypedToolCall<ToolSet>["providerMetadata"];
    toolCallId: string;
    toolMetadata?: TypedToolCall<ToolSet>["toolMetadata"];
    toolName: string;
    type: "tool-error";
  } = {
    type: "tool-error",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
    error: input.error,
  };

  if (toolCall.dynamic === true) {
    toolError.dynamic = true;
  }
  if (toolCall.providerExecuted === true) {
    toolError.providerExecuted = true;
  }
  if (toolCall.providerMetadata !== undefined) {
    toolError.providerMetadata = toolCall.providerMetadata;
  }
  if (toolCall.toolMetadata !== undefined) {
    toolError.toolMetadata = toolCall.toolMetadata;
  }

  return toolError as TypedToolError<ToolSet>;
}

/**
 * Resolves a provider-executed tool call into an observable runtime-action
 * request, or the synthesized tool error when the model emitted arguments
 * that cannot satisfy the JSON-object contract.
 *
 * Provider-executed calls skip the AI SDK's input validation, so malformed
 * JSON argument text reaches the harness only here.
 */
export function resolveProviderToolCallRequest(
  toolCall: {
    readonly input?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  },
  tools: HarnessToolMap,
):
  | { readonly request: RuntimeActionRequestProjection; readonly toolError?: undefined }
  | { readonly request?: undefined; readonly toolError: TypedToolError<ToolSet> } {
  try {
    return {
      request: createPresentedRuntimeActionRequestFromToolCall({
        toolCall: {
          ...toolCall,
          providerExecuted: true,
          type: "tool-call",
        } as TypedToolCall<ToolSet>,
        tools,
      }),
    };
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return {
      toolError: createInvalidToolCallInputError({
        error,
        toolCall: {
          input: toolCall.input,
          providerExecuted: true,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          type: "tool-call",
        } as TypedToolCall<ToolSet>,
      }),
    };
  }
}

export function getInvalidToolCallInputError(input: {
  readonly toolCall: TypedToolCall<ToolSet>;
}): TypedToolError<ToolSet> | undefined {
  const { toolCall } = input;

  if (isInvalidToolCall(toolCall)) {
    return undefined;
  }

  try {
    resolveToolCallInputObject(toolCall.input, {
      callId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    return undefined;
  } catch (error) {
    if (error instanceof TypeError) {
      return createInvalidToolCallInputError({ error, toolCall });
    }
    throw error;
  }
}

/** Stable `action.result` error code for a tool call whose arguments failed schema validation. */
export const ACTION_INPUT_INVALID = "ACTION_INPUT_INVALID";

const MAX_REJECTION_ISSUES = 5;
const MAX_REJECTION_ISSUE_LENGTH = 200;

/**
 * Describes a call the AI SDK rejected because its arguments did not satisfy the tool's input schema,
 * or returns `undefined` for any other kind of invalid call (unknown tool, unparsable provider output).
 *
 * The message names each offending field and the validator's complaint, never the offending values: the
 * SDK's own error message embeds the full rejected input, which can carry secrets the model copied into
 * a mistaken call. The model still receives the SDK's complete error; this is the stream-facing view.
 */
export function describeRejectedToolInput(
  toolCall: TypedToolCall<ToolSet>,
): { readonly code: typeof ACTION_INPUT_INVALID; readonly message: string } | undefined {
  if (!isInvalidToolCall(toolCall)) return undefined;
  const error = (toolCall as { readonly error?: unknown }).error;
  if (!isInvalidToolInputError(error)) return undefined;

  const issues = collectValidationIssues(error).slice(0, MAX_REJECTION_ISSUES);
  const detail =
    issues.length === 0 ? "the arguments do not match the tool's input schema" : issues.join("; ");
  return {
    code: ACTION_INPUT_INVALID,
    message: `Invalid arguments for tool "${toolCall.toolName}": ${detail}`,
  };
}

/** The AI SDK tags its schema-validation rejection with a stable name, so no class identity is needed. */
function isInvalidToolInputError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { readonly name?: unknown }).name === "AI_InvalidToolInputError"
  );
}

function collectValidationIssues(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || typeof error !== "object") return [];
  const { cause, issues } = error as { cause?: unknown; issues?: unknown };
  if (Array.isArray(issues)) return issues.map(formatValidationIssue);
  return collectValidationIssues(cause, depth + 1);
}

function formatValidationIssue(issue: unknown): string {
  const { message, path } = (issue ?? {}) as { message?: unknown; path?: unknown };
  const where = Array.isArray(path) && path.length > 0 ? path.map(String).join(".") : "(input)";
  const what = typeof message === "string" && message.length > 0 ? message : "is invalid";
  return `${where}: ${what}`.slice(0, MAX_REJECTION_ISSUE_LENGTH);
}
