import { describe, expect, it } from "vitest";

import {
  createRuntimeToolResultFromToolError,
  createRuntimeToolResultFromValue,
} from "#harness/action-result-helpers.js";

describe("createRuntimeToolResultFromValue", () => {
  it("rejects non-JSON-serializable successful action results", () => {
    expect(() =>
      createRuntimeToolResultFromValue({
        callId: "call_timestamp",
        output: { now: new Date("2026-01-02T03:04:05.000Z") },
        toolName: "timestamp",
      }),
    ).toThrow(
      'Tool "timestamp" call "call_timestamp" produced a non-JSON-serializable action result. Expected a JSON-serializable value.',
    );
  });

  it("normalizes top-level undefined action results to null", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_empty",
        output: undefined,
        toolName: "empty",
      }),
    ).toEqual({
      callId: "call_empty",
      kind: "tool-result",
      output: null,
      toolName: "empty",
    });
  });

  it("projects Error instances for failed action results to their message", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_failed",
        isError: true,
        output: new Error("tool failed"),
        toolName: "broken",
      }),
    ).toEqual({
      callId: "call_failed",
      isError: true,
      kind: "tool-result",
      output: "tool failed",
      toolName: "broken",
    });
  });
});

describe("createRuntimeToolResultFromToolError", () => {
  it("projects AI SDK tool-error parts as failed action results", () => {
    expect(
      createRuntimeToolResultFromToolError({
        error: new Error('No skill named "demo"'),
        input: { skill: "demo" },
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-error",
      }),
    ).toEqual({
      callId: "call_load_skill",
      isError: true,
      kind: "tool-result",
      output: 'No skill named "demo"',
      toolName: "load_skill",
    });
  });
});

describe("createRuntimeToolResultFromValue with an MCP result", () => {
  const failure = {
    _meta: { "app/error": { code: "NOT_FOUND" } },
    content: [{ text: "NOT_FOUND: todo todo_999 not found", type: "text" }],
    isError: true,
  };

  it("marks an MCP error result as an error and keeps the result verbatim for the model", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "c",
        output: failure,
        toolName: "todos__complete",
      }),
    ).toEqual({
      callId: "c",
      isError: true,
      kind: "tool-result",
      output: failure,
      toolName: "todos__complete",
    });
  });

  it("leaves a successful MCP result, and a result with isError:false, unmarked", () => {
    const ok = { content: [{ text: "ok", type: "text" }], isError: false };
    const result = createRuntimeToolResultFromValue({
      callId: "c",
      output: ok,
      toolName: "todos__list",
    });
    expect(result).not.toHaveProperty("isError");
    expect(result.output).toEqual(ok);
  });
});
