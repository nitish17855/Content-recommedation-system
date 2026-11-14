import { GeminiPipelineClient } from "../ai/client.js";
import {
  MarketScanOutputSchema,
  type EventCluster,
  type MarketScanOutput,
} from "../ai/schemas.js";
import type { SeedDataset } from "../data/loader.js";
import { areClustersSameStory, getClusterChannel, type DiscoveryChannel } from "./pre-filter.js";

/**
 * Single Gemini intelligence check across collected signals, Google Trends India,
 * and competitor activity to prioritize what truly matters in NSP's Indian business sectors.
 */
export async function scanIndiaMarketTrends(params: {
  ai: GeminiPipelineClient;
  model: string;
  clusters: EventCluster[];
  seeds: SeedDataset;
}): Promise<MarketScanOutput> {
  const payload = {
    target_market: "India",
    nsp_services: params.seeds.services.map((s) => ({
      service_id: s.service_id,
      name: s.name,
      category: s.category,
      status_india: s.status_india,
    })),
    competitors_to_watch: params.seeds.competitors,
    calendar_context: params.seeds.calendar,
    discovered_clusters: params.clusters.map((c) => ({
      event_id: c.event_id,
      title: c.cluster_title,
      country_relevance: c.country_relevance,
      last_seen_at: c.last_seen_at,
      sources: c.signals.slice(0, 2).map((s) => ({
        source_id: s.source_id,
        source_type: s.source_type,
        publisher: s.publisher,
        url: s.url,
        title: s.title,
        excerpt: s.excerpt,
      })),
    })),
  };

  const provider = params.ai.hasGeminiKey() ? "gemini" : "openrouter";
  return params.ai.generateStructured({
    stage: "market-scan:india-trends",
    provider,
    model: provider === "gemini" ? params.model : "openrouter/free",
    promptName: "market-scan",
    inputPayload: payload,
    schema: MarketScanOutputSchema,
    maxOutputTokens: 1600,
    temperature: 0.2,
  });
}

export function reorderClustersByMarketScan(
  clusters: EventCluster[],
  scan: MarketScanOutput,
  maxClusters: number,
): EventCluster[] {
  const byId = new Map(clusters.map((c) => [c.event_id, c]));
  const ordered: EventCluster[] = [];
  const channelCounts = new Map<DiscoveryChannel, number>();
  const maxPerChannel = 2;

  const tryAdd = (candidate: EventCluster, enforceChannelCap: boolean) => {
    if (ordered.length >= maxClusters) return;
    if (ordered.some((existing) => areClustersSameStory(existing, candidate))) return;
    const channel = getClusterChannel(candidate);
    const count = channelCounts.get(channel) ?? 0;
    if (enforceChannelCap && count >= maxPerChannel) return;
    ordered.push(candidate);
    channelCounts.set(channel, count + 1);
  };

  for (const id of scan.prioritized_event_ids) {
    if (ordered.length >= maxClusters) break;
    const match = byId.get(id);
    if (match) tryAdd(match, true);
  }

  for (const c of clusters) {
    if (ordered.length >= maxClusters) break;
    tryAdd(c, true);
  }

  // Pass 2 only if channel caps left unused capacity
  for (const c of clusters) {
    if (ordered.length >= maxClusters) break;
    tryAdd(c, false);
  }

  return ordered;
}

