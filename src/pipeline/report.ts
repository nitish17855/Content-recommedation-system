import { GeminiPipelineClient } from "../ai/client.js";
import {
  BaselineOutputSchema,
  type BaselineOutput,
  type EventCluster,
  type RecommendationCard,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";

export async function generateDirectBaseline(
  ai: GeminiPipelineClient,
  model: string,
  candidateClusters: EventCluster[],
  seeds: SeedDataset,
): Promise<BaselineOutput> {
  // Deliberately supply the EXACT SAME starting signal evidence as the multi-stage pipeline
  const payload = {
    brand_profile: seeds.brandProfile,
    services: seeds.services,
    calendar_context: seeds.calendar,
    current_signals: candidateClusters.map((c) => ({
      event_id: c.event_id,
      title: c.cluster_title,
      country_relevance: c.country_relevance,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
      sources: c.signals.map((s) => ({
        title: s.title,
        url: s.url,
        publisher: s.publisher,
        published_at: s.published_at,
        excerpt: s.excerpt,
      })),
    })),
  };

  return ai.generateStructured({
    stage: "baseline:direct-llm",
    model,
    promptName: "baseline",
    inputPayload: payload,
    schema: BaselineOutputSchema,
    maxOutputTokens: 2400,
    temperature: 0.4,
  });
}

export function buildComparisonNotesTemplate(
  dateStamp: string,
  pipelineCards: RecommendationCard[],
  baseline: BaselineOutput,
) {
  return {
    report_date: dateStamp,
    evaluation_instructions:
      "Review each recommendation and record decision (Accept | Revise | Reject) plus reason (Relevant | Too generic | Forced service connection | Too late | Weak evidence | Not creative enough | Risky | Not actionable). Owner acceptance measures selection only, not post performance.",
    pipeline_reviews: pipelineCards.map((card, i) => ({
      index: i + 1,
      title: card.title,
      decision: null,
      reason: null,
      notes: "",
    })),
    baseline_reviews: baseline.ideas.map((idea, i) => ({
      index: i + 1,
      concept: idea.concept,
      decision: null,
      reason: null,
      notes: "",
    })),
  };
}

