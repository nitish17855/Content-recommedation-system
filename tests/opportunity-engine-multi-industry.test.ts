import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpportunityMatchSchema,
  CreativeIdeationSchema,
  CriticBatchOutputSchema,
  RecommendationCardSchema,
  type ContextPack,
  type OpportunityMatch,
  type CreativeIdeation,
  type CriticBatchOutput,
  type EventCluster,
} from "../src/ai/schemas.js";
import { rankAndSelectRecommendations, type EvaluatedCandidate } from "../src/pipeline/ranking.js";
import { normalizeRecommendationCard } from "../src/ai/compatibility/recommendation-normalizer.js";

function makeContextPack(
  id: string,
  title: string,
  summary: string,
  url: string,
  publisher: string,
): ContextPack {
  return {
    event_id: id,
    discovery_category: "Industry and business developments",
    event_title: title,
    event_summary: summary,
    event_type: "other",
    event_status: "active",
    occurred_at: "2024-11-10T00:00:00Z",
    first_seen_at: "2024-11-10T00:00:00Z",
    last_seen_at: "2024-11-10T00:00:00Z",
    geography: {
      primary: "Global",
      relevance: "high",
      reason: "Global market impact",
    },
    india_availability: {
      status: "available_in_india",
      who_can_use_it: "All companies in target sector",
      restrictions_or_eligibility: "Standard enterprise compliance",
    },
    why_it_matters: "Direct operational and financial impact on industry unit economics.",
    participating_entities: [publisher],
    affected_audiences: ["Business decision makers"],
    audience_problems: ["Cost inflation", "Process latency"],
    audience_reactions: ["Seeking alternatives"],
    trend_phase: "emerging",
    estimated_lifespan: "12-24 months",
    potential_service_tags: ["core-service"],
    evidence: [
      {
        evidence_id: "ev_1",
        url,
        publisher,
        published_at: "2024-11-10T00:00:00Z",
        source_type: "trade_publication",
        supports: "Factual record of price or regulatory change",
      },
    ],
    contradictions: [],
    unknowns: [],
    sensitivity: "low",
    confidence_basis: ["Verified trade publisher"],
  };
}

function makeClusterForPack(pack: ContextPack): EventCluster {
  return {
    event_id: pack.event_id,
    cluster_title: pack.event_title,
    signal_ids: ["sig_1"],
    signals: [
      {
        signal_id: "sig_1",
        source_id: "trade-feed",
        title: pack.event_title,
        url: pack.evidence[0]!.url,
        publisher: pack.evidence[0]!.publisher,
        published_at: pack.evidence[0]!.published_at,
        fetched_at: pack.evidence[0]!.published_at,
        source_type: "official_platform",
        country_relevance: "Global",
        excerpt: pack.event_summary,
        content_hash: `hash_${pack.event_id}`,
        keywords: ["industry", "market", "pricing"],
        summary: null,
      },
    ],
    first_seen_at: pack.first_seen_at!,
    last_seen_at: pack.last_seen_at!,
    independent_source_count: 2,
    source_diversity: 2,
    country_relevance: "Global",
    keywords: ["industry", "market", "pricing"],
    status: "active",
  };
}

