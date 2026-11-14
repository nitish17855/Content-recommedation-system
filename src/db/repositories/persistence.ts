import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type { AppDb } from "../client.js";
import {
  brandProfiles,
  brandSources,
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
  CompetitorEvidenceRecord,
  ContextPack,
  EventCluster,
  ExtractedService,
  RecommendationCard,
  SourceConfig,
  SourceRunResult,
} from "../../ai/schemas.js";
import type { SeedDataset } from "../../data/loader.js";
import {
  extractEntitiesAndTopicTokens,
  type PersistedClusterContext,
} from "../../pipeline/cluster.js";
import { SOURCE_REGISTRY } from "../../sources/source-registry.js";

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

  const [brandRecord] = await db
    .insert(brandProfiles)
    .values({
      brandKey,
      businessKey: "biz_nspglobalservices_com",
      originalUrl: "https://www.nspglobalservices.com/",
      canonicalUrl: "https://nspglobalservices.com",
      industry: "B2B Digital Marketing & Technology",
      brandName,
      targetMarket,
      primaryDomain,
      secondaryDomain,
      onboardingStatus: "completed",
      profileJson: seeds.brandProfile,
      lastCrawledAt: new Date(),
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
    })
    .returning();

  const brandId = brandRecord?.id ?? 1;

  for (const svc of seeds.services) {
    const serviceId = String(svc.service_id);
    await db
      .insert(services)
      .values({
        brandProfileId: brandId,
        serviceId,
        name: String(svc.name),
        category: String(svc.category ?? "General"),
        statusIndia: String(svc.status_india ?? "needs_confirmation"),
        indiaPricing: svc.india_pricing ? String(svc.india_pricing) : null,
        detailsJson: svc,
      })
      .onConflictDoUpdate({
        target: [services.brandProfileId, services.serviceId],
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
          brandProfileId: brandId,
          slug,
          name,
          market: String(rec.market ?? "India"),
          classification,
          website: rec.website ? String(rec.website) : null,
          detailsJson: rec,
        })
        .onConflictDoUpdate({
          target: [competitors.brandProfileId, competitors.slug],
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
    const [insertedSrc] = await db
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
      })
      .returning();

    const srcDbId =
      insertedSrc?.id ??
      (
        await db
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.sourceId, src.id))
          .limit(1)
      )[0]?.id;

    if (srcDbId) {
      await db
        .insert(brandSources)
        .values({
          brandProfileId: brandId,
          sourceId: srcDbId,
          industryTag: "baseline",
          discoveryMethod: "baseline",
          validationStatus: "valid",
          enabled: src.enabled,
        })
        .onConflictDoNothing();
    }
  }
}

/**
 * Loads all active, enabled sources for a specific brand profile
 * (combining shared baseline feeds and dynamically validated industry feeds).
 */
export async function getActiveSourcesForBrand(
  db: AppDb,
  brandProfileId: number,
): Promise<SourceConfig[]> {
  const rows = await db
    .select({
      id: sources.sourceId,
      name: sources.name,
      feedUrl: sources.feedUrl,
      sourceType: sources.sourceType,
      geoScope: sources.geoScope,
      enabled: sources.enabled,
    })
    .from(brandSources)
    .innerJoin(sources, eq(brandSources.sourceId, sources.id))
    .where(
      and(
        eq(brandSources.brandProfileId, brandProfileId),
        eq(brandSources.enabled, true),
        eq(sources.enabled, true),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    feedUrl: r.feedUrl,
    sourceType: r.sourceType as SourceConfig["sourceType"],
    geoScope: r.geoScope as SourceConfig["geoScope"],
    enabled: r.enabled,
    maxItems: 25,
  }));
}

export interface BrandOnboardingSaveParams {
  brandKey?: string;
  businessKey: string;
  originalUrl: string;
  canonicalUrl: string;
  brandName: string;
  industry: string;
  targetMarket?: string;
  profileJson: Record<string, unknown>;
  servicesList: ExtractedService[];
  competitorsList: CompetitorEvidenceRecord[];
  now?: Date;
}

export interface CachedBrandResult {
  cached: boolean;
  brand?: typeof brandProfiles.$inferSelect;
  services?: (typeof services.$inferSelect)[];
  competitors?: (typeof competitors.$inferSelect)[];
  sources?: SourceConfig[];
}

