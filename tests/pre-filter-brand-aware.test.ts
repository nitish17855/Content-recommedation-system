import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EventCluster } from "../src/ai/schemas.js";
import {
  scoreClusterNspV1,
  scoreClusterBrandAwareV2,
  buildBrandPreFilterProfile,
  selectCandidateClusters,
  scoreClusterForPreFilter,
} from "../src/pipeline/pre-filter.js";

function makeCluster(
  id: string,
  title: string,
  excerpt: string,
  keywords: string[] = [],
  countryRelevance = "India",
  sourcesCount = 2,
  ageHours = 12,
): EventCluster {
  const now = new Date();
  const seenAt = new Date(now.getTime() - ageHours * 3600 * 1000).toISOString();
  return {
    event_id: id,
    cluster_title: title,
    signal_ids: ["sig_1"],
    signals: [
      {
        signal_id: "sig_1",
        source_id: "test-source",
        title,
        url: `https://example.com/${id}`,
        publisher: "Industry News",
        published_at: seenAt,
        fetched_at: seenAt,
        source_type: "rss_feed",
        country_relevance: countryRelevance as any,
        excerpt,
        content_hash: `hash_${id}`,
        keywords,
        summary: null,
      },
    ],
    first_seen_at: seenAt,
    last_seen_at: seenAt,
    independent_source_count: sourcesCount,
    source_diversity: sourcesCount,
    country_relevance: countryRelevance as any,
    keywords,
    status: "active",
  };
}

