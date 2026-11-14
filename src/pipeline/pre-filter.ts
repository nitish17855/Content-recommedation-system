import type { EventCluster } from "../ai/schemas.js";
import { extractSignificantTokens } from "./normalize.js";
import {
  classifyCrossIndustryEvent,
  calculateCrossIndustryRelevance,
  inferBrandSensitivities,
  resolveEffectiveSensitivity,
  type BrandSensitivityConfig,
  type SensitivityDimensions,
} from "./cross-industry-classifier.js";

export type DiscoveryChannel =
  | "ai_tech"
  | "business_startups"
  | "ecommerce_retail"
  | "social_creators"
  | "marketing_competitors"
  | "search_web"
  | "culture_trends";

export interface RecommendationHistory {
  eventKeys: Set<string>;
  evidenceUrls: Set<string>;
  priorTitles: string[];
}

export interface BrandKeywordTerm {
  term: string;
  category: "offering" | "problem" | "industry" | "audience" | "operation" | "competitor" | "geo";
  weight: number;
  sourceField: string;
  confidence: number;
}

export interface BrandPreFilterProfile {
  brandKey: string;
  industry: string;
  keywords: BrandKeywordTerm[];
  sensitivities: BrandSensitivityConfig;
}

export interface PreFilterScoringConfig {
  strategy: "nsp-v1" | "brand-aware-v2";
  brandProfile?: BrandPreFilterProfile;
  weights?: {
    brandRelevance: number;
    crossIndustry: number;
    sourceQualityFreshness: number;
  };
}

const CONTROLLED_INDUSTRY_SYNONYMS: Record<string, string[]> = {
  logistics: [
    "freight",
    "container",
    "demurrage",
    "cold chain",
    "refrigerated transport",
    "ocean freight",
    "intermodal",
    "shipping rates",
    "port congestion",
    "warehousing",
  ],
  coffee: [
    "green coffee",
    "arabica",
    "coffee futures",
    "roasting",
    "single-origin",
    "fssai",
    "landed cost",
    "packaging compliance",
    "commodities",
  ],
  food: [
    "fssai",
    "fda",
    "food safety",
    "ingredients",
    "cold storage",
    "packaging regulation",
    "shelf life",
    "d2c food",
  ],
  healthcare: [
    "telehealth",
    "hipaa",
    "clinical intake",
    "diagnostics",
    "patient retention",
    "telemedicine",
    "medical records",
    "compliance",
  ],
  saas: [
    "cac",
    "ltv",
    "plg",
    "churn",
    "retention",
    "geo citation",
    "ai search",
    "arr",
    "onboarding activation",
  ],
};

