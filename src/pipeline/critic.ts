import { GeminiPipelineClient } from "../ai/client.js";
import {
  CriticBatchOutputSchema,
  type ContextPack,
  type CreativeIdeation,
  type CriticBatchOutput,
  type OpportunityMatch,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";

export async function critiqueCreativeRoutes(
  ai: GeminiPipelineClient,
  model: string,
  contextPack: ContextPack,
  opportunity: OpportunityMatch,
  ideation: CreativeIdeation,
  seeds: SeedDataset,
): Promise<CriticBatchOutput> {
  const payload = {
    brand_profile: seeds.brandProfile,
    services: seeds.services.map((s) => ({
      service_id: s.service_id,
      name: s.name,
      status_india: s.status_india,
      verified_claims: s.verified_claims,
    })),
    competitors: seeds.competitors,
    context_pack: contextPack,
    opportunity,
    creative_routes: ideation.creative_routes.map((route, idx) => ({
      route_index: idx,
      ...route,
    })),
  };

  const result = await ai.generateStructured({
    stage: `critic:${contextPack.event_id}`,
    model,
    promptName: "critic",
    inputPayload: payload,
    schema: CriticBatchOutputSchema,
    maxOutputTokens: 1800,
    temperature: 0.1,
  });

  return {
    ...result,
    event_id: contextPack.event_id,
  };
}

