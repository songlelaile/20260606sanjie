import "server-only";
import { GATEWAY_MODELS, type GatewayModel } from "@/lib/model-gateway/catalog";
import { getRelayRuntime } from "@/lib/model-gateway/relay-config";

/** Explicit relay settings replace only the relay catalog. Vendor routes remain intact. */
export async function listAvailableGatewayModels(): Promise<GatewayModel[]> {
  const relay = await getRelayRuntime();
  const defaults = GATEWAY_MODELS.find((model) => model.provider === "shaozhuang")!;
  const relayModels: GatewayModel[] = relay.models.flatMap((model) => {
    if (!model.enabled || model.kind === "unknown") return [];
    return [{
      id: model.id,
      label: model.label,
      upstreamModel: model.upstreamModel,
      provider: "shaozhuang" as const,
      kind: model.kind,
      endpoint: model.kind === "chat" ? "chat.completions" as const
        : model.kind === "image" ? "images.generations" as const : "videos" as const,
      baseUrlEnv: defaults.baseUrlEnv,
      apiKeyEnv: defaults.apiKeyEnv,
      defaultBaseUrl: relay.baseUrl,
      promptCentsPer1K: model.promptCentsPer1K,
      completionCentsPer1K: model.completionCentsPer1K,
      imageCents: model.imageCents,
      videoCents: model.videoCents
    }];
  });
  return [...relayModels, ...GATEWAY_MODELS.filter((model) => model.provider !== "shaozhuang")];
}

export async function findAvailableGatewayModel(name: string, endpoint: GatewayModel["endpoint"]) {
  const models = await listAvailableGatewayModels();
  // Exact public IDs win over upstream aliases, preventing a direct model being shadowed.
  return models.find((model) => model.endpoint === endpoint && model.id === name)
    ?? models.find((model) => model.endpoint === endpoint && model.upstreamModel === name);
}