export function buildBrandPreFilterProfile(params: {
  brandKey: string;
  industry?: string;
  subIndustry?: string;
  businessModel?: string;
  offerings?: Array<{ name?: string; service_id?: string; category?: string }>;
  targetAudiences?: string[];
  customerProblems?: string[];
  competitors?: Array<{ name?: string }>;
  overrides?: Partial<SensitivityDimensions>;
}): BrandPreFilterProfile {
  const terms: BrandKeywordTerm[] = [];
  const seen = new Set<string>();

  const addTerm = (
    raw: string,
    category: BrandKeywordTerm["category"],
    weight: number,
    sourceField: string,
  ) => {
    const clean = raw.trim().toLowerCase();
    if (clean.length < 3 || seen.has(clean)) return;
    seen.add(clean);
    terms.push({
      term: clean,
      category,
      weight,
      sourceField,
      confidence: 1.0,
    });
  };

  if (params.industry) {
    addTerm(params.industry, "industry", 0.8, "brandProfile.industry");
  }
  if (params.subIndustry) {
    addTerm(params.subIndustry, "industry", 0.8, "brandProfile.subIndustry");
  }
  if (params.businessModel) {
    addTerm(params.businessModel, "operation", 0.7, "brandProfile.businessModel");
  }

  for (const off of params.offerings ?? []) {
    if (off.name) {
      addTerm(off.name, "offering", 1.0, "services.name");
      for (const t of extractSignificantTokens(off.name)) {
        if (t.length >= 3) addTerm(t, "offering", 0.75, "services.name.token");
      }
    }
    if (off.category) {
      addTerm(off.category, "offering", 0.85, "services.category");
      for (const t of extractSignificantTokens(off.category)) {
        if (t.length >= 3) addTerm(t, "offering", 0.7, "services.category.token");
      }
    }
  }

  for (const aud of params.targetAudiences ?? []) {
    addTerm(aud, "audience", 0.8, "brandProfile.targetAudiences");
    for (const t of extractSignificantTokens(aud)) {
      if (t.length >= 3) addTerm(t, "audience", 0.65, "brandProfile.targetAudiences.token");
    }
  }

  for (const prob of params.customerProblems ?? []) {
    addTerm(prob, "problem", 1.0, "brandProfile.customerProblems");
    for (const t of extractSignificantTokens(prob)) {
      if (t.length >= 3) addTerm(t, "problem", 0.75, "brandProfile.customerProblems.token");
    }
  }

  for (const comp of params.competitors ?? []) {
    if (comp.name) addTerm(comp.name, "competitor", 0.6, "competitors.name");
  }

  // Controlled Synonym Expansion based on verified industry & sub-industry
  const industryText = `${params.industry ?? ""} ${params.subIndustry ?? ""} ${params.businessModel ?? ""}`.toLowerCase();
  for (const [key, synList] of Object.entries(CONTROLLED_INDUSTRY_SYNONYMS)) {
    if (industryText.includes(key)) {
      for (const syn of synList) {
        addTerm(syn, "industry", 0.75, `synonyms.${key}`);
      }
    }
  }

  const inferred = inferBrandSensitivities({
    industry: params.industry,
    subIndustry: params.subIndustry,
    businessModel: params.businessModel,
    offerings: (params.offerings ?? []).map((o) => o.name ?? ""),
    targetAudiences: params.targetAudiences,
    customerProblems: params.customerProblems,
  });

  const effective = resolveEffectiveSensitivity(inferred, params.overrides);

  return {
    brandKey: params.brandKey,
    industry: params.industry ?? "General",
    keywords: terms,
    sensitivities: {
      inferenceVersion: "1.0",
      inferred,
      overrides: params.overrides ?? {},
      effective,
      inferredAt: new Date().toISOString(),
    },
  };
}

export const SAAS_GROWTH_KEYWORDS = [
  "saas", "b2b", "plg", "product-led", "cac", "ltv", "churn", "retention",
  "onboarding", "activation", "demo", "pipeline", "inbound", "outbound",
  "prospecting", "sdr", "crm", "pricing", "freemium", "self-serve",
  "cro", "conversion", "geo", "aeo", "ai search", "enterprise seo",
  "rank tracking", "arr", "mrr", "paywall", "lead generation",
];

export const FOUNDATIONAL_AI_KEYWORDS = [
  "ai", "agent", "agentic", "automation", "copilot", "llm", "reasoning",
  "model", "multimodal", "voice", "assistant", "workflow", "intelligence",
  "search", "vision", "speech", "autonomous",
];

export const CONSUMER_NOISE_KEYWORDS = [
  "box office", "movie collection", "day collection", "cricket", "match prediction",
  "who is broadcasting", "where to watch", "line-ups", "celebrity", "actress",
  "actor", "trailer release", "teaser release", "sports betting", "horoscope",
  "football match", "league match",
];

const BROAD_MARKET_KEYWORDS = [
  "startup", "startups", "funding", "founder", "msme", "sme",
  "ecommerce", "e-commerce", "shopify", "d2c", "retail", "shopping", "checkout",
  "quick commerce", "marketing", "advertising", "ads", "campaign", "brand",
  "branding", "rebrand", "instagram", "reels", "youtube", "linkedin", "whatsapp",
  "creator", "creators", "social media", "video", "traffic", "analytics", "visibility",
];

const HOUSEKEEPING_NOISE = [
  "blog is moving",
  "api now supports",
  "multi-party approval",
  "deprecation notice",
  "sdk v",
  "release notes",
  "bug fix",
  "changelog",
  "share price",
  "q1 results",
  "q2 results",
  "q3 results",
  "q4 results",
  "interim dividend",
  "profit falls",
  "net profit",
];

