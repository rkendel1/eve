import { describe, expect, it } from "vitest";

import { validateModelSlug } from "./model-source-change.js";

describe("validateModelSlug", () => {
  it("accepts a valid ChatGPT selection without consulting the Gateway catalog", async () => {
    await expect(validateModelSlug("/app", "chatgpt/gpt-5.6-sol")).resolves.toBeNull();
  });

  it("rejects a ChatGPT selection whose model is not a bare OpenAI id", async () => {
    await expect(validateModelSlug("/app", "chatgpt/not/a-bare-slug")).resolves.toBe(
      "Choose a bare OpenAI model id after `chatgpt/`.",
    );
  });

  it("accepts well-formed provider/model ids even when they are not in the Gateway catalog", async () => {
    await expect(validateModelSlug("/app", "local/llama3.2")).resolves.toBeNull();
  });

  it("rejects ids without a provider prefix", async () => {
    await expect(validateModelSlug("/app", "llama3.2")).resolves.toBe(
      "`llama3.2` isn't a provider/model id (e.g. anthropic/claude-sonnet-5).",
    );
  });
});
