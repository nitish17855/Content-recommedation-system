import type { EventCluster } from "../ai/schemas.js";

const RELEVANT_KEYWORDS = [
  "seo", "geo", "aeo", "search", "google", "ads", "advertising", "marketing",
  "brand", "branding", "ai", "chatgpt", "gemini", "perplexity", "ecommerce",
  "e-commerce", "shopify", "d2c", "saas", "content", "social media", "instagram",
  "linkedin", "youtube", "whatsapp", "conversion", "retail", "diwali", "festive",
  "campaign", "digital", "consumer", "agency", "meta", "ppc", "crawl", "indexing",
  "creator", "creators", "rebrand", "traffic", "ranking", "overviews", "algorithm",
];

const HOUSEKEEPING_NOISE = [
  "blog is moving",
  "api now supports",
  "developer blog",
  "multi-party approval",
  "release notes",
];

function scoreClusterForPreFilter(cluster: EventCluster, nowMs: number): number {
  let score = 0;

  // Official Google Search / Ads updates directly affect NSP core services
  if (cluster.signals.some((s) => s.source_type === "official_platform")) {
    score += 28;
  }

  // Indian marketing/digital & search industry feeds carry strong topical relevance
  if (
    cluster.signals.some((s) =>
      ["et-brandequity-marketing", "et-brandequity-digital", "seroundtable"].includes(s.source_id),
    )
  ) {
    score += 22;
  }

  // Corroboration bonus
  score += Math.min(cluster.independent_source_count, 4) * 15;
  score += Math.min(cluster.signals.length - 1, 3) * 5;

  // Domain keyword relevance
  const combined = `${cluster.cluster_title} ${cluster.keywords.join(" ")} ${cluster.signals[0]?.excerpt ?? ""}`.toLowerCase();
  let keywordHits = 0;
  for (const kw of RELEVANT_KEYWORDS) {
    if (combined.includes(kw)) keywordHits++;
  }
  score += Math.min(keywordHits, 6) * 8;

  // Penalize zero-domain-overlap general news & low-level developer housekeeping
  if (keywordHits === 0) {
    score -= 25;
  }
  if (HOUSEKEEPING_NOISE.some((phrase) => combined.includes(phrase))) {
    score -= 28;
  }

  // Recency boost
  const ageHours = (nowMs - Date.parse(cluster.last_seen_at)) / (1000 * 60 * 60);
  if (!Number.isNaN(ageHours)) {
    if (ageHours <= 48) score += 12;
    else if (ageHours <= 120) score += 6;
  }

  return score;
}

export function selectCandidateClusters(
  clusters: EventCluster[],
  maxClusters: number,
  now: Date = new Date(),
): EventCluster[] {
  const nowMs = now.getTime();
  const ranked = [...clusters]
    .map((cluster) => ({ cluster, score: scoreClusterForPreFilter(cluster, nowMs) }))
    .filter((entry) => entry.score > 12)
    .sort((a, b) => b.score - a.score);

  // Enforce gentle per-source cap (max 3 per feed initially) so one feed does not crowd out others
  const selected: EventCluster[] = [];
  const sourceCounts = new Map<string, number>();

  for (const entry of ranked) {
    if (selected.length >= maxClusters) break;
    const primarySource = entry.cluster.signals[0]?.source_id ?? "unknown";
    const count = sourceCounts.get(primarySource) ?? 0;
    if (count >= 3) continue;
    selected.push(entry.cluster);
    sourceCounts.set(primarySource, count + 1);
  }

  // Fill remaining slots if diversity cap left space
  if (selected.length < maxClusters) {
    const selectedIds = new Set(selected.map((c) => c.event_id));
    for (const entry of ranked) {
      if (selected.length >= maxClusters) break;
      if (!selectedIds.has(entry.cluster.event_id)) {
        selected.push(entry.cluster);
      }
    }
  }

  return selected;
}
