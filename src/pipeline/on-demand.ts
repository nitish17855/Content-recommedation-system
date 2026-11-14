import { getConfiguredGeminiKeys } from "../config/env.js";
import { GeminiPipelineClient, selectFirstHalfTarget } from "../ai/client.js";
import {
  OnDemandAnswerSchema,
  type EventCluster,
  type OnDemandAnswer,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";

function scoreClusterForQuery(cluster: EventCluster, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = `${cluster.cluster_title} ${cluster.keywords.join(" ")} ${cluster.signals.map((s) => s.title).join(" ")}`.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits;
}

/**
 * Answers an owner's immediate "want something right now" brief using NSP's verified brand profile,
 * India service catalog, calendar context, and the most relevant recent clusters from Neon.
 */
export async function answerOnDemandRequest(params: {
  ai: GeminiPipelineClient;
  model: string;
  provider: "openrouter" | "gemini";
  question: string;
  platformPreference?: string;
  clusters: EventCluster[];
  seeds: SeedDataset;
}): Promise<OnDemandAnswer> {
  const queryTokens = params.question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  const rankedClusters = [...params.clusters]
    .map((cluster) => ({
      cluster,
      hits: scoreClusterForQuery(cluster, queryTokens),
    }))
    .sort((a, b) => b.hits - a.hits || b.cluster.last_seen_at.localeCompare(a.cluster.last_seen_at))
    .slice(0, 10)
    .map((x) => x.cluster);

  const payload = {
    owner_request: params.question.trim(),
    platform_preference: params.platformPreference?.trim() || "Auto (best fit for NSP India)",
    brand_profile: params.seeds.brandProfile,
    services: params.seeds.services.map((s) => ({
      service_id: s.service_id,
      name: s.name,
      category: s.category,
      status_india: s.status_india,
      india_pricing: s.india_pricing,
      verified_claims: s.verified_claims,
    })),
    calendar_context: params.seeds.calendar,
    recent_signals: rankedClusters.map((c) => ({
      event_id: c.event_id,
      title: c.cluster_title,
      country_relevance: c.country_relevance,
      last_seen_at: c.last_seen_at,
      sources: c.signals.slice(0, 2).map((s) => ({
        title: s.title,
        url: s.url,
        publisher: s.publisher,
        published_at: s.published_at,
        excerpt: s.excerpt,
      })),
    })),
  };

  return params.ai.generateStructured({
    stage: "on-demand:owner-request",
    provider: params.provider,
    model: params.model,
    promptName: "on-demand",
    inputPayload: payload,
    schema: OnDemandAnswerSchema,
    maxOutputTokens: 2200,
    temperature: 0.35,
  });
}

export function selectOnDemandTarget(env: Parameters<typeof selectFirstHalfTarget>[0]) {
  // Prefer Gemini fallback/reasoning when available for fast grounded answers, or OpenRouter when Gemini keys absent/exhausted
  if (getConfiguredGeminiKeys(env).length > 0) {
    return { provider: "gemini" as const, model: env.GEMINI_MODEL_LIGHT };
  }
  return selectFirstHalfTarget(env);
}

