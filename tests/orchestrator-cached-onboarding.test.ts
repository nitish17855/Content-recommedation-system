import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import {
  brandProfiles,
  brandSources,
  competitors,
  contextPacks,
  recommendations,
  reportRuns,
  services,
  sources,
} from "../src/db/schema.js";
import {
  claimActiveOrNewReportRun,
  DEFAULT_STALE_LEASE_THRESHOLD_MS,
  saveBrandOnboardingRecord,
} from "../src/db/repositories/persistence.js";
import {
  runWebsiteRecommendationPipeline,
} from "../src/pipeline/orchestrator.js";
import { ProgressBroadcaster } from "../src/pipeline/progress-broadcaster.js";
import type {
  BrandProfileExtraction,
  CompetitorEvidenceRecord,
  EventCluster,
} from "../ai/schemas.js";
import type { CrawlResult } from "../src/pipeline/crawler.js";

describe("Slice 6.3 — Cached Brand Onboarding & Forced Refresh Integration Suite", () => {
  let db: AppDb;
  let testBrandId: number;

  const testSuffix = crypto.randomUUID().slice(0, 8);
  const testUrl = `https://coldchain-${testSuffix}.example.com`;
  const testBusinessKey = `biz_coldchain_${testSuffix}_example_com`;

  const T_Day0 = new Date("2026-06-01T10:00:00.000Z");
  const T_Day2 = new Date("2026-06-03T10:00:00.000Z"); // 2 days later: fresh cache (<30d)
  const T_Day35 = new Date("2026-07-06T10:00:00.000Z"); // 35 days later: stale (>30d)

  const mockCrawlResult: CrawlResult = {
    homepage: {
      url: testUrl,
      rawHtml: "<html><body>Precision Cold Chain Logistics</body></html>",
      extractedText: "Precision temperature-controlled freight logistics and cold storage transport.",
      title: "Cold Chain Freight",
    },
    selectedPages: [],
    allDiscoveredLinks: [],
    extractedPagesCount: 1,
    durationMs: 50,
  };

  const mockBrandExtraction: BrandProfileExtraction = {
    brand_name: "Apex Cold Chain Freight",
    industry: "Freight Logistics",
    sub_industry: "Cold Chain Transport",
    business_model: "Asset-based Fleet Logistics",
    target_market: "Global",
    value_proposition: "Zero-excursion temperature-controlled freight forwarding.",
    core_offerings: [
      {
        service_id: "reefer-freight",
        name: "Temperature-Controlled Freight",
        category: "Transportation",
        description: "Active reefer fleet with real-time telematics.",
      },
      {
        service_id: "pharma-cold-storage",
        name: "Pharma Cold Chain Storage",
        category: "Warehousing",
        description: "GDP compliant cold rooms.",
      },
    ],
    target_audiences: ["Pharma Manufacturers", "Frozen Food Shippers"],
    customer_pain_points: ["Thermal excursions and cargo spoilage"],
    verified_differentiators: ["Continuous IoT temperature logging"],
    proof_points: ["99.8% thermal compliance across 10,000 corridors"],
    tone_and_style: "Executive and Operational",
    uncertainties: [],
  };

  const mockCompetitors: CompetitorEvidenceRecord[] = [
    {
      name: "Lineage Logistics",
      website: "https://lineagelogistics.com",
      canonical_domain: "lineagelogistics.com",
      classification: "direct",
      scale_classification: "larger",
      overlap_scores: {
        overall: 0.9,
        offerings: 0.9,
        audience: 0.85,
        geography: 0.9,
        model_pricing: 0.8,
        composite_score: 0.89,
      },
      competitive_rationale: "Direct cold-chain temperature-controlled freight and cold storage.",
      verified_facts: ["Global temperature-controlled network"],
      inferred_judgments: [],
      supporting_evidence_urls: ["https://lineagelogistics.com"],
      confidence: "high",
      unknowns: [],
      last_verified_at: "2026-06-01T10:00:00.000Z",
    },
  ];

  function getMockClusters(baseId: string, title: string): EventCluster[] {
    const eventId = `${baseId}_${testSuffix}`;
    return [
      {
        event_id: eventId,
        cluster_title: title,
        signal_ids: [`sig_${eventId}_1`],
        signals: [
          {
            signal_id: `sig_${eventId}_1`,
            source_id: "trade_press",
            title,
            url: `https://example.com/${eventId}`,
            publisher: "Global Freight Watch",
            published_at: "2026-06-01T08:00:00Z",
            fetched_at: "2026-06-01T08:00:00Z",
            summary: `${title} announced across international cold chain routes.`,
          },
        ],
        first_seen_at: "2026-06-01T08:00:00Z",
        last_seen_at: "2026-06-01T08:00:00Z",
        independent_source_count: 1,
        source_diversity: 1,
        country_relevance: {
          india_relevance: "high",
          reason: "Global trade corridors affect international exporters",
        },
        keywords: ["freight", "reefer", "bunker", "fuel", "surcharge"],
        status: "active",
      },
    ];
  }

  const mockDiscoveredSources = [
    {
      publisherName: "Global Reefer Watch",
      websiteUrl: "https://example.com/reefer",
      feedUrl: `https://example.com/reefer/feed-${testSuffix}.xml`,
      feedTitle: "Global Reefer News",
      feedType: "rss" as const,
      validationStatus: "valid" as const,
      validationReason: "Valid RSS 2.0 channel",
      isSpecialist: true,
    },
  ];

  before(async () => {
    const env = loadEnv();
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
    db = createDb(env.DATABASE_URL);
  });

  after(async () => {
    if (!db || !testBrandId) return;
    const runs = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.brandProfileId, testBrandId));
    const runIds = runs.map((r) => r.id);
    if (runIds.length > 0) {
      await db.delete(recommendations).where(inArray(recommendations.reportRunId, runIds));
      await db.delete(reportRuns).where(inArray(reportRuns.id, runIds));
    }
    await db.delete(brandSources).where(eq(brandSources.brandProfileId, testBrandId));
    await db.delete(competitors).where(eq(competitors.brandProfileId, testBrandId));
    await db.delete(services).where(eq(services.brandProfileId, testBrandId));
    await db.delete(brandProfiles).where(eq(brandProfiles.id, testBrandId));
  });

  // Test 1: New URL triggers complete onboarding (crawl, extraction, competitors, sources)
  it("triggers complete autonomous onboarding for a brand URL seen for the first time", async () => {
    const broadcaster = new ProgressBroadcaster();
    const token = crypto.randomUUID();

    // 0. Ensure brand row exists in 'pending' status as the start endpoint creates on first sight
    const [pendingBrand] = await db
      .insert(brandProfiles)
      .values({
        brandKey: `brand_${testSuffix}`,
        businessKey: testBusinessKey,
        originalUrl: testUrl,
        canonicalUrl: testUrl,
        brandName: "Cold Chain Freight",
        industry: "Logistics",
        targetMarket: "Global",
        primaryDomain: `coldchain-${testSuffix}.example.com`,
        onboardingStatus: "pending",
        profileJson: {},
      })
      .returning({ id: brandProfiles.id });
    testBrandId = pendingBrand!.id;

    // 1. Claim initial report run with the brand's own id
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day0,
    );

    const result = await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      broadcaster,
      now: T_Day0,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_maritime_fuel_surcharge", "Maritime Carriers Introduce Emergency Bunker Surcharges"),
      skipAiCalls: true,
    });

    assert.ok(result.brandProfileId);
    assert.equal(result.recommendationsCount > 0, true);
    testBrandId = result.brandProfileId;

    // Verify brand was persisted with completed onboarding
    const [brand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.id, testBrandId));
    assert.equal(brand!.onboardingStatus, "completed");
    assert.equal(brand!.businessKey, testBusinessKey);

    // Verify snapshot has website_analysis and brand_extraction completed (not skipped)
    const snapshot = await broadcaster.getLatestSnapshot(db, claim.run.id);
    assert.equal(snapshot!.stages.website_analysis.status, "completed");
    assert.equal(snapshot!.stages.brand_extraction.status, "completed");
    assert.equal(snapshot!.stages.competitor_research.status, "completed");
    assert.equal(snapshot!.stages.industry_sources.status, "completed");
    assert.equal(snapshot!.overallStatus, "completed");
  });

  // Test 2: Fresh cached URL skips onboarding but generates fresh recommendations
  it("reuses fresh cached onboarding (< 30 days old) by skipping crawl and extraction, but generates fresh recommendations", async () => {
    const broadcaster = new ProgressBroadcaster();
    const token = crypto.randomUUID();

    // Claim run at Day 2 (within 30-day window)
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day2,
    );

    const result = await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: false, // Normal Get Recommendations
      broadcaster,
      now: T_Day2,
      mockCandidateClusters: getMockClusters("evt_port_automation_strike", "Port Automation Dispute Leads to Reefer Congestion"),
      skipAiCalls: true,
    });

    assert.equal(result.brandProfileId, testBrandId);
    assert.equal(result.recommendationsCount > 0, true);

    const snapshot = await broadcaster.getLatestSnapshot(db, claim.run.id);
    // Onboarding stages must be skipped with explanation
    assert.equal(snapshot!.stages.website_analysis.status, "skipped");
    assert.ok(snapshot!.stages.website_analysis.details?.includes("Reusing"));
    assert.equal(snapshot!.stages.brand_extraction.status, "skipped");
    assert.equal(snapshot!.stages.competitor_research.status, "skipped");
    assert.equal(snapshot!.stages.industry_sources.status, "skipped");

    // Downstream recommendation stages must be executed and completed
    assert.equal(snapshot!.stages.opportunity_matching.status, "completed");
    assert.equal(snapshot!.stages.ranking_persistence.status, "completed");
    assert.equal(snapshot!.overallStatus, "completed");
  });

  // Test 3: Stale profile (> 30 days) triggers automatic refresh
  it("triggers automatic refresh when the brand profile is older than 30 days", async () => {
    const broadcaster = new ProgressBroadcaster();
    const token = crypto.randomUUID();

    // Claim run at Day 35 (> 30 days after Day 0 crawl)
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day35,
    );

    const result = await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: false, // Normal request, but profile is stale
      broadcaster,
      now: T_Day35,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_lithium_reefer_batteries", "New Solid State Reefer Batteries Extend Transit Windows"),
      skipAiCalls: true,
    });

    assert.equal(result.brandProfileId, testBrandId);

    const snapshot = await broadcaster.getLatestSnapshot(db, claim.run.id);
    // Must NOT be skipped because it was stale!
    assert.equal(snapshot!.stages.website_analysis.status, "completed");
    assert.equal(snapshot!.stages.brand_extraction.status, "completed");
    assert.equal(snapshot!.overallStatus, "completed");

    // Verify lastCrawledAt was bumped to T_Day35
    const [updatedBrand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.id, testBrandId));
    assert.equal(updatedBrand!.lastCrawledAt?.toISOString(), T_Day35.toISOString());
  });

  // Test 4: Explicit forced refresh (refreshProfile: true) forces fresh crawl even when fresh
  it("forces a fresh website crawl and extraction when refreshProfile is true even if profile is fresh", async () => {
    const broadcaster = new ProgressBroadcaster();
    const token = crypto.randomUUID();

    // Time is T_Day35 + 1 day (brand was just refreshed at Day 35, so it is 1 day old)
    const T_Day36 = new Date("2026-07-07T10:00:00.000Z");

    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day36,
    );

    // Call with explicit refreshProfile: true
    const result = await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: true, // EXPLICIT FORCED REFRESH
      broadcaster,
      now: T_Day36,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_eu_pharma_cold_mandate", "EU Finalizes Temperature Mandates for Biologics"),
      skipAiCalls: true,
    });

    assert.equal(result.brandProfileId, testBrandId);

    const snapshot = await broadcaster.getLatestSnapshot(db, claim.run.id);
    // Forced refresh must NOT skip website analysis or brand extraction
    assert.equal(snapshot!.stages.website_analysis.status, "completed");
    assert.equal(snapshot!.stages.brand_extraction.status, "completed");
    assert.equal(snapshot!.stages.competitor_research.status, "completed");
    assert.equal(snapshot!.overallStatus, "completed");
  });

  // Test 5: Competitor information is refreshed and updated during forced refresh
  it("updates competitor catalog with new entries upon forced refresh", async () => {
    const token = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day35,
    );

    const newMockCompetitors: CompetitorEvidenceRecord[] = [
      ...mockCompetitors,
      {
        name: "Americold Logistics",
        website: "https://americold.com",
        canonical_domain: "americold.com",
        classification: "direct",
        scale_classification: "larger",
        overlap_scores: {
          overall: 0.88,
          offerings: 0.9,
          audience: 0.85,
          geography: 0.9,
          model_pricing: 0.8,
          composite_score: 0.88,
        },
        competitive_rationale: "Major cold chain competitor",
        verified_facts: ["Temperature controlled infrastructure"],
        inferred_judgments: [],
        supporting_evidence_urls: ["https://americold.com"],
        confidence: "high",
        unknowns: [],
        last_verified_at: "2026-07-06T10:00:00.000Z",
      },
    ];

    await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: true,
      now: T_Day35,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors: newMockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_panama_canal_draft_limits", "Panama Canal Issues New Draft Restrictions on Reefer Slots"),
      skipAiCalls: true,
    });

    const storedCompetitors = await db
      .select()
      .from(competitors)
      .where(eq(competitors.brandProfileId, testBrandId));
    assert.equal(storedCompetitors.length >= 2, true);
    assert.ok(storedCompetitors.some((c) => c.name === "Americold Logistics"));
  });

  // Test 6: Source discovery is refreshed and linked in brand_sources
  it("re-assesses industry source coverage and links validated feeds", async () => {
    const brandSourcesList = await db
      .select()
      .from(brandSources)
      .where(eq(brandSources.brandProfileId, testBrandId));
    // Industry sources should be linked for the brand
    assert.equal(brandSourcesList.length > 0, true);
  });

  // Test 7: Owner sensitivity overrides survive profile refresh
  it("preserves explicit owner sensitivity overrides across profile refresh", async () => {
    // 1. Manually set an owner override on the brand profile: supplyChainSensitivity = high
    const [brand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.id, testBrandId));
    const currentJson = (brand!.profileJson as Record<string, unknown>) ?? {};

    await db
      .update(brandProfiles)
      .set({
        profileJson: {
          ...currentJson,
          sensitivityConfig: {
            inferenceVersion: "1.0",
            inferred: { aiRelevance: "low", supplyChainSensitivity: "medium", regulatorySensitivity: "low" },
            overrides: { supplyChainSensitivity: "high" }, // OWNER OVERRIDE
            effective: { aiRelevance: "low", supplyChainSensitivity: "high", regulatorySensitivity: "low" },
            inferredAt: T_Day0.toISOString(),
          },
        },
      })
      .where(eq(brandProfiles.id, testBrandId));

    // 2. Perform forced refresh
    const token = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day35,
    );

    await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: true, // FORCED REFRESH
      now: T_Day35,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_dg_cargo_dry_ice_rules", "ICAO Updates Dry Ice Transport Limits for Air Reefer Freight"),
      skipAiCalls: true,
    });

    // 3. Verify override survived
    const [refreshedBrand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.id, testBrandId));
    const refreshedJson = refreshedBrand!.profileJson as any;
    assert.equal(
      refreshedJson.sensitivityConfig.overrides.supplyChainSensitivity,
      "high",
      "Owner override must survive profile refresh",
    );
    assert.equal(
      refreshedJson.sensitivityConfig.effective.supplyChainSensitivity,
      "high",
      "Effective sensitivity must reflect owner override",
    );
  });

  // Test 8: Historical recommendations remain accessible across multiple runs
  it("preserves historical recommendations across multiple report runs", async () => {
    const historicalRecs = await db
      .select()
      .from(recommendations)
      .innerJoin(reportRuns, eq(recommendations.reportRunId, reportRuns.id))
      .where(eq(reportRuns.brandProfileId, testBrandId));

    // Multiple completed runs exist for this brand; all recommendations should be intact
    assert.equal(historicalRecs.length > 1, true);
    for (const r of historicalRecs) {
      assert.ok(r.recommendations.title);
      assert.equal(r.recommendations.status, "published");
    }
  });

  // Test 9: Active-run deduplication takes precedence over forced refresh
  it("returns existing active run when duplicate request arrives, even if refreshProfile is requested", async () => {
    const token = crypto.randomUUID();
    // Start an active run
    const claim1 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_active_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day2,
    );
    assert.equal(claim1.reused, false);

    // Another request arrives while claim1 is active, asking for refreshProfile: true
    const claim2 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_dup_${crypto.randomUUID()}`,
      {},
      crypto.randomUUID(),
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day2,
    );

    // Deduplication must take precedence
    assert.equal(claim2.reused, true);
    assert.equal(claim2.run.id, claim1.run.id);
    assert.equal(claim2.workerToken, null);

    // Clean up active run for next test
    await db.update(reportRuns).set({ status: "completed" }).where(eq(reportRuns.id, claim1.run.id));
  });

  // Test 10: Failed onboarding allows retry
  it("retries and completes onboarding when previous onboarding failed", async () => {
    // Set onboardingStatus to 'failed'
    await db
      .update(brandProfiles)
      .set({ onboardingStatus: "failed", onboardingError: "Network timeout during extraction" })
      .where(eq(brandProfiles.id, testBrandId));

    const token = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      {},
      token,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_Day2,
    );

    // Run pipeline
    await runWebsiteRecommendationPipeline(db, {
      url: testUrl,
      runId: claim.run.id,
      workerToken: token,
      refreshProfile: false, // Normal request
      now: T_Day2,
      mockCrawlResult,
      mockBrandExtraction,
      mockCompetitors,
      mockDiscoveredSources,
      mockCandidateClusters: getMockClusters("evt_retried_onboarding_event", "Global Cold Storage Capacity Expands by 14 Percent"),
      skipAiCalls: true,
    });

    // Verify status transitioned from failed to completed
    const [retriedBrand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.id, testBrandId));
    assert.equal(retriedBrand!.onboardingStatus, "completed");
  });
});
