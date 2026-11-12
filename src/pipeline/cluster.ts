import type { CanonicalSignal, EventCluster } from "../ai/schemas.js";
import { extractSignificantTokens } from "./normalize.js";

const CLUSTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function tokenOverlapCount(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const t of a) {
    if (b.has(t)) hits++;
  }
  return hits;
}

function shouldCluster(
  sigTokens: Set<string>,
  sigTs: number,
  clusterTokens: Set<string>,
  clusterMinTs: number,
  clusterMaxTs: number,
): boolean {
  if (!Number.isNaN(sigTs)) {
    const withinWindow =
      Math.abs(sigTs - clusterMinTs) <= CLUSTER_WINDOW_MS ||
      Math.abs(sigTs - clusterMaxTs) <= CLUSTER_WINDOW_MS;
    if (!withinWindow) return false;
  }

  const hits = tokenOverlapCount(sigTokens, clusterTokens);
  if (hits >= 3) return true;

  const union = sigTokens.size + clusterTokens.size - hits;
  const jaccard = union > 0 ? hits / union : 0;
  return hits >= 2 && jaccard >= 0.3;
}

export function clusterSignals(signals: CanonicalSignal[]): EventCluster[] {
  const sorted = [...signals].sort(
    (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
  );

  const buckets: Array<{
    signals: CanonicalSignal[];
    titleTokens: Set<string>;
    minTs: number;
    maxTs: number;
  }> = [];

  for (const sig of sorted) {
    const sigTokens = new Set(extractSignificantTokens(sig.title));
    const sigTs = Date.parse(sig.published_at);

    let matchedBucket: (typeof buckets)[number] | undefined;
    for (const bucket of buckets) {
      if (shouldCluster(sigTokens, sigTs, bucket.titleTokens, bucket.minTs, bucket.maxTs)) {
        matchedBucket = bucket;
        break;
      }
    }

    if (matchedBucket) {
      matchedBucket.signals.push(sig);
      for (const tok of sigTokens) matchedBucket.titleTokens.add(tok);
      if (!Number.isNaN(sigTs)) {
        matchedBucket.minTs = Math.min(matchedBucket.minTs, sigTs);
        matchedBucket.maxTs = Math.max(matchedBucket.maxTs, sigTs);
      }
    } else {
      buckets.push({
        signals: [sig],
        titleTokens: sigTokens,
        minTs: Number.isNaN(sigTs) ? Date.now() : sigTs,
        maxTs: Number.isNaN(sigTs) ? Date.now() : sigTs,
      });
    }
  }

  return buckets.map((bucket, idx) => {
    const uniquePublishers = new Set(bucket.signals.map((s) => s.publisher));
    const uniqueSourceTypes = new Set(bucket.signals.map((s) => s.source_type));
    const allKeywords = Array.from(
      new Set(bucket.signals.flatMap((s) => s.keywords)),
    ).slice(0, 15);
    const hasIndiaSignal = bucket.signals.some((s) => s.country_relevance === "India");
    const hasIndiaRelevantGlobal = bucket.signals.some(
      (s) => s.country_relevance === "Global (India-relevant)",
    );

    return {
      event_id: `evt_${String(idx + 1).padStart(3, "0")}`,
      cluster_title: bucket.signals[0]!.title,
      signal_ids: bucket.signals.map((s) => s.signal_id),
      signals: bucket.signals,
      first_seen_at: new Date(bucket.minTs).toISOString(),
      last_seen_at: new Date(bucket.maxTs).toISOString(),
      independent_source_count: uniquePublishers.size,
      source_diversity: uniqueSourceTypes.size,
      country_relevance: hasIndiaSignal
        ? "India"
        : hasIndiaRelevantGlobal
          ? "Global (India-relevant)"
          : "Global (needs India review)",
      keywords: allKeywords,
      status: "active",
    };
  });
}

