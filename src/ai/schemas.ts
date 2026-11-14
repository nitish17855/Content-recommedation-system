import { z } from "zod";

export const SourceTypeSchema = z.enum([
  "official_platform",
  "industry_news",
  "competitor_blog",
  "calendar",
  "google_trends",
]);

export const DiscoveryCategorySchema = z.enum([
  "New tools and product launches",
  "Changes in how customers discover businesses",
  "Marketing and advertising developments",
  "Competitor and brand campaigns",
  "Industry and business developments",
  "Cultural and emerging conversations",
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
  entities: z.array(z.string()).optional(),
  topic_tokens: z.array(z.string()).optional(),
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
  discovery_category: DiscoveryCategorySchema,
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
  india_availability: z.object({
    status: z.enum(["available_in_india", "limited_or_beta", "us_or_global_only", "not_applicable", "unknown"]),
    who_can_use_it: z.string(),
    restrictions_or_eligibility: z.string(),
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

export const OpportunityTypeSchema = z.enum([
  "timely_market_shift",
  "growth_and_unit_economics",
  "practical_framework",
  "educational_problem_solver",
  "thought_leadership",
  "case_proof",
]);

export type OpportunityType = z.infer<typeof OpportunityTypeSchema>;

export const OpportunityMatchSchema = z.object({
  event_id: z.string(),
  opportunity_status: z.enum(["ACCEPT", "REJECT"]),
  opportunity_type: OpportunityTypeSchema.optional(),
  matched_services: z.array(z.string()),
  matched_audiences: z.array(z.string()).default(["Target Customers"]),
  target_audience_profile: z.string().optional(),
  core_business_problem: z.string().optional(),
  opportunity_reason: z.string(),
  distinctive_angle: z.string(),
  saturation_notes: z.string(),
  rejection_reason: z.string().nullable(),
  unresolved_unknowns: z.array(z.string()),
});

export type OpportunityMatch = z.infer<typeof OpportunityMatchSchema>;

export const MarketScanOutputSchema = z.object({
  india_market_pulse: z.string(),
  competitor_watch: z
    .array(
      z.object({
        name_or_group: z.string(),
        observed_activity: z.string(),
        source_url: z.string(),
      }),
    )
    .max(6),
  trending_in_brand_sectors: z.array(z.string()).max(6),
  prioritized_event_ids: z.array(z.string()).min(1).max(16),
});

export type MarketScanOutput = z.infer<typeof MarketScanOutputSchema>;

export const MaterialGuideSchema = z.object({
  label: z.string(),
  url: z.string(),
  what_to_record_or_screenshot: z.string(),
});

export const CreationStepsSchema = z.object({
  opening_line: z.string(),
  what_to_show: z.array(z.string()).min(1).max(6),
  on_screen_text: z.array(z.string()).min(1).max(6),
  demonstration_step: z.string(),
  ending_line: z.string(),
});

export const CreativeRouteSchema = z.object({
  route: z.string(),
  concept_title: z.string(),
  plain_what_happened: z.string(),
  why_brand_should_care: z.string(),
  what_to_create: z.string(),
  how_to_create_it: CreationStepsSchema,
  where_to_get_material: z.array(MaterialGuideSchema).min(1).max(4),
  what_to_communicate: z.string(),
  when_to_publish: z.object({
    urgency: z.enum(["urgent", "this_week", "flexible"]),
    timing_reason: z.string(),
  }),
  facts_and_claims_to_check: z.array(z.string()),
  suggested_platform: z.string(),
  suggested_format: z.string(),
  objective: z.string(),
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
  schemaVersion: z.literal(2).default(2),
  title: z.string(),
  category: DiscoveryCategorySchema,
  // 8-question non-technical owner brief
  what_happened: z.string(),
  why_brand_should_care: z.string(),
  what_to_create: z.string(),
  how_to_create_it: CreationStepsSchema,
  where_to_get_material: z.array(MaterialGuideSchema),
  what_to_communicate: z.string(),
  when_to_publish: z.object({
    urgency: z.enum(["urgent", "this_week", "flexible"]),
    timing_reason: z.string(),
  }),
  what_to_verify: z.object({
    india_availability: z.string(),
    who_can_use_it: z.string(),
    facts_and_claims_to_check: z.array(z.string()),
  }),
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
  risk: z.enum(["safe", "caution", "blocked"]),
  evidence_confidence: z.object({
    level: z.enum(["high", "medium", "low"]),
    score: z.number(),
    factual_basis: z.string(),
  }),
  // Transparent internal scoring metadata (separate deterministic vs AI rubric)
  metadata: z.object({
    event_id: z.string(),
    creative_route: z.string(),
    matched_services: z.array(z.string()),
    target_audience_profile: z.string().optional(),
    core_business_problem: z.string().optional(),
    opportunity_type: OpportunityTypeSchema.optional(),
    critic_verdict: z.enum(["ACCEPT", "REVISE", "REJECT"]),
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

export const ExtractedServiceSchema = z.object({
  service_id: z.string().describe("Lowercase slug identifier for the service, e.g. seo-optimization or custom-manufacturing"),
  name: z.string().describe("Official name of the service or product offering"),
  category: z.string().describe("Logical category, e.g. Organic Search, Cloud Engineering, Direct Sales"),
  description: z.string().describe("1-2 sentence description of what this offering delivers"),
  pricing_note: z.string().optional().describe("Public pricing details if disclosed on site, else null"),
});

export type ExtractedService = z.infer<typeof ExtractedServiceSchema>;

export const BrandProfileExtractionSchema = z.object({
  brand_name: z.string().describe("Official company or brand name"),
  industry: z.string().describe("Primary industry, e.g. B2B SaaS, E-Commerce Logistics, D2C Nutrition"),
  sub_industry: z.string().optional().describe("More specific niche or vertical"),
  business_model: z.string().describe("Business model, e.g. B2B Subscription SaaS, Direct-to-Consumer, Agency/Consulting"),
  target_market: z.string().default("Global").describe("Primary geographic market, e.g. India, United States, Global"),
  value_proposition: z.string().describe("The core promise and unique value proposition the company offers to customers"),
  core_offerings: z.array(ExtractedServiceSchema).min(1).max(12).describe("Products, services, or solutions explicitly verified on the website"),
  target_audiences: z.array(z.string()).min(1).max(8).describe("Customer segments or personas the company targets"),
  customer_pain_points: z.array(z.string()).min(1).max(8).describe("Problems, friction points, or bottlenecks the company helps its clients solve"),
  verified_differentiators: z.array(z.string()).min(1).max(8).describe("Concrete claims, proprietary methods, or differentiators stated on the site"),
  proof_points: z.array(z.string()).default([]).describe("Case studies, testimonials, client names, or quantified results mentioned on the site"),
  tone_and_style: z.string().describe("Observed communication style, e.g. Executive & Analytical, Bold & Modern, Friendly & Pragmatic"),
  uncertainties: z.array(z.string()).default([]).describe("Important aspects not clear or not publicly disclosed on the website"),
});

export type BrandProfileExtraction = z.infer<typeof BrandProfileExtractionSchema>;

export const CandidatePublisherSchema = z.object({
  publisher_name: z.string().describe("Name of the industry trade publication or authoritative news outlet"),
  website_url: z.string().describe("Official homepage URL of the publication"),
  candidate_feed_urls: z.array(z.string()).describe("Candidate RSS or Atom feed URLs for this publication"),
  coverage_focus: z.string().describe("What aspect of the industry this publication covers"),
  is_specialist_or_regulatory: z.boolean().default(false).describe("Whether this is a trade association, regulatory body, or high-authority specialist"),
});

export const SourceDiscoveryProposalsSchema = z.object({
  industry: z.string(),
  reasoning: z.string(),
  publishers: z.array(CandidatePublisherSchema).min(1).max(5),
});

export type CandidatePublisher = z.infer<typeof CandidatePublisherSchema>;
export type SourceDiscoveryProposals = z.infer<typeof SourceDiscoveryProposalsSchema>;

export const CompetitorClassificationSchema = z.enum(["direct", "indirect", "adjacent"]);
export type CompetitorClassification = z.infer<typeof CompetitorClassificationSchema>;

export const ScaleClassificationSchema = z.enum(["comparable", "larger", "smaller", "unknown"]);
export type ScaleClassification = z.infer<typeof ScaleClassificationSchema>;

export const CandidateCompetitorProposalSchema = z.object({
  name: z.string().describe("Company or provider name"),
  website: z.string().describe("Official company website or canonical domain"),
  claimed_market: z.string().describe("Geographic operating market or headquarters"),
  proposed_classification: CompetitorClassificationSchema,
  scale_fit: ScaleClassificationSchema,
  offering_overlap_rationale: z.string().describe("How their products/services specifically overlap with the submitted business"),
  target_customer_rationale: z.string().describe("How their target customers overlap with the submitted business"),
  competitive_rationale: z.string().describe("Why this company is a genuine competitor or strategic benchmark"),
});

export const CompetitorEvidenceRecordSchema = z.object({
  name: z.string(),
  website: z.string(),
  canonical_domain: z.string(),
  classification: CompetitorClassificationSchema,
  scale_classification: ScaleClassificationSchema,
  verification_method: z.enum(["direct_website", "search_grounded"]),
  verification_status: z.enum(["verified", "unverified"]),
  overlap_scores: z.object({
    offering: z.number().min(0).max(1),
    customer: z.number().min(0).max(1),
    geography: z.number().min(0).max(1),
    scale: z.number().min(0).max(1),
    model_pricing: z.number().min(0).max(1),
    composite_score: z.number().min(0).max(1),
  }),
  competitive_rationale: z.string(),
  verified_facts: z.array(z.string()),
  inferred_judgments: z.array(z.string()),
  supporting_evidence_urls: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  unknowns: z.array(z.string()),
  last_verified_at: z.string(),
});

export type CandidateCompetitorProposal = z.infer<typeof CandidateCompetitorProposalSchema>;
export type CompetitorEvidenceRecord = z.infer<typeof CompetitorEvidenceRecordSchema>;

export const CompetitorDiscoveryProposalsSchema = z.object({
  boundary_summary: z.string().describe("Concise summary of the competitive boundary constraints applied"),
  candidates: z.array(CandidateCompetitorProposalSchema).min(1).max(8),
});

export type CompetitorDiscoveryProposals = z.infer<typeof CompetitorDiscoveryProposalsSchema>;
