import {
  RecommendationCardSchema,
  type CreationStepsSchema,
  type MaterialGuideSchema,
  type RecommendationCard,
} from "../schemas.js";
import {
  LegacyRecommendationCardSchema,
  type LegacyRecommendationCard,
} from "./legacy-v1.schema.js";
import { z } from "zod";

export interface NormalizedRecommendationCard {
  schemaVersion: 2;
  title: string;
  category: string;
  what_happened: string;
  why_brand_should_care: string;
  what_to_create: string;
  how_to_create_it: z.infer<typeof CreationStepsSchema>;
  where_to_get_material: Array<z.infer<typeof MaterialGuideSchema>>;
  what_to_communicate: string;
  when_to_publish: {
    urgency: "urgent" | "this_week" | "flexible";
    timing_reason: string;
  };
  what_to_verify: {
    india_availability: string;
    who_can_use_it: string;
    facts_and_claims_to_check: string[];
  };
  suggested_platform: string;
  suggested_format: string;
  objective: string;
  evidence: Array<{
    url: string;
    publisher: string;
    published_at: string;
  }>;
  risk: "safe" | "caution" | "blocked";
  evidence_confidence: {
    level: "high" | "medium" | "low";
    score: number;
    factual_basis: string;
  };
  metadata: {
    event_id: string;
    creative_route: string;
    matched_services: string[];
    target_audience_profile?: string;
    core_business_problem?: string;
    opportunity_type?: string;
    critic_verdict: "ACCEPT" | "REVISE" | "REJECT";
    deterministic_evidence_score: number;
    ai_rubric_score: number;
    combined_rank_score: number;
    raw_metadata?: Record<string, unknown>;
  };
}

const KNOWN_METADATA_KEYS = new Set([
  "event_id",
  "creative_route",
  "matched_services",
  "target_audience_profile",
  "target_saas_profile",
  "core_business_problem",
  "saas_business_problem",
  "opportunity_type",
  "critic_verdict",
  "deterministic_evidence_score",
  "ai_rubric_score",
  "combined_rank_score",
]);

/**
 * Normalizes any recommendation payload (legacy V1, active V2, or unversioned historical record)
 * into a single canonical NormalizedRecommendationCard.
 */
