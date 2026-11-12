import { z } from "zod";

export const SourceTypeSchema = z.enum([
  "official_platform",
  "industry_news",
  "competitor_blog",
  "calendar",
]);

export const GeoScopeSchema = z.enum(["india", "global"]);

export const CountryRelevanceSchema = z.enum([
  "India",
  "Global (India-relevant)",
  "Global (needs India review)",
]);

export const SourceConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  feedUrl: z.string().url(),
  sourceType: SourceTypeSchema,
  geoScope: GeoScopeSchema,
  enabled: z.boolean(),
  maxItems: z.number().int().positive().default(30),
});

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const RawFeedItemSchema = z.object({
  sourceId: z.string(),
  publisher: z.string(),
  sourceType: SourceTypeSchema,
  geoScope: GeoScopeSchema,
  title: z.string(),
  url: z.string(),
  publishedAtRaw: z.string().nullable(),
  excerptRaw: z.string(),
  categories: z.array(z.string()).default([]),
});

export type RawFeedItem = z.infer<typeof RawFeedItemSchema>;

export const CanonicalSignalSchema = z.object({
  signal_id: z.string(),
  source_id: z.string(),
  title: z.string(),
  url: z.string().url(),
  publisher: z.string(),
  published_at: z.string(),
  fetched_at: z.string(),
  source_type: SourceTypeSchema,
  country_relevance: CountryRelevanceSchema,
  excerpt: z.string(),
  content_hash: z.string(),
  keywords: z.array(z.string()),
  summary: z.string().nullable(),
});

export type CanonicalSignal = z.infer<typeof CanonicalSignalSchema>;

export interface SourceRunResult {
  sourceId: string;
  sourceName: string;
  status: "ok" | "skipped" | "error";
  fetchedCount: number;
  inWindowCount: number;
  error?: string;
}

export const EventClusterSchema = z.object({
  event_id: z.string(),
  cluster_title: z.string(),
  signal_ids: z.array(z.string()),
  signals: z.array(CanonicalSignalSchema),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  independent_source_count: z.number().int().positive(),
  source_diversity: z.number().int().positive(),
  country_relevance: CountryRelevanceSchema,
  keywords: z.array(z.string()),
  status: z.enum(["active", "expired"]),
});

export type EventCluster = z.infer<typeof EventClusterSchema>;

// --- Step 3 & Step 4 AI Pipeline Schemas ---

export const ContextEvidenceSchema = z.object({
  evidence_id: z.string(),
  url: z.string(),
  publisher: z.string(),
  published_at: z.string(),
  source_type: z.string(),
  supports: z.string(),
});

export const ContextPackSchema = z.object({
  event_id: z.string(),
  event_title: z.string(),
  event_summary: z.string(),
  event_type: z.enum(["search_industry", "paid_media", "india_marketing", "india_startup_tech", "calendar_moment", "other"]),
  event_status: z.enum(["active", "expired"]),
  occurred_at: z.string().nullable(),
  first_seen_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  geography: z.object({
    primary: z.string(),
    relevance: z.enum(["high", "medium", "low"]),
    reason: z.string(),
  }),
  why_it_matters: z.string(),
  participating_entities: z.array(z.string()),
  affected_audiences: z.array(z.string()),
  audience_problems: z.array(z.string()),
  audience_reactions: z.array(z.string()),
  trend_phase: z.enum(["emerging", "growing", "peak", "declining", "expired", "evergreen"]),
  estimated_lifespan: z.string(),
  potential_service_tags: z.array(z.string()),
  evidence: z.array(ContextEvidenceSchema),
  contradictions: z.array(z.string()),
  unknowns: z.array(z.string()),
  sensitivity: z.enum(["low", "medium", "high"]),
  confidence_basis: z.array(z.string()),
});

export type ContextPack = z.infer<typeof ContextPackSchema>;

export const OpportunityMatchSchema = z.object({
  event_id: z.string(),
  opportunity_status: z.enum(["ACCEPT", "REJECT"]),
  matched_services: z.array(z.string()),
  matched_audiences: z.array(z.string()),
  opportunity_reason: z.string(),
  distinctive_angle: z.string(),
  saturation_notes: z.string(),
  rejection_reason: z.string().nullable(),
  unresolved_unknowns: z.array(z.string()),
});

export type OpportunityMatch = z.infer<typeof OpportunityMatchSchema>;

