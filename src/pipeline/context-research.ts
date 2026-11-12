import { GeminiPipelineClient, type AiProvider } from "../ai/client.js";
import { ContextPackSchema, type ContextPack, type EventCluster } from "../ai/schemas.js";

export async function researchClusterContext(
  ai: GeminiPipelineClient,
  model: string,
  cluster: EventCluster,
  provider: AiProvider = "gemini",
): Promise<ContextPack> {
  const payload = {
    event_id: cluster.event_id,
    cluster_title: cluster.cluster_title,
    first_seen_at: cluster.first_seen_at,
    last_seen_at: cluster.last_seen_at,
    independent_source_count: cluster.independent_source_count,
    country_relevance_hint: cluster.country_relevance,
    sources: cluster.signals.slice(0, 5).map((s, idx) => ({
      evidence_id: `evi_${cluster.event_id}_${idx + 1}`,
      title: s.title,
      url: s.url,
      publisher: s.publisher,
      published_at: s.published_at,
      source_type: s.source_type,
      excerpt: s.excerpt,
    })),
  };

  const pack = await ai.generateStructured({
    stage: `context:${cluster.event_id}`,
    provider,
    model,
    promptName: "context",
    inputPayload: payload,
    schema: ContextPackSchema,
    maxOutputTokens: 1600,
    temperature: 0.2,
  });

  // Code/DB owns observed timestamps — never allow LLM to overwrite them
  return {
    ...pack,
    event_id: cluster.event_id,
    first_seen_at: cluster.first_seen_at,
    last_seen_at: cluster.last_seen_at,
  };
}