export function normalizeRecommendationCard(raw: unknown): NormalizedRecommendationCard {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createFallbackCard("Unparseable Recommendation Payload", raw);
  }

  const record = raw as Record<string, unknown>;
  const isV2 = record.schemaVersion === 2;

  // Extract unknown/extra top-level and metadata fields to preserve historical context
  const rawMetadata: Record<string, unknown> = {};
  const metaObj =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};

  for (const [k, v] of Object.entries(metaObj)) {
    if (!KNOWN_METADATA_KEYS.has(k)) {
      rawMetadata[k] = v;
    }
  }

  if (isV2) {
    const v2Parse = RecommendationCardSchema.safeParse(record);
    if (v2Parse.success) {
      const v2 = v2Parse.data;
      return {
        schemaVersion: 2,
        title: v2.title,
        category: v2.category,
        what_happened: v2.what_happened,
        why_brand_should_care: v2.why_brand_should_care,
        what_to_create: v2.what_to_create,
        how_to_create_it: v2.how_to_create_it,
        where_to_get_material: v2.where_to_get_material,
        what_to_communicate: v2.what_to_communicate,
        when_to_publish: v2.when_to_publish,
        what_to_verify: v2.what_to_verify,
        suggested_platform: v2.suggested_platform,
        suggested_format: v2.suggested_format,
        objective: v2.objective,
        evidence: v2.evidence,
        risk: v2.risk,
        evidence_confidence: v2.evidence_confidence,
        metadata: {
          ...v2.metadata,
          raw_metadata: Object.keys(rawMetadata).length > 0 ? rawMetadata : undefined,
        },
      };
    }
  }

  // Fallback or V1 processing
  const v1Parse = LegacyRecommendationCardSchema.safeParse(record);
  const data = v1Parse.success ? v1Parse.data : (record as Partial<LegacyRecommendationCard>);

  // Precedence rule: canonical V2 property names take precedence over legacy V1 aliases
  const whyBrandShouldCare =
    typeof record.why_brand_should_care === "string" && record.why_brand_should_care.trim()
      ? record.why_brand_should_care
      : typeof record.why_nsp_should_care === "string" && record.why_nsp_should_care.trim()
        ? record.why_nsp_should_care
        : typeof data.what_happened === "string"
          ? data.what_happened
          : "";

  const targetAudienceProfile =
    typeof metaObj.target_audience_profile === "string" && metaObj.target_audience_profile.trim()
      ? metaObj.target_audience_profile
      : typeof metaObj.target_saas_profile === "string" && metaObj.target_saas_profile.trim()
        ? metaObj.target_saas_profile
        : undefined;

  const coreBusinessProblem =
    typeof metaObj.core_business_problem === "string" && metaObj.core_business_problem.trim()
      ? metaObj.core_business_problem
      : typeof metaObj.saas_business_problem === "string" && metaObj.saas_business_problem.trim()
        ? metaObj.saas_business_problem
        : undefined;

  // Preserve legacy opportunity type (e.g. saas_growth_insight) without forced re-mapping
  const oppType =
    typeof metaObj.opportunity_type === "string" && metaObj.opportunity_type.trim()
      ? metaObj.opportunity_type
      : undefined;

  const title = typeof data.title === "string" && data.title.trim() ? data.title : "Untitled Recommendation";
  const category = typeof data.category === "string" && data.category.trim() ? data.category : "General";

  const howToCreate = data.how_to_create_it ?? {
    opening_line: "",
    what_to_show: [],
    on_screen_text: [],
    demonstration_step: "",
    ending_line: "",
  };

  const whenToPublish = data.when_to_publish ?? {
    urgency: "flexible",
    timing_reason: "",
  };

  const whatToVerify = data.what_to_verify ?? {
    india_availability: "",
    who_can_use_it: "",
    facts_and_claims_to_check: [],
  };

  const evidenceConfidence = data.evidence_confidence ?? {
    level: "medium",
    score: 0.5,
    factual_basis: "Historical record",
  };

  return {
    schemaVersion: 2,
    title,
    category,
    what_happened: typeof data.what_happened === "string" ? data.what_happened : "",
    why_brand_should_care: whyBrandShouldCare,
    what_to_create: typeof data.what_to_create === "string" ? data.what_to_create : "",
    how_to_create_it: {
      opening_line: String(howToCreate.opening_line ?? ""),
      what_to_show: Array.isArray(howToCreate.what_to_show) ? howToCreate.what_to_show.map(String) : [],
      on_screen_text: Array.isArray(howToCreate.on_screen_text) ? howToCreate.on_screen_text.map(String) : [],
      demonstration_step: String(howToCreate.demonstration_step ?? ""),
      ending_line: String(howToCreate.ending_line ?? ""),
    },
    where_to_get_material: Array.isArray(data.where_to_get_material)
      ? data.where_to_get_material.map((m) => ({
          label: String(m.label ?? ""),
          url: String(m.url ?? ""),
          what_to_record_or_screenshot: String(m.what_to_record_or_screenshot ?? ""),
        }))
      : [],
    what_to_communicate: typeof data.what_to_communicate === "string" ? data.what_to_communicate : "",
    when_to_publish: {
      urgency:
        whenToPublish.urgency === "urgent" || whenToPublish.urgency === "this_week" || whenToPublish.urgency === "flexible"
          ? whenToPublish.urgency
          : "flexible",
      timing_reason: String(whenToPublish.timing_reason ?? ""),
    },
    what_to_verify: {
      india_availability: String(whatToVerify.india_availability ?? ""),
      who_can_use_it: String(whatToVerify.who_can_use_it ?? ""),
      facts_and_claims_to_check: Array.isArray(whatToVerify.facts_and_claims_to_check)
        ? whatToVerify.facts_and_claims_to_check.map(String)
        : [],
    },
    suggested_platform: typeof data.suggested_platform === "string" ? data.suggested_platform : "LinkedIn / YouTube",
    suggested_format: typeof data.suggested_format === "string" ? data.suggested_format : "Video",
    objective: typeof data.objective === "string" ? data.objective : "Brand Authority",
    evidence: Array.isArray(data.evidence)
      ? data.evidence.map((e) => ({
          url: String(e.url ?? ""),
          publisher: String(e.publisher ?? ""),
          published_at: String(e.published_at ?? ""),
        }))
      : [],
    risk: data.risk === "caution" || data.risk === "blocked" ? data.risk : "safe",
    evidence_confidence: {
      level: evidenceConfidence.level === "high" || evidenceConfidence.level === "low" ? evidenceConfidence.level : "medium",
      score: typeof evidenceConfidence.score === "number" ? evidenceConfidence.score : 0.5,
      factual_basis: String(evidenceConfidence.factual_basis ?? "Historical record"),
    },
    metadata: {
      event_id: String(metaObj.event_id ?? ""),
      creative_route: String(metaObj.creative_route ?? ""),
      matched_services: Array.isArray(metaObj.matched_services) ? metaObj.matched_services.map(String) : [],
      target_audience_profile: targetAudienceProfile,
      core_business_problem: coreBusinessProblem,
      opportunity_type: oppType,
      critic_verdict:
        metaObj.critic_verdict === "REVISE" || metaObj.critic_verdict === "REJECT"
          ? metaObj.critic_verdict
          : "ACCEPT",
      deterministic_evidence_score:
        typeof metaObj.deterministic_evidence_score === "number" ? metaObj.deterministic_evidence_score : 0.5,
      ai_rubric_score: typeof metaObj.ai_rubric_score === "number" ? metaObj.ai_rubric_score : 0.5,
      combined_rank_score: typeof metaObj.combined_rank_score === "number" ? metaObj.combined_rank_score : 0.5,
      raw_metadata: Object.keys(rawMetadata).length > 0 ? rawMetadata : undefined,
    },
  };
}

export function normalizeRecommendationBatch(rawList: unknown[]): NormalizedRecommendationCard[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(normalizeRecommendationCard);
}

function createFallbackCard(title: string, raw: unknown): NormalizedRecommendationCard {
  return {
    schemaVersion: 2,
    title,
    category: "General",
    what_happened: "Corrupted or non-standard recommendation payload.",
    why_brand_should_care: "Historical record requires human inspection.",
    what_to_create: "Review raw record in database.",
    how_to_create_it: {
      opening_line: "",
      what_to_show: [],
      on_screen_text: [],
      demonstration_step: "",
      ending_line: "",
    },
    where_to_get_material: [],
    what_to_communicate: "",
    when_to_publish: { urgency: "flexible", timing_reason: "Review required" },
    what_to_verify: { india_availability: "Unknown", who_can_use_it: "Internal", facts_and_claims_to_check: [] },
    suggested_platform: "Internal",
    suggested_format: "Note",
    objective: "Audit",
    evidence: [],
    risk: "caution",
    evidence_confidence: { level: "low", score: 0, factual_basis: "Malformed payload" },
    metadata: {
      event_id: "",
      creative_route: "audit",
      matched_services: [],
      critic_verdict: "REJECT",
      deterministic_evidence_score: 0,
      ai_rubric_score: 0,
      combined_rank_score: 0,
      raw_metadata: { malformedPayload: raw },
    },
  };
}