const CHANNEL_BY_SOURCE_ID: Record<string, DiscoveryChannel> = {
  "openai-news": "ai_tech",
  "google-official-blog": "ai_tech",
  techcrunch: "ai_tech",
  "ai-business-india": "ai_tech",
  inc42: "business_startups",
  yourstory: "business_startups",
  "et-retail-ecommerce": "ecommerce_retail",
  "platforms-commerce-india": "ecommerce_retail",
  "india-d2c-brand-campaigns": "ecommerce_retail",
  "social-media-examiner": "social_creators",
  "social-platforms-india": "social_creators",
  saastr: "business_startups",
  "techcrunch-enterprise": "ai_tech",
  "b2b-saas-news": "business_startups",
  "saas-growth-plg": "marketing_competitors",
  "et-brandequity-marketing": "marketing_competitors",
  "et-brandequity-digital": "marketing_competitors",
  "competitors-india": "marketing_competitors",
  "google-search-central": "search_web",
  "google-ads-dev": "search_web",
  seroundtable: "search_web",
  "google-trends-india": "culture_trends",
};

export function getClusterChannel(cluster: EventCluster): DiscoveryChannel {
  const sourceId = cluster.signals[0]?.source_id ?? "";
  if (CHANNEL_BY_SOURCE_ID[sourceId]) {
    return CHANNEL_BY_SOURCE_ID[sourceId]!;
  }
  const st = cluster.signals[0]?.source_type;
  if (st === "google_trends") return "culture_trends";
  if (st === "competitor_blog") return "marketing_competitors";
  return "ai_tech";
}

function getStoryTokenSet(cluster: EventCluster): Set<string> {
  return new Set(
    extractSignificantTokens(`${cluster.cluster_title} ${cluster.keywords.slice(0, 6).join(" ")}`),
  );
}

function setsOverlapStory(tokensA: Set<string>, tokensB: Set<string>): boolean {
  let hits = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) hits++;
  }
  if (hits >= 3) return true;
  const union = tokensA.size + tokensB.size - hits;
  return hits >= 2 && union > 0 && hits / union >= 0.25;
}

export function areClustersSameStory(a: EventCluster, b: EventCluster): boolean {
  if (a.event_id === b.event_id) return true;
  const urlsA = new Set(a.signals.map((s) => s.url));
  if (b.signals.some((s) => urlsA.has(s.url))) return true;
  return setsOverlapStory(getStoryTokenSet(a), getStoryTokenSet(b));
}

export function isPreviouslyRecommended(
  cluster: EventCluster,
  history?: RecommendationHistory,
): boolean {
  if (!history) return false;
  if (history.eventKeys.has(cluster.event_id)) return true;
  if (cluster.signals.some((s) => history.evidenceUrls.has(s.url))) return true;

  const clusterTokens = getStoryTokenSet(cluster);
  for (const priorTitle of history.priorTitles) {
    const priorTokens = new Set(extractSignificantTokens(priorTitle));
    if (setsOverlapStory(clusterTokens, priorTokens)) {
      return true;
    }
  }
  return false;
}

