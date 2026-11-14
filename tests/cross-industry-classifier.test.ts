import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EventCluster } from "../src/ai/schemas.js";
import {
  classifyCrossIndustryEvent,
  calculateCrossIndustryRelevance,
  inferBrandSensitivities,
  resolveEffectiveSensitivity,
  type SensitivityDimensions,
} from "../src/pipeline/cross-industry-classifier.js";

function makeTestCluster(title: string, excerpt: string, keywords: string[] = []): EventCluster {
  return {
    event_id: `evt_test_${Math.random().toString(36).substring(7)}`,
    cluster_title: title,
    signal_ids: ["sig_1"],
    signals: [
      {
        signal_id: "sig_1",
        source_id: "test-source",
        title,
        url: "https://example.com/test",
        publisher: "Industry News",
        published_at: "2024-11-10T00:00:00Z",
        fetched_at: "2024-11-10T01:00:00Z",
        source_type: "rss_feed",
        country_relevance: "Global",
        excerpt,
        content_hash: "hash123",
        keywords,
        summary: null,
      },
    ],
    first_seen_at: "2024-11-10T00:00:00Z",
    last_seen_at: "2024-11-10T00:00:00Z",
    independent_source_count: 1,
    source_diversity: 1,
    country_relevance: "Global",
    keywords,
    status: "active",
  };
}

