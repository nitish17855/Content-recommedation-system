import { createHash } from "node:crypto";
import type { CanonicalSignal, EventCluster } from "../ai/schemas.js";
import { extractSignificantTokens } from "./normalize.js";

const CLUSTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const KNOWN_ENTITY_ALIASES: Record<string, string> = {
  openai: "openai",
  chatgpt: "openai",
  gpt: "openai",
  "gpt-4": "openai",
  "gpt-5": "openai",
  "open-ai": "openai",
  google: "google",
  gemini: "google",
  android: "google",
  deepmind: "google",
  anthropic: "anthropic",
  claude: "anthropic",
  meta: "meta",
  instagram: "meta",
  facebook: "meta",
  whatsapp: "meta",
  shopify: "shopify",
  canva: "canva",
  adobe: "adobe",
  microsoft: "microsoft",
  copilot: "microsoft",
  azure: "microsoft",
  amazon: "amazon",
  aws: "amazon",
  meesho: "meesho",
  zomato: "zomato",
  blinkit: "zomato",
  swiggy: "swiggy",
  instamart: "swiggy",
  zepto: "zepto",
  hubspot: "hubspot",
  salesforce: "salesforce",
  stripe: "stripe",
  razorpay: "razorpay",
  zoho: "zoho",
  freshworks: "freshworks",
  notion: "notion",
  slack: "slack",
  airtable: "airtable",
  figma: "figma",
};

export interface PersistedClusterContext {
  dbClusterId?: number;
  event_id: string; // The immutable persistent event identity
  cluster_title: string;
  entities: Set<string>;
  topicTokens: Set<string>;
  signalUrls: Set<string>;
  signalHashes: Set<string>;
  firstSeenAt: number; // ms
  lastSeenAt: number;  // ms
}

export function extractEntitiesAndTopicTokens(text: string): {
  entities: Set<string>;
  topicTokens: Set<string>;
} {
  const tokens = extractSignificantTokens(text);
  const entities = new Set<string>();
  const topicTokens = new Set<string>();

  for (const t of tokens) {
    const canonical = KNOWN_ENTITY_ALIASES[t];
    if (canonical) {
      entities.add(canonical);
    } else {
      topicTokens.add(t);
    }
  }

  return { entities, topicTokens };
}

function calculateTopicSimilarity(
  sigTokens: Set<string>,
  clusterTokens: Set<string>,
): { hits: number; jaccard: number } {
  let hits = 0;
  for (const t of sigTokens) {
    if (clusterTokens.has(t)) hits++;
  }
  const union = sigTokens.size + clusterTokens.size - hits;
  const jaccard = union > 0 ? hits / union : 0;
  return { hits, jaccard };
}

function evaluateSignalAgainstCluster(
  sig: {
    url: string;
    contentHash: string;
    entities: Set<string>;
    topicTokens: Set<string>;
    ts: number;
  },
  cluster: {
    firstSeenAt: number;
    lastSeenAt: number;
    entities: Set<string>;
    topicTokens: Set<string>;
    signalUrls?: Set<string>;
    signalHashes?: Set<string>;
  },
): { qualifies: boolean; score: number } {
  // 1. Exact URL or content-hash hit
  if (cluster.signalUrls?.has(sig.url) || cluster.signalHashes?.has(sig.contentHash)) {
    return { qualifies: true, score: 1.0 };
  }

  // 2. Temporal gate (published within [firstSeen - 2d, lastSeen + 7d])
  if (!Number.isNaN(sig.ts)) {
    const minAllowed = cluster.firstSeenAt - 2 * 24 * 60 * 60 * 1000;
    const maxAllowed = cluster.lastSeenAt + 7 * 24 * 60 * 60 * 1000;
    if (sig.ts < minAllowed || sig.ts > maxAllowed) {
      return { qualifies: false, score: 0 };
    }
  }

  // 3. Entity consistency
  const bothHaveEntities = sig.entities.size > 0 && cluster.entities.size > 0;
  if (bothHaveEntities) {
    let sharedEntityHits = 0;
    for (const e of sig.entities) {
      if (cluster.entities.has(e)) sharedEntityHits++;
    }
    // If specific entities are named but disjoint (e.g. Google vs Meta), do NOT merge
    if (sharedEntityHits === 0) {
      return { qualifies: false, score: 0 };
    }

    const { hits: topicHits, jaccard } = calculateTopicSimilarity(
      sig.topicTokens,
      cluster.topicTokens,
    );
    // Shared entity + (at least 2 topic tokens OR 1 topic token with jaccard >= 0.35)
    if (topicHits >= 2 || (topicHits >= 1 && jaccard >= 0.35)) {
      return { qualifies: true, score: jaccard };
    }
    return { qualifies: false, score: 0 };
  }

  // 4. Generic / un-entitied stories
  const { hits: topicHits, jaccard } = calculateTopicSimilarity(
    sig.topicTokens,
    cluster.topicTokens,
  );
  if (topicHits >= 3 && jaccard >= 0.28) {
    return { qualifies: true, score: jaccard };
  }

  return { qualifies: false, score: 0 };
}

function generateBirthClusterId(params: {
  firstSeenAt: number;
  primaryEntity: string;
  rootSignalHash: string;
}): string {
  const earliestDate = new Date(params.firstSeenAt).toISOString().slice(0, 10);
  const entity = params.primaryEntity || "general";
  const hash = params.rootSignalHash.slice(0, 10);
  return `evt_${earliestDate}_${entity}_${hash}`;
}

