import { and, desc, eq, or, sql } from "drizzle-orm";
import type { AppDb } from "../client.js";
import {
  brandProfiles,
  brandSources,
  eventClusters,
  recommendations,
  reportRuns,
  signals,
  sourceRuns,
  sources,
} from "../schema.js";
import { normalizeRecommendationCard } from "../../ai/compatibility/recommendation-normalizer.js";

export async function getDashboardSnapshot(
  db: AppDb,
  requestedRunId?: number,
  brandIdentifier?: string | number,
) {
  let brand: typeof brandProfiles.$inferSelect | null = null;

  if (requestedRunId) {
    const [reqRun] = await db
      .select({ id: reportRuns.id, brandProfileId: reportRuns.brandProfileId })
      .from(reportRuns)
      .where(eq(reportRuns.id, requestedRunId))
      .limit(1);
    if (reqRun?.brandProfileId) {
      const [b] = await db
        .select()
        .from(brandProfiles)
        .where(eq(brandProfiles.id, reqRun.brandProfileId))
        .limit(1);
      brand = b ?? null;
    }
  }

  if (!brand && brandIdentifier !== undefined) {
    if (typeof brandIdentifier === "number") {
      const [b] = await db
        .select()
        .from(brandProfiles)
        .where(eq(brandProfiles.id, brandIdentifier))
        .limit(1);
      brand = b ?? null;
    } else if (typeof brandIdentifier === "string" && brandIdentifier.trim()) {
      const [b] = await db
        .select()
        .from(brandProfiles)
        .where(
          or(
            eq(brandProfiles.businessKey, brandIdentifier),
            eq(brandProfiles.brandKey, brandIdentifier),
          ),
        )
        .limit(1);
      brand = b ?? null;
    }
  }

  if (!brand) {
    const [b] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.brandKey, "nsp-india"))
      .limit(1);
    brand = b ?? null;
  }

  if (!brand) {
    const allBrands = await db.select().from(brandProfiles).limit(1);
    brand = allBrands[0] ?? null;
  }

  const [counts] = await db
    .select({
      signalsCount: sql<number>`(SELECT count(*)::int FROM signals)`,
      clustersCount: sql<number>`(SELECT count(*)::int FROM event_clusters)`,
      reportsCount: sql<number>`(SELECT count(*)::int FROM report_runs WHERE status = 'completed')`,
      recommendationsCount: sql<number>`(SELECT count(*)::int FROM recommendations)`,
    })
    .from(brandProfiles)
    .limit(1);

  const runsQuery = db
    .select({
      id: reportRuns.id,
      brandProfileId: reportRuns.brandProfileId,
      runKey: reportRuns.runKey,
      status: reportRuns.status,
      checkpointStage: reportRuns.checkpointStage,
      recommendationsCount: reportRuns.recommendationsCount,
      errorMessage: reportRuns.errorMessage,
      startedAt: reportRuns.startedAt,
      completedAt: reportRuns.completedAt,
      tokenUsageJson: reportRuns.tokenUsageJson,
    })
    .from(reportRuns);

  const recentRuns = brand
    ? await runsQuery
        .where(
          or(
            eq(reportRuns.brandProfileId, brand.id),
            sql`${reportRuns.brandProfileId} IS NULL`,
          ),
        )
        .orderBy(desc(reportRuns.id))
        .limit(12)
    : await runsQuery.orderBy(desc(reportRuns.id)).limit(12);

  const activeRun =
    (requestedRunId ? recentRuns.find((r) => r.id === requestedRunId) : undefined) ??
    recentRuns.find((r) => r.status === "completed" && (r.recommendationsCount ?? 0) > 0) ??
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

  const sourceList = brand
    ? await db
        .select({
          sourceId: sources.sourceId,
          name: sources.name,
          geoScope: sources.geoScope,
          enabled: brandSources.enabled,
          lastSuccessAt: sources.lastSuccessAt,
          lastError: sources.lastError,
        })
        .from(brandSources)
        .innerJoin(sources, eq(brandSources.sourceId, sources.id))
        .where(eq(brandSources.brandProfileId, brand.id))
        .orderBy(sources.id)
    : await db
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
          id: brand.id,
          brandKey: brand.brandKey,
          businessKey: brand.businessKey,
          originalUrl: brand.originalUrl,
          canonicalUrl: brand.canonicalUrl,
          industry: brand.industry,
          brandName: brand.brandName,
          targetMarket: brand.targetMarket,
          onboardingStatus: brand.onboardingStatus,
          nextReportAt: brand.nextReportAt?.toISOString() ?? null,
          lastCrawledAt: brand.lastCrawledAt?.toISOString() ?? null,
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
    marketScan: (activeRun?.tokenUsageJson as { marketScan?: unknown } | null)?.marketScan ?? null,
    recommendations: activeRecommendations.map((rec) => ({
      ...rec,
      cardJson: normalizeRecommendationCard(rec.cardJson),
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
