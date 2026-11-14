import { z } from "zod";

export const LegacyOpportunityTypeSchema = z.enum([
  "timely_market_shift",
  "saas_growth_insight",
  "practical_framework",
  "educational_problem_solver",
  "thought_leadership",
  "case_proof",
]);

export type LegacyOpportunityType = z.infer<typeof LegacyOpportunityTypeSchema>;

export const LegacyRecommendationCardSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    title: z.string().default("Untitled Recommendation"),
    category: z.string().default("General"),
    what_happened: z.string().default(""),
    why_nsp_should_care: z.string().optional(),
    why_brand_should_care: z.string().optional(),
    what_to_create: z.string().default(""),
    how_to_create_it: z
      .object({
        opening_line: z.string().default(""),
        what_to_show: z.array(z.string()).default([]),
        on_screen_text: z.array(z.string()).default([]),
        demonstration_step: z.string().default(""),
        ending_line: z.string().default(""),
      })
      .default({
        opening_line: "",
        what_to_show: [],
        on_screen_text: [],
        demonstration_step: "",
        ending_line: "",
      }),
    where_to_get_material: z
      .array(
        z.object({
          label: z.string().default(""),
          url: z.string().default(""),
          what_to_record_or_screenshot: z.string().default(""),
        }),
      )
      .default([]),
    what_to_communicate: z.string().default(""),
    when_to_publish: z
      .object({
        urgency: z.enum(["urgent", "this_week", "flexible"]).default("flexible"),
        timing_reason: z.string().default(""),
      })
      .default({ urgency: "flexible", timing_reason: "" }),
    what_to_verify: z
      .object({
        india_availability: z.string().default(""),
        who_can_use_it: z.string().default(""),
        facts_and_claims_to_check: z.array(z.string()).default([]),
      })
      .default({
        india_availability: "",
        who_can_use_it: "",
        facts_and_claims_to_check: [],
      }),
    suggested_platform: z.string().default("LinkedIn / YouTube"),
    suggested_format: z.string().default("Video"),
    objective: z.string().default("Brand Authority"),
    evidence: z
      .array(
        z.object({
          url: z.string().default(""),
          publisher: z.string().default(""),
          published_at: z.string().default(""),
        }),
      )
      .default([]),
    risk: z.enum(["safe", "caution", "blocked"]).default("safe"),
    evidence_confidence: z
      .object({
        level: z.enum(["high", "medium", "low"]).default("medium"),
        score: z.number().default(0.5),
        factual_basis: z.string().default("Historical record"),
      })
      .default({
        level: "medium",
        score: 0.5,
        factual_basis: "Historical record",
      }),
    metadata: z
      .object({
        event_id: z.string().default(""),
        creative_route: z.string().default(""),
        matched_services: z.array(z.string()).default([]),
        target_saas_profile: z.string().optional(),
        saas_business_problem: z.string().optional(),
        target_audience_profile: z.string().optional(),
        core_business_problem: z.string().optional(),
        opportunity_type: z.string().optional(),
        critic_verdict: z.enum(["ACCEPT", "REVISE", "REJECT"]).default("ACCEPT"),
        deterministic_evidence_score: z.number().default(0.5),
        ai_rubric_score: z.number().default(0.5),
        combined_rank_score: z.number().default(0.5),
      })
      .passthrough()
      .default({
        event_id: "",
        creative_route: "",
        matched_services: [],
        critic_verdict: "ACCEPT",
        deterministic_evidence_score: 0.5,
        ai_rubric_score: 0.5,
        combined_rank_score: 0.5,
      }),
  })
  .passthrough();

export type LegacyRecommendationCard = z.infer<typeof LegacyRecommendationCardSchema>;