describe("Brand-Aware Pre-Filtering Suite", () => {
  const now = new Date();
  const nowMs = now.getTime();

  // Test 1: NSP legacy scoring parity
  it("preserves exact nsp-v1 legacy scoring parity", () => {
    const cluster = makeCluster(
      "evt_saas_seo",
      "Google Rolls Out AI Overviews Expansion for Enterprise SEO and SaaS",
      "B2B SaaS companies see organic pipeline shift toward GEO and AI search citations with rising CAC on Google Ads.",
      ["saas", "seo", "cac", "pipeline"],
    );

    const legacyScore = scoreClusterNspV1(cluster, nowMs);
    const delegatedScore = scoreClusterForPreFilter(cluster, nowMs, { strategy: "nsp-v1" });

    assert.equal(legacyScore, delegatedScore, "Legacy score and delegated nsp-v1 score must be 100% identical");
    assert.ok(legacyScore >= 60, "SaaS cluster with CAC and SEO should score high in NSP v1");
  });

  // Test 2: SaaS-relevant AI developments score high on brand-aware-v2
  it("scores SaaS-relevant AI developments highly for B2B SaaS profiles", () => {
    const saasProfile = buildBrandPreFilterProfile({
      brandKey: "nsp-india",
      industry: "B2B SaaS Growth & SEO",
      offerings: [
        { name: "B2B SaaS SEO Growth", category: "SEO" },
        { name: "GEO & AI Search Citations", category: "AI Search" },
      ],
      targetAudiences: ["B2B SaaS founders", "Heads of Growth"],
      customerProblems: ["Rising CAC on paid channels", "Loss of organic pipeline to AI search"],
    });

    const aiSearchCluster = makeCluster(
      "evt_ai_search",
      "Google AI Overviews Roll Out in India for SaaS and Tech Searches",
      "Enterprise SEO visibility drops as autonomous agents and AI summaries answer software queries.",
      ["ai", "seo", "saas", "autonomous agent"],
    );

    const score = scoreClusterBrandAwareV2(aiSearchCluster, nowMs, saasProfile);
    assert.ok(score >= 65, `Expected score >= 65 for SaaS brand on AI search development, got ${score}`);
  });

  // Test 3: D2C coffee commodity price developments score high for coffee profile
  it("scores green coffee commodity developments highly for D2C coffee brand", () => {
    const coffeeProfile = buildBrandPreFilterProfile({
      brandKey: "blue-tokai",
      industry: "Food & Beverage",
      subIndustry: "Specialty Coffee Roasting",
      businessModel: "Direct-to-Consumer & Cafes",
      offerings: [
        { name: "Specialty Arabica Roasting", category: "Coffee" },
        { name: "Single-Origin Green Beans", category: "Sourcing" },
      ],
      targetAudiences: ["Specialty coffee lovers", "Artisanal cafes"],
      customerProblems: ["Green bean price volatility", "FSSAI compliance"],
    });

    const coffeeFuturesCluster = makeCluster(
      "evt_coffee_futures",
      "Arabica Coffee Futures Hit 13-Year Highs Following Brazil Drought",
      "Specialty coffee roasters face severe wholesale green coffee bean cost surges and freight surcharges.",
      ["arabica", "coffee futures", "freight", "green coffee"],
    );

    const score = scoreClusterBrandAwareV2(coffeeFuturesCluster, nowMs, coffeeProfile);
    assert.ok(score >= 65, `Expected score >= 65 for Coffee brand on Arabica futures spike, got ${score}`);
  });

  // Test 4: Logistics port congestion developments score high for logistics profile
  it("scores maritime port congestion developments highly for freight logistics brand", () => {
    const logisticsProfile = buildBrandPreFilterProfile({
      brandKey: "flexport",
      industry: "Logistics & Supply Chain",
      subIndustry: "Freight Forwarding",
      businessModel: "Digital Freight Forwarder",
      offerings: [
        { name: "Ocean Freight Forwarding", category: "Logistics" },
        { name: "Customs Clearance & Brokerage", category: "Customs" },
      ],
      targetAudiences: ["Import/export cargo shippers", "Supply chain directors"],
      customerProblems: ["Port congestion demurrage fees", "Container transit delays"],
    });

    const portCongestionCluster = makeCluster(
      "evt_port_congestion",
      "Global Port Congestion Spikes Container Demurrage and Detention Fees",
      "Maritime carriers issue emergency container freight surcharges as terminal wait times exceed 10 days.",
      ["port congestion", "demurrage", "container freight"],
    );

    const score = scoreClusterBrandAwareV2(portCongestionCluster, nowMs, logisticsProfile);
    assert.ok(score >= 65, `Expected score >= 65 for Logistics brand on port demurrage, got ${score}`);
  });

  // Test 5: Healthcare regulatory changes score high for healthcare profile
  it("scores health regulatory developments highly for healthcare telemedicine brand", () => {
    const healthProfile = buildBrandPreFilterProfile({
      brandKey: "health-plus",
      industry: "Healthcare & Telemedicine",
      subIndustry: "Digital Clinical Care",
      businessModel: "Telehealth Services",
      offerings: [
        { name: "Virtual Doctor Consultations", category: "Telehealth" },
        { name: "HIPAA Compliant Remote Intake", category: "Clinical" },
      ],
      targetAudiences: ["Patients", "Clinical practitioners"],
      customerProblems: ["HIPAA compliance risks", "Patient onboarding friction"],
    });

    const healthRegCluster = makeCluster(
      "evt_telehealth_reg",
      "New Telehealth Statutory Compliance Rules Enacted for Remote Intake",
      "Government issues mandatory clinical data privacy guidelines for asynchronous patient triage.",
      ["telehealth", "compliance", "hipaa", "statutory compliance"],
    );

    const score = scoreClusterBrandAwareV2(healthRegCluster, nowMs, healthProfile);
    assert.ok(score >= 65, `Expected score >= 65 for Healthcare brand on telehealth compliance, got ${score}`);
  });

  // Test 6: Broad market changes without exact brand keyword matches survive soft penalty
  it("allows credible high-impact cross-industry events to survive without exact brand keywords", () => {
    const coffeeProfile = buildBrandPreFilterProfile({
      brandKey: "specialty-roast",
      industry: "Food & Beverage",
      offerings: [{ name: "Espresso Blends" }],
    });

    // Global shipping crisis that impacts imports but doesn't mention the brand's exact "Espresso Blends"
    const shippingCrisisCluster = makeCluster(
      "evt_shipping_crisis",
      "Panama Canal Drought Surcharges Cause Container Demurrage Across Maritime Fleets",
      "Ocean carriers impose heavy demurrage fees and container freight delays across import routes.",
      ["container freight", "demurrage", "shipping rates"],
    );

    const score = scoreClusterBrandAwareV2(shippingCrisisCluster, nowMs, coffeeProfile);
    // Since coffee has high supply-chain sensitivity, cross-industry relevance is high (>=40)
    // It should receive only the mild -8 soft penalty rather than the harsh -18 or drop below 15
    assert.ok(
      score >= 20,
      `High-impact supply chain event must survive for coffee importer (score: ${score} >= 20)`,
    );
  });

  // Test 7: Generic AI news does not overwhelm non-AI brands
  it("moderates generic AI news for non-tech physical brands to prevent candidate flood", () => {
    const coffeeProfile = buildBrandPreFilterProfile({
      brandKey: "specialty-roast",
      industry: "Food & Beverage",
      offerings: [{ name: "Espresso Blends" }],
    });

    const genericAiCluster = makeCluster(
      "evt_generic_ai",
      "Anthropic Releases Claude 3.5 Sonnet Coding Model",
      "The new large language model achieves state of the art results on Python coding and SWE-bench.",
      ["anthropic", "llm", "claude"],
    );

    const score = scoreClusterBrandAwareV2(genericAiCluster, nowMs, coffeeProfile);
    // Coffee brand has low AI sensitivity (0.15 multiplier) and 0 brand matches
    assert.ok(score < 30, `Generic AI coding model should receive low score (${score} < 30) for coffee brand`);
  });

  // Test 8: Irrelevant consumer noise is penalized heavily
  it("heavily penalizes irrelevant consumer noise", () => {
    const saasProfile = buildBrandPreFilterProfile({
      brandKey: "nsp-india",
      industry: "B2B SaaS Growth & SEO",
      offerings: [{ name: "SaaS SEO" }],
    });

    const noiseCluster = makeCluster(
      "evt_noise_cricket",
      "India vs Australia Cricket Match Score and Highlights",
      "Celebrity actor attends stadium as box office hits new peak record in movie collections.",
      ["cricket", "celebrity", "box office"],
    );

    const score = scoreClusterBrandAwareV2(noiseCluster, nowMs, saasProfile);
    assert.ok(score < 15, `Consumer noise score (${score}) must be below 15 threshold`);
  });

  // Test 9: Controlled synonym expansion injects verified domain terms
  it("automatically expands domain synonyms during profile creation", () => {
    const logisticsProfile = buildBrandPreFilterProfile({
      brandKey: "test_3pl",
      industry: "Cold-chain Logistics",
      offerings: [{ name: "Refrigerated Sourcing" }],
    });

    const keywordTerms = logisticsProfile.keywords.map((k) => k.term);
    assert.ok(keywordTerms.includes("demurrage"), "Expected 'demurrage' from logistics synonyms");
    assert.ok(keywordTerms.includes("cold chain"), "Expected 'cold chain' from logistics synonyms");
    assert.ok(keywordTerms.includes("intermodal"), "Expected 'intermodal' from logistics synonyms");
  });

  // Test 10: Same event evaluated against different brand profiles yields divergent scores
  it("evaluates the exact same event with divergent scores across different brand profiles", () => {
    const coffeeProfile = buildBrandPreFilterProfile({
      brandKey: "coffee_co",
      industry: "Food & Beverage",
      subIndustry: "Specialty Coffee Roasting",
      offerings: [{ name: "Arabica Roasting" }],
    });

    const saasProfile = buildBrandPreFilterProfile({
      brandKey: "saas_co",
      industry: "B2B Enterprise Software",
      offerings: [{ name: "Cloud Analytics" }],
    });

    const coffeeEvent = makeCluster(
      "evt_coffee_drought",
      "Brazil Drought Surges Arabica Coffee Futures by 30%",
      "Wholesale green coffee bean prices skyrocket as roaster operating margins collapse.",
      ["arabica", "coffee futures", "green coffee"],
    );

    const coffeeScore = scoreClusterBrandAwareV2(coffeeEvent, nowMs, coffeeProfile);
    const saasScore = scoreClusterBrandAwareV2(coffeeEvent, nowMs, saasProfile);

    assert.ok(
      coffeeScore > saasScore + 35,
      `Coffee score (${coffeeScore}) must be vastly higher than SaaS score (${saasScore}) on coffee event`,
    );
  });

  // Test 11: Score normalization and caps
  it("guarantees scores are normalized and never exceed 100", () => {
    const saasProfile = buildBrandPreFilterProfile({
      brandKey: "nsp-india",
      industry: "B2B SaaS Growth & SEO",
      offerings: [{ name: "SaaS SEO" }, { name: "GEO AI Search" }],
      customerProblems: ["High CAC", "Low Pipeline"],
    });

    // Extreme multi-match event
    const megaCluster = makeCluster(
      "evt_mega",
      "SaaS SEO and GEO AI Search Citations Slash High CAC and Grow Low Pipeline",
      "B2B SaaS founders celebrate massive AI search expansion with verified official platform corroboration.",
      ["saas", "seo", "ai", "autonomous agent"],
      "India",
      4, // 4 independent sources
      2, // 2 hours old
    );

    const score = scoreClusterBrandAwareV2(megaCluster, nowMs, saasProfile);
    assert.ok(score <= 100, `Score ${score} must not exceed 100`);
    assert.ok(score >= 80, `Mega matching cluster should score >= 80, got ${score}`);
  });

  // Test 12: Deterministic repeated scoring
  it("is 100% deterministic across repeated runs on identical inputs", () => {
    const profile = buildBrandPreFilterProfile({
      brandKey: "test",
      industry: "Logistics",
      offerings: [{ name: "Ocean Freight" }],
    });

    const cluster = makeCluster(
      "evt_det",
      "Port Congestion Spikes Ocean Freight Rates",
      "Demurrage surcharges hit container shipping lines.",
      ["demurrage", "ocean freight"],
    );

    const score1 = scoreClusterBrandAwareV2(cluster, nowMs, profile);
    const score2 = scoreClusterBrandAwareV2(cluster, nowMs, profile);

    assert.equal(score1, score2, "Scores must be strictly identical across runs");
  });
});

