import { describe, expect, it, vi } from "vitest";

import { createRuntimeModelCatalog } from "#runtime/agent/model-catalog.js";

const CATALOG = {
  models: [
    {
      providers: [
        {
          contextWindowTokens: 200_000,
          maxOutputTokens: 32_000,
          provider: "anthropic",
          providerModelId: "claude-opus-4-7",
        },
      ],
      slug: "anthropic/claude-opus-4.7",
    },
    {
      providers: [
        {
          contextWindowTokens: 1_000,
          maxOutputTokens: 1_000,
          provider: "bfl",
          providerModelId: "flux-pro",
        },
      ],
      slug: "bfl/flux-pro",
    },
  ],
  providerAliases: { blackForestLabs: "bfl" },
};

describe("createRuntimeModelCatalog", () => {
  it("resolves gateway ids and provider aliases from one execution-local response", async () => {
    const fetchCatalog = vi.fn(async () => Response.json(CATALOG));
    const catalog = createRuntimeModelCatalog(fetchCatalog);

    await expect(catalog.getByGatewayId("anthropic/claude-opus-4.7-thinking")).resolves.toEqual({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      resolvedModelId: "anthropic/claude-opus-4.7",
    });
    await expect(
      catalog.getByProviderModelId("blackForestLabs.images", "flux-pro"),
    ).resolves.toEqual({
      contextWindowTokens: 1_000,
      maxOutputTokens: 1_000,
      resolvedModelId: "bfl/flux-pro",
    });
    expect(fetchCatalog).toHaveBeenCalledOnce();
  });

  it("does not retain a failed catalog request", async () => {
    const fetchCatalog = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce(Response.json(CATALOG));
    const catalog = createRuntimeModelCatalog(fetchCatalog);

    // `bfl/flux-pro` is not a built-in model, so this exercises the catalog path.
    await expect(catalog.getByGatewayId("bfl/flux-pro")).rejects.toThrow("transport unavailable");
    await expect(catalog.getByGatewayId("bfl/flux-pro")).resolves.toMatchObject({
      resolvedModelId: "bfl/flux-pro",
    });
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps authentication and HTTP failures distinct from missing models", async () => {
    const catalog = createRuntimeModelCatalog(
      vi.fn(async () => new Response(null, { status: 401, statusText: "Unauthorized" })),
    );

    await expect(catalog.getByGatewayId("bfl/flux-pro")).rejects.toThrow("HTTP 401 Unauthorized");
  });

  it("resolves a built-in model without contacting the AI Gateway catalog", async () => {
    const fetchCatalog = vi.fn<typeof fetch>(async () => {
      throw new Error("the AI Gateway catalog must not be requested for a built-in model");
    });
    const catalog = createRuntimeModelCatalog(fetchCatalog);

    await expect(catalog.getByGatewayId("openai/gpt-5.4")).resolves.toEqual({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      resolvedModelId: "openai/gpt-5.4",
    });
    // A direct provider instance has no gateway id, so the built-in table is
    // consulted with the `provider/model` form its id would take.
    await expect(catalog.getByProviderModelId("openai.responses", "gpt-5.4")).resolves.toEqual({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      resolvedModelId: "openai/gpt-5.4",
    });
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("reports the canonical slug for a built-in -thinking variant", async () => {
    const fetchCatalog = vi.fn<typeof fetch>(async () => {
      throw new Error("the AI Gateway catalog must not be requested for a built-in model");
    });
    const catalog = createRuntimeModelCatalog(fetchCatalog);

    await expect(
      catalog.getByGatewayId("anthropic/claude-opus-4.7-thinking"),
    ).resolves.toMatchObject({
      resolvedModelId: "anthropic/claude-opus-4.7",
    });
    expect(fetchCatalog).not.toHaveBeenCalled();
  });
});
