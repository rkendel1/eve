import { describe, expect, it } from "vitest";

import {
  APICallError,
  UnsupportedFunctionalityError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from "#compiled/@ai-sdk/provider/index.js";

import {
  fx,
  type FxChatCompletion,
  type FxChatFailure,
  type FxChatModel,
  type FxChatRequest,
  type FxStreamEvent,
} from "./index.js";

const completion: FxChatCompletion = {
  content: "Hello from FX",
  tool_calls: [],
  finish_reason: "stop",
  response_id: "resp_1",
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_tokens: 2,
    cache_write_tokens: null,
    reasoning_tokens: 1,
  },
};

function recordingModel(input: {
  readonly chat?: FxChatCompletion | FxChatFailure;
  readonly events?: readonly FxStreamEvent[];
}) {
  const calls: { request: FxChatRequest; signal: AbortSignal | undefined }[] = [];
  let returned = false;
  const model: FxChatModel = {
    id: "openai-compatible",
    model: "fixture",
    async chat(request, options) {
      calls.push({ request, signal: options?.signal });
      const result = input.chat ?? completion;
      return "kind" in result ? { failed: result } : { completed: result };
    },
    stream(request, options) {
      calls.push({ request, signal: options?.signal });
      const events = [...(input.events ?? [])];
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            events.length > 0
              ? { done: false as const, value: events.shift()! }
              : { done: true as const, value: undefined },
          return: async () => {
            returned = true;
            return { done: true as const, value: undefined };
          },
        }),
      };
    },
  };
  return { model, calls, wasReturned: () => returned };
}

