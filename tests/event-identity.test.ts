import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { CanonicalSignal } from "../src/ai/schemas.js";
import {
  clusterAndResolveSignals,
  clusterSignals,
  type PersistedClusterContext,
} from "../src/pipeline/cluster.js";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import {
  loadActiveEventClusters,
  persistCollectionRun,
} from "../src/db/repositories/persistence.js";
import { eventClusters, signals } from "../src/db/schema.js";

function makeSignal(params: {
  id: string;
  title: string;
  url: string;
  publisher?: string;
  publishedAt: string;
}): CanonicalSignal {
  return {
    signal_id: params.id,
    source_id: "test-source",
    title: params.title,
    url: params.url,
    publisher: params.publisher ?? "TechCrunch",
    published_at: params.publishedAt,
    fetched_at: params.publishedAt,
    source_type: "Tech blogs",
    country_relevance: "Global (India-relevant)",
    excerpt: params.title,
    content_hash: createHash("sha256").update(params.url).digest("hex"),
    keywords: [],
    summary: null,
  };
}

function toPersistedContext(cluster: ReturnType<typeof clusterSignals>[0]): PersistedClusterContext {
  const allUrls = new Set(cluster.signals.map((s) => s.url));
  const allHashes = new Set(cluster.signals.map((s) => s.content_hash));
  return {
    event_id: cluster.event_id,
    cluster_title: cluster.cluster_title,
    entities: new Set(cluster.entities ?? []),
    topicTokens: new Set(cluster.topic_tokens ?? []),
    signalUrls: allUrls,
    signalHashes: allHashes,
    firstSeenAt: Date.parse(cluster.first_seen_at),
    lastSeenAt: Date.parse(cluster.last_seen_at),
  };
}

