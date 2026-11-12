import { desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "../client.js";
import {
  brandProfiles,
  eventClusters,
  recommendations,
  reportRuns,
  signals,
  sourceRuns,
  sources,
} from "../schema.js";

export async function getDashboardSnapshot(db: AppDb, requestedRunId?: number) {
  const [brand] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.brandKey, "nsp-india"))
    .limit(1);

  const [counts] = await db
    .select({
      signalsCount: sql<number>`(SELECT count(*)::int FROM signals)`,
      clustersCount: sql<number>`(SELECT count(*)::int FROM event_clusters)`,
      reportsCount: sql<number>`(SELECT count(*)::int FROM report_runs WHERE status = 'completed')`,
      recommendationsCount: sql<number>`(SELECT count(*)::int FROM recommendations)`,
    })
    .from(brandProfiles)
    .limit(1);

  const recentRuns = await db
    .select({
      id: reportRuns.id,
      runKey: reportRuns.runKey,
      status: reportRuns.status,
      checkpointStage: reportRuns.checkpointStage,
      recommendationsCount: reportRuns.recommendationsCount,
      errorMessage: reportRuns.errorMessage,
      startedAt: reportRuns.startedAt,
      completedAt: reportRuns.completedAt,
      tokenUsageJson: reportRuns.tokenUsageJson,
    })
    .from(reportRuns)
    .orderBy(desc(reportRuns.id))
    .limit(12);

  const activeRun =
    (requestedRunId ? recentRuns.find((r) => r.id === requestedRunId) : undefined) ??
    recentRuns.find((r) => r.status === "completed") ??
    recentRuns[0] ??
    null;

  const activeRecommendations = activeRun
    ? await db
        .select({
          id: recommendations.id,
          reportRunId: recommendations.reportRunId,
          eventKey: recommendations.eventKey,
          title: recommendations.title,
          category: recommendations.category,
          risk: recommendations.risk,
          criticVerdict: recommendations.criticVerdict,
          combinedRankScore: recommendations.combinedRankScore,
          cardJson: recommendations.cardJson,
          createdAt: recommendations.createdAt,
        })
        .from(recommendations)
        .where(eq(recommendations.reportRunId, activeRun.id))
        .orderBy(desc(recommendations.combinedRankScore), recommendations.id)
    : [];

  const recentSignals = await db
    .select({
      id: signals.id,
      title: signals.title,
      url: signals.url,
      publisher: signals.publisher,
      publishedAt: signals.publishedAt,
      countryRelevance: signals.countryRelevance,
      sourceType: signals.sourceType,
    })
    .from(signals)
    .orderBy(desc(signals.publishedAt))
    .limit(20);

  const sourceList = await db
    .select({
      sourceId: sources.sourceId,
      name: sources.name,
      geoScope: sources.geoScope,
      enabled: sources.enabled,
      lastSuccessAt: sources.lastSuccessAt,
      lastError: sources.lastError,
    })
    .from(sources)
    .orderBy(sources.id);

  const latestSourceRuns = await db
    .select({
      runKey: sourceRuns.runKey,
      sourceId: sourceRuns.sourceId,
      status: sourceRuns.status,
      fetchedCount: sourceRuns.fetchedCount,
      inWindowCount: sourceRuns.inWindowCount,
      errorMessage: sourceRuns.errorMessage,
      finishedAt: sourceRuns.finishedAt,
    })
    .from(sourceRuns)
    .orderBy(desc(sourceRuns.id))
    .limit(6);

  return {
    brand: brand
      ? {
          brandKey: brand.brandKey,
          brandName: brand.brandName,
          targetMarket: brand.targetMarket,
          nextReportAt: brand.nextReportAt?.toISOString() ?? null,
          updatedAt: brand.updatedAt.toISOString(),
        }
      : null,
    counts: counts ?? {
      signalsCount: 0,
      clustersCount: 0,
      reportsCount: 0,
      recommendationsCount: 0,
    },
    recentRuns: recentRuns.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    activeRunId: activeRun?.id ?? null,
    recommendations: activeRecommendations.map((rec) => ({
      ...rec,
      createdAt: rec.createdAt.toISOString(),
    })),
    recentSignals: recentSignals.map((s) => ({
      ...s,
      publishedAt: s.publishedAt.toISOString(),
    })),
    sources: sourceList.map((s) => ({
      ...s,
      lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
    })),
    latestSourceRuns: latestSourceRuns.map((r) => ({
      ...r,
      finishedAt: r.finishedAt.toISOString(),
    })),
  };
}