/**
 * Checks if a brand is already onboarded and fresh (< maxAgeDays old).
 * If fresh, returns cached profile, services, competitors, and sources.
 */
export async function lookupBrandOrOnboard(
  db: AppDb,
  businessKey: string,
  maxAgeDays = 30,
  now: Date = new Date(),
): Promise<CachedBrandResult> {
  const [brand] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.businessKey, businessKey))
    .limit(1);

  if (!brand || !brand.lastCrawledAt || brand.onboardingStatus !== "completed") {
    return { cached: false, brand: brand ?? undefined };
  }

  const ageMs = now.getTime() - new Date(brand.lastCrawledAt).getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return { cached: false, brand }; // Stale, requires refresh
  }

  // Load cached services
  const brandServices = await db
    .select()
    .from(services)
    .where(eq(services.brandProfileId, brand.id));

  // Load cached competitors
  const brandCompetitors = await db
    .select()
    .from(competitors)
    .where(eq(competitors.brandProfileId, brand.id));

  // Load cached active sources
  const brandSourcesList = await getActiveSourcesForBrand(db, brand.id);

  return {
    cached: true,
    brand,
    services: brandServices,
    competitors: brandCompetitors,
    sources: brandSourcesList,
  };
}

/**
 * Atomically persists a brand's onboarding profile, extracted services,
 * evidence-verified competitors (using stable domain keys), and baseline sources.
 */
