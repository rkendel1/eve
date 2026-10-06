import {
  APICallError,
  UnsupportedFunctionalityError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Content,
  type LanguageModelV4FinishReason,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage,
  type SharedV4Warning,
} from "#compiled/@ai-sdk/provider/index.js";

// Structural mirror of the public FX model API (`createFxModel()` from the FX
// Node SDK). eve never imports FX: the caller constructs the model, so the FX
// package and its native addon stay the application's dependency.

/** A message in an FX chat request. */
export interface FxChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly FxToolCall[];
}

/** A tool call requested by the model or replayed in history. */
export interface FxToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments_json: string;
}

/** A request accepted by `chat()` and `stream()`. */
export interface FxChatRequest {
  readonly messages: readonly FxChatMessage[];
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly input_schema: object;
  }[];
  readonly tool_choice?: "auto" | "none" | "required";
  readonly max_output_tokens?: number;
}

/** The `completed` result of a provider call. Unreported fields are `null`. */
export interface FxChatCompletion {
  readonly content: string | null;
  readonly tool_calls: readonly FxToolCall[];
  readonly finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  readonly response_id: string | null;
  readonly usage: {
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly cache_write_tokens: number | null;
    readonly reasoning_tokens: number | null;
  };
}

/** The `failed` result of a provider call: the provider answered with an HTTP error. */
export interface FxChatFailure {
  readonly kind: string;
  readonly detail: string | null;
  readonly retry_after_seconds: number | null;
}

/** An event produced by `stream()`. */
export type FxStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "completion"; readonly completion: FxChatCompletion }
  | { readonly type: "failure"; readonly failure: FxChatFailure };

/** The model object returned by FX's `createFxModel()`. */
export interface FxChatModel {
  readonly id: string;
  readonly model: string;
  chat(
    request: FxChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly completed: FxChatCompletion } | { readonly failed: FxChatFailure }>;
  stream(
    request: FxChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<FxStreamEvent>;
}

// FX failure kinds that name a transient provider condition.
const RETRYABLE_FAILURE_KINDS = new Set([
  "rate_limited",
  "server_error",
  "bad_gateway",
  "unavailable",
  "gateway_timeout",
]);

/**
 * Serves an agent's model through FX's provider layer instead of AI Gateway.
 *
 * Pass the model returned by `createFxModel()` from the FX Node SDK. FX owns
 * the endpoint, credentials, and transport; eve translates its own model calls
 * into FX chat requests and streams FX events back into the session.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { fx } from "eve/models/fx";
 * import { createFxModel } from "libfx";
 *
 * export default defineAgent({
 *   model: fx(await createFxModel({ baseUrl: "http://localhost:11434/v1", model: "qwen3-coder" })),
 *   modelContextWindowTokens: 32_000,
 *   build: { externalDependencies: ["libfx"] },
 * });
 * ```
 *
 * FX models are not in the AI Gateway catalog, so set
 * `modelContextWindowTokens`. FX loads a native addon relative to its own
 * package, so keep it in `build.externalDependencies`. Prompts are text-only: file parts are rejected,
 * and reasoning from earlier turns is not replayed to the provider.
 */
export function fx(model: FxChatModel): LanguageModelV4 {
  const provider = `fx.${model.id}`;
  const failureUrl = `fx:${model.id}/${model.model}`;

  return {
    specificationVersion: "v4",
    provider,
    modelId: model.model,
    supportedUrls: {},

    async doGenerate(options) {
      const { request, warnings } = toFxRequest(options);
      const result = await model.chat(request, { signal: options.abortSignal });
      if ("failed" in result) throw toApiCallError(result.failed, failureUrl, request);
      const completion = result.completed;

      const content: LanguageModelV4Content[] = [];
      if (completion.content !== null && completion.content.length > 0) {
        content.push({ type: "text", text: completion.content });
      }
      content.push(...toToolCallContent(completion.tool_calls));

      return {
        content,
        finishReason: toFinishReason(completion.finish_reason),
        usage: toUsage(completion.usage),
        request: { body: request },
        response: toResponseMetadata(completion, model.model),
        warnings,
      };
    },

    async doStream(options) {
      const { request, warnings } = toFxRequest(options);
      const events = model.stream(request, { signal: options.abortSignal })[Symbol.asyncIterator]();
      let textOpen = false;
      let reasoningOpen = false;

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
        },
        async pull(controller) {
          const next = await events.next();
          if (next.done) {
            controller.close();
            return;
          }
          const event = next.value;
          switch (event.type) {
            case "text_delta":
              if (!textOpen) controller.enqueue({ type: "text-start", id: "text" });
              textOpen = true;
              controller.enqueue({ type: "text-delta", id: "text", delta: event.text });
              return;
            case "reasoning_delta":
              if (!reasoningOpen) controller.enqueue({ type: "reasoning-start", id: "reasoning" });
              reasoningOpen = true;
              controller.enqueue({ type: "reasoning-delta", id: "reasoning", delta: event.text });
              return;
            case "completion": {
              const completion = event.completion;
              if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: "reasoning" });
              if (textOpen) controller.enqueue({ type: "text-end", id: "text" });
              controller.enqueue({
                type: "response-metadata",
                ...toResponseMetadata(completion, model.model),
              });
              // The OpenAI-compatible stream reducer delivers tool calls whole.
              for (const call of toToolCallContent(completion.tool_calls)) controller.enqueue(call);
              controller.enqueue({
                type: "finish",
                finishReason: toFinishReason(completion.finish_reason),
                usage: toUsage(completion.usage),
              });
              controller.close();
              return;
            }
            case "failure":
              controller.enqueue({
                type: "error",
                error: toApiCallError(event.failure, failureUrl, request),
              });
              controller.close();
              return;
          }
        },
        async cancel() {
          // Leaving the FX iterator early cancels the provider request.
          await events.return?.();
        },
      });

      return { stream, request: { body: request } };
    },
  };
}