interface ClusterBucket {
  isExisting: boolean;
  dbClusterId?: number;
  event_id: string;
  cluster_title: string;
  signals: CanonicalSignal[];
  currentBatchUrls: Set<string>;
  priorSignalUrls: Set<string>;
  priorSignalHashes: Set<string>;
  entities: Set<string>;
  topicTokens: Set<string>;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * Statefully clusters incoming signals against active persisted event clusters.
 * If an incoming signal corroborates an active event in the database, it adopts that
 * persistent event's ID and updates its boundary. If unmatched, it forms a new cluster
 * with an immutable event ID generated at birth.
 */
export function clusterAndResolveSignals(
  signals: CanonicalSignal[],
  activeClusters: PersistedClusterContext[] = [],
): EventCluster[] {
  const sorted = [...signals].sort(
    (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
  );

  const buckets: ClusterBucket[] = activeClusters.map((act) => ({
    isExisting: true,
    dbClusterId: act.dbClusterId,
    event_id: act.event_id,
    cluster_title: act.cluster_title,
    signals: [],
    currentBatchUrls: new Set<string>(),
    priorSignalUrls: new Set(act.signalUrls),
    priorSignalHashes: new Set(act.signalHashes),
    entities: new Set(act.entities),
    topicTokens: new Set(act.topicTokens),
    firstSeenAt: act.firstSeenAt,
    lastSeenAt: act.lastSeenAt,
  }));

  for (const sig of sorted) {
    const { entities, topicTokens } = extractEntitiesAndTopicTokens(sig.title);
    const sigTs = Date.parse(sig.published_at);
    const sigPayload = {
      url: sig.url,
      contentHash: sig.content_hash,
      entities,
      topicTokens,
      ts: sigTs,
    };

    // Evaluate candidates across active and currently formed buckets
    const candidates: Array<{ bucket: ClusterBucket; score: number }> = [];

    for (const bucket of buckets) {
      const evaluation = evaluateSignalAgainstCluster(sigPayload, {
        firstSeenAt: bucket.firstSeenAt,
        lastSeenAt: bucket.lastSeenAt,
        entities: bucket.entities,
        topicTokens: bucket.topicTokens,
        signalUrls: bucket.isExisting ? bucket.priorSignalUrls : bucket.currentBatchUrls,
        signalHashes: bucket.isExisting ? bucket.priorSignalHashes : undefined,
      });
      if (evaluation.qualifies) {
        candidates.push({ bucket, score: evaluation.score });
      }
    }

    let matchedBucket: ClusterBucket | undefined;

    if (candidates.length === 1) {
      matchedBucket = candidates[0]!.bucket;
    } else if (candidates.length > 1) {
      // Sort candidates by score descending
      candidates.sort((a, b) => b.score - a.score);
      const top = candidates[0]!;
      const runnerUp = candidates[1]!;

      // Require confidence margin to prevent ambiguous merges across distinct stories
      if (top.score === 1.0 || top.score - runnerUp.score >= 0.15) {
        matchedBucket = top.bucket;
      } else {
        // Ambiguous match: treat as distinct new event to prevent false positive merge
        matchedBucket = undefined;
      }
    }

    if (matchedBucket) {
      if (!matchedBucket.currentBatchUrls.has(sig.url)) {
        matchedBucket.signals.push(sig);
        matchedBucket.currentBatchUrls.add(sig.url);
        for (const e of entities) matchedBucket.entities.add(e);
        for (const t of topicTokens) matchedBucket.topicTokens.add(t);
        if (!Number.isNaN(sigTs)) {
          matchedBucket.firstSeenAt = Math.min(matchedBucket.firstSeenAt, sigTs);
          matchedBucket.lastSeenAt = Math.max(matchedBucket.lastSeenAt, sigTs);
        }
      }
    } else {
      const primaryEntity = Array.from(entities).sort()[0] ?? "general";
      const ts = Number.isNaN(sigTs) ? Date.now() : sigTs;
      const event_id = generateBirthClusterId({
        firstSeenAt: ts,
        primaryEntity,
        rootSignalHash: sig.content_hash,
      });

      buckets.push({
        isExisting: false,
        event_id,
        cluster_title: sig.title,
        signals: [sig],
        currentBatchUrls: new Set([sig.url]),
        priorSignalUrls: new Set(),
        priorSignalHashes: new Set(),
        entities,
        topicTokens,
        firstSeenAt: ts,
        lastSeenAt: ts,
      });
    }
  }

  // Filter out any pre-existing active clusters that received zero incoming signals in this batch
  const populatedBuckets = buckets.filter((b) => b.signals.length > 0);

  return populatedBuckets.map((bucket) => {
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
      event_id: bucket.event_id,
      cluster_title: bucket.cluster_title,
      signal_ids: bucket.signals.map((s) => s.signal_id),
      signals: bucket.signals,
      first_seen_at: new Date(bucket.firstSeenAt).toISOString(),
      last_seen_at: new Date(bucket.lastSeenAt).toISOString(),
      independent_source_count: Math.max(1, uniquePublishers.size),
      source_diversity: Math.max(1, uniqueSourceTypes.size),
      country_relevance: hasIndiaSignal
        ? "India"
        : hasIndiaRelevantGlobal
          ? "Global (India-relevant)"
          : "Global (needs India review)",
      keywords: allKeywords,
      entities: Array.from(bucket.entities),
      topic_tokens: Array.from(bucket.topicTokens),
      status: "active",
    };
  });
}

/**
 * Backward-compatible pure in-memory clusterer.
 */
export function clusterSignals(signals: CanonicalSignal[]): EventCluster[] {
  return clusterAndResolveSignals(signals, []);
}