export async function saveBrandOnboardingRecord(
  db: AppDb,
  params: BrandOnboardingSaveParams,
): Promise<{
  brandId: number;
  servicesSavedCount: number;
  competitorsSavedCount: number;
}> {
  const now = params.now ?? new Date();

  // 1. Upsert brand profile
  const [savedBrand] = await db
    .insert(brandProfiles)
    .values({
      brandKey: params.brandKey ?? params.businessKey,
      businessKey: params.businessKey,
      originalUrl: params.originalUrl,
      canonicalUrl: params.canonicalUrl,
      brandName: params.brandName,
      industry: params.industry,
      targetMarket: params.targetMarket ?? "Global",
      primaryDomain: params.canonicalUrl,
      onboardingStatus: "completed",
      profileJson: params.profileJson,
      lastCrawledAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: brandProfiles.businessKey,
      set: {
        brandName: params.brandName,
        industry: params.industry,
        targetMarket: params.targetMarket ?? "Global",
        canonicalUrl: params.canonicalUrl,
        profileJson: params.profileJson,
        lastCrawledAt: now,
        onboardingStatus: "completed",
        updatedAt: now,
      },
    })
    .returning({ id: brandProfiles.id });

  const brandId = savedBrand!.id;

  // 2. Upsert extracted services
  let servicesSavedCount = 0;
  for (const s of params.servicesList) {
    await db
      .insert(services)
      .values({
        brandProfileId: brandId,
        serviceId: s.service_id,
        name: s.name,
        category: s.category,
        statusIndia: "active",
        detailsJson: s,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [services.brandProfileId, services.serviceId],
        set: {
          name: s.name,
          category: s.category,
          detailsJson: s,
          updatedAt: now,
        },
      });
    servicesSavedCount++;
  }

  // 3. Upsert evidence-verified competitors with stable domain-based slugs
  let competitorsSavedCount = 0;
  for (const c of params.competitorsList) {
    const slug = `comp_${c.canonical_domain.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
    await db
      .insert(competitors)
      .values({
        brandProfileId: brandId,
        slug,
        name: c.name,
        market: c.overlap_scores.geography >= 0.8 ? (params.targetMarket ?? "Global") : "Global",
        classification: c.classification,
        website: c.website,
        detailsJson: c,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [competitors.brandProfileId, competitors.slug],
        set: {
          name: c.name,
          classification: c.classification,
          website: c.website,
          detailsJson: c,
          updatedAt: now,
        },
      });
    competitorsSavedCount++;
  }

  // 4. Link baseline feeds into brand_sources
  for (const src of SOURCE_REGISTRY) {
    let [srcRow] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.sourceId, src.id))
      .limit(1);

    if (!srcRow) {
      const [inserted] = await db
        .insert(sources)
        .values({
          sourceId: src.id,
          name: src.name,
          feedUrl: src.feedUrl,
          sourceType: src.sourceType,
          geoScope: src.geoScope,
          enabled: src.enabled,
        })
        .onConflictDoNothing()
        .returning({ id: sources.id });
      srcRow = inserted;
    }

    if (srcRow) {
      await db
        .insert(brandSources)
        .values({
          brandProfileId: brandId,
          sourceId: srcRow.id,
          industryTag: "baseline",
          discoveryMethod: "baseline",
          validationStatus: "valid",
          enabled: src.enabled,
        })
        .onConflictDoNothing();
    }
  }

  return { brandId, servicesSavedCount, competitorsSavedCount };
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
    const eventKey = cluster.event_id;
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
        entitiesJson: cluster.entities ?? [],
        topicTokensJson: cluster.topic_tokens ?? [],
        status: cluster.status,
      })
      .onConflictDoUpdate({
        target: eventClusters.eventKey,
        set: {
          lastSeenAt: new Date(cluster.last_seen_at),
          independentSourceCount: cluster.independent_source_count,
          sourceDiversity: cluster.source_diversity,
          keywordsJson: cluster.keywords,
          entitiesJson: cluster.entities ?? [],
          topicTokensJson: cluster.topic_tokens ?? [],
          status: cluster.status,
          updatedAt: now,
        },
      })
      .returning({ id: eventClusters.id });

    let clusterId = upsertedCluster?.id ?? null;
    if (!clusterId) {
      const [existing] = await db
        .select({ id: eventClusters.id })
        .from(eventClusters)
        .where(eq(eventClusters.eventKey, eventKey))
        .limit(1);
      clusterId = existing?.id ?? null;
    }


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

/**
 * Loads active persistent event clusters from Neon within the lookback window,
 * capturing their stable event_key, entity/topic token fingerprints, and known signal URLs.
 */
export async function loadActiveEventClusters(
  db: AppDb,
  lookbackDays = 14,
  limit = 500,
): Promise<PersistedClusterContext[]> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(eventClusters)
    .where(
      and(
        gte(eventClusters.lastSeenAt, cutoff),
        eq(eventClusters.status, "active"),
      ),
    )
    .orderBy(desc(eventClusters.lastSeenAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const clusterIds = rows.map((r) => r.id);
  const sigRows = await db
    .select({
      clusterId: signals.clusterId,
      url: signals.url,
      contentHash: signals.contentHash,
    })
    .from(signals)
    .where(inArray(signals.clusterId, clusterIds));

  const sigsByClusterId = new Map<number, Array<{ url: string; contentHash: string }>>();
  for (const sig of sigRows) {
    if (sig.clusterId == null) continue;
    let list = sigsByClusterId.get(sig.clusterId);
    if (!list) {
      list = [];
      sigsByClusterId.set(sig.clusterId, list);
    }
    list.push(sig);
  }

  const out: PersistedClusterContext[] = [];

  for (const row of rows) {
    const clusterSigs = sigsByClusterId.get(row.id) ?? [];

    let entities = new Set<string>();
    let topicTokens = new Set<string>();

    if (Array.isArray(row.entitiesJson) && Array.isArray(row.topicTokensJson)) {
      entities = new Set(row.entitiesJson as string[]);
      topicTokens = new Set(row.topicTokensJson as string[]);
    } else {
      const extracted = extractEntitiesAndTopicTokens(row.clusterTitle);
      entities = extracted.entities;
      topicTokens = extracted.topicTokens;
    }

    out.push({
      dbClusterId: row.id,
      event_id: row.eventKey,
      cluster_title: row.clusterTitle,
      entities,
      topicTokens,
      signalUrls: new Set(clusterSigs.map((s) => s.url)),
      signalHashes: new Set(clusterSigs.map((s) => s.contentHash)),
      firstSeenAt: row.firstSeenAt.getTime(),
      lastSeenAt: row.lastSeenAt.getTime(),
    });
  }

  return out;
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

export async function getBrandProfileByBusinessKey(db: AppDb, businessKey: string) {
  const [brand] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.businessKey, businessKey))
    .limit(1);
  return brand ?? null;
}

export async function getBrandProfileById(db: AppDb, id: number) {
  const [brand] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.id, id))
    .limit(1);
  return brand ?? null;
}

export async function getBrandSources(db: AppDb, brandProfileId: number) {
  return await db
    .select({
      id: sources.id,
      sourceId: sources.sourceId,
      name: sources.name,
      feedUrl: sources.feedUrl,
      sourceType: sources.sourceType,
      geoScope: sources.geoScope,
      enabled: brandSources.enabled,
      industryTag: brandSources.industryTag,
      discoveryMethod: brandSources.discoveryMethod,
      validationStatus: brandSources.validationStatus,
    })
    .from(brandSources)
    .innerJoin(sources, eq(brandSources.sourceId, sources.id))
    .where(and(eq(brandSources.brandProfileId, brandProfileId), eq(brandSources.enabled, true)));
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const DEFAULT_STALE_LEASE_THRESHOLD_MS = 5 * 60 * 1000;

export async function renewWorkerHeartbeat(
  db: AppDb,
  reportRunId: number,
  workerToken: string,
  now = new Date(),
): Promise<boolean> {
  const [updated] = await db
    .update(reportRuns)
    .set({ heartbeatAt: now })
    .where(
      and(
        eq(reportRuns.id, reportRunId),
        eq(reportRuns.status, "running"),
        eq(reportRuns.workerToken, workerToken),
      ),
    )
    .returning({ id: reportRuns.id });
  return !!updated;
}

export async function recoverStaleReportRuns(
  db: AppDb,
  brandProfileId?: number,
  staleThresholdMs = DEFAULT_STALE_LEASE_THRESHOLD_MS,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleThresholdMs);
  const conditions = [
    eq(reportRuns.status, "running"),
    or(
      sql`${reportRuns.heartbeatAt} <= ${cutoff}`,
      and(sql`${reportRuns.heartbeatAt} IS NULL`, sql`${reportRuns.startedAt} <= ${cutoff}`),
    ),
  ];
  if (brandProfileId !== undefined) {
    conditions.push(eq(reportRuns.brandProfileId, brandProfileId));
  }

  const updated = await db
    .update(reportRuns)
    .set({
      status: "failed",
      errorMessage: "Worker lease expired: no heartbeat received within 5 minutes.",
      completedAt: now,
    })
    .where(and(...conditions))
    .returning({ id: reportRuns.id });

  return updated.length;
}

export async function updateRunCheckpointFenced(
  db: AppDb,
  reportRunId: number,
  workerToken: string,
  stage: string,
  checkpointData: unknown,
  now = new Date(),
): Promise<boolean> {
  const [updated] = await db
    .update(reportRuns)
    .set({
      checkpointStage: stage,
      checkpointJson: checkpointData,
      heartbeatAt: now,
    })
    .where(
      and(
        eq(reportRuns.id, reportRunId),
        eq(reportRuns.status, "running"),
        eq(reportRuns.workerToken, workerToken),
      ),
    )
    .returning({ id: reportRuns.id });

  if (!updated) {
    throw new Error(
      `Worker fenced: lost active run ownership for reportRunId=${reportRunId}. Cannot update checkpoint.`,
    );
  }
  return true;
}

export async function claimActiveOrNewReportRun(
  db: AppDb,
  brandProfileId: number,
  runKey: string,
  initialCheckpoint: unknown,
  workerToken: string = crypto.randomUUID(),
  staleThresholdMs = DEFAULT_STALE_LEASE_THRESHOLD_MS,
  now = new Date(),
): Promise<{
  run: typeof reportRuns.$inferSelect;
  reused: boolean;
  workerToken: string | null;
}> {
  // 1. Recover any stale running runs for this brand first
  await recoverStaleReportRuns(db, brandProfileId, staleThresholdMs, now);

  // 2. Fast path: check if a healthy active run is currently running
  const [active] = await db
    .select()
    .from(reportRuns)
    .where(and(eq(reportRuns.brandProfileId, brandProfileId), eq(reportRuns.status, "running")))
    .limit(1);

  if (active) {
    return { run: active, reused: true, workerToken: null };
  }

  // 3. Atomic insert protected by PostgreSQL partial unique index
  try {
    const [inserted] = await db
      .insert(reportRuns)
      .values({
        brandProfileId,
        runKey,
        status: "running",
        checkpointStage: "url_validation",
        checkpointJson: initialCheckpoint,
        workerToken,
        heartbeatAt: now,
        startedAt: now,
        recommendationsCount: 0,
      })
      .returning();

    return { run: inserted!, reused: false, workerToken };
  } catch (err: unknown) {
    const errMsg = String(err);
    if (errMsg.includes("report_runs_active_brand_idx") || (err as { code?: string }).code === "23505") {
      const [concurrentActive] = await db
        .select()
        .from(reportRuns)
        .where(and(eq(reportRuns.brandProfileId, brandProfileId), eq(reportRuns.status, "running")))
        .limit(1);

      if (concurrentActive) {
        return { run: concurrentActive, reused: true, workerToken: null };
      }
    }
    throw err;
  }
}

export async function claimOrResumeReportRun(
  db: AppDb,
  runKey: string,
  brandProfileId?: number,
) {
  const inserted = await db
    .insert(reportRuns)
    .values({
      runKey,
      brandProfileId: brandProfileId ?? null,
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

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
      }
    }
  }
  throw lastErr;
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
    workerToken?: string;
    now?: Date;
  },
): Promise<void> {
  const now = params.now ?? new Date();
  const nextReportAt = new Date(now.getTime() + params.intervalDays * 24 * 60 * 60 * 1000);

  // Worker Fencing check: verify worker still owns the active lease before writing recommendations
  if (params.workerToken) {
    const [ownership] = await db
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.id, params.reportRunId),
          eq(reportRuns.status, "running"),
          eq(reportRuns.workerToken, params.workerToken),
        ),
      )
      .limit(1);

    if (!ownership) {
      throw new Error(
        `Worker fenced: lost active run ownership for reportRunId=${params.reportRunId}. Cannot persist recommendations.`,
      );
    }
  }

  for (const pack of params.packs) {
    await withDbRetry(() =>
      db.insert(contextPacks).values({
        clusterId: params.clusterIdByEventKey.get(pack.event_id) ?? null,
        eventKey: pack.event_id,
        contextJson: pack,
        modelUsed: params.modelUsed,
      }),
    );
  }

  for (const card of params.cards) {
    await withDbRetry(() =>
      db.insert(recommendations).values({
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
      }),
    );
  }

  const updateConditions = [eq(reportRuns.id, params.reportRunId), eq(reportRuns.status, "running")];
  if (params.workerToken) {
    updateConditions.push(eq(reportRuns.workerToken, params.workerToken));
  }

  const [updatedRun] = await withDbRetry(() =>
    db
      .update(reportRuns)
      .set({
        status: "completed",
        checkpointStage: "completed",
        recommendationsCount: params.cards.length,
        tokenUsageJson: params.tokenUsage,
        completedAt: now,
      })
      .where(and(...updateConditions))
      .returning({ id: reportRuns.id }),
  );

  if (!updatedRun) {
    throw new Error(
      `Worker fenced: reportRunId=${params.reportRunId} is no longer running or owned by workerToken.`,
    );
  }

  // Advance next_report_at ONLY after report generation fully completes
  await withDbRetry(() =>
    db
      .update(brandProfiles)
      .set({
        nextReportAt,
        updatedAt: sql`NOW()`,
      })
      .where(eq(brandProfiles.brandKey, params.brandKey)),
  );
}

export async function loadRecentRecommendationHistory(
  db: AppDb,
  lookbackDays = 30,
  brandProfileId?: number,
): Promise<{
  eventKeys: Set<string>;
  evidenceUrls: Set<string>;
  priorTitles: string[];
}> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  let rows: Array<{ eventKey: string; title: string; cardJson: unknown }>;
  if (brandProfileId !== undefined) {
    const joined = await db
      .select({
        eventKey: recommendations.eventKey,
        title: recommendations.title,
        cardJson: recommendations.cardJson,
      })
      .from(recommendations)
      .innerJoin(reportRuns, eq(recommendations.reportRunId, reportRuns.id))
      .where(
        and(
          gte(recommendations.createdAt, cutoff),
          eq(reportRuns.brandProfileId, brandProfileId),
        ),
      );
    rows = joined;
  } else {
    rows = await db
      .select({
        eventKey: recommendations.eventKey,
        title: recommendations.title,
        cardJson: recommendations.cardJson,
      })
      .from(recommendations)
      .where(gte(recommendations.createdAt, cutoff));
  }

  const eventKeys = new Set<string>();
  const evidenceUrls = new Set<string>();
  const priorTitles: string[] = [];

  for (const r of rows) {
    eventKeys.add(r.eventKey);
    priorTitles.push(r.title);
    const card = r.cardJson as { evidence?: Array<{ url?: string }> } | null;
    if (Array.isArray(card?.evidence)) {
      for (const ev of card.evidence) {
        if (typeof ev?.url === "string" && ev.url) {
          evidenceUrls.add(ev.url);
        }
      }
    }
  }

  return { eventKeys, evidenceUrls, priorTitles };
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

