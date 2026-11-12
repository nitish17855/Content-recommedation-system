import { desc, eq, gte, sql } from "drizzle-orm";
import type { AppDb } from "../client.js";
import {
  brandProfiles,
  competitors,
  contextPacks,
  eventClusters,
  recommendations,
  reportRuns,
  services,
  signals,
  sourceRuns,
  sources,
} from "../schema.js";
import type {
  ContextPack,
  EventCluster,
  RecommendationCard,
  SourceConfig,
  SourceRunResult,
} from "../../ai/schemas.js";
import type { SeedDataset } from "../../data/loader.js";

export async function syncSeedData(
  db: AppDb,
  seeds: SeedDataset,
  sourceRegistry: SourceConfig[],
): Promise<void> {
  const brandKey = "nsp-india";
  const brandName = String(seeds.brandProfile.brand ?? "NSP Global Services");
  const targetMarket = String(seeds.brandProfile.target_market ?? "India");
  const primaryDomain = String(seeds.brandProfile.primary_domain ?? "https://www.nspglobalservices.com/");
  const secondaryDomain = seeds.brandProfile.secondary_domain
    ? String(seeds.brandProfile.secondary_domain)
    : null;

  await db
    .insert(brandProfiles)
    .values({
      brandKey,
      brandName,
      targetMarket,
      primaryDomain,
      secondaryDomain,
      profileJson: seeds.brandProfile,
    })
    .onConflictDoUpdate({
      target: brandProfiles.brandKey,
      set: {
        brandName,
        targetMarket,
        primaryDomain,
        secondaryDomain,
        profileJson: seeds.brandProfile,
        updatedAt: new Date(),
      },
    });

  for (const svc of seeds.services) {
    const serviceId = String(svc.service_id);
    await db
      .insert(services)
      .values({
        serviceId,
        name: String(svc.name),
        category: String(svc.category ?? "General"),
        statusIndia: String(svc.status_india ?? "needs_confirmation"),
        indiaPricing: svc.india_pricing ? String(svc.india_pricing) : null,
        detailsJson: svc,
      })
      .onConflictDoUpdate({
        target: services.serviceId,
        set: {
          name: String(svc.name),
          category: String(svc.category ?? "General"),
          statusIndia: String(svc.status_india ?? "needs_confirmation"),
          indiaPricing: svc.india_pricing ? String(svc.india_pricing) : null,
          detailsJson: svc,
          updatedAt: new Date(),
        },
      });
  }

  const competitorGroups: Array<[string, string]> = [
    ["direct_india", "direct_india"],
    ["direct_uk_reference", "direct_uk_reference"],
    ["indirect_alternatives", "indirect"],
    ["adjacent_creative_references", "adjacent"],
  ];

  for (const [groupKey, classification] of competitorGroups) {
    const list = seeds.competitors[groupKey];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rec = item as Record<string, unknown>;
      const name = String(rec.name ?? "unknown");
      const slug = `${classification}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      await db
        .insert(competitors)
        .values({
          slug,
          name,
          market: String(rec.market ?? "India"),
          classification,
          website: rec.website ? String(rec.website) : null,
          detailsJson: rec,
        })
        .onConflictDoUpdate({
          target: competitors.slug,
          set: {
            name,
            market: String(rec.market ?? "India"),
            classification,
            website: rec.website ? String(rec.website) : null,
            detailsJson: rec,
            updatedAt: new Date(),
          },
        });
    }
  }

  for (const src of sourceRegistry) {
    await db
      .insert(sources)
      .values({
        sourceId: src.id,
        name: src.name,
        feedUrl: src.feedUrl,
        sourceType: src.sourceType,
        geoScope: src.geoScope,
        enabled: src.enabled,
      })
      .onConflictDoUpdate({
        target: sources.sourceId,
        set: {
          name: src.name,
          feedUrl: src.feedUrl,
          sourceType: src.sourceType,
          geoScope: src.geoScope,
          enabled: src.enabled,
          updatedAt: new Date(),
        },
      });
  }
}

export async function persistCollectionRun(
  db: AppDb,
  collectionRunKey: string,
  runs: SourceRunResult[],
  clusters: EventCluster[],
): Promise<void> {
  const now = new Date();

  for (const run of runs) {
    await db.insert(sourceRuns).values({
      runKey: collectionRunKey,
      sourceId: run.sourceId,
      status: run.status,
      fetchedCount: run.fetchedCount,
      inWindowCount: run.inWindowCount,
      errorMessage: run.error ?? null,
      startedAt: now,
      finishedAt: now,
    });

    if (run.status === "ok") {
      await db
        .update(sources)
        .set({ lastSuccessAt: now, lastError: null, updatedAt: now })
        .where(eq(sources.sourceId, run.sourceId));
    } else if (run.status === "error") {
      await db
        .update(sources)
        .set({ lastError: run.error ?? "Unknown error", updatedAt: now })
        .where(eq(sources.sourceId, run.sourceId));
    }
  }

  for (const cluster of clusters) {
    const eventKey = `${cluster.last_seen_at.slice(0, 10)}_${cluster.signals[0]?.content_hash.slice(0, 12) ?? cluster.event_id}`;
    const [upsertedCluster] = await db
      .insert(eventClusters)
      .values({
        eventKey,
        clusterTitle: cluster.cluster_title,
        firstSeenAt: new Date(cluster.first_seen_at),
        lastSeenAt: new Date(cluster.last_seen_at),
        independentSourceCount: cluster.independent_source_count,
        sourceDiversity: cluster.source_diversity,
        countryRelevance: cluster.country_relevance,
        keywordsJson: cluster.keywords,
        status: cluster.status,
      })
      .onConflictDoUpdate({
        target: eventClusters.eventKey,
        set: {
          lastSeenAt: new Date(cluster.last_seen_at),
          independentSourceCount: cluster.independent_source_count,
          sourceDiversity: cluster.source_diversity,
          keywordsJson: cluster.keywords,
          status: cluster.status,
          updatedAt: now,
        },
      })
      .returning({ id: eventClusters.id });

    const clusterId = upsertedCluster?.id ?? null;

    for (const sig of cluster.signals) {
      await db
        .insert(signals)
        .values({
          contentHash: sig.content_hash,
          sourceId: sig.source_id,
          clusterId,
          title: sig.title,
          url: sig.url,
          publisher: sig.publisher,
          publishedAt: new Date(sig.published_at),
          fetchedAt: new Date(sig.fetched_at),
          sourceType: sig.source_type,
          countryRelevance: sig.country_relevance,
          excerpt: sig.excerpt,
          keywordsJson: sig.keywords,
          summary: sig.summary,
        })
        .onConflictDoUpdate({
          target: signals.url,
          set: {
            clusterId,
            fetchedAt: new Date(sig.fetched_at),
            excerpt: sig.excerpt,
          },
        });
    }
  }
}

export async function isReportDue(
  db: AppDb,
  brandKey: string,
  now: Date = new Date(),
): Promise<{ due: boolean; nextReportAt: Date | null }> {
  const [profile] = await db
    .select({ nextReportAt: brandProfiles.nextReportAt })
    .from(brandProfiles)
    .where(eq(brandProfiles.brandKey, brandKey))
    .limit(1);

  if (!profile || !profile.nextReportAt) {
    return { due: true, nextReportAt: null };
  }
  return {
    due: now.getTime() >= profile.nextReportAt.getTime(),
    nextReportAt: profile.nextReportAt,
  };
}

export async function loadRecentClustersFromDb(
  db: AppDb,
  lookbackDays: number,
): Promise<Array<{ dbClusterId: number; cluster: EventCluster }>> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(eventClusters)
    .where(gte(eventClusters.lastSeenAt, cutoff))
    .orderBy(desc(eventClusters.lastSeenAt))
    .limit(100);

  const out: Array<{ dbClusterId: number; cluster: EventCluster }> = [];
  for (const row of rows) {
    const sigRows = await db
      .select()
      .from(signals)
      .where(eq(signals.clusterId, row.id));

    if (sigRows.length === 0) continue;

    out.push({
      dbClusterId: row.id,
      cluster: {
        event_id: row.eventKey,
        cluster_title: row.clusterTitle,
        signal_ids: sigRows.map((s) => `sig_${s.id}`),
        signals: sigRows.map((s) => ({
          signal_id: `sig_${s.id}`,
          source_id: s.sourceId,
          title: s.title,
          url: s.url,
          publisher: s.publisher,
          published_at: s.publishedAt.toISOString(),
          fetched_at: s.fetchedAt.toISOString(),
          source_type: s.sourceType as EventCluster["signals"][number]["source_type"],
          country_relevance: s.countryRelevance as EventCluster["country_relevance"],
          excerpt: s.excerpt,
          content_hash: s.contentHash,
          keywords: Array.isArray(s.keywordsJson) ? (s.keywordsJson as string[]) : [],
          summary: s.summary,
        })),
        first_seen_at: row.firstSeenAt.toISOString(),
        last_seen_at: row.lastSeenAt.toISOString(),
        independent_source_count: row.independentSourceCount,
        source_diversity: row.sourceDiversity,
        country_relevance: row.countryRelevance as EventCluster["country_relevance"],
        keywords: Array.isArray(row.keywordsJson) ? (row.keywordsJson as string[]) : [],
        status: row.status === "expired" ? "expired" : "active",
      },
    });
  }
  return out;
}

export async function claimOrResumeReportRun(db: AppDb, runKey: string) {
  const inserted = await db
    .insert(reportRuns)
    .values({
      runKey,
      status: "running",
      checkpointStage: "started",
      recommendationsCount: 0,
    })
    .onConflictDoNothing({ target: reportRuns.runKey })
    .returning();

  if (inserted.length > 0) {
    return { action: "claimed" as const, run: inserted[0]! };
  }

  const [existing] = await db
    .select()
    .from(reportRuns)
    .where(eq(reportRuns.runKey, runKey))
    .limit(1);

  if (!existing) {
    throw new Error(`Failed to claim or locate report_runs entry for runKey=${runKey}`);
  }

  if (existing.status === "completed") {
    return { action: "already_completed" as const, run: existing };
  }

  // Re-open failed/stalled run so checkpoints can resume cleanly
  const [resumed] = await db
    .update(reportRuns)
    .set({ status: "running", errorMessage: null })
    .where(eq(reportRuns.id, existing.id))
    .returning();

  return { action: "resumed" as const, run: resumed! };
}

export async function updateRunCheckpoint(
  db: AppDb,
  reportRunId: number,
  stage: string,
  checkpointData: unknown,
): Promise<void> {
  await db
    .update(reportRuns)
    .set({
      checkpointStage: stage,
      checkpointJson: checkpointData,
    })
    .where(eq(reportRuns.id, reportRunId));
}

export async function completeReportRunAndAdvanceSchedule(
  db: AppDb,
  params: {
    reportRunId: number;
    brandKey: string;
    intervalDays: number;
    cards: RecommendationCard[];
    packs: ContextPack[];
    clusterIdByEventKey: Map<string, number>;
    modelUsed: string;
    tokenUsage: unknown;
  },
): Promise<void> {
  const now = new Date();
  const nextReportAt = new Date(now.getTime() + params.intervalDays * 24 * 60 * 60 * 1000);

  for (const pack of params.packs) {
    await db.insert(contextPacks).values({
      clusterId: params.clusterIdByEventKey.get(pack.event_id) ?? null,
      eventKey: pack.event_id,
      contextJson: pack,
      modelUsed: params.modelUsed,
    });
  }

  for (const card of params.cards) {
    await db.insert(recommendations).values({
      reportRunId: params.reportRunId,
      clusterId: params.clusterIdByEventKey.get(card.metadata.event_id) ?? null,
      eventKey: card.metadata.event_id,
      title: card.title,
      category: card.category,
      status: "published",
      risk: card.risk,
      criticVerdict: card.metadata.critic_verdict,
      deterministicScore: card.metadata.deterministic_evidence_score,
      aiRubricScore: card.metadata.ai_rubric_score,
      combinedRankScore: card.metadata.combined_rank_score,
      cardJson: card,
    });
  }

  await db
    .update(reportRuns)
    .set({
      status: "completed",
      checkpointStage: "completed",
      recommendationsCount: params.cards.length,
      tokenUsageJson: params.tokenUsage,
      completedAt: now,
    })
    .where(eq(reportRuns.id, params.reportRunId));

  // Advance next_report_at ONLY after report generation fully completes
  await db
    .update(brandProfiles)
    .set({
      nextReportAt,
      updatedAt: sql`NOW()`,
    })
    .where(eq(brandProfiles.brandKey, params.brandKey));
}

export async function markReportRunFailed(
  db: AppDb,
  reportRunId: number,
  errorMessage: string,
): Promise<void> {
  await db
    .update(reportRuns)
    .set({
      status: "failed",
      errorMessage,
    })
    .where(eq(reportRuns.id, reportRunId));
}

