import { GeminiPipelineClient, type AiProvider } from "../ai/client.js";
import {
  OpportunityMatchSchema,
  type ContextPack,
  type OpportunityMatch,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";

export async function matchOpportunityToBrand(
  ai: GeminiPipelineClient,
  model: string,
  contextPack: ContextPack,
  seeds: SeedDataset,
  provider: AiProvider = "gemini",
): Promise<OpportunityMatch> {
  const payload = {
    brand_profile: seeds.brandProfile,
    services: seeds.services,
    competitors: seeds.competitors,
    calendar_context: seeds.calendar,
    context_pack: contextPack,
  };

  const result = await ai.generateStructured({
    stage: `matching:${contextPack.event_id}`,
    provider,
    model,
    promptName: "matching",
    inputPayload: payload,
    schema: OpportunityMatchSchema,
    maxOutputTokens: 1200,
    temperature: 0.2,
  });

  return {
    ...result,
    event_id: contextPack.event_id,
  };
}

