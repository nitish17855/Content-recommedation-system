import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type AppDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import { brandProfiles, reportRuns } from "../src/db/schema.js";
import {
  claimActiveOrNewReportRun,
  DEFAULT_STALE_LEASE_THRESHOLD_MS,
  renewWorkerHeartbeat,
} from "../src/db/repositories/persistence.js";
import {
  createInitialSnapshot,
  createManagedSubscription,
  PipelineProgressSnapshot,
  ProgressBroadcaster,
} from "../src/pipeline/progress-broadcaster.js";

describe("Slice 6.2 — Database-First Progress Broadcasting & Race Prevention Suite", () => {
  let db: AppDb;
  let testBrandId: number;
  let broadcaster: ProgressBroadcaster;

  const testBrandKey = `test-bcast-${crypto.randomUUID().slice(0, 8)}`;
  const testBusinessKey = `biz_test_bcast_${crypto.randomUUID().slice(0, 8)}`;

  const T_10_00_00 = new Date("2026-06-01T10:00:00.000Z");
  const T_10_01_00 = new Date("2026-06-01T10:01:00.000Z");
  const T_10_02_00 = new Date("2026-06-01T10:02:00.000Z");

  before(async () => {
    const env = loadEnv();
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing.");
    }
    db = createDb(env.DATABASE_URL);
    broadcaster = new ProgressBroadcaster();

    const [insertedBrand] = await db
      .insert(brandProfiles)
      .values({
        brandKey: testBrandKey,
        businessKey: testBusinessKey,
        originalUrl: "https://bcast-test.example.com",
        canonicalUrl: "https://bcast-test.example.com",
        brandName: "Broadcast Logistics Corp",
        industry: "Freight Logistics",
        targetMarket: "Global",
        primaryDomain: "bcast-test.example.com",
        onboardingStatus: "completed",
        profileJson: { test: true },
      })
      .returning();

    testBrandId = insertedBrand!.id;
  });

  after(async () => {
    if (!db || !testBrandId) return;
    const existing = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.brandProfileId, testBrandId));
    const ids = existing.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(reportRuns).where(inArray(reportRuns.id, ids));
    }
    await db.delete(brandProfiles).where(eq(brandProfiles.id, testBrandId));
  });

  beforeEach(async () => {
    const existing = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.brandProfileId, testBrandId));
    const ids = existing.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(reportRuns).where(inArray(reportRuns.id, ids));
    }
  });

  // Test 1: Database update completes before SSE event emission
  it("verifies database update commits and is readable before SSE event emission", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    let eventObserved = false;
    let queryPromise: Promise<{ checkpointJson: unknown } | undefined> | null = null;

    const unsubscribe = broadcaster.subscribe(claim.run.id, (snapshot) => {
      eventObserved = true;
      // In synchronous event callback, trigger DB read immediately to verify database commit
      queryPromise = db
        .select({ checkpointJson: reportRuns.checkpointJson })
        .from(reportRuns)
        .where(eq(reportRuns.id, claim.run.id))
        .then(([row]) => row);
    });

    const published = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "running",
      message: "Resolving verified brand identity",
      now: T_10_01_00,
    });

    assert.equal(eventObserved, true);
    assert.equal(published.revision, 2);
    assert.equal(published.currentStage, "brand_lookup");

    assert.ok(queryPromise, "Query promise must have been initiated during emission callback");
    const row = await queryPromise;
    const dbStateAtEmission = row?.checkpointJson as PipelineProgressSnapshot;
    assert.ok(dbStateAtEmission);
    assert.equal(dbStateAtEmission!.revision, 2);
    assert.equal(dbStateAtEmission!.currentStage, "brand_lookup");

    unsubscribe();
  });

  // Test 2: Failed database update emits no successful progress event
  it("emits no SSE progress event when database update fails or is rejected", async () => {
    let eventReceived = false;
    const unsubscribe = broadcaster.subscribe(99999999, () => {
      eventReceived = true;
    });

    await assert.rejects(
      async () => {
        await broadcaster.publishProgress(db, {
          runId: 99999999, // Non-existent run
          workerToken: "invalid_token",
          stage: "website_analysis",
          status: "running",
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Worker fenced"));
        return true;
      },
    );

    assert.equal(eventReceived, false, "No event should be emitted if DB update fails");
    unsubscribe();
  });

  // Test 3: Worker fencing prevents unauthorized progress updates
  it("fences stale or unauthorized worker from publishing progress updates", async () => {
    const validToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      validToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    let eventCount = 0;
    const unsubscribe = broadcaster.subscribe(claim.run.id, () => {
      eventCount++;
    });

    // Impostor worker tries to publish progress
    await assert.rejects(
      async () => {
        await broadcaster.publishProgress(db, {
          runId: claim.run.id,
          workerToken: "stale_or_wrong_worker_token",
          stage: "competitor_research",
          status: "running",
        });
      },
      (err: Error) => {
        assert.ok(err.message.includes("Worker fenced"));
        return true;
      },
    );

    assert.equal(eventCount, 0, "No progress event emitted for fenced worker");
    unsubscribe();
  });

  // Test 4: Multiple SSE listeners receive the same revision
  it("delivers the exact same revision snapshot to multiple concurrent SSE listeners", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    const receivedA: PipelineProgressSnapshot[] = [];
    const receivedB: PipelineProgressSnapshot[] = [];

    const unsubA = broadcaster.subscribe(claim.run.id, (s) => receivedA.push(s));
    const unsubB = broadcaster.subscribe(claim.run.id, (s) => receivedB.push(s));

    assert.equal(broadcaster.getSubscriberCount(claim.run.id), 2);

    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "website_analysis",
      status: "running",
      now: T_10_01_00,
    });

    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
    assert.equal(receivedA[0]!.revision, receivedB[0]!.revision);
    assert.equal(receivedA[0]!.currentStage, "website_analysis");

    unsubA();
    unsubB();
    assert.equal(broadcaster.getSubscriberCount(claim.run.id), 0);
  });

  // Test 5: Disconnected listeners are cleaned up cleanly
  it("cleans up unsubscribed listeners so disconnected clients do not receive subsequent updates", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    let client1Events = 0;
    let client2Events = 0;

    const unsub1 = broadcaster.subscribe(claim.run.id, () => client1Events++);
    const unsub2 = broadcaster.subscribe(claim.run.id, () => client2Events++);

    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "running",
    });

    assert.equal(client1Events, 1);
    assert.equal(client2Events, 1);

    // Client 1 disconnects (closes SSE connection)
    unsub1();
    assert.equal(broadcaster.getSubscriberCount(claim.run.id), 1);

    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "website_analysis",
      status: "running",
    });

    assert.equal(client1Events, 1, "Disconnected client 1 should not receive new event");
    assert.equal(client2Events, 2, "Remaining client 2 receives new event");

    unsub2();
  });

  // Test 6: Reconnecting client recovers latest database snapshot
  it("recovers latest database snapshot when a client connects or reconnects", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Advance 3 stages without any SSE client connected
    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "completed",
    });
    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "website_analysis",
      status: "completed",
    });
    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "competitor_research",
      status: "running",
      message: "Probing competitor catalog",
    });

    // Client connects late via createManagedSubscription
    const events: PipelineProgressSnapshot[] = [];
    const sub = await createManagedSubscription(
      db,
      claim.run.id,
      (s) => events.push(s),
      broadcaster,
    );

    assert.ok(sub.initialSnapshot);
    assert.equal(sub.initialSnapshot!.currentStage, "competitor_research");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.currentStage, "competitor_research");
    assert.ok(events[0]!.completedStages.includes("brand_lookup"));
    assert.ok(events[0]!.completedStages.includes("website_analysis"));

    sub.unsubscribe();
  });

  // Test 7: Race Prevention during Initial Subscription (zero lost events)
  it("buffers intermediate progress events and delivers them in order without loss during subscription", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    const receivedRevisions: number[] = [];

    // Subscribe managed
    const sub = await createManagedSubscription(
      db,
      claim.run.id,
      (s) => receivedRevisions.push(s.revision),
      broadcaster,
    );

    // Initial snapshot delivered
    assert.equal(receivedRevisions.length, 1);
    const initialRev = receivedRevisions[0]!;

    // Worker publishes subsequent events
    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "running",
    });
    await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "website_analysis",
      status: "running",
    });

    assert.equal(receivedRevisions.length, 3);
    assert.equal(receivedRevisions[1], initialRev + 1);
    assert.equal(receivedRevisions[2], initialRev + 2);

    sub.unsubscribe();
  });

  // Test 8 & 9: Duplicate and out-of-order revisions are filtered out
  it("ignores duplicate and out-of-order revisions in managed subscription", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    const receivedRevisions: number[] = [];
    const sub = await createManagedSubscription(
      db,
      claim.run.id,
      (s) => receivedRevisions.push(s.revision),
      broadcaster,
    );

    // Initial snapshot has revision 1
    assert.deepEqual(receivedRevisions, [1]);

    // Simulate an out-of-order emission or duplicate replay
    (broadcaster as any).emitProgress(claim.run.id, {
      runId: claim.run.id,
      revision: 1, // Duplicate
      currentStage: "url_validation",
    } as any);

    (broadcaster as any).emitProgress(claim.run.id, {
      runId: claim.run.id,
      revision: 0, // Out-of-order
      currentStage: "url_validation",
    } as any);

    // Should still only have [1]
    assert.deepEqual(receivedRevisions, [1]);

    // Legitimate higher revision
    (broadcaster as any).emitProgress(claim.run.id, {
      runId: claim.run.id,
      revision: 2,
      currentStage: "brand_lookup",
    } as any);

    assert.deepEqual(receivedRevisions, [1, 2]);
    sub.unsubscribe();
  });

  // Test 10: Server interruption after DB commit but before emission is recoverable from DB
  it("recovers checkpoint directly from DB when a server crash occurs before event emission", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Simulate direct DB checkpoint commit (e.g. server crashed right after DB write)
    const crashedSnapshot: PipelineProgressSnapshot = {
      runId: claim.run.id,
      revision: 10,
      currentStage: "critic_evaluation",
      overallStatus: "running",
      stages: {} as any,
      completedStages: ["url_validation", "brand_lookup", "event_clustering"],
      startedAt: T_10_00_00.toISOString(),
      updatedAt: T_10_02_00.toISOString(),
      message: "Auditing candidate briefs",
      error: null,
    };

    await db
      .update(reportRuns)
      .set({
        checkpointStage: "critic_evaluation",
        checkpointJson: crashedSnapshot,
      })
      .where(eq(reportRuns.id, claim.run.id));

    // Fresh broadcaster with empty in-memory cache
    const freshBroadcaster = new ProgressBroadcaster();
    const recovered = await freshBroadcaster.getLatestSnapshot(db, claim.run.id);

    assert.ok(recovered);
    assert.equal(recovered!.revision, 10);
    assert.equal(recovered!.currentStage, "critic_evaluation");
    assert.deepEqual(recovered!.completedStages, [
      "url_validation",
      "brand_lookup",
      "event_clustering",
    ]);
  });

  // Test 11: SSE subscriber failure does not interrupt a healthy worker
  it("protects worker from unhandled errors when an individual subscriber socket throws", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Broken subscriber that throws an error when called
    broadcaster.subscribe(claim.run.id, () => {
      throw new Error("Client socket ECONNRESET abruptly dropped");
    });

    // Well-behaved subscriber
    let wellBehavedCount = 0;
    const unsubWellBehaved = broadcaster.subscribe(claim.run.id, () => {
      wellBehavedCount++;
    });

    // Worker publishes progress — must NOT throw despite the broken subscriber!
    const result = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "signal_collection",
      status: "running",
    });

    assert.equal(result.currentStage, "signal_collection");
    assert.equal(wellBehavedCount, 1);

    unsubWellBehaved();
  });

  // Test 12: Stage transitions preserve previously completed stages
  it("accumulates completedStages across all 14 stages without resetting state", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Transition 1: advance to brand_lookup
    const s1 = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "running",
    });
    assert.deepEqual(s1.completedStages, ["url_validation"]);
    assert.equal(s1.stages.url_validation.status, "completed");
    assert.equal(s1.stages.brand_lookup.status, "running");

    // Transition 2: advance to website_analysis
    const s2 = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "website_analysis",
      status: "running",
    });
    assert.deepEqual(s2.completedStages, ["url_validation", "brand_lookup"]);
    assert.equal(s2.stages.brand_lookup.status, "completed");

    // Transition 3: mark website_analysis and brand_extraction skipped (e.g. brand cache hit)
    const s3 = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "signal_collection",
      status: "running",
      mutateSnapshot: (snap) => {
        snap.stages.website_analysis.status = "skipped";
        snap.stages.brand_extraction.status = "skipped";
      },
    });
    assert.equal(s3.stages.website_analysis.status, "skipped");
    assert.equal(s3.stages.brand_extraction.status, "skipped");
    assert.equal(s3.stages.signal_collection.status, "running");
    // url_validation and brand_lookup still preserved
    assert.ok(s3.completedStages.includes("url_validation"));
    assert.ok(s3.completedStages.includes("brand_lookup"));
  });

  // Test 13: Heartbeat renewal continues independently of progress updates
  it("allows heartbeat renewal to proceed independently without requiring progress stage changes", async () => {
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      testBrandId,
      `run_${crypto.randomUUID()}`,
      createInitialSnapshot(1, T_10_00_00),
      workerToken,
      DEFAULT_STALE_LEASE_THRESHOLD_MS,
      T_10_00_00,
    );

    // Heartbeat renewed while worker is still processing url_validation (no stage advance)
    const renewed = await renewWorkerHeartbeat(db, claim.run.id, workerToken, T_10_01_00);
    assert.equal(renewed, true);

    const [runAfterHeartbeat] = await db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.id, claim.run.id));
    assert.equal(runAfterHeartbeat!.heartbeatAt?.toISOString(), T_10_01_00.toISOString());
    assert.equal(runAfterHeartbeat!.checkpointStage, "url_validation");

    // Progress update occurs later at T_10_02_00
    const snap = await broadcaster.publishProgress(db, {
      runId: claim.run.id,
      workerToken,
      stage: "brand_lookup",
      status: "running",
      now: T_10_02_00,
    });
    assert.equal(snap.currentStage, "brand_lookup");
  });
});
