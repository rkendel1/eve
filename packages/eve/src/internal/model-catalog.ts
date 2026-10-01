import { z } from "#compiled/zod/index.js";

const THINKING_SUFFIX = "-thinking";

export const catalogModelProviderSchema = z
  .object({
    provider: z.string().min(1),
    providerModelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const catalogModelSchema = z
  .object({
    slug: z.string().min(1),
    providers: z.array(catalogModelProviderSchema).min(1),
  })
  .passthrough();

export const modelCatalogResponseSchema = z
  .object({
    models: z.array(catalogModelSchema),
    providerAliases: z.record(z.string(), z.string()),
  })
  .passthrough();

export type CatalogModelProvider = z.infer<typeof catalogModelProviderSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export interface ModelCatalogLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

/**
 * Limits eve can state for a model without asking the AI Gateway.
 *
 * This is the single source of truth for known model limits: the compile-time
 * loader and the runtime catalog both consult it before falling back to a
 * catalog request, so a known model never needs the network to resolve.
 *
 * Keys are gateway-style `provider/model` ids. `-thinking` variants resolve via
 * {@link normalizeCatalogModelId}.
 */
const builtInModelLimitsById = new Map<string, ModelCatalogLimits>([
  [
    "anthropic/claude-opus-4.7",
    {
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    },
  ],
  [
    "openai/gpt-5.4",
    {
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
  ],
  [
    "openai/gpt-5.4-mini",
    {
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
  ],
]);

/**
 * Returns eve's built-in limits for a gateway-style model id, or `null` when the
 * model is not one it can describe without a catalog lookup.
 *
 * The lookup accepts `-thinking` variants; {@link canonicalBuiltInModelId} maps
 * such an id back to the canonical slug a catalog would report, so callers can
 * keep returning a stable `resolvedModelId`.
 */
export function findBuiltInModelLimits(modelId: string): ModelCatalogLimits | null {
  return (
    builtInModelLimitsById.get(modelId) ??
    builtInModelLimitsById.get(normalizeCatalogModelId(modelId)) ??
    null
  );
}

/** Canonical slug of a built-in model id, matching the catalog's `resolvedModelId`. */
export function canonicalBuiltInModelId(modelId: string): string | null {
  return builtInModelLimitsById.has(modelId)
    ? modelId
    : builtInModelLimitsById.has(normalizeCatalogModelId(modelId))
      ? normalizeCatalogModelId(modelId)
      : null;
}

export function normalizeCatalogModelId(modelId: string): string {
  return modelId.endsWith(THINKING_SUFFIX) ? modelId.slice(0, -THINKING_SUFFIX.length) : modelId;
}

export function findCatalogModelBySlug(
  models: readonly CatalogModel[],
  slug: string,
): CatalogModel | undefined {
  // Some models publish `-thinking` as their own canonical slug, so the
  // verbatim id must win before the suffix is stripped.
  const exact = models.find((model) => model.slug === slug);
  if (exact !== undefined) {
    return exact;
  }

  const normalized = normalizeCatalogModelId(slug);
  return normalized === slug ? undefined : models.find((model) => model.slug === normalized);
}

export function findCatalogModelByProviderModelId(input: {
  readonly models: readonly CatalogModel[];
  readonly provider: string;
  readonly providerAliases: Readonly<Record<string, string>>;
  readonly providerModelId: string;
}): { readonly model: CatalogModel; readonly provider: CatalogModelProvider } | null {
  const baseProvider = input.provider.split(".")[0]!;
  const resolvedProvider = input.providerAliases[baseProvider] ?? baseProvider;
  const normalizedModelId = normalizeCatalogModelId(input.providerModelId);

  for (const model of input.models) {
    for (const provider of model.providers) {
      if (
        provider.provider === resolvedProvider &&
        normalizeCatalogModelId(provider.providerModelId) === normalizedModelId
      ) {
        return { model, provider };
      }
    }
  }

  return null;
}

export function modelCatalogLimitsFromProvider(
  provider: CatalogModelProvider,
): ModelCatalogLimits | null {
  if (provider.contextWindowTokens === undefined || provider.contextWindowTokens <= 0) {
    return null;
  }
  return {
    contextWindowTokens: provider.contextWindowTokens,
    ...(provider.maxOutputTokens !== undefined &&
      provider.maxOutputTokens > 0 && { maxOutputTokens: provider.maxOutputTokens }),
  };
}
