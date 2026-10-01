import type { LanguageModel } from "ai";

import { AI_GATEWAY_MODELS_CATALOG_URL, vercelGatewayFetch } from "#internal/gateway.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import {
  canonicalBuiltInModelId,
  findBuiltInModelLimits,
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
} from "#internal/model-catalog.js";

export interface RuntimeModelMetadata {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly resolvedModelId: string;
}

export interface RuntimeModelCatalog {
  getByGatewayId(modelId: string): Promise<RuntimeModelMetadata | null>;
  getByProviderModelId(
    provider: string,
    providerModelId: string,
  ): Promise<RuntimeModelMetadata | null>;
}

export function createRuntimeModelCatalog(
  fetchCatalog: typeof globalThis.fetch = vercelGatewayFetch,
): RuntimeModelCatalog {
  let catalogPromise: Promise<ReturnType<typeof parseCatalogResponse>> | null = null;

  const loadCatalog = async () => {
    if (catalogPromise === null) {
      catalogPromise = fetchCatalog(AI_GATEWAY_MODELS_CATALOG_URL)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(
              `AI Gateway model catalog request failed with HTTP ${response.status} ${response.statusText}.`,
            );
          }
          return parseCatalogResponse(await response.json());
        })
        .catch((error: unknown) => {
          catalogPromise = null;
          throw error;
        });
    }
    return await catalogPromise;
  };

  return {
    async getByGatewayId(modelId) {
      // Known models resolve without a catalog request, so selecting one never
      // depends on AI Gateway being reachable. The canonical id is returned so
      // a `-thinking` query reports the same id a catalog lookup would.
      const builtIn = resolveBuiltInMetadata(modelId);
      if (builtIn !== null) {
        return builtIn;
      }

      const catalog = await loadCatalog();
      const model = findCatalogModelBySlug(catalog.models, modelId);
      if (model === undefined) return null;

      for (const provider of model.providers) {
        const limits = modelCatalogLimitsFromProvider(provider);
        if (limits !== null) {
          return { ...limits, resolvedModelId: model.slug };
        }
      }
      return null;
    },

    async getByProviderModelId(provider, providerModelId) {
      // A direct provider instance has no gateway id of its own, so consult the
      // built-in table with the `provider/model` form its id would take. A
      // provider may carry a dotted sub-path (`openai.responses`), so it is
      // normalized exactly as the reference id is. Only an unknown model falls
      // through to the catalog.
      const providerModelKey = formatLanguageModelGatewayId({
        provider,
        modelId: providerModelId,
      } as LanguageModel);
      const builtIn = resolveBuiltInMetadata(providerModelKey);
      if (builtIn !== null) {
        return builtIn;
      }

      const catalog = await loadCatalog();
      const match = findCatalogModelByProviderModelId({
        models: catalog.models,
        provider,
        providerAliases: catalog.providerAliases,
        providerModelId,
      });
      if (match === null) return null;
      const limits = modelCatalogLimitsFromProvider(match.provider);
      return limits === null ? null : { ...limits, resolvedModelId: match.model.slug };
    },
  };
}

/** Built-in metadata for a known model id, or `null` when eve cannot describe it. */
function resolveBuiltInMetadata(modelId: string): RuntimeModelMetadata | null {
  const limits = findBuiltInModelLimits(modelId);
  const canonicalId = canonicalBuiltInModelId(modelId);
  if (limits === null || canonicalId === null) {
    return null;
  }
  const metadata: {
    contextWindowTokens: number;
    maxOutputTokens?: number;
    resolvedModelId: string;
  } = {
    contextWindowTokens: limits.contextWindowTokens,
    resolvedModelId: canonicalId,
  };
  if (limits.maxOutputTokens !== undefined) {
    metadata.maxOutputTokens = limits.maxOutputTokens;
  }
  return metadata;
}

function parseCatalogResponse(value: unknown) {
  const parsed = modelCatalogResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("AI Gateway model catalog response did not match the expected schema.");
  }
  return parsed.data;
}