export function scoreClusterNspV1(cluster: EventCluster, nowMs: number): number {
  let score = 15;

  // India focus bonus
  if (cluster.country_relevance === "India") score += 16;
  else if (cluster.country_relevance === "Global (India-relevant)") score += 10;

  // Corroboration & source diversity bonus
  score += Math.min(cluster.independent_source_count, 4) * 12;
  score += Math.min(cluster.signals.length - 1, 3) * 5;

  const combined = `${cluster.cluster_title} ${cluster.keywords.join(" ")} ${cluster.signals[0]?.excerpt ?? ""}`.toLowerCase();

  // Equal High Priority Boost: Foundational AI and B2B SaaS Growth (no company-name bias)
  let saasHits = 0;
  for (const kw of SAAS_GROWTH_KEYWORDS) {
    if (combined.includes(kw)) saasHits++;
  }

  let aiHits = 0;
  for (const kw of FOUNDATIONAL_AI_KEYWORDS) {
    if (combined.includes(kw)) aiHits++;
  }

  // Both categories receive equal high-priority boost without company-level favor
  const highPriorityBoost = Math.min(saasHits, 4) * 8 + Math.min(aiHits, 4) * 8;
  score += Math.min(highPriorityBoost, 40);

  // Supplementary broad business keywords
  let broadHits = 0;
  for (const kw of BROAD_MARKET_KEYWORDS) {
    if (combined.includes(kw)) broadHits++;
  }
  score += Math.min(broadHits, 3) * 4;

  // Aggressive penalty for pure consumer noise (movie box office, cricket scores, celebrity gossip)
  if (CONSUMER_NOISE_KEYWORDS.some((phrase) => combined.includes(phrase))) {
    score -= 40;
  }

  // Filter out pure developer API maintenance or zero-business trend spikes
  const totalBusinessHits = saasHits + aiHits + broadHits;
  const isOnlyTrends = cluster.signals.every((s) => s.source_type === "google_trends");
  if (isOnlyTrends && totalBusinessHits === 0) {
    score -= 25;
  } else if (totalBusinessHits === 0) {
    score -= 15;
  }

  if (HOUSEKEEPING_NOISE.some((phrase) => combined.includes(phrase))) {
    score -= 32;
  }

  // Recency boost
  const ageHours = (nowMs - Date.parse(cluster.last_seen_at)) / (1000 * 60 * 60);
  if (!Number.isNaN(ageHours)) {
    if (ageHours <= 48) score += 14;
    else if (ageHours <= 120) score += 8;
  }

  return score;
}

export function scoreClusterBrandAwareV2(
  cluster: EventCluster,
  nowMs: number,
  profile?: BrandPreFilterProfile,
  weights: { brandRelevance: number; crossIndustry: number; sourceQualityFreshness: number } = {
    brandRelevance: 0.6,
    crossIndustry: 0.2,
    sourceQualityFreshness: 0.2,
  },
): number {
  const combined = `${cluster.cluster_title} ${cluster.keywords.join(" ")} ${cluster.signals.map((s) => s.excerpt).join(" ")}`.toLowerCase();

  // 1. Brand Relevance Component (0 - 100)
  let brandRelevanceRaw = 0;
  if (profile && profile.keywords.length > 0) {
    for (const kw of profile.keywords) {
      if (combined.includes(kw.term)) {
        brandRelevanceRaw += kw.weight * 25;
      }
    }
  } else {
    // If no brand profile is provided, assign neutral baseline
    brandRelevanceRaw = 50;
  }
  const brandRelevance = Math.min(100, Math.round(brandRelevanceRaw));

  // 2. Cross-Industry Relevance Component (0 - 100)
  const classification = classifyCrossIndustryEvent(cluster);
  const effectiveSensitivities = profile?.sensitivities.effective ?? {
    aiRelevance: "medium",
    supplyChainSensitivity: "medium",
    regulatorySensitivity: "medium",
  };
  const crossIndustryResult = calculateCrossIndustryRelevance(classification, effectiveSensitivities);
  const crossIndustryRelevance = crossIndustryResult.relevance100;

  // 3. Source Quality and Freshness Component (0 - 100)
  let sourceQuality = 0;
  sourceQuality += Math.min(cluster.independent_source_count, 4) * 10; // up to 40
  sourceQuality += Math.min(cluster.source_diversity, 3) * 6; // up to 18
  const hasOfficial = cluster.signals.some((s) => s.source_type === "official_platform");
  if (hasOfficial) sourceQuality += 17; // up to 17

  const ageHours = (nowMs - Date.parse(cluster.last_seen_at)) / (1000 * 60 * 60);
  if (!Number.isNaN(ageHours)) {
    if (ageHours <= 48) sourceQuality += 25;
    else if (ageHours <= 120) sourceQuality += 15;
    else sourceQuality += 5;
  } else {
    sourceQuality += 10;
  }
  const sourceQualityFreshness = Math.min(100, sourceQuality);

  // 4. Noise Penalties
  let noisePenalty = 0;
  if (CONSUMER_NOISE_KEYWORDS.some((phrase) => combined.includes(phrase))) {
    noisePenalty += 40;
  }
  if (HOUSEKEEPING_NOISE.some((phrase) => combined.includes(phrase))) {
    noisePenalty += 30;
  }

  // 5. Zero Direct Match Handling (Soft Bounded Penalty)
  let zeroMatchPenalty = 0;
  if (brandRelevance === 0) {
    if (crossIndustryRelevance >= 40) {
      // High-impact cross-industry event: no extra penalty so credible shifts survive
      zeroMatchPenalty = 0;
    } else {
      zeroMatchPenalty = 12;
    }
  }

  // Calculate weighted composite score
  const positiveComposite =
    weights.brandRelevance * brandRelevance +
    weights.crossIndustry * crossIndustryRelevance +
    weights.sourceQualityFreshness * sourceQualityFreshness;

  const finalScore = positiveComposite - noisePenalty - zeroMatchPenalty;
  return Number(finalScore.toFixed(2));
}