describe("Cross-Industry Classifier & Sensitivity Modulation Suite", () => {
  const highAll: SensitivityDimensions = { aiRelevance: "high", supplyChainSensitivity: "high", regulatorySensitivity: "high" };
  const saasSensitivities: SensitivityDimensions = { aiRelevance: "high", supplyChainSensitivity: "low", regulatorySensitivity: "medium" };
  const coffeeSensitivities: SensitivityDimensions = { aiRelevance: "low", supplyChainSensitivity: "high", regulatorySensitivity: "medium" };
  const logisticsSensitivities: SensitivityDimensions = { aiRelevance: "medium", supplyChainSensitivity: "high", regulatorySensitivity: "high" };

  // Test 1: AI-only event: no synergy bonus
  it("classifies pure AI event and leaves primary score unchanged without synergy bonus", () => {
    const cluster = makeTestCluster(
      "OpenAI Releases Reasoning Model with Advanced Chain of Thought",
      "The new large language model outperforms humans on complex code and mathematics benchmarks.",
      ["openai", "llm", "reasoning model"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.ok(classification.aiShiftScore >= 0.75, "Expected strong AI score");
    assert.equal(classification.supplyChainScore, 0, "Supply chain should be 0");
    assert.equal(classification.regulatoryScore, 0, "Regulatory should be 0");

    const relevance = calculateCrossIndustryRelevance(classification, saasSensitivities);
    assert.equal(relevance.synergyBonus, 0, "AI-only event should receive zero synergy bonus");
    assert.equal(relevance.compositeScore, relevance.primaryScore, "Composite score must equal primary score");
  });

  // Test 2: Supply-chain-only event: no synergy bonus
  it("classifies pure supply-chain event and leaves primary score unchanged without synergy bonus", () => {
    const cluster = makeTestCluster(
      "Global Port Congestion Spikes Container Demurrage and Detention Fees",
      "Severe backlogs at maritime hubs pushed container freight demurrage rates up by 40%.",
      ["port congestion", "demurrage", "container freight"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.equal(classification.aiShiftScore, 0, "AI score should be 0");
    assert.ok(classification.supplyChainScore >= 0.8, "Expected strong supply chain score");
    assert.equal(classification.regulatoryScore, 0, "Regulatory should be 0");

    const relevance = calculateCrossIndustryRelevance(classification, logisticsSensitivities);
    assert.equal(relevance.synergyBonus, 0);
    assert.equal(relevance.compositeScore, relevance.primaryScore);
  });

  // Test 3: Regulatory-only event: no synergy bonus
  it("classifies pure regulatory event and leaves primary score unchanged without synergy bonus", () => {
    const cluster = makeTestCluster(
      "New FSSAI Food Safety Legislation Imposes Strict Mandatory Labeling",
      "Statutory compliance deadlines require all packaged goods to clearly disclose nutritional ingredients.",
      ["fssai", "food safety legislation", "compliance"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.equal(classification.aiShiftScore, 0);
    assert.equal(classification.supplyChainScore, 0);
    assert.ok(classification.regulatoryScore >= 0.8, "Expected strong regulatory score");

    const relevance = calculateCrossIndustryRelevance(classification, coffeeSensitivities);
    assert.equal(relevance.synergyBonus, 0);
    assert.equal(relevance.compositeScore, relevance.primaryScore);
  });

  // Test 4: AI + supply-chain event: receives a small capped bonus
  it("awards a small capped synergy bonus to multi-category AI + supply chain events", () => {
    const cluster = makeTestCluster(
      "Freight Shipping Platforms Test Agent Workflows to Mitigate Demurrage",
      "AI-powered container freight platform uses machine learning to predict port congestion.",
      ["freight", "demurrage", "ai-powered"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.ok(classification.aiShiftScore >= 0.7, "Expected strong AI score");
    assert.ok(classification.supplyChainScore >= 0.7, "Expected strong supply chain score");

    // Moderate sensitivity so primary is < 1.0 and has headroom for synergy bonus
    const moderateSensitivities: SensitivityDimensions = { aiRelevance: "medium", supplyChainSensitivity: "medium", regulatorySensitivity: "low" };
    const relevance = calculateCrossIndustryRelevance(classification, moderateSensitivities);
    assert.ok(relevance.synergyBonus > 0, "Should receive synergy bonus");
    assert.ok(relevance.synergyBonus <= 0.08, "Synergy bonus must be capped at 0.08");
    assert.ok(relevance.compositeScore > relevance.primaryScore, "Composite score should be higher than primary");
  });

  // Test 5: AI + regulatory event: receives a small capped bonus
  it("awards a small capped synergy bonus to multi-category AI + regulatory events", () => {
    const cluster = makeTestCluster(
      "AI-Powered Customs Compliance Platform Automates Tariff Disclosures",
      "Machine learning software helps importers adhere to new customs duty statutory compliance.",
      ["ai-powered", "customs compliance", "customs tariff", "machine learning"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.ok(classification.aiShiftScore >= 0.7);
    assert.ok(classification.regulatoryScore >= 0.7);

    const relevance = calculateCrossIndustryRelevance(classification, highAll);
    assert.ok(relevance.synergyBonus > 0);
    assert.ok(relevance.synergyBonus <= 0.08);
  });

  // Test 6: Three-category event never exceeds 1.0
  it("ensures composite score never exceeds 1.0 even with all three categories matching strongly", () => {
    const cluster = makeTestCluster(
      "AI-Powered Maritime Cold Chain Systems Face New Statutory Compliance Mandates",
      "Generative AI controls refrigerated transport container freight under strict FDA and FSSAI statutory regulations.",
      ["generative ai", "cold chain", "fssai", "refrigerated transport", "statutory compliance"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    const relevance = calculateCrossIndustryRelevance(classification, highAll);

    assert.ok(relevance.compositeScore <= 1.0, `Composite score ${relevance.compositeScore} must not exceed 1.0`);
    assert.ok(relevance.relevance100 <= 100, `Relevance 100 ${relevance.relevance100} must not exceed 100`);
  });

  // Test 7: Secondary score below 0.35 receives no bonus
  it("does not grant synergy bonus if secondary category score is below 0.35 threshold", () => {
    const cluster = makeTestCluster(
      "Major Tech Crunch on Silicon Valley Cloud Platforms",
      "LLM provider discusses minimal compliance notes as a minor footnote.",
      ["llm"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    // Artificially low regulatory sensitivity
    const lowRegSensitivity: SensitivityDimensions = { aiRelevance: "high", supplyChainSensitivity: "low", regulatorySensitivity: "low" };
    const relevance = calculateCrossIndustryRelevance(classification, lowRegSensitivity);

    assert.equal(relevance.synergyBonus, 0, "Secondary score below 0.35 must not trigger synergy bonus");
  });

  // Test 8: Negative disambiguation: "travel agent" must not classify as AI
  it("strictly suppresses AI classification for false agent contexts like travel agent", () => {
    const cluster = makeTestCluster(
      "Top Travel Agent Bookings Surge Across Summer Holiday Destinations",
      "A veteran travel agent explains how family package vacations and hotel bookings grew 20% this season.",
      ["travel agent", "vacations", "bookings"],
    );

    const classification = classifyCrossIndustryEvent(cluster);
    assert.equal(classification.aiShiftScore, 0, "Travel agent must strictly have 0 AI score");
    assert.equal(classification.matchedTerms.ai.length, 0);
  });

  // Test 9: Sensitivity modulation changes score based on brand profile without mutating classification
  it("modulates relevance score based on brand sensitivities while keeping underlying classification identical", () => {
    const cluster = makeTestCluster(
      "Arabica Coffee Futures Spike 30% Following Brazil Drought and Cold Chain Freight Surcharges",
      "Severe droughts pushed green coffee commodity prices higher, with refrigerated transport logistics costs rising.",
      ["arabica", "coffee futures", "cold chain", "green coffee"],
    );

    const classification = classifyCrossIndustryEvent(cluster);

    // Coffee roaster (high supply chain sensitivity)
    const coffeeRel = calculateCrossIndustryRelevance(classification, coffeeSensitivities);
    // SaaS company (low supply chain sensitivity)
    const saasRel = calculateCrossIndustryRelevance(classification, saasSensitivities);

    assert.equal(coffeeRel.classification, saasRel.classification, "Underlying classification must be identical");
    assert.ok(
      coffeeRel.relevance100 > saasRel.relevance100,
      `Coffee brand relevance (${coffeeRel.relevance100}) must be significantly higher than SaaS (${saasRel.relevance100})`,
    );
    assert.ok(coffeeRel.relevance100 >= 80, "Coffee brand should score >= 80 on coffee futures");
    assert.ok(saasRel.relevance100 <= 30, "SaaS brand should score <= 30 on coffee futures");
  });

  // Test 10: Deterministic repeated scoring
  it("produces identical classification and composite scores on repeated runs", () => {
    const cluster = makeTestCluster(
      "Autonomous Agents Optimize Intermodal Freight Routing to Cut Demurrage",
      "AI-powered container freight platform uses generative AI to predict port congestion.",
      ["autonomous agent", "intermodal freight", "demurrage"],
    );

    const res1 = calculateCrossIndustryRelevance(classifyCrossIndustryEvent(cluster), logisticsSensitivities);
    const res2 = calculateCrossIndustryRelevance(classifyCrossIndustryEvent(cluster), logisticsSensitivities);

    assert.deepEqual(res1, res2, "Repeated scoring must be 100% deterministic");
  });

  // Test 11: Inference helper tests across multiple verticals
  it("correctly infers brand sensitivities for diverse business verticals", () => {
    // 1. AI SaaS
    const aiSaas = inferBrandSensitivities({
      industry: "B2B SaaS",
      businessModel: "Subscription Software",
      offerings: ["Autonomous AI Agents", "LLM Evaluation Platform", "Generative AI Workflows"],
      customerProblems: ["High LLM inference cost", "Hallucination risks"],
    });
    assert.equal(aiSaas.aiRelevance, "high");
    assert.equal(aiSaas.supplyChainSensitivity, "low");

    // 2. Traditional SaaS
    const tradSaas = inferBrandSensitivities({
      industry: "Enterprise Software",
      businessModel: "B2B SaaS",
      offerings: ["Employee Payroll System", "Attendance Tracker"],
      customerProblems: ["Manual timesheet calculation"],
    });
    assert.equal(tradSaas.aiRelevance, "medium");
    assert.equal(tradSaas.supplyChainSensitivity, "low");

    // 3. Cold-Chain Logistics with Customs Compliance
    const coldChain = inferBrandSensitivities({
      industry: "Logistics & Supply Chain",
      businessModel: "Freight Forwarder",
      offerings: ["Refrigerated Transport", "Ocean Freight", "Cold Storage Warehousing", "Customs Compliance & Brokerage"],
      customerProblems: ["Temperature excursions", "Port congestion demurrage"],
    });
    assert.equal(coldChain.supplyChainSensitivity, "high");
    assert.equal(coldChain.regulatorySensitivity, "high");

    // 4. Specialty Coffee Roaster
    const coffeeRoaster = inferBrandSensitivities({
      industry: "Food & Beverage",
      businessModel: "Direct-to-Consumer & Wholesale",
      offerings: ["Specialty Coffee Roasting", "Single-Origin Green Coffee Sourcing", "Cafe Supplies"],
      customerProblems: ["Green bean price volatility", "FSSAI compliance"],
    });
    assert.equal(coffeeRoaster.supplyChainSensitivity, "high");
    assert.equal(coffeeRoaster.regulatorySensitivity, "high");

    // 5. Missing / ambiguous information defaults to medium rather than low
    const ambiguous = inferBrandSensitivities({});
    assert.equal(ambiguous.aiRelevance, "medium");
    assert.equal(ambiguous.supplyChainSensitivity, "medium");
    assert.equal(ambiguous.regulatorySensitivity, "medium");
  });

  // Test 12: Override resolution and persistence semantics
  it("resolves overrides correctly and restores inferred values when override is removed", () => {
    const inferred: SensitivityDimensions = { aiRelevance: "low", supplyChainSensitivity: "high", regulatorySensitivity: "medium" };

    // Explicit override for aiRelevance
    const effective1 = resolveEffectiveSensitivity(inferred, { aiRelevance: "high" });
    assert.equal(effective1.aiRelevance, "high", "Override must take precedence");
    assert.equal(effective1.supplyChainSensitivity, "high", "Non-overridden field keeps inferred value");

    // Removing override restores inferred
    const effective2 = resolveEffectiveSensitivity(inferred, {});
    assert.equal(effective2.aiRelevance, "low", "Removing override must restore inferred value");
  });
});