describe("Multi-Industry Opportunity Engine & Recommendation Pipeline Suite", () => {
  const now = new Date();

  // Test 1: Vertical A - B2B SaaS Growth & SEO
  it("processes and ranks opportunities for B2B SaaS vertical using universal archetypes", () => {
    const pack = makeContextPack(
      "evt_saas_geo",
      "Google Rolls Out AI Overviews Globally for Software Search",
      "Traditional search engine result pages give way to synthesized AI summaries with zero-click citations.",
      "https://example.com/ai-search-saas",
      "Search Engine Journal",
    );
    const cluster = makeClusterForPack(pack);

    const opportunity: OpportunityMatch = {
      event_id: pack.event_id,
      opportunity_status: "ACCEPT",
      opportunity_type: "growth_and_unit_economics",
      matched_services: ["b2b-saas-seo-growth", "geo-aeo-ai-search"],
      matched_audiences: ["B2B SaaS Founders", "Heads of Growth"],
      target_audience_profile: "Self-serve and hybrid sales-led SaaS companies",
      core_business_problem: "Organic customer acquisition cost (CAC) inflation from zero-click AI search",
      opportunity_reason: "High strategic relevance for SaaS founders facing pipeline contraction.",
      distinctive_angle: "How to engineer authoritative citations inside AI summaries.",
      saturation_notes: "Low competition on GEO playbooks.",
      rejection_reason: null,
      unresolved_unknowns: [],
    };
    assert.equal(OpportunityMatchSchema.safeParse(opportunity).success, true);

    const ideation: CreativeIdeation = {
      event_id: pack.event_id,
      creative_routes: [
        {
          route: "growth_breakdown",
          concept_title: "How B2B SaaS Companies Can Stop AI Search Pipeline Leakage",
          plain_what_happened: "Google expanded AI Overviews, shifting organic clicks away from classic 10 blue links.",
          why_brand_should_care: "Positions our GEO citation optimization service as an immediate defensive moat for client pipeline.",
          what_to_create: "45-second screen recording teardown",
          how_to_create_it: {
            opening_line: '"If your SaaS ranks #1 but your pipeline is down 20%, here is the reason why."',
            what_to_show: ["Classic SERP vs AI Overview citation", "Brand citation gap audit"],
            on_screen_text: ["Classic rank: #1", "AI citation: Missing", "GEO Playbook"],
            demonstration_step: "Inspect an active AI Overview snippet on desktop and check domain citation tags.",
            ending_line: "Audit your GEO citations before next quarter.",
          },
          where_to_get_material: [
            {
              label: "Search Engine Journal",
              url: "https://example.com/ai-search-saas",
              what_to_record_or_screenshot: "Screenshot the citation source block.",
            },
          ],
          what_to_communicate: "Explain why traditional rank tracking no longer correlates directly with demo requests.",
          when_to_publish: { urgency: "urgent", timing_reason: "Feature rolled out globally this week" },
          facts_and_claims_to_check: ["Confirm mobile vs desktop citation frequency"],
          suggested_platform: "LinkedIn Video",
          suggested_format: "Teardown Reel",
          objective: "High-Intent Lead Generation",
        },
      ],
    };
    assert.equal(CreativeIdeationSchema.safeParse(ideation).success, true);

    const critic: CriticBatchOutput = {
      event_id: pack.event_id,
      reviews: [
        {
          route_index: 0,
          verdict: "ACCEPT",
          risk: "SAFE",
          ai_scores: {
            brand_fit: 5,
            audience_relevance: 5,
            creative_usefulness: 5,
            distinctiveness: 4,
            execution_feasibility: 5,
            cultural_appropriateness: 5,
          },
          issues: [],
          required_revisions: [],
          factual_concerns: [],
          final_reason: "High strategic clarity, grounded evidence, and clear visual screen demonstration.",
        },
      ],
    };
    assert.equal(CriticBatchOutputSchema.safeParse(critic).success, true);

    const candidate: EvaluatedCandidate = {
      cluster,
      contextPack: pack,
      opportunity,
      route: ideation.creative_routes[0]!,
      review: critic.reviews[0]!,
    };

    const recommendations = rankAndSelectRecommendations([candidate], now, 1);
    assert.equal(recommendations.length, 1);

    const card = recommendations[0]!;
    assert.equal(card.schemaVersion, 2);
    assert.equal(card.why_brand_should_care, ideation.creative_routes[0]!.why_brand_should_care);
    assert.equal(card.metadata.target_audience_profile, opportunity.target_audience_profile);
    assert.equal(card.metadata.core_business_problem, opportunity.core_business_problem);
    assert.equal(card.metadata.opportunity_type, "growth_and_unit_economics");

    const normalized = normalizeRecommendationCard(card);
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.why_brand_should_care, card.why_brand_should_care);
  });

  // Test 2: Vertical B - D2C Specialty Food & Beverage
  it("processes and ranks opportunities for D2C Coffee vertical using universal archetypes", () => {
    const pack = makeContextPack(
      "evt_coffee_futures",
      "ICE Arabica Coffee Futures Surge 35% on Brazil Crop Deficits",
      "Severe droughts in Minas Gerais reduced yield estimates, pushing green coffee futures to 13-year highs.",
      "https://example.com/coffee-futures-spike",
      "Reuters Commodities",
    );
    const cluster = makeClusterForPack(pack);

    const opportunity: OpportunityMatch = {
      event_id: pack.event_id,
      opportunity_status: "ACCEPT",
      opportunity_type: "timely_market_shift",
      matched_services: ["specialty-roasting", "direct-trade-sourcing"],
      matched_audiences: ["Specialty coffee consumers", "Boutique cafe wholesale buyers"],
      target_audience_profile: "Quality-conscious coffee drinkers and wholesale cafe partners",
      core_business_problem: "Retail customer pushback against upcoming retail bag price increases",
      opportunity_reason: "Timely educational opportunity explaining farmgate green coffee economics.",
      distinctive_angle: "Why direct trade sourcing buffers specialty roasters against global exchange volatility.",
      saturation_notes: "Very low saturation among retail coffee brands.",
      rejection_reason: null,
      unresolved_unknowns: [],
    };
    assert.equal(OpportunityMatchSchema.safeParse(opportunity).success, true);

    const ideation: CreativeIdeation = {
      event_id: pack.event_id,
      creative_routes: [
        {
          route: "market_shift_breakdown",
          concept_title: "Why Your Single-Origin Bag Prices Are Changing This Month",
          plain_what_happened: "Global Arabica futures spiked 35% after the worst drought in Brazilian history.",
          why_brand_should_care: "Establishes pricing transparency and builds brand equity for our direct trade origin contracts.",
          what_to_create: "50-second educational origin reel",
          how_to_create_it: {
            opening_line: '"If you noticed coffee prices creeping up everywhere, here is what is happening at the origin."',
            what_to_show: ["Green unroasted coffee bean sample comparison", "Futures exchange chart vs farmgate contract"],
            on_screen_text: ["Arabica futures: +35%", "Direct trade farmgate price: Protected", "Farm-to-Cup"],
            demonstration_step: "Show a green coffee grading tray and explain how origin contract pricing works.",
            ending_line: "Support direct trade farmers by choosing sustainably sourced specialty beans.",
          },
          where_to_get_material: [
            {
              label: "Reuters Commodities",
              url: "https://example.com/coffee-futures-spike",
              what_to_record_or_screenshot: "Show the ICE exchange price chart.",
            },
          ],
          what_to_communicate: "Educate consumers on commodity coffee vs specialty direct trade pricing mechanics.",
          when_to_publish: { urgency: "urgent", timing_reason: "Futures hit new peak this week" },
          facts_and_claims_to_check: ["Confirm current spot price percentage increase"],
          suggested_platform: "Instagram Reels",
          suggested_format: "Educational Reel",
          objective: "Brand Trust & Transparency",
        },
      ],
    };
    assert.equal(CreativeIdeationSchema.safeParse(ideation).success, true);

    const critic: CriticBatchOutput = {
      event_id: pack.event_id,
      reviews: [
        {
          route_index: 0,
          verdict: "ACCEPT",
          risk: "SAFE",
          ai_scores: {
            brand_fit: 5,
            audience_relevance: 5,
            creative_usefulness: 5,
            distinctiveness: 5,
            execution_feasibility: 5,
            cultural_appropriateness: 5,
          },
          issues: [],
          required_revisions: [],
          factual_concerns: [],
          final_reason: "Exceptional transparency angle grounded in real agricultural commodity data.",
        },
      ],
    };
    assert.equal(CriticBatchOutputSchema.safeParse(critic).success, true);

    const candidate: EvaluatedCandidate = {
      cluster,
      contextPack: pack,
      opportunity,
      route: ideation.creative_routes[0]!,
      review: critic.reviews[0]!,
    };

    const recommendations = rankAndSelectRecommendations([candidate], now, 1);
    assert.equal(recommendations.length, 1);

    const card = recommendations[0]!;
    assert.equal(card.schemaVersion, 2);
    assert.equal(card.why_brand_should_care, ideation.creative_routes[0]!.why_brand_should_care);
    assert.equal(card.metadata.opportunity_type, "timely_market_shift");
    assert.equal(card.metadata.target_audience_profile, opportunity.target_audience_profile);
  });

  // Test 3: Vertical C - Freight Logistics & Supply Chain
  it("processes and ranks opportunities for Freight Logistics vertical using universal archetypes", () => {
    const pack = makeContextPack(
      "evt_freight_demurrage",
      "Major Maritime Hubs Implement 5-Day Demurrage Clock Tightening",
      "Ocean terminal operators reduce free storage time from 7 days to 4 days, sparking massive detention penalties.",
      "https://example.com/demurrage-tightening",
      "Journal of Commerce",
    );
    const cluster = makeClusterForPack(pack);

    const opportunity: OpportunityMatch = {
      event_id: pack.event_id,
      opportunity_status: "ACCEPT",
      opportunity_type: "practical_framework",
      matched_services: ["ocean-freight-forwarding", "customs-brokerage", "intermodal-drayage"],
      matched_audiences: ["Import Shippers", "Logistics Managers"],
      target_audience_profile: "High-volume container importers and industrial manufacturers",
      core_business_problem: "Unexpected terminal demurrage fees averaging $250/day per container",
      opportunity_reason: "Urgent operational problem requiring swift drayage coordination.",
      distinctive_angle: "How pre-clearing customs and booking bonded warehouse drayage saves $15k per shipment.",
      saturation_notes: "High demand for actionable demurrage checklists.",
      rejection_reason: null,
      unresolved_unknowns: [],
    };
    assert.equal(OpportunityMatchSchema.safeParse(opportunity).success, true);

    const ideation: CreativeIdeation = {
      event_id: pack.event_id,
      creative_routes: [
        {
          route: "strategic_framework",
          concept_title: "How Shippers Can Avoid the New 4-Day Demurrage Trap",
          plain_what_happened: "Major ocean terminals cut free dwell days by 40%, catching import supply chains off guard.",
          why_brand_should_care: "Positions our expedited drayage and customs pre-clearance service as an immediate cost-saving solution.",
          what_to_create: "5-slide LinkedIn PDF carousel",
          how_to_create_it: {
            opening_line: '"Your container free-time just dropped by 40%—here is your 48-hour action plan."',
            what_to_show: ["Demurrage cost calculation formula", "Pre-clearance timeline vs standard dwell"],
            on_screen_text: ["Old free time: 7 days", "New free time: 4 days", "Demurrage risk: $250/day"],
            demonstration_step: "Walk through the 3-step electronic pre-filing workflow that clears cargo before vessel discharge.",
            ending_line: "Download our 4-day port dwell checklist.",
          },
          where_to_get_material: [
            {
              label: "Journal of Commerce",
              url: "https://example.com/demurrage-tightening",
              what_to_record_or_screenshot: "Show the terminal free-time rule changes.",
            },
          ],
          what_to_communicate: "Provide supply chain directors with a concrete mitigation workflow.",
          when_to_publish: { urgency: "urgent", timing_reason: "Rule changes take effect next Monday" },
          facts_and_claims_to_check: ["Confirm specific terminal tariff codes"],
          suggested_platform: "LinkedIn Carousel",
          suggested_format: "Carousel",
          objective: "High-Ticket Enterprise Brokerage Leads",
        },
      ],
    };
    assert.equal(CreativeIdeationSchema.safeParse(ideation).success, true);

    const critic: CriticBatchOutput = {
      event_id: pack.event_id,
      reviews: [
        {
          route_index: 0,
          verdict: "ACCEPT",
          risk: "SAFE",
          ai_scores: {
            brand_fit: 5,
            audience_relevance: 5,
            creative_usefulness: 5,
            distinctiveness: 4,
            execution_feasibility: 5,
            cultural_appropriateness: 5,
          },
          issues: [],
          required_revisions: [],
          factual_concerns: [],
          final_reason: "High operational utility and clear, actionable workflow guidance for shippers.",
        },
      ],
    };
    assert.equal(CriticBatchOutputSchema.safeParse(critic).success, true);

    const candidate: EvaluatedCandidate = {
      cluster,
      contextPack: pack,
      opportunity,
      route: ideation.creative_routes[0]!,
      review: critic.reviews[0]!,
    };

    const recommendations = rankAndSelectRecommendations([candidate], now, 1);
    assert.equal(recommendations.length, 1);

    const card = recommendations[0]!;
    assert.equal(card.schemaVersion, 2);
    assert.equal(card.metadata.opportunity_type, "practical_framework");
    assert.equal(card.why_brand_should_care, ideation.creative_routes[0]!.why_brand_should_care);
    assert.equal(card.metadata.core_business_problem, opportunity.core_business_problem);
  });
});