export function scoreClusterForPreFilter(
  cluster: EventCluster,
  nowMs: number,
  scoringConfig: PreFilterScoringConfig = { strategy: "nsp-v1" },
): number {
  if (scoringConfig.strategy === "brand-aware-v2") {
    return scoreClusterBrandAwareV2(
      cluster,
      nowMs,
      scoringConfig.brandProfile,
      scoringConfig.weights,
    );
  }
  return scoreClusterNspV1(cluster, nowMs);
}

/**
 * Selects candidate clusters using independent-channel round-robin, underlying-story dedupe,
 * and cross-run recommendation history exclusion so one platform or topic never crowds out others.
 */
export function selectCandidateClusters(
  clusters: EventCluster[],
  maxClusters: number,
  now: Date = new Date(),
  history?: RecommendationHistory,
  scoringConfig: PreFilterScoringConfig = { strategy: "nsp-v1" },
): EventCluster[] {
  const nowMs = now.getTime();
  const ranked = [...clusters]
    .filter((cluster) => !isPreviouslyRecommended(cluster, history))
    .map((cluster) => ({
      cluster,
      channel: getClusterChannel(cluster),
      score: scoreClusterForPreFilter(cluster, nowMs, scoringConfig),
    }))
    .filter((entry) => entry.score >= 15)
    .sort((a, b) => b.score - a.score);

  // Bucket top unique stories per independent discovery channel
  const channelOrder: DiscoveryChannel[] = [
    "ai_tech",
    "ecommerce_retail",
    "business_startups",
    "social_creators",
    "marketing_competitors",
    "culture_trends",
    "search_web",
  ];
  const buckets = new Map<DiscoveryChannel, typeof ranked>();
  for (const ch of channelOrder) buckets.set(ch, []);
  for (const entry of ranked) {
    buckets.get(entry.channel)?.push(entry);
  }

  const selected: EventCluster[] = [];
  const perChannelCount = new Map<DiscoveryChannel, number>();
  const maxPerChannelFirstPass = Math.max(2, Math.ceil(maxClusters / channelOrder.length) + 1);

  // Pass 1: Round-robin across channels (taking the top distinct story from each channel in turn)
  let progressed = true;
  while (selected.length < maxClusters && progressed) {
    progressed = false;
    for (const ch of channelOrder) {
      if (selected.length >= maxClusters) break;
      const usedCount = perChannelCount.get(ch) ?? 0;
      if (usedCount >= maxPerChannelFirstPass) continue;

      const queue = buckets.get(ch) ?? [];
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (selected.some((picked) => areClustersSameStory(picked, next.cluster))) {
          continue;
        }
        selected.push(next.cluster);
        perChannelCount.set(ch, usedCount + 1);
        progressed = true;
        break;
      }
    }
  }

  // Pass 2: If slots still remain, fill highest-scoring non-duplicate stories across any channel
  if (selected.length < maxClusters) {
    for (const entry of ranked) {
      if (selected.length >= maxClusters) break;
      if (selected.some((picked) => areClustersSameStory(picked, entry.cluster))) {
        continue;
      }
      selected.push(entry.cluster);
    }
  }

  return selected;
}
