import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeRecommendationCard,
  normalizeRecommendationBatch,
  type NormalizedRecommendationCard,
} from "../src/ai/compatibility/recommendation-normalizer.js";
import {
  RecommendationCardSchema,
  OpportunityTypeSchema,
  OpportunityMatchSchema,
  CreativeRouteSchema,
} from "../src/ai/schemas.js";

describe("Recommendation Normalizer & Schema Compatibility Suite", () => {
  // Test 1: Existing NSP V1 recommendation with all legacy metadata keys
  it("normalizes a historical NSP V1 record with all legacy keys into canonical format", () => {
    const legacyV1 = {
      title: "How Indian SaaS Companies Can Build AI Search Moats",
      category: "search_industry",
      what_happened: "Google expanded AI Overviews to 100+ countries including India.",
      why_nsp_should_care:
        "Directly impacts NSP's SaaS SEO and GEO citation practices for Indian software clients.",
      what_to_create: "45-second screen walkthrough breakdown",
      how_to_create_it: {
        opening_line: '"If your SaaS relies on traditional rank tracking, you are already losing pipeline."',
        what_to_show: ["Show traditional SERP vs AI Overview citation", "Show citation gap analysis"],
        on_screen_text: ["Traditional SERPs are shrinking", "GEO citations drive 3x conversion"],
        demonstration_step: "Inspect an AI Overview citation source in real-time.",
        ending_line: "Start tracking citations today.",
      },
      where_to_get_material: [
        {
          label: "Google Blog",
          url: "https://blog.google/products/search/ai-overviews-expansion/",
          what_to_record_or_screenshot: "Screenshot the country rollout announcement.",
        },
      ],
      what_to_communicate: "Walk through how AI search fundamentally shifts software distribution.",
      when_to_publish: {
        urgency: "urgent",
        timing_reason: "Feature just rolled out in India.",
      },
      what_to_verify: {
        india_availability: "Available in India",
        who_can_use_it: "All users in India",
        facts_and_claims_to_check: ["Verify mobile vs desktop rollout"],
      },
      suggested_platform: "LinkedIn Video",
      suggested_format: "Walkthrough Video",
      objective: "Thought Leadership",
      evidence: [
        {
          url: "https://blog.google/products/search/ai-overviews-expansion/",
          publisher: "Google Official Blog",
          published_at: "2024-10-28T00:00:00Z",
        },
      ],
      risk: "safe",
      evidence_confidence: {
        level: "high",
        score: 0.9,
        factual_basis: "Official Google announcement",
      },
      metadata: {
        event_id: "evt_2024-10-28_google_ai_search",
        creative_route: "teardown_analysis",
        matched_services: ["b2b-saas-seo-growth", "geo-aeo-ai-search"],
        target_saas_profile: "B2B SaaS companies with inbound organic models",
        saas_business_problem: "Loss of organic pipeline to zero-click AI summaries",
        opportunity_type: "saas_growth_insight",
        critic_verdict: "ACCEPT",
        deterministic_evidence_score: 0.88,
        ai_rubric_score: 0.92,
        combined_rank_score: 0.895,
      },
    };

    const normalized = normalizeRecommendationCard(legacyV1);

    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.title, legacyV1.title);
    assert.equal(normalized.why_brand_should_care, legacyV1.why_nsp_should_care);
    assert.equal(normalized.metadata.target_audience_profile, "B2B SaaS companies with inbound organic models");
    assert.equal(normalized.metadata.core_business_problem, "Loss of organic pipeline to zero-click AI summaries");
    assert.equal(normalized.metadata.opportunity_type, "saas_growth_insight");
    assert.equal(normalized.metadata.critic_verdict, "ACCEPT");
  });

  // Test 2: New V2 non-SaaS recommendation
  it("validates and accepts a pure V2 non-SaaS recommendation payload", () => {
    const v2Card = {
      schemaVersion: 2 as const,
      title: "Rising Arabica Green Coffee Spot Rates: Defending Roaster Margins",
      category: "Industry and business developments" as const,
      what_happened: "ICE Arabica coffee futures hit 13-year highs following severe Brazilian drought.",
      why_brand_should_care:
        "Specialty roasters face 35% cost-of-goods increases; our sourcing transparency builds pricing power.",
      what_to_create: "60-second origin breakdown video",
      how_to_create_it: {
        opening_line: '"Why your favorite single-origin espresso is about to get more expensive."',
        what_to_show: ["Chart of ICE Arabica futures", "Direct trade farm contract comparison"],
        on_screen_text: ["Green coffee +35% YoY", "Direct trade buffers farmgate volatility"],
        demonstration_step: "Show a cost-per-cup unit economics breakdown.",
        ending_line: "Drink better coffee while supporting origin farmers.",
      },
      where_to_get_material: [
        {
          label: "Reuters Commodities",
          url: "https://www.reuters.com/markets/commodities/coffee-prices-surge-2024/",
          what_to_record_or_screenshot: "Show the ICE coffee price chart.",
        },
      ],
      what_to_communicate: "Explain green coffee commodity pricing vs direct trade specialty coffee stability.",
      when_to_publish: {
        urgency: "urgent" as const,
        timing_reason: "Spot rates spiked this week.",
      },
      what_to_verify: {
        india_availability: "Global market impact",
        who_can_use_it: "All specialty coffee roasters and cafe operators",
        facts_and_claims_to_check: ["Confirm current spot price vs 2023 baseline"],
      },
      suggested_platform: "Instagram Reels / YouTube Shorts",
      suggested_format: "Educational Breakdown Reel",
      objective: "Customer Education & Brand Trust",
      evidence: [
        {
          url: "https://www.reuters.com/markets/commodities/coffee-prices-surge-2024/",
          publisher: "Reuters",
          published_at: "2024-11-01T00:00:00Z",
        },
      ],
      risk: "safe" as const,
      evidence_confidence: {
        level: "high" as const,
        score: 0.95,
        factual_basis: "Reuters commodities pricing and ICE exchange data",
      },
      metadata: {
        event_id: "evt_2024-11-01_arabica_surge",
        creative_route: "growth_and_unit_economics",
        matched_services: ["specialty-roasting", "direct-trade-sourcing"],
        target_audience_profile: "Specialty coffee roasters and discerning retail consumers",
        core_business_problem: "Severe margin compression from wholesale green bean price shocks",
        opportunity_type: "growth_and_unit_economics" as const,
        critic_verdict: "ACCEPT" as const,
        deterministic_evidence_score: 0.92,
        ai_rubric_score: 0.94,
        combined_rank_score: 0.931,
      },
    };

    const parsed = RecommendationCardSchema.safeParse(v2Card);
    assert.equal(parsed.success, true);

    const normalized = normalizeRecommendationCard(v2Card);
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.why_brand_should_care, v2Card.why_brand_should_care);
    assert.equal(normalized.metadata.target_audience_profile, v2Card.metadata.target_audience_profile);
    assert.equal(normalized.metadata.core_business_problem, v2Card.metadata.core_business_problem);
    assert.equal(normalized.metadata.opportunity_type, "growth_and_unit_economics");
  });

  // Test 3: V1 record without schemaVersion
  it("treats records missing schemaVersion as legacy V1 and normalizes cleanly", () => {
    const unversioned = {
      title: "AI Overviews Update",
      category: "search_web",
      what_happened: "New search update rolled out.",
      why_nsp_should_care: "Affects agency SEO offerings.",
      metadata: {
        event_id: "evt_unversioned_1",
        creative_route: "breakdown",
        matched_services: ["seo"],
        target_saas_profile: "Mid-market SaaS",
        saas_business_problem: "High CAC",
        opportunity_type: "saas_growth_insight",
      },
    };

    const normalized = normalizeRecommendationCard(unversioned);

    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.why_brand_should_care, "Affects agency SEO offerings.");
    assert.equal(normalized.metadata.target_audience_profile, "Mid-market SaaS");
    assert.equal(normalized.metadata.core_business_problem, "High CAC");
    assert.equal(normalized.metadata.opportunity_type, "saas_growth_insight");
  });

  // Test 4: V2 record with schemaVersion 2
  it("preserves explicit schemaVersion 2 payloads without data corruption", () => {
    const v2Payload = {
      schemaVersion: 2,
      title: "Panama Canal Drought Surcharges on Container Freight",
      category: "business_startups",
      what_happened: "Transit restrictions increased slot auction rates by 40%.",
      why_brand_should_care: "Shifts freight forwarder route margins toward intermodal rail alternatives.",
      what_to_create: "Visual explainer carousel",
      how_to_create_it: {
        opening_line: '"Why maritime shipping rates just jumped 40% overnight."',
        what_to_show: ["Panama lake water level graph", "Transit queue map"],
        on_screen_text: ["Panama daily transits cut to 24", "Rail alternatives save 6 days"],
        demonstration_step: "Compare cost per FEU across ocean vs rail routing.",
        ending_line: "Diversify your multimodal freight routing before peak season.",
      },
      where_to_get_material: [{ label: "Port Tech", url: "https://example.com/panama", what_to_record_or_screenshot: "Queue" }],
      what_to_communicate: "Provide shippers with alternatives to avoid port congestion demurrage.",
      when_to_publish: { urgency: "urgent" as const, timing_reason: "Immediate rate surge" },
      what_to_verify: { india_availability: "Global logistics", who_can_use_it: "Freight brokers", facts_and_claims_to_check: [] },
      suggested_platform: "LinkedIn",
      suggested_format: "Carousel",
      objective: "Lead Generation",
      evidence: [{ url: "https://example.com/panama", publisher: "FreightWave", published_at: "2024-11-05T00:00:00Z" }],
      risk: "safe" as const,
      evidence_confidence: { level: "high" as const, score: 0.9, factual_basis: "Official canal authority" },
      metadata: {
        event_id: "evt_panama_2024",
        creative_route: "practical_framework",
        matched_services: ["freight-forwarding", "customs-brokerage"],
        target_audience_profile: "Import/Export Cargo Shippers and 3PL Providers",
        core_business_problem: "Unexpected demurrage and container transit delays",
        opportunity_type: "practical_framework" as const,
        critic_verdict: "ACCEPT" as const,
        deterministic_evidence_score: 0.9,
        ai_rubric_score: 0.88,
        combined_rank_score: 0.89,
      },
    };

    const normalized = normalizeRecommendationCard(v2Payload);
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.metadata.core_business_problem, "Unexpected demurrage and container transit delays");
    assert.equal(normalized.metadata.target_audience_profile, "Import/Export Cargo Shippers and 3PL Providers");
  });

  // Test 5: Both old and new aliases present: canonical precedence
  it("enforces canonical V2 field precedence when both legacy and canonical keys coexist", () => {
    const mixedPayload = {
      schemaVersion: 2,
      title: "Mixed Aliases Record",
      category: "ai_tech",
      what_happened: "Test event",
      why_brand_should_care: "CANONICAL BRAND REASON",
      why_nsp_should_care: "OLD LEGACY NSP REASON",
      metadata: {
        event_id: "evt_mixed_1",
        creative_route: "test",
        matched_services: ["test"],
        target_audience_profile: "CANONICAL AUDIENCE",
        target_saas_profile: "OLD LEGACY SAAS AUDIENCE",
        core_business_problem: "CANONICAL PROBLEM",
        saas_business_problem: "OLD LEGACY SAAS PROBLEM",
      },
    };

    const normalized = normalizeRecommendationCard(mixedPayload);

    assert.equal(normalized.why_brand_should_care, "CANONICAL BRAND REASON");
    assert.equal(normalized.metadata.target_audience_profile, "CANONICAL AUDIENCE");
    assert.equal(normalized.metadata.core_business_problem, "CANONICAL PROBLEM");
  });

  // Test 6: Legacy saas_growth_insight preserved without forced incorrect mapping
  it("preserves legacy saas_growth_insight as a valid category without forced conversion", () => {
    const legacyRecord = {
      title: "PLG Churn Dynamics",
      category: "business_startups",
      why_nsp_should_care: "NSP client retention advisory",
      metadata: {
        event_id: "evt_churn_1",
        creative_route: "saas_insight",
        matched_services: ["cro"],
        opportunity_type: "saas_growth_insight",
      },
    };

    const normalized = normalizeRecommendationCard(legacyRecord);

    assert.equal(normalized.metadata.opportunity_type, "saas_growth_insight");
    // Verify it did not blindly convert to growth_and_unit_economics
    assert.notEqual(normalized.metadata.opportunity_type, "growth_and_unit_economics");
  });

  // Test 7: Malformed historical optional metadata does not crash dashboard rendering
  it("handles malformed or missing optional metadata gracefully without throwing", () => {
    const malformedPayloads = [
      null,
      undefined,
      "not an object",
      12345,
      [],
      {},
      { title: null, metadata: "corrupted_string" },
      { title: 42, metadata: { target_saas_profile: null, combined_rank_score: "not_a_number" } },
    ];

    for (const bad of malformedPayloads) {
      assert.doesNotThrow(() => {
        const res = normalizeRecommendationCard(bad);
        assert.equal(typeof res.title, "string");
        assert.equal(typeof res.why_brand_should_care, "string");
        assert.equal(typeof res.metadata, "object");
        assert.equal(res.schemaVersion, 2);
      });
    }

    const batch = normalizeRecommendationBatch(malformedPayloads);
    assert.equal(batch.length, malformedPayloads.length);
  });

  // Test 8: Unknown legacy metadata preservation
  it("preserves unrecognized legacy metadata fields inside raw_metadata", () => {
    const legacyWithCustomFields = {
      title: "Historical Deep Dive",
      category: "search_web",
      why_nsp_should_care: "Legacy reasons",
      metadata: {
        event_id: "evt_custom_1",
        creative_route: "custom",
        matched_services: ["service_a"],
        target_saas_profile: "Enterprise SaaS",
        saas_business_problem: "Legacy Churn",
        // Unknown legacy extra keys
        internal_reviewer_score: 9.4,
        historical_cohort_tag: "q3_2024_beta",
        legacy_crm_campaign_id: "CAMP-90210",
      },
    };

    const normalized = normalizeRecommendationCard(legacyWithCustomFields);

    assert.equal(normalized.metadata.raw_metadata?.internal_reviewer_score, 9.4);
    assert.equal(normalized.metadata.raw_metadata?.historical_cohort_tag, "q3_2024_beta");
    assert.equal(normalized.metadata.raw_metadata?.legacy_crm_campaign_id, "CAMP-90210");
  });

  // Test 9: Prompt files do not emit legacy NSP/SaaS property names
  it("verifies that active prompt files do not instruct the AI to emit legacy property names", async () => {
    const promptFiles = ["matching.md", "ideation.md", "critic.md", "market-scan.md"];
    const legacyDisallowedTokens = [
      "`why_nsp_should_care`",
      "`target_saas_profile`",
      "`saas_business_problem`",
      "`trending_in_nsp_sectors`",
    ];

    for (const file of promptFiles) {
      const filePath = path.resolve("src", "ai", "prompts", file);
      const content = await readFile(filePath, "utf8");

      for (const disallowed of legacyDisallowedTokens) {
        assert.equal(
          content.includes(disallowed),
          false,
          `Prompt ${file} should not contain legacy property name ${disallowed}`,
        );
      }
    }
  });

  // Test 10: All new business categories generate valid V2 recommendation payloads
  it("verifies that multiple diverse industry profiles validate against canonical V2 schemas", () => {
    const testIndustries = [
      {
        industry: "B2B SaaS",
        opportunityType: "growth_and_unit_economics" as const,
        audience: "Early-stage SaaS founders",
        problem: "Customer onboarding churn before Day 14",
      },
      {
        industry: "D2C Food & Beverage",
        opportunityType: "timely_market_shift" as const,
        audience: "Artisanal food manufacturers and D2C brands",
        problem: "New FSSAI labeling compliance deadlines for packaged goods",
      },
      {
        industry: "Freight Logistics & Supply Chain",
        opportunityType: "practical_framework" as const,
        audience: "Intermodal freight forwarders and shippers",
        problem: "Container demurrage penalties from port congestion",
      },
      {
        industry: "Healthcare & Telemedicine",
        opportunityType: "educational_problem_solver" as const,
        audience: "Clinical practice managers and digital health providers",
        problem: "Patient drop-off during remote asynchronous intake",
      },
    ];

    for (const t of testIndustries) {
      const matchResult = OpportunityMatchSchema.safeParse({
        event_id: `evt_industry_${t.industry.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        opportunity_status: "ACCEPT",
        opportunity_type: t.opportunityType,
        matched_services: ["core_service_1"],
        matched_audiences: [t.audience],
        target_audience_profile: t.audience,
        core_business_problem: t.problem,
        opportunity_reason: `Highly timely development in ${t.industry}.`,
        distinctive_angle: `Direct operational playbook for ${t.audience}.`,
        saturation_notes: "Low saturation in current content ecosystem.",
        rejection_reason: null,
        unresolved_unknowns: [],
      });

      assert.equal(matchResult.success, true, `OpportunityMatch failed for ${t.industry}`);

      const creativeResult = CreativeRouteSchema.safeParse({
        route: "operational_walkthrough",
        concept_title: `Actionable Strategy for ${t.industry}`,
        plain_what_happened: "A key regulatory or operational update occurred.",
        why_brand_should_care: `Enables our brand to position our services directly addressing ${t.problem}.`,
        what_to_create: "45-second tactical video breakdown",
        how_to_create_it: {
          opening_line: '"If your team is facing this issue, here is the exact fix."',
          what_to_show: ["Show the root cause", "Walk through the resolution"],
          on_screen_text: ["Step 1: Diagnose", "Step 2: Implement"],
          demonstration_step: "Show the actual workflow step on screen.",
          ending_line: "Implement this protocol before the end of the quarter.",
        },
        where_to_get_material: [
          {
            label: "Official Regulation Portal",
            url: "https://example.com/regulatory-update",
            what_to_record_or_screenshot: "Show the official notification page.",
          },
        ],
        what_to_communicate: `Script explaining how ${t.audience} can solve ${t.problem}.`,
        when_to_publish: { urgency: "this_week", timing_reason: "Immediate relevance" },
        facts_and_claims_to_check: ["Verify compliance deadlines"],
        suggested_platform: "LinkedIn / YouTube",
        suggested_format: "Walkthrough Video",
        objective: "Authority & Lead Generation",
      });

      assert.equal(creativeResult.success, true, `CreativeRoute failed for ${t.industry}`);
    }
  });
});
