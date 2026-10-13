import { type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

/**
 * What the action events say about a tool call's outcome, against the real AI SDK.
 *
 * A finished model turn is not an outcome: a client reading the stream must be able to tell
 * that a call was attempted and rejected (schema-invalid arguments), and that an MCP tool
 * reported an application error, instead of seeing a "completed" action.
 */

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const USAGE = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

const TOOL_SCHEMA = z.strictObject({ title: z.string() });

function toolCallStream(toolName: string, callId: string, input: string): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ input, toolCallId: callId, toolName, type: "tool-call" });
        controller.enqueue({
          finishReason: { raw: undefined, unified: "tool-calls" },
          type: "finish",
          usage: USAGE,
        });
        controller.close();
      },
    }),
  };
}

function textStream(text: string): StreamResult {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "t", type: "text-start" });
        controller.enqueue({ delta: text, id: "t", type: "text-delta" });
        controller.enqueue({ id: "t", type: "text-end" });
        controller.enqueue({
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: USAGE,
        });
        controller.close();
      },
    }),
  };
}

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "outcome-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Creates a todo.",
          inputSchema: {
            additionalProperties: false,
            properties: { title: { type: "string" } },
            required: ["title"],
            type: "object",
          },
          name: "todo_create",
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:outcome-session",
    history: [],
    sessionId: "outcome-session",
  };
}

/** Runs one tool call (then a closing text step) and returns every emitted event. */
async function runOneCall(input: {
  readonly args: string;
  readonly execute?: (args: { title: string }) => unknown;
}): Promise<{
  events: UnstampedMessageStreamEvent[];
  executed: number;
  history: HarnessSession["history"];
}> {
  const events: UnstampedMessageStreamEvent[] = [];
  const emit: HarnessEmitFn = async (event) => {
    events.push(event);
  };
  let executed = 0;
  const doStream = vi
    .fn()
    .mockImplementationOnce(async () => toolCallStream("todo_create", "call-1", input.args))
    .mockImplementation(async () => textStream("done"));
  const model = new MockLanguageModelV3({
    doStream,
    modelId: "outcome-model",
    provider: "eve-integration-mock",
  });
  const tools: ToolLoopHarnessConfig["tools"] = new Map([
    [
      "todo_create",
      {
        description: "Creates a todo.",
        execute: async (args: unknown) => {
          executed += 1;
          return input.execute?.(args as { title: string });
        },
        inputSchema: TOOL_SCHEMA,
        name: "todo_create",
      },
    ],
  ]);
  const runStep = createToolLoopHarness({
    handleEvent: emit,
    mode: "conversation",
    resolveModel: vi.fn().mockResolvedValue(model as LanguageModel),
    tools,
  });
  let step = await runStep(session(), { message: "Create the todo." });
  while (typeof step.next === "function") step = await step.next(step.session);
  return { events, executed, history: step.session.history };
}

function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined)
    throw new Error(`Expected exactly one item, got ${String(items.length)}.`);
  return item;
}

const ofType = <T extends UnstampedMessageStreamEvent["type"]>(
  events: readonly UnstampedMessageStreamEvent[],
  type: T,
) =>
  events.filter((event) => event.type === type) as Extract<
    UnstampedMessageStreamEvent,
    { type: T }
  >[];