function toFxRequest(options: LanguageModelV4CallOptions): {
  readonly request: FxChatRequest;
  readonly warnings: SharedV4Warning[];
} {
  const warnings: SharedV4Warning[] = [];
  const unsupportedSettings = {
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty,
    stopSequences: options.stopSequences,
    seed: options.seed,
  };
  for (const [feature, value] of Object.entries(unsupportedSettings)) {
    if (value !== undefined) warnings.push({ type: "unsupported", feature });
  }
  if (options.responseFormat?.type === "json") {
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details: "JSON response format",
    });
  }
  if (options.reasoning !== undefined && options.reasoning !== "provider-default") {
    warnings.push({ type: "unsupported", feature: "reasoning" });
  }

  let tools = (options.tools ?? []).flatMap((tool) => {
    if (tool.type === "function") {
      return [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }];
    }
    warnings.push({ type: "unsupported", feature: `provider-defined tool ${tool.id}` });
    return [];
  });

  let toolChoice: FxChatRequest["tool_choice"];
  const choice = options.toolChoice;
  if (choice?.type === "tool") {
    // FX has no named tool choice; offering only that tool and requiring a call is equivalent.
    tools = tools.filter((tool) => tool.name === choice.toolName);
    toolChoice = "required";
  } else {
    toolChoice = choice?.type;
  }

  return {
    request: {
      messages: toFxMessages(options.prompt),
      ...(tools.length > 0 && { tools }),
      ...(toolChoice !== undefined && { tool_choice: toolChoice }),
      ...(options.maxOutputTokens !== undefined && { max_output_tokens: options.maxOutputTokens }),
    },
    warnings,
  };
}

function toFxMessages(prompt: LanguageModelV4Prompt): FxChatMessage[] {
  const messages: FxChatMessage[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        messages.push({ role: "system", content: message.content });
        break;
      case "user": {
        const text: string[] = [];
        for (const part of message.content) {
          if (part.type !== "text") throw unsupported("file parts in user messages");
          text.push(part.text);
        }
        messages.push({ role: "user", content: text.join("\n") });
        break;
      }
      case "assistant": {
        const text: string[] = [];
        const toolCalls: FxToolCall[] = [];
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              text.push(part.text);
              break;
            case "tool-call":
              toolCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                arguments_json: JSON.stringify(part.input ?? {}),
              });
              break;
            case "reasoning":
            case "reasoning-file":
              // An FX request has no field for prior reasoning.
              break;
            default:
              throw unsupported(`${part.type} parts in assistant messages`);
          }
        }
        messages.push({
          role: "assistant",
          content: text.length > 0 ? text.join("") : null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        });
        break;
      }
      case "tool":
        for (const part of message.content) {
          // Approval responses are resolved by the AI SDK before the provider call.
          if (part.type !== "tool-result") continue;
          messages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolOutputText(part.output),
          });
        }
        break;
    }
  }
  return messages;
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "content":
      return output.value
        .map((item) => {
          if (item.type !== "text") throw unsupported("file content in tool results");
          return item.text;
        })
        .join("\n");
  }
}

function toToolCallContent(calls: readonly FxToolCall[]) {
  return calls.map((call) => ({
    type: "tool-call" as const,
    toolCallId: call.id,
    toolName: call.name,
    input: call.arguments_json,
  }));
}

function toFinishReason(reason: FxChatCompletion["finish_reason"]): LanguageModelV4FinishReason {
  switch (reason) {
    case "stop":
      return { unified: "stop", raw: reason };
    case "tool_calls":
      return { unified: "tool-calls", raw: reason };
    case "length":
      return { unified: "length", raw: reason };
    case "content_filter":
      return { unified: "content-filter", raw: reason };
    case null:
      return { unified: "other", raw: undefined };
  }
}

function toUsage(usage: FxChatCompletion["usage"]): LanguageModelV4Usage {
  const input = usage.input_tokens ?? undefined;
  const output = usage.output_tokens ?? undefined;
  const cacheRead = usage.cache_read_tokens ?? undefined;
  const reasoning = usage.reasoning_tokens ?? undefined;
  return {
    inputTokens: {
      total: input,
      noCache: input !== undefined && cacheRead !== undefined ? input - cacheRead : undefined,
      cacheRead,
      cacheWrite: usage.cache_write_tokens ?? undefined,
    },
    outputTokens: {
      total: output,
      text: output !== undefined && reasoning !== undefined ? output - reasoning : undefined,
      reasoning,
    },
    raw: { ...usage },
  };
}

function toResponseMetadata(completion: FxChatCompletion, modelId: string) {
  return {
    ...(completion.response_id !== null && { id: completion.response_id }),
    modelId,
  };
}

function toApiCallError(failure: FxChatFailure, url: string, request: FxChatRequest): APICallError {
  return new APICallError({
    message: `FX provider call failed (${failure.kind})${failure.detail === null ? "" : `: ${failure.detail}`}`,
    url,
    requestBodyValues: request,
    responseBody: failure.detail ?? undefined,
    // The AI SDK retry policy reads the delay from this header.
    responseHeaders:
      failure.retry_after_seconds === null
        ? undefined
        : { "retry-after": String(failure.retry_after_seconds) },
    isRetryable: RETRYABLE_FAILURE_KINDS.has(failure.kind),
    data: failure,
  });
}

function unsupported(functionality: string): UnsupportedFunctionalityError {
  return new UnsupportedFunctionalityError({
    functionality: `${functionality} (FX chat requests carry text only)`,
  });
}