async function runTests() {
  console.log("=== Testing Event Identity & Active Cluster Reconciliation ===");

  const article1 = makeSignal({
    id: "sig_1",
    title: "HubSpot launches AI prospecting agent for B2B sales teams",
    url: "https://techcrunch.com/2026/11/10/hubspot-ai-prospecting-agent",
    publisher: "TechCrunch",
    publishedAt: "2026-11-10T10:00:00.000Z",
  });

  const article2 = makeSignal({
    id: "sig_2",
    title: "HubSpot adds automated AI SDR prospecting agent to enterprise CRM",
    url: "https://saastr.com/2026/11/11/hubspot-adds-automated-sdr-sequence-agent",
    publisher: "SaaStr",
    publishedAt: "2026-11-11T12:00:00.000Z",
  });

  const article3 = makeSignal({
    id: "sig_3",
    title: "HubSpot autonomous AI SDR and prospecting workflows explained",
    url: "https://venturebeat.com/2026/11/12/hubspot-autonomous-sdr-prospecting-workflows",
    publisher: "VentureBeat",
    publishedAt: "2026-11-12T14:00:00.000Z",
  });

  const articleDistinct = makeSignal({
    id: "sig_distinct",
    title: "HubSpot reports Q3 financial earnings and revenue acceleration",
    url: "https://cnbc.com/2026/11/11/hubspot-q3-earnings-acceleration",
    publisher: "CNBC",
    publishedAt: "2026-11-11T16:00:00.000Z",
  });

  // Test 1: Day 1 - Genesis
  console.log("[Test 1] Day 1: Single article creates 1 persistent event...");
  const day1Clusters = clusterAndResolveSignals([article1], []);
  assert.equal(day1Clusters.length, 1, "Day 1 should produce exactly 1 cluster");
  const day1EventId = day1Clusters[0]!.event_id;
  assert.ok(day1EventId.startsWith("evt_"), `Event ID should start with evt_, got: ${day1EventId}`);
  assert.equal(day1Clusters[0]!.signals.length, 1);
  console.log(`  Passed! Day 1 event_id: ${day1EventId}`);

  // Test 2: Day 2 - New URL follow-up must reuse the original event ID
  console.log("[Test 2] Day 2: New URL follow-up must reuse original event ID...");
  const activeAfterDay1 = [toPersistedContext(day1Clusters[0]!)];
  const day2Clusters = clusterAndResolveSignals([article1, article2], activeAfterDay1);
  assert.equal(day2Clusters.length, 1, "Day 2 should maintain exactly 1 cluster");
  assert.equal(day2Clusters[0]!.event_id, day1EventId, "Day 2 must reuse Day 1 event_id!");
  assert.equal(day2Clusters[0]!.signals.length, 2, "Cluster should now contain both signals");
  assert.equal(day2Clusters[0]!.independent_source_count, 2, "Source count should be 2");
  console.log(`  Passed! Reused event_id: ${day2Clusters[0]!.event_id}`);

  // Test 3: Day 3 - Token drift must NOT alter the event ID
  console.log("[Test 3] Day 3: Influx of new topic tokens must NOT alter event ID...");
  const activeAfterDay2 = [toPersistedContext(day2Clusters[0]!)];
  const day3Clusters = clusterAndResolveSignals([article1, article2, article3], activeAfterDay2);
  assert.equal(day3Clusters.length, 1, "Day 3 should maintain exactly 1 cluster");
  assert.equal(day3Clusters[0]!.event_id, day1EventId, "Day 3 must STILL have the exact same event_id!");
  assert.equal(day3Clusters[0]!.signals.length, 3, "Cluster should now contain all 3 signals");
  console.log(`  Passed! Maintained stable event_id: ${day3Clusters[0]!.event_id}`);

  // Test 4: Rolling-Window Eviction - Day 1 drops out of incoming signals
  console.log("[Test 4] Rolling window: Article 1 evicted from incoming batch...");
  const activeAfterDay3 = [toPersistedContext(day3Clusters[0]!)];
  const rollingClusters = clusterAndResolveSignals([article2, article3], activeAfterDay3);
  assert.equal(rollingClusters.length, 1, "Evicted batch should still reconcile to exactly 1 cluster");
  assert.equal(rollingClusters[0]!.event_id, day1EventId, "Must STILL preserve original event_id when Day 1 drops!");
  console.log(`  Passed! Preserved event_id across rolling window eviction.`);

  // Test 5: Repeated-run Idempotency
  console.log("[Test 5] Idempotency: Processing identical batch a second time...");
  const repeatClusters = clusterAndResolveSignals([article2, article3], activeAfterDay3);
  assert.equal(repeatClusters.length, 1);
  assert.equal(repeatClusters[0]!.event_id, day1EventId);
  console.log(`  Passed! Idempotent output.`);

  // Test 6: Distinct Story Separation
  console.log("[Test 6] Distinct event separation: Same entity (HubSpot), different story...");
  const mixedClusters = clusterAndResolveSignals([article1, articleDistinct], []);
  assert.equal(mixedClusters.length, 2, "Unrelated stories about same entity must remain 2 distinct clusters!");
  assert.notEqual(mixedClusters[0]!.event_id, mixedClusters[1]!.event_id, "Event IDs must be distinct");
  console.log(`  Passed! Separated into 2 clusters:`);
  console.log(`    - Cluster 1: "${mixedClusters[0]!.cluster_title}" (${mixedClusters[0]!.event_id})`);
  console.log(`    - Cluster 2: "${mixedClusters[1]!.cluster_title}" (${mixedClusters[1]!.event_id})`);

  console.log("\nAll 6 core identity-resolution tests PASSED successfully!");

  // Live Neon Database Persistence Test
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.log("\n[Neon DB Test] Skipped: DATABASE_URL not set.");
    return;
  }

  console.log("\n=== Testing Live Neon DB Persistence Across 3 Collection Runs ===");
  const db = createDb(env.DATABASE_URL);
  const testUrls = [article1.url, article2.url, article3.url, articleDistinct.url];

  try {
    // Cleanup any prior test artifacts
    await db.delete(signals).where(inArray(signals.url, testUrls));
    await db.delete(eventClusters).where(like(eventClusters.eventKey, "%hubspot%"));

    // Run 1 (Day 1)
    console.log("[Neon DB Test] Run 1 (Day 1): Persisting Article 1...");
    const run1Active = await loadActiveEventClusters(db, 14);
    const run1Clusters = clusterAndResolveSignals([article1], run1Active);
    await persistCollectionRun(db, "test-collection-day1", [], run1Clusters);

    const dbClustersDay1 = await db
      .select()
      .from(eventClusters)
      .where(eq(eventClusters.eventKey, day1EventId));
    assert.equal(dbClustersDay1.length, 1, "Neon DB must have exactly 1 record after Day 1");
    const day1ClusterId = dbClustersDay1[0]!.id;
    console.log(`  Passed! Neon event record created: id=${day1ClusterId}, key=${day1EventId}`);

    // Run 2 (Day 2)
    console.log("[Neon DB Test] Run 2 (Day 2): Persisting follow-up Article 2...");
    const run2Active = await loadActiveEventClusters(db, 14);
    const run2Clusters = clusterAndResolveSignals([article1, article2], run2Active);
    await persistCollectionRun(db, "test-collection-day2", [], run2Clusters);

    const dbClustersDay2 = await db
      .select()
      .from(eventClusters)
      .where(eq(eventClusters.eventKey, day1EventId));
    assert.equal(dbClustersDay2.length, 1, "Neon DB must STILL have exactly 1 record after Day 2!");
    assert.equal(dbClustersDay2[0]!.id, day1ClusterId, "Neon cluster ID must remain identical on Day 2!");

    const dbSignalsDay2 = await db
      .select()
      .from(signals)
      .where(eq(signals.clusterId, day1ClusterId));
    assert.equal(dbSignalsDay2.length, 2, "Neon must now link 2 signals to the same cluster record");
    console.log(`  Passed! Neon record updated in-place: id=${day1ClusterId}, signals=${dbSignalsDay2.length}`);

    // Run 3 (Day 3)
    console.log("[Neon DB Test] Run 3 (Day 3): Persisting follow-up Article 3 with new tokens...");
    const run3Active = await loadActiveEventClusters(db, 14);
    const run3Clusters = clusterAndResolveSignals([article1, article2, article3], run3Active);
    await persistCollectionRun(db, "test-collection-day3", [], run3Clusters);

    const dbClustersDay3 = await db
      .select()
      .from(eventClusters)
      .where(eq(eventClusters.eventKey, day1EventId));
    assert.equal(dbClustersDay3.length, 1, "Neon DB must STILL have exactly 1 record after Day 3!");
    assert.equal(dbClustersDay3[0]!.id, day1ClusterId, "Neon cluster ID must remain identical on Day 3!");

    const dbSignalsDay3 = await db
      .select()
      .from(signals)
      .where(eq(signals.clusterId, day1ClusterId));
    assert.equal(dbSignalsDay3.length, 3, "Neon must now link all 3 signals to the same cluster record");
    console.log(`  Passed! Neon record updated in-place: id=${day1ClusterId}, signals=${dbSignalsDay3.length}`);

    // Rolling-window test
    console.log("[Neon DB Test] Rolling Window: Ingesting batch with Article 1 evicted...");
    const run4Active = await loadActiveEventClusters(db, 14);
    const run4Clusters = clusterAndResolveSignals([article2, article3], run4Active);
    await persistCollectionRun(db, "test-collection-rolling", [], run4Clusters);

    const dbClustersRolling = await db
      .select()
      .from(eventClusters)
      .where(eq(eventClusters.eventKey, day1EventId));
    assert.equal(dbClustersRolling.length, 1, "Neon DB must STILL have exactly 1 record after rolling eviction!");
    assert.equal(dbClustersRolling[0]!.id, day1ClusterId, "Cluster ID preserved across rolling window!");
    console.log(`  Passed! Exactly 1 record preserved in Neon across rolling eviction.`);

    console.log("\n=== All Neon DB multi-day persistence tests PASSED successfully! ===");
  } finally {
    await db.delete(signals).where(inArray(signals.url, testUrls));
    await db.delete(eventClusters).where(like(eventClusters.eventKey, "%hubspot%"));
    console.log("[Neon DB Test] Cleaned up temporary test rows.");
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
