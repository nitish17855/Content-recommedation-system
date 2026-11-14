import { GeminiPipelineClient } from "../ai/client.js";
import {
  CreativeIdeationSchema,
  type ContextPack,
  type CreativeIdeation,
  type OpportunityMatch,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";

export async function generateCreativeRoutes(
  ai: GeminiPipelineClient,
  model: string,
  contextPack: ContextPack,
  opportunity: OpportunityMatch,
  seeds: SeedDataset,
): Promise<CreativeIdeation> {
  const payload = {
    brand_profile: {
      brand: seeds.brandProfile.brand ?? seeds.brandProfile.brand_name ?? seeds.brandProfile.brandName ?? "Brand",
      industry: seeds.brandProfile.industry ?? "General",
      target_market: seeds.brandProfile.target_market ?? "India",
      tone: seeds.brandProfile.tone ?? "Professional and Strategic",
      creative_boundaries: seeds.brandProfile.creative_boundaries ?? [],
    },
    matched_services: seeds.services.filter((s) =>
      opportunity.matched_services.includes(String(s.service_id)) ||
      opportunity.matched_services.includes(String(s.name)),
    ),
    context_pack: contextPack,
    opportunity,
  };

  const result = await ai.generateStructured({
    stage: `ideation:${contextPack.event_id}`,
    model,
    promptName: "ideation",
    inputPayload: payload,
    schema: CreativeIdeationSchema,
    maxOutputTokens: 2800,
    temperature: 0.5,
  });

  return {
    ...result,
    event_id: contextPack.event_id,
  };
}