export const CreativeRouteSchema = z.object({
  route: z.string(),
  concept_title: z.string(),
  what_to_communicate: z.string(),
  why_timely: z.string(),
  brand_connection: z.string(),
  suggested_platform: z.string(),
  suggested_format: z.string(),
  objective: z.string(),
  execution_note: z.string(),
});

export type CreativeRoute = z.infer<typeof CreativeRouteSchema>;

export const CreativeIdeationSchema = z.object({
  event_id: z.string(),
  creative_routes: z.array(CreativeRouteSchema).min(1).max(3),
});

export type CreativeIdeation = z.infer<typeof CreativeIdeationSchema>;

export const CriticRouteReviewSchema = z.object({
  route_index: z.number().int().min(0),
  verdict: z.enum(["ACCEPT", "REVISE", "REJECT"]),
  risk: z.enum(["SAFE", "CAUTION", "BLOCKED"]),
  ai_scores: z.object({
    brand_fit: z.number().int().min(1).max(5),
    audience_relevance: z.number().int().min(1).max(5),
    creative_usefulness: z.number().int().min(1).max(5),
    distinctiveness: z.number().int().min(1).max(5),
    execution_feasibility: z.number().int().min(1).max(5),
    cultural_appropriateness: z.number().int().min(1).max(5),
  }),
  issues: z.array(z.string()),
  required_revisions: z.array(z.string()),
  factual_concerns: z.array(z.string()),
  final_reason: z.string(),
});

export const CriticBatchOutputSchema = z.object({
  event_id: z.string(),
  reviews: z.array(CriticRouteReviewSchema),
});

export type CriticRouteReview = z.infer<typeof CriticRouteReviewSchema>;
export type CriticBatchOutput = z.infer<typeof CriticBatchOutputSchema>;

export const RecommendationCardSchema = z.object({
  title: z.string(),
  category: z.string(),
  what_happened: z.string(),
  why_now: z.string(),
  brand_connection: z.string(),
  what_to_post: z.string(),
  suggested_platform: z.string(),
  suggested_format: z.string(),
  objective: z.string(),
  evidence: z.array(
    z.object({
      url: z.string(),
      publisher: z.string(),
      published_at: z.string(),
    }),
  ),
  urgency: z.enum(["immediate", "soon", "flexible"]),
  risk: z.enum(["safe", "caution", "blocked"]),
  evidence_confidence: z.object({
    level: z.enum(["high", "medium", "low"]),
    score: z.number(),
    factual_basis: z.string(),
  }),
  execution_note: z.string(),
  // Transparent internal scoring metadata (separate deterministic vs AI rubric)
  metadata: z.object({
    event_id: z.string(),
    creative_route: z.string(),
    matched_services: z.array(z.string()),
    critic_verdict: z.enum(["ACCEPT", "REVISE"]),
    deterministic_evidence_score: z.number(),
    ai_rubric_score: z.number(),
    combined_rank_score: z.number(),
  }),
});

export type RecommendationCard = z.infer<typeof RecommendationCardSchema>;

export const BaselineIdeaSchema = z.object({
  concept: z.string(),
  relevant_service: z.string(),
  target_audience: z.string(),
  why_timely: z.string(),
  creative_direction: z.string(),
  suggested_platform: z.string(),
  suggested_format: z.string(),
  objective: z.string(),
  supporting_source_urls: z.array(z.string()),
});

export const BaselineOutputSchema = z.object({
  ideas: z.array(BaselineIdeaSchema).max(6),
});

export type BaselineOutput = z.infer<typeof BaselineOutputSchema>;

export const OnDemandSuggestionSchema = z.object({
  title: z.string(),
  category: z.string(),
  matched_services: z.array(z.string()),
  why_now: z.string(),
  brand_connection: z.string(),
  what_to_post: z.string(),
  suggested_platform: z.string(),
  suggested_format: z.string(),
  objective: z.string(),
  risk: z.enum(["safe", "caution"]),
  execution_note: z.string(),
  evidence_urls: z.array(z.string()),
});

export const OnDemandAnswerSchema = z.object({
  direct_answer: z.string(),
  matched_service_ids: z.array(z.string()),
  suggestions: z.array(OnDemandSuggestionSchema).min(1).max(3),
  unknowns: z.array(z.string()),
});

export type OnDemandAnswer = z.infer<typeof OnDemandAnswerSchema>;