describe("schema-invalid tool arguments are observable", () => {
  const SECRET = "sk-live-do-not-leak-0123456789";

  it("emits the action request and a failed action result with a stable code, and never runs the tool", async () => {
    const { events, executed } = await runOneCall({
      args: JSON.stringify({ title: 42, token: SECRET }),
    });

    expect(executed).toBe(0);
    const requested = ofType(events, "actions.requested");
    expect(requested).toHaveLength(1);
    expect(only(only(requested).data.actions)).toMatchObject({
      callId: "call-1",
      kind: "tool-call",
      toolName: "todo_create",
    });
    expect(only(only(requested).data.actions)).toHaveProperty("input", {});
    expect(JSON.stringify(requested)).not.toContain(SECRET);

    const results = ofType(events, "action.result");
    expect(results).toHaveLength(1);
    expect(only(results).data).toMatchObject({
      error: { code: "ACTION_INPUT_INVALID" },
      result: { callId: "call-1", isError: true, toolName: "todo_create" },
      status: "failed",
    });
    expect(events.map((event) => event.type).indexOf("actions.requested")).toBeLessThan(
      events.map((event) => event.type).indexOf("action.result"),
    );
  });

  it("keeps the validation detail (which field) but never echoes the offending values", async () => {
    const { events } = await runOneCall({ args: JSON.stringify({ title: 42, token: SECRET }) });
    const result = only(ofType(events, "action.result"));
    const serialized = JSON.stringify(result);
    expect(result.data.error?.message).toMatch(/title/);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("42}");
  });

  it("is additive: the model still receives its tool error, the turn does not fail, and no step or turn failure is emitted", async () => {
    const { events, history } = await runOneCall({ args: JSON.stringify({ title: 42 }) });
    for (const failure of ["step.failed", "turn.failed", "session.failed"]) {
      expect(events.map((event) => event.type)).not.toContain(failure);
    }
    const toolMessages = history.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
  });

  it("does not change a valid call: one request, one completed result", async () => {
    const { events, executed } = await runOneCall({
      args: JSON.stringify({ title: "Certify" }),
      execute: () => ({ id: "todo_1" }),
    });
    expect(executed).toBe(1);
    expect(ofType(events, "actions.requested")).toHaveLength(1);
    const result = only(ofType(events, "action.result"));
    expect(result.data.status).toBe("completed");
    expect(result.data.error).toBeUndefined();
  });
});

describe("MCP application errors are failed actions", () => {
  const error = {
    _meta: { "app/error": { code: "NOT_FOUND", message: "todo todo_999 not found" } },
    content: [{ text: "NOT_FOUND: todo todo_999 not found", type: "text" }],
    isError: true,
  };

  it("lifts an MCP result with isError:true into status 'failed' with ACTION_RESULT_FAILED, keeping the result for the model", async () => {
    const { events } = await runOneCall({
      args: JSON.stringify({ title: "x" }),
      execute: () => error,
    });
    const result = only(ofType(events, "action.result"));
    expect(result.data.status).toBe("failed");
    expect(result.data.error).toEqual({
      code: "ACTION_RESULT_FAILED",
      message: "NOT_FOUND: todo todo_999 not found",
    });
    expect(result.data.result).toMatchObject({ isError: true, kind: "tool-result", output: error });
  });

  it("leaves a successful MCP result completed", async () => {
    const ok = {
      content: [{ text: '{"id":"todo_1"}', type: "text" }],
      structuredContent: { id: "todo_1" },
    };
    const { events } = await runOneCall({
      args: JSON.stringify({ title: "x" }),
      execute: () => ok,
    });
    const result = only(ofType(events, "action.result"));
    expect(result.data.status).toBe("completed");
    expect(result.data.error).toBeUndefined();
    expect(result.data.result).not.toHaveProperty("isError");
  });

  it("does not treat an ordinary object that merely has isError:false, or a non-MCP isError, as a failure", async () => {
    const falsy = { content: [{ text: "fine", type: "text" }], isError: false };
    const { events } = await runOneCall({
      args: JSON.stringify({ title: "x" }),
      execute: () => falsy,
    });
    expect(only(ofType(events, "action.result")).data.status).toBe("completed");

    const lookalike = { isError: true, note: "not an MCP result: no content array" };
    const second = await runOneCall({
      args: JSON.stringify({ title: "x" }),
      execute: () => lookalike,
    });
    expect(only(ofType(second.events, "action.result")).data.status).toBe("completed");
  });
});
