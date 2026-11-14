import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import {
  brandProfiles,
  contextPacks,
  recommendations,
  reportRuns,
} from "../src/db/schema.js";
import {
  claimActiveOrNewReportRun,
  completeReportRunAndAdvanceSchedule,
  DEFAULT_STALE_LEASE_THRESHOLD_MS,
  recoverStaleReportRuns,
  renewWorkerHeartbeat,
  updateRunCheckpointFenced,
} from "../src/db/repositories/persistence.js";
import type { ContextPack, RecommendationCard } from "../src/ai/schemas.js";

describe("Worker Lease, Fencing & Deduplication Integration Suite", () => {
  let db: AppDb;
  let testBrandId: number;
  const testBrandKey = `test-lease-${crypto.randomUUID().slice(0, 8)}`;
  const testBusinessKey = `biz_test_lease_${crypto.randomUUID().slice(0, 8)}`;

  // Base deterministic timeline anchor: 2026-06-01 10:00:00.000 UTC
  const T_10_00_00 = new Date("2026-06-01T10:00:00.000Z");
  const T_10_01_00 = new Date("2026-06-01T10:01:00.000Z");
  const T_10_04_59 = new Date("2026-06-01T10:04:59.000Z"); // 4 min 59s: healthy
  const T_10_05_00 = new Date("2026-06-01T10:05:00.000Z"); // 5 min 00s: boundary expiry
  const T_10_05_01 = new Date("2026-06-01T10:05:01.000Z"); // 5 min 01s: stale
  const T_10_06_00 = new Date("2026-06-01T10:06:00.000Z");

  before(async () => {
    const env = loadEnv();
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Please set it in .env");
    }
    db = createDb(env.DATABASE_URL);

    // Create an isolated brand profile fixture for lease tests
    const [insertedBrand] = await db
      .insert(brandProfiles)
      .values({
        brandKey: testBrandKey,
        businessKey: testBusinessKey,
        originalUrl: "https://lease-test.example.com",
        canonicalUrl: "https://lease-test.example.com",
        brandName: "Lease Test Logistics Co.",
        industry: "Cold Chain Freight",
        targetMarket: "Global",
        primaryDomain: "lease-test.example.com",
        onboardingStatus: "completed",
        profileJson: { test: true },
      })
      .returning();

    testBrandId = insertedBrand!.id;
  });

  after(async () => {
    if (!db || !testBrandId) return;
    // Clean up all runs, recommendations, packs, and the test brand profile
    const existingRuns = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.brandProfileId, testBrandId));

    const runIds = existingRuns.map((r) => r.id);
    if (runIds.length > 0) {
      await db.delete(recommendations).where(inArray(recommendations.reportRunId, runIds));
      await db.delete(reportRuns).where(inArray(reportRuns.id, runIds));
    }
    await db.delete(brandProfiles).where(eq(brandProfiles.id, testBrandId));
  });

  beforeEach(async () => {
    // Reset test runs before each test case for isolation
    const existingRuns = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.brandProfileId, testBrandId));

    const runIds = existingRuns.map((r) => r.id);
    if (runIds.length > 0) {
      await db.delete(recommendations).where(inArray(recommendations.reportRunId, runIds));
      await db.delete(reportRuns).where(inArray(reportRuns.id, runIds));
    }
  });

  function makeMockCard(eventId: string): RecommendationCard {
    return {
      schemaVersion: 2,
      title: "Optimizing Cold Chain Telematics Amidst Fuel Surcharges",
      category: "Industry and business developments",
      what_happened: "Global maritime carriers introduced emergency bunker surcharges.",
      why_brand_should_care: "Directly erodes cold chain freight margins unless dynamic fuel indexing is active.",
      what_to_create: "45-second route margin teardown video",
      how_to_create_it: {
        opening_line: '"If your freight contracts lack dynamic fuel indexing, you are subsidizing carrier fuel."',
        what_to_show: ["Chart showing carrier bunker adjustments", "Dynamic contract clause mockup"],
        on_screen_text: ["Carrier surcharges +14%", "Dynamic indexing saves 8% freight spend"],
        demonstration_step: "Walk through real-time fuel index clause adjustment.",
        ending_line: "Protect your per-reefer margin before Q3 contracts close.",
      },
      where_to_get_material: [
        {
          label: "FreightWaves Analysis",
          url: "https://freightwaves.com/bunker-rates-2024",
          what_to_record_or_screenshot: "Screenshot fuel rate curve",
        },
      ],
      what_to_communicate: "How temperature-controlled freight operators defend margins with indexed contracts.",
      when_to_publish: {
        urgency: "urgent",
        timing_reason: "Quarterly freight RFPs are currently open.",
      },
      what_to_verify: {
        india_availability: "applicable_globally",
        who_can_use_it: "All cold chain shippers and forwarders",
        facts_and_claims_to_check: ["Verify maritime fuel surcharge percentage"],
      },
      suggested_platform: "LinkedIn Video",
      suggested_format: "Teardown with on-screen chart",
      objective: "Demonstrate operational cold-chain logistics domain authority",
      evidence: [
        {
          url: "https://freightwaves.com/bunker-rates-2024",
          publisher: "FreightWaves",
          published_at: "2026-06-01T08:00:00Z",
        },
      ],
      risk: "safe",
      evidence_confidence: {
        level: "high",
        score: 0.94,
        factual_basis: "Verified trade publication data",
      },
      metadata: {
        event_id: eventId,
        creative_route: "margin_teardown",
        matched_services: ["cold-chain-freight", "dynamic-rate-indexing"],
        target_audience_profile: "Cold chain logistics operators and pharma shippers",
        core_business_problem: "Erosion of freight operating margin from unexpected fuel surcharges",
        opportunity_type: "growth_and_unit_economics",
        critic_verdict: "ACCEPT",
        deterministic_evidence_score: 0.88,
        ai_rubric_score: 0.92,
        combined_rank_score: 0.9,
      },
    };
  }

  function makeMockPack(eventId: string): ContextPack {
    return {
      event_id: eventId,
      discovery_category: "Industry and business developments",
      event_title: "Carrier Bunker Surcharge Spike",
      event_summary: "Carriers announced emergency surcharges across refrigerated ocean corridors.",
      event_type: "other",
      event_status: "active",
      occurred_at: "2026-06-01T00:00:00Z",
      first_seen_at: "2026-06-01T00:00:00Z",
      last_seen_at: "2026-06-01T00:00:00Z",
      geography: { primary: "Global", relevance: "high", reason: "Global maritime lanes" },
      india_availability: { status: "available_in_india", who_can_use_it: "Exporters", restrictions_or_eligibility: "None" },
      why_it_matters: "Direct operational impact on per-shipment profitability.",
      participating_entities: ["FreightWaves"],
      affected_audiences: ["Logistics Directors"],
      audience_problems: ["Budget overruns"],
      audience_reactions: ["Renegotiating rates"],
      trend_phase: "emerging",
      estimated_lifespan: "3-6 months",
      potential_service_tags: ["cold-chain-freight"],
      evidence: [{
        evidence_id: "ev_1",
        url: "https://freightwaves.com/bunker-rates-2024",
        publisher: "FreightWaves",
        published_at: "2026-06-01T08:00:00Z",
        source_type: "trade_publication",
        supports: "Carrier fuel announcements",
      }],
      contradictions: [],
      unknowns: [],
      sensitivity: "low",
      confidence_basis: ["Trade press"],
    };
  }

  // Test 1: Healthy heartbeat renewal updates heartbeat_at
  it("renews worker heartbeat using injected timestamp", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );
    assert.equal(claim.reused, false);
    assert.equal(claim.workerToken, workerToken);

    // Renew heartbeat at 10:01:00
    const renewed = await renewWorkerHeartbeat(db, claim.run.id, workerToken, T_10_01_00);
    assert.equal(renewed, true);

    const [updatedRun] = await db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.id, claim.run.id));
    assert.equal(updatedRun!.heartbeatAt?.toISOString(), T_10_01_00.toISOString());
    assert.equal(updatedRun!.status, "running");
  });

  // Test 2: Heartbeat renewal rejected with incorrect worker token
  it("rejects heartbeat renewal when worker token does not match active lease", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    const renewed = await renewWorkerHeartbeat(db, claim.run.id, "impostor_token_xyz", T_10_01_00);
    assert.equal(renewed, false);

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(run!.heartbeatAt?.toISOString(), T_10_00_00.toISOString());
  });

  // Test 3: Lease boundary check at 4 minutes 59 seconds (Must NOT expire)
  it("preserves run as healthy at 4 minutes 59 seconds boundary", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Run recovery at 10:04:59 (4m59s elapsed: < 5m)
    const recovered = await recoverStaleReportRuns(
      db,
      testBrandId,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_04_59,
    );
    assert.equal(recovered, 0, "4m59s should not trigger recovery");

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(run!.status, "running");
  });

  // Test 4: Exact 5 minutes 00 seconds lease boundary (Eligible for recovery)
  it("marks run as failed at exactly 5 minutes 00 seconds boundary", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Run recovery at 10:05:00 (exactly 5m00s elapsed)
    const recovered = await recoverStaleReportRuns(
      db,
      testBrandId,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_05_00,
    );
    assert.equal(recovered, 1, "Exactly 5m00s must trigger recovery");

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(run!.status, "failed");
    assert.ok(run!.errorMessage?.includes("Worker lease expired"));
  });

  // Test 5: Inactivity > 5 minutes is marked stale
  it("marks run as failed when elapsed time is 5 minutes 1 second", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Run recovery at 10:05:01 (5m01s elapsed)
    const recovered = await recoverStaleReportRuns(
      db,
      testBrandId,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_05_01,
    );
    assert.equal(recovered, 1);

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(run!.status, "failed");
  });

  // Test 6: Intermediate heartbeat prevents recovery at 10:05:00
  it("prevents recovery when intermediate heartbeat was renewed", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Renew heartbeat at 10:03:00 (3 minutes in)
    const T_10_03_00 = new Date("2026-06-01T10:03:00.000Z");
    await renewWorkerHeartbeat(db, claim.run.id, workerToken, T_10_03_00);

    // At 10:05:00, only 2 minutes have elapsed since last heartbeat
    const recovered = await recoverStaleReportRuns(
      db,
      testBrandId,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_05_00,
    );
    assert.equal(recovered, 0, "Run should remain healthy because heartbeat was renewed");

    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(run!.status, "running");
  });

  // Test 7: Zombie Worker Fencing & Zero Partial Writes
  it("fences zombie worker from checkpoint updates and persistence, with zero partial writes", async () => {
    const tokenA = crypto.randomUUID();
    const claimA = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_A_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      tokenA,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );
    const runAId = claimA.run.id;

    // Time advances past lease threshold -> Stale recovery marks Run A failed
    const recovered = await recoverStaleReportRuns(
      db,
      testBrandId,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_05_01,
    );
    assert.equal(recovered, 1);

    const [staleA] = await db.select().from(reportRuns).where(eq(reportRuns.id, runAId));
    assert.equal(staleA!.status, "failed");

    // Replacement Run B claimed by Worker B
    const tokenB = crypto.randomUUID();
    const claimB = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_B_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      tokenB,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_05_01,
    );
    assert.equal(claimB.reused, false);
    assert.equal(claimB.workerToken, tokenB);
    const runBId = claimB.run.id;
    assert.notEqual(runAId, runBId);

    // Zombie Worker A awakens and attempts checkpoint update
    await assert.rejects(
      async () => {
        await updateRunCheckpointFenced(
          db,
          runAId,
          tokenA,
          "event_clustering",
          { candidates: [1, 2, 3] },
          T_10_05_01,
        );
      },
      (err: Error) => {
        assert.ok(err.message.includes("Worker fenced"), `Expected fencing error, got: ${err.message}`);
        return true;
      },
    );

    // Zombie Worker A awakens and attempts recommendation persistence
    const cardA = makeMockCard("evt_zombie_a");
    const packA = makeMockPack("evt_zombie_a");
    await assert.rejects(
      async () => {
        await completeReportRunAndAdvanceSchedule(db, {
          reportRunId: runAId,
          brandKey: testBrandKey,
          intervalDays: 7,
          cards: [cardA],
          packs: [packA],
          clusterIdByEventKey: new Map(),
          modelUsed: "gemini-2.5-flash",
          tokenUsage: { prompt: 100, completion: 50 },
          workerToken: tokenA,
          now: T_10_05_01,
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Worker fenced"), `Expected fencing error, got: ${err.message}`);
        return true;
      },
    );

    // Verify ZERO partial writes by Worker A
    const recommendationsA = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.reportRunId, runAId));
    assert.equal(recommendationsA.length, 0, "No recommendations must be written by fenced worker A");

    // Verify Worker B can update checkpoint and persist recommendations cleanly
    const updatedCheckpoint = await updateRunCheckpointFenced(
      db,
      runBId,
      tokenB,
      "event_clustering",
      { step: "done" },
      T_10_05_01,
    );
    assert.equal(updatedCheckpoint, true);

    const cardB = makeMockCard("evt_worker_b");
    const packB = makeMockPack("evt_worker_b");
    await completeReportRunAndAdvanceSchedule(db, {
      reportRunId: runBId,
      brandKey: testBrandKey,
      intervalDays: 7,
      cards: [cardB],
      packs: [packB],
      clusterIdByEventKey: new Map(),
      modelUsed: "gemini-2.5-flash",
      tokenUsage: { prompt: 100, completion: 50 },
      workerToken: tokenB,
      now: T_10_05_01,
    });

    const [completedRunB] = await db.select().from(reportRuns).where(eq(reportRuns.id, runBId));
    assert.equal(completedRunB!.status, "completed");
    assert.equal(completedRunB!.recommendationsCount, 1);

    const recommendationsB = await db
      .select()
      .from(recommendations)
      .where(eq(recommendations.reportRunId, runBId));
    assert.equal(recommendationsB.length, 1);
    assert.equal(recommendationsB[0]!.title, cardB.title);
  });

  // Test 8: Healthy In-Flight Job Reuse
  it("reuses existing healthy run when a duplicate request arrives", async () => {
    const workerToken = crypto.randomUUID();
    const claim1 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );
    assert.equal(claim1.reused, false);

    // Second client triggers Get Recommendations for the same brand at 10:01:00 (healthy)
    const claim2 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      crypto.randomUUID(),
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_01_00,
    );

    assert.equal(claim2.reused, true);
    assert.equal(claim2.run.id, claim1.run.id);
    assert.equal(claim2.workerToken, null);

    const count = await db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.brandProfileId, testBrandId), eq(reportRuns.status, "running")));
    assert.equal(count.length, 1, "Exactly 1 active running run must exist");
  });

  // Test 9: Stale Run Recovery followed by New Job Creation in claimActiveOrNewReportRun
  it("recovers stale run on new claim and returns a fresh run with new ownership", async () => {
    const token1 = crypto.randomUUID();
    const claim1 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      token1,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );
    assert.equal(claim1.reused, false);

    // Next request arrives at 10:06:00 (6 mins later, stale)
    const token2 = crypto.randomUUID();
    const claim2 = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      token2,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_06_00,
    );

    assert.equal(claim2.reused, false, "Should create fresh run after recovering stale run");
    assert.equal(claim2.workerToken, token2);
    assert.notEqual(claim2.run.id, claim1.run.id);

    const [staleRun] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim1.run.id));
    assert.equal(staleRun!.status, "failed");
  });

  // Test 10: Concurrency Race: Two Simultaneous Claims for Same Brand
  it("safely handles concurrent claims for the same brand with exactly one new run and one reuse", async () => {
    const token1 = crypto.randomUUID();
    const token2 = crypto.randomUUID();

    const [res1, res2] = await Promise.all([
      claimActiveOrNewReportRun(
        db,
        testBrandId,
        `run_race_1_${crypto.randomUUID()}`,
        { stage: "url_validation" },
        token1,
        DEFAULT_STALE_LEASE_THRESHOLD_MS,
        T_10_00_00,
      ),
      claimActiveOrNewReportRun(
        db,
        testBrandId,
        `run_race_2_${crypto.randomUUID()}`,
        { stage: "url_validation" },
        token2,
        DEFAULT_STALE_LEASE_THRESHOLD_MS,
        T_10_00_00,
      ),
    ]);

    // Both should point to the exact same run id
    assert.equal(res1.run.id, res2.run.id);

    // Exactly one created it and one reused it
    const created = [res1, res2].filter((r) => !r.reused);
    const reused = [res1, res2].filter((r) => r.reused);
    assert.equal(created.length, 1);
    assert.equal(reused.length, 1);
    assert.notEqual(created[0]!.workerToken, null);
    assert.equal(reused[0]!.workerToken, null);

    const running = await db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.brandProfileId, testBrandId), eq(reportRuns.status, "running")));
    assert.equal(running.length, 1, "Partial unique index guarantees exactly one running run");
  });

  // Test 11: Concurrency Race: Simultaneous Heartbeat vs Stale Recovery
  it("resolves race between heartbeat renewal and stale recovery deterministically", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Fire both at boundary
    const [renewResult, recoveryResult] = await Promise.all([
      renewWorkerHeartbeat(db, claim.run.id, workerToken, T_10_05_01),
      recoverStaleReportRuns(db, testBrandId, DEFAULT_STALE_LEASE_THRESHOLD_MS, T_10_05_01),
    ]);

    const [finalRun] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    if (finalRun!.status === "failed") {
      assert.equal(recoveryResult, 1);
      // If recovery won, run is failed
      assert.equal(finalRun!.status, "failed");
    } else {
      // If renewal won, run remains running
      assert.equal(renewResult, true);
      assert.equal(finalRun!.status, "running");
    }
  });

  // Test 12: Concurrency Race: Multiple Concurrent Recovery Attempts
  it("safely handles multiple simultaneous recovery attempts so exactly one succeeds", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      { stage: "url_validation" },
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    const [rec1, rec2] = await Promise.all([
      recoverStaleReportRuns(db, testBrandId, DEFAULT_STALE_LEASE_THRESHOLD_MS, T_10_05_01),
      recoverStaleReportRuns(db, testBrandId, DEFAULT_STALE_LEASE_THRESHOLD_MS, T_10_05_01),
    ]);

    // Sum of rows updated must be exactly 1
    assert.equal(rec1 + rec2, 1);
    const [finalRun] = await db.select().from(reportRuns).where(eq(reportRuns.id, claim.run.id));
    assert.equal(finalRun!.status, "failed");
  });
});
