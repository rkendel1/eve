import { describe, expect, it } from "vitest";

import { isMcpErrorResult, mcpErrorText } from "#shared/mcp-tool-result.js";

describe("isMcpErrorResult", () => {
  it("accepts the MCP error shape: isError true beside a content array", () => {
    expect(isMcpErrorResult({ content: [], isError: true })).toBe(true);
    expect(
      isMcpErrorResult({ _meta: {}, content: [{ text: "x", type: "text" }], isError: true }),
    ).toBe(true);
  });

  it.each([
    ["isError false", { content: [], isError: false }],
    ["no isError", { content: [] }],
    ["isError without a content array", { isError: true }],
    ["content that is not an array", { content: "x", isError: true }],
    ["a truthy non-boolean isError", { content: [], isError: "true" }],
    ["an array", [{ content: [], isError: true }]],
    ["null", null],
    ["a string", "isError"],
    ["an Error", new Error("boom")],
  ])("rejects %s", (_name, value) => {
    expect(isMcpErrorResult(value)).toBe(false);
  });
});

describe("mcpErrorText", () => {
  it("joins the text parts and ignores non-text parts", () => {
    expect(
      mcpErrorText({
        content: [
          { text: "first", type: "text" },
          { data: "..", type: "image" },
          { text: "second", type: "text" },
          null,
          3,
        ],
        isError: true,
      }),
    ).toBe("first\nsecond");
  });

  it("returns undefined when there is no text", () => {
    expect(
      mcpErrorText({
        content: [
          { data: "..", type: "image" },
          { text: "", type: "text" },
        ],
        isError: true,
      }),
    ).toBeUndefined();
  });
});