function callOptions(
  overrides: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    prompt: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ],
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("fx()", () => {
  it("takes provider identity from the FX model", () => {
    const languageModel = fx(recordingModel({}).model);
    expect(languageModel).toMatchObject({
      specificationVersion: "v4",
      provider: "fx.openai-compatible",
      modelId: "fixture",
    });
  });

  it("translates the prompt, tools, and output limit into an FX request", async () => {
    const { model, calls } = recordingModel({});
    const controller = new AbortController();
    await fx(model).doGenerate(
      callOptions({
        abortSignal: controller.signal,
        maxOutputTokens: 64,
        prompt: [
          { role: "system", content: "Be brief." },
          { role: "user", content: [{ type: "text", text: "Weather in Oslo?" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "check the tool" },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "weather",
                input: { city: "Oslo" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "weather",
                output: { type: "json", value: { celsius: 3 } },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Current weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        toolChoice: { type: "auto" },
      }),
    );

    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.request).toEqual({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather in Oslo?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", name: "weather", arguments_json: '{"city":"Oslo"}' }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"celsius":3}' },
      ],
      tools: [
        {
          name: "weather",
          description: "Current weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
      max_output_tokens: 64,
    });
  });

  it("narrows a named tool choice to that tool with a required call", async () => {
    const { model, calls } = recordingModel({});
    const schema = { type: "object" as const };
    await fx(model).doGenerate(
      callOptions({
        tools: [
          { type: "function", name: "a", inputSchema: schema },
          { type: "function", name: "b", inputSchema: schema },
        ],
        toolChoice: { type: "tool", toolName: "b" },
      }),
    );
    expect(calls[0]!.request.tools?.map((tool) => tool.name)).toEqual(["b"]);
    expect(calls[0]!.request.tool_choice).toBe("required");
  });

  it("rejects file parts instead of dropping them", async () => {
    const { model } = recordingModel({});
    await expect(
      fx(model).doGenerate(
        callOptions({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  mediaType: "image/png",
                  data: { type: "data", data: new Uint8Array([1]) },
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedFunctionalityError);
  });

  it("reports settings FX cannot carry as warnings", async () => {
    const { model } = recordingModel({});
    const result = await fx(model).doGenerate(callOptions({ temperature: 0.2, seed: 1 }));
    expect(result.warnings).toEqual([
      { type: "unsupported", feature: "temperature" },
      { type: "unsupported", feature: "seed" },
    ]);
  });

  it("maps a completion to content, finish reason, usage, and response metadata", async () => {
    const { model } = recordingModel({
      chat: {
        ...completion,
        content: null,
        finish_reason: "tool_calls",
        tool_calls: [{ id: "call_9", name: "weather", arguments_json: '{"city":"Oslo"}' }],
      },
    });
    const result = await fx(model).doGenerate(callOptions());
    expect(result.content).toEqual([
      { type: "tool-call", toolCallId: "call_9", toolName: "weather", input: '{"city":"Oslo"}' },
    ]);
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool_calls" });
    expect(result.usage).toMatchObject({
      inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: undefined },
      outputTokens: { total: 5, text: 4, reasoning: 1 },
    });
    expect(result.response).toEqual({ id: "resp_1", modelId: "fixture" });
  });

  it("does not invent a finish reason FX did not report", async () => {
    const { model } = recordingModel({ chat: { ...completion, finish_reason: null } });
    const result = await fx(model).doGenerate(callOptions());
    expect(result.finishReason).toEqual({ unified: "other", raw: undefined });
  });

  it("throws a provider failure as an APICallError with kind, detail, and retry delay", async () => {
    const failure: FxChatFailure = {
      kind: "rate_limited",
      detail: '{"error":"slow down"}',
      retry_after_seconds: 7,
    };
    const { model } = recordingModel({ chat: failure });
    const error = await Promise.resolve(fx(model).doGenerate(callOptions())).catch(
      (caught: unknown) => caught,
    );
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({
      message: 'FX provider call failed (rate_limited): {"error":"slow down"}',
      isRetryable: true,
      responseBody: '{"error":"slow down"}',
      responseHeaders: { "retry-after": "7" },
      data: failure,
    });
  });

  it("marks client failures as not retryable", async () => {
    const { model } = recordingModel({
      chat: { kind: "invalid_request", detail: null, retry_after_seconds: null },
    });
    await expect(fx(model).doGenerate(callOptions())).rejects.toMatchObject({
      isRetryable: false,
    });
  });

  it("streams FX deltas as text and reasoning parts, then tool calls and finish", async () => {
    const { model } = recordingModel({
      events: [
        { type: "reasoning_delta", text: "thinking" },
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        {
          type: "completion",
          completion: {
            ...completion,
            content: "Hello",
            finish_reason: "tool_calls",
            tool_calls: [{ id: "call_2", name: "weather", arguments_json: "{}" }],
          },
        },
      ],
    });
    const { stream } = await fx(model).doStream(callOptions({ temperature: 1 }));
    const parts = await readAll(stream);
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "text-start",
      "text-delta",
      "text-delta",
      "reasoning-end",
      "text-end",
      "response-metadata",
      "tool-call",
      "finish",
    ]);
    expect(parts[0]).toEqual({
      type: "stream-start",
      warnings: [{ type: "unsupported", feature: "temperature" }],
    });
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([
      "Hel",
      "lo",
    ]);
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    });
  });

  it("streams a provider failure as an error part, not a finish", async () => {
    const { model } = recordingModel({
      events: [
        {
          type: "failure",
          failure: { kind: "server_error", detail: "boom", retry_after_seconds: null },
        },
      ],
    });
    const { stream } = await fx(model).doStream(callOptions());
    const parts = await readAll(stream);
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "error"]);
    const errorPart = parts[1] as Extract<LanguageModelV4StreamPart, { type: "error" }>;
    expect(APICallError.isInstance(errorPart.error)).toBe(true);
    expect(errorPart.error).toMatchObject({ isRetryable: true, responseBody: "boom" });
  });

  it("returns the FX iterator when the AI SDK cancels the stream", async () => {
    const recording = recordingModel({ events: [{ type: "text_delta", text: "a" }] });
    const { stream } = await fx(recording.model).doStream(callOptions());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(recording.wasReturned()).toBe(true);
  });
});
