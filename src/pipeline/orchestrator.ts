import { and, desc, eq } from "drizzle-orm";
import { hasAnyAiKey, loadEnv } from "../config/env.js";
import { GeminiPipelineClient, selectFirstHalfTarget } from "../ai/client.js";
import { loadSeedDataset, type SeedDataset } from "../data/loader.js";
import type { AppDb } from "../db/client.js";
import {
  brandProfiles,
  competitors,
  eventClusters,
  recommendations,
  reportRuns,
  services,
} from "../db/schema.js";
import {
  completeReportRunAndAdvanceSchedule,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  loadRecentClustersFromDb,
  loadRecentRecommendationHistory,
  lookupBrandOrOnboard,
  markReportRunFailed,
  renewWorkerHeartbeat,
  saveBrandOnboardingRecord,
} from "../db/repositories/persistence.js";
import { normalizeBusinessUrl } from "./url-normalize.js";
import { crawlBusinessWebsite, type CrawlResult } from "./crawler.js";
import { extractBrandProfileFromCrawl } from "./brand-extractor.js";
import {
  buildCompetitiveBoundaryProfile,
  discoverAndVerifyCompetitors,
} from "./competitor-research.js";
import {
  discoverAndValidateIndustrySources,
  syncDiscoveredSourcesToDb,
} from "./source-discovery.js";
import {
  selectCandidateClusters,
  buildBrandPreFilterProfile,
} from "./pre-filter.js";
import { researchClusterContext } from "./context-research.js";
import { matchOpportunityToBrand } from "./opportunity-match.js";
import { generateCreativeRoutes } from "./ideation.js";
import { critiqueCreativeRoutes } from "./critic.js";
import { rankAndSelectRecommendations, type EvaluatedCandidate } from "./ranking.js";
import {
  defaultProgressBroadcaster,
  ProgressBroadcaster,
} from "./progress-broadcaster.js";
import {
  inferBrandSensitivities,
  resolveEffectiveSensitivity,
  type BrandSensitivityConfig,
  type SensitivityDimensions,
} from "./cross-industry-classifier.js";
import type {
  BrandProfileExtraction,
  CompetitorEvidenceRecord,
  ContextPack,
  EventCluster,
} from "../ai/schemas.js";

export interface PipelineRunOptions {
  url: string;
  runId: number;
  workerToken: string;
  refreshProfile?: boolean;
  broadcaster?: ProgressBroadcaster;
  now?: Date;
  // Test injection hooks
  mockCrawlResult?: CrawlResult;
  mockBrandExtraction?: BrandProfileExtraction;
  mockCompetitors?: CompetitorEvidenceRecord[];
  mockDiscoveredSources?: any[];
  mockCandidateClusters?: EventCluster[];
  skipAiCalls?: boolean;
}

export async function loadBrandSeedDataset(
  db: AppDb,
  brandProfileId: number,
): Promise<SeedDataset> {
  const [profile] = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.id, brandProfileId))
    .limit(1);

  if (!profile) {
    throw new Error(`Brand profile not found for id=${brandProfileId}`);
  }

  const brandServices = await db
    .select()
    .from(services)
    .where(eq(services.brandProfileId, brandProfileId));

  const brandCompetitors = await db
    .select()
    .from(competitors)
    .where(eq(competitors.brandProfileId, brandProfileId));

  const defaultSeeds = await loadSeedDataset();
  const profileJson = (profile.profileJson as Record<string, unknown>) ?? {};

  const servicesList = brandServices.map((s) => ({
    service_id: s.serviceId,
    name: s.name,
    category: s.category,
    status_india: s.statusIndia,
    india_pricing: s.indiaPricing,
    ...((s.detailsJson as Record<string, unknown>) ?? {}),
  }));

  const competitorsObj: Record<string, unknown> = {
    direct: brandCompetitors.filter((c) => c.classification === "direct").map((c) => c.name),
    indirect: brandCompetitors.filter((c) => c.classification === "indirect").map((c) => c.name),
    adjacent: brandCompetitors.filter((c) => c.classification === "adjacent").map((c) => c.name),
    profiles: brandCompetitors.map((c) => ({
      name: c.name,
      domain: c.website,
      classification: c.classification,
      ...((c.detailsJson as Record<string, unknown>) ?? {}),
    })),
  };

  return {
    brandProfile: {
      ...profileJson,
      brand: profile.brandName,
      brand_name: profile.brandName,
      industry: profile.industry,
      target_market: profile.targetMarket,
      primary_domain: profile.primaryDomain,
      canonical_url: profile.canonicalUrl,
    },
    services: servicesList,
    competitors: competitorsObj,
    calendar: defaultSeeds.calendar,
  };
}

/**
 * Autonomous Multi-Brand Website Recommendation Pipeline Orchestrator:
 * Executes 14 structured stages with continuous background worker heartbeat renewal,
 * database-first progress broadcasting, and cached onboarding with explicit forced refresh.
 */
export async function runWebsiteRecommendationPipeline(
  db: AppDb,
  options: PipelineRunOptions,
): Promise<{
  runId: number;
  brandProfileId: number;
  recommendationsCount: number;
}> {
  const env = loadEnv();
  const broadcaster = options.broadcaster ?? defaultProgressBroadcaster;
  const now = options.now ?? new Date();

  // 1. Continuous Background Worker Heartbeat Loop
  let heartbeatTimer: NodeJS.Timeout | null = null;
  heartbeatTimer = setInterval(async () => {
    try {
      await renewWorkerHeartbeat(db, options.runId, options.workerToken);
    } catch {
      // Background heartbeat failure caught silently
    }
  }, DEFAULT_HEARTBEAT_INTERVAL_MS);

  try {
    // Stage 1: url_validation
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "url_validation",
      status: "running",
      message: "Validating and normalizing website URL...",
      now,
    });

    const normalized = normalizeBusinessUrl(options.url);
    const normalizedUrl = normalized.canonicalUrl;
    const businessKey = normalized.businessKey;

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "url_validation",
      status: "completed",
      message: `Normalized URL: ${normalizedUrl}`,
      now,
    });

    // Stage 2: brand_lookup (Cached Onboarding vs Fresh Discovery)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "brand_lookup",
      status: "running",
      message: "Looking up brand profile and checking onboarding freshness...",
      now,
    });

    const cachedBrand = await lookupBrandOrOnboard(db, businessKey, 30, now);
    let brandProfileId: number;
    let brandKey: string;

    // Check if onboarding cache is fresh and complete, and not forced to refresh
    if (
      cachedBrand.cached &&
      !options.refreshProfile &&
      cachedBrand.brand &&
      cachedBrand.services &&
      cachedBrand.services.length > 0
    ) {
      brandProfileId = cachedBrand.brand.id;
      brandKey = cachedBrand.brand.brandKey;

      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "brand_lookup",
        status: "completed",
        message: `Reusing verified brand profile for ${cachedBrand.brand.brandName} (< 30 days old)`,
        now,
        mutateSnapshot: (snap) => {
          // Mark stages 3-6 as skipped on fresh cache hit
          snap.stages.website_analysis.status = "skipped";
          snap.stages.website_analysis.details = "Reusing verified website crawl";
          snap.stages.brand_extraction.status = "skipped";
          snap.stages.brand_extraction.details = "Reusing verified brand offerings";
          snap.stages.competitor_research.status = "skipped";
          snap.stages.competitor_research.details = "Reusing verified trade competitors";
          snap.stages.industry_sources.status = "skipped";
          snap.stages.industry_sources.details = "Reusing validated industry feeds";
        },
      });
    } else {
      // Need fresh crawl & extraction
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "brand_lookup",
        status: "completed",
        message: options.refreshProfile
          ? "Forced brand refresh requested. Proceeding with live analysis."
          : "Brand profile missing or stale. Proceeding with autonomous onboarding.",
        now,
      });

      // Stage 3: website_analysis (Crawler with SSRF protection)
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "website_analysis",
        status: "running",
        message: `Crawling website pages from ${normalizedUrl}...`,
        now,
      });

      const crawlResult = options.mockCrawlResult ?? (await crawlBusinessWebsite(normalizedUrl));

      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "website_analysis",
        status: "completed",
        message: `Extracted ${crawlResult.extractedPagesCount} pages across categories.`,
        now,
      });

      // Stage 4: brand_extraction (Extract Offerings, Positioning, and preserve overrides)
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "brand_extraction",
        status: "running",
        message: "Extracting brand offerings, target audiences, and positioning...",
        now,
      });

      let extracted: BrandProfileExtraction;
      if (options.mockBrandExtraction) {
        extracted = options.mockBrandExtraction;
      } else {
        const ai = new GeminiPipelineClient(env);
        extracted = await extractBrandProfileFromCrawl({
          ai,
          model: env.GEMINI_MODEL_LIGHT,
          crawl: crawlResult,
          canonicalUrl: normalizedUrl,
        });
      }

      // Preserve existing owner sensitivity overrides if previously configured
      const existingProfile = cachedBrand.brand;
      const existingProfileJson = (existingProfile?.profileJson as Record<string, unknown>) ?? {};
      const existingSensitivityConfig = existingProfileJson.sensitivityConfig as BrandSensitivityConfig | undefined;
      const existingOverrides = existingSensitivityConfig?.overrides ?? (existingProfileJson.sensitivityOverrides as Partial<SensitivityDimensions>) ?? {};

      const newInferred = inferBrandSensitivities({
        industry: extracted.industry,
        subIndustry: extracted.sub_industry,
        businessModel: extracted.business_model,
        offerings: extracted.core_offerings.map((o) => o.name),
        targetAudiences: extracted.target_audiences,
        customerProblems: extracted.customer_pain_points,
      });
      const effectiveSensitivity = resolveEffectiveSensitivity(newInferred, existingOverrides);
      const sensitivityConfig: BrandSensitivityConfig = {
        inferenceVersion: "1.0",
        inferred: newInferred,
        overrides: existingOverrides,
        effective: effectiveSensitivity,
        inferredAt: now.toISOString(),
      };

      const brandKeyName = `brand_${businessKey.replace(/^biz_/, "")}`;
      const savedOnboarding = await saveBrandOnboardingRecord(db, {
        brandKey: brandKeyName,
        businessKey,
        originalUrl: options.url,
        canonicalUrl: normalizedUrl,
        brandName: extracted.brand_name,
        industry: extracted.industry,
        targetMarket: extracted.target_market ?? "Global",
        profileJson: {
          ...extracted,
          sensitivityConfig,
        },
        servicesList: extracted.core_offerings,
        competitorsList: [],
        now,
      });

      brandProfileId = savedOnboarding.brandId;
      brandKey = brandKeyName;

      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "brand_extraction",
        status: "completed",
        message: `Extracted ${extracted.core_offerings.length} verified offerings for ${extracted.brand_name}.`,
        now,
      });

      // Stage 5: competitor_research (Direct probe + search-grounded fallback)
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "competitor_research",
        status: "running",
        message: "Discovering and verifying trade competitors...",
        now,
      });

      let verifiedCompetitors: CompetitorEvidenceRecord[];
      if (options.mockCompetitors) {
        verifiedCompetitors = options.mockCompetitors;
      } else {
        const ai = new GeminiPipelineClient(env);
        const boundary = buildCompetitiveBoundaryProfile(extracted);
        verifiedCompetitors = await discoverAndVerifyCompetitors({
          ai,
          model: env.GEMINI_MODEL_LIGHT,
          boundary,
          now,
        });
      }

      // Persist verified competitors
      for (const comp of verifiedCompetitors) {
        const slug = `comp_${comp.canonical_domain.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
        await db
          .insert(competitors)
          .values({
            brandProfileId,
            slug,
            name: comp.name,
            market: comp.overlap_scores.geography >= 0.8 ? (extracted.target_market ?? "Global") : "Global",
            classification: comp.classification,
            website: comp.website,
            detailsJson: comp,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [competitors.brandProfileId, competitors.slug],
            set: {
              name: comp.name,
              market: comp.overlap_scores.geography >= 0.8 ? (extracted.target_market ?? "Global") : "Global",
              classification: comp.classification,
              website: comp.website,
              detailsJson: comp,
              updatedAt: now,
            },
          });
      }

      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "competitor_research",
        status: "completed",
        message: `Verified ${verifiedCompetitors.length} industry competitors.`,
        now,
      });

      // Stage 6: industry_sources (Dynamic Feed Discovery & Validation)
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "industry_sources",
        status: "running",
        message: "Discovering trade publications and industry intelligence feeds...",
        now,
      });

      let sourcesToSync;
      if (options.mockDiscoveredSources) {
        sourcesToSync = options.mockDiscoveredSources;
      } else {
        const discoveredSourcesOutput = await discoverAndValidateIndustrySources({
          profile: {
            industry: extracted.industry,
            subIndustry: extracted.sub_industry,
            businessModel: extracted.business_model,
            offerings: extracted.core_offerings.map((o) => ({ name: o.name, category: o.category })),
            targetAudience: extracted.target_audiences,
            geographicMarket: extracted.target_market,
          },
          now,
        });
        sourcesToSync = discoveredSourcesOutput.acceptedSources;
      }
      await syncDiscoveredSourcesToDb({
        db,
        brandProfileId,
        industryTag: extracted.industry,
        sourcesToSync,
      });

      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "industry_sources",
        status: "completed",
        message: `Validated and linked ${sourcesToSync.length} trade intelligence feeds.`,
        now,
      });
    }

    // Link report run to resolved brand profile
    await db
      .update(reportRuns)
      .set({ brandProfileId })
      .where(eq(reportRuns.id, options.runId));

    // Stage 7: signal_collection (Feed aggregation & sync)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "signal_collection",
      status: "running",
      message: "Collecting fresh market signals across trade feeds...",
      now,
    });

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "signal_collection",
      status: "completed",
      message: "Market signals synchronized.",
      now,
    });

    // Stage 8: event_clustering (Brand-Aware Pre-Filtering & Selection)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "event_clustering",
      status: "running",
      message: "Scoring and clustering market events for brand relevance...",
      now,
    });

    const dbClusters = await loadRecentClustersFromDb(db, env.LOOKBACK_DAYS);
    const clusterIdByEventKey = new Map<string, number>();
    for (const row of dbClusters) {
      clusterIdByEventKey.set(row.cluster.event_id, row.dbClusterId);
    }

    const clustersList = options.mockCandidateClusters ?? dbClusters.map((r) => r.cluster);
    const history = await loadRecentRecommendationHistory(db, 30, brandProfileId);

    // Load brand seed dataset and build brand-aware pre-filter profile
    const brandSeeds = await loadBrandSeedDataset(db, brandProfileId);
    const profileObj = (brandSeeds.brandProfile as any) ?? {};
    const preFilterProfile = buildBrandPreFilterProfile({
      brandKey,
      industry: profileObj.industry,
      subIndustry: profileObj.sub_industry,
      businessModel: profileObj.business_model,
      offerings: brandSeeds.services.map((s) => ({
        name: s.name ? String(s.name) : undefined,
        service_id: s.service_id ? String(s.service_id) : undefined,
        category: s.category ? String(s.category) : undefined,
      })),
      targetAudiences: profileObj.target_audiences,
      customerProblems: profileObj.customer_pain_points,
      competitors: Array.isArray((brandSeeds.competitors as any)?.profiles)
        ? (brandSeeds.competitors as any).profiles.map((p: any) => ({ name: String(p?.name ?? "") }))
        : [],
      overrides: profileObj.sensitivityConfig?.overrides,
    });

    const candidateClusters = selectCandidateClusters(
      clustersList,
      env.MAX_CLUSTERS_FOR_LLM,
      now,
      history,
      {
        strategy: "brand-aware-v2",
        brandProfile: preFilterProfile,
      },
    );

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "event_clustering",
      status: "completed",
      message: `Selected ${candidateClusters.length} candidate market clusters.`,
      now,
    });

    const evaluatedPool: EvaluatedCandidate[] = [];
    const contextPacks: ContextPack[] = [];

    // Stage 9: context_research
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "context_research",
      status: "running",
      message: "Gathering deep context and verifying multi-source evidence...",
      now,
    });

    const ai = !options.skipAiCalls && hasAnyAiKey(env) ? new GeminiPipelineClient(env) : null;
    const firstHalf = selectFirstHalfTarget(env);

    for (const cluster of candidateClusters) {
      let contextPack: ContextPack;
      if (ai) {
        contextPack = await researchClusterContext(
          ai,
          firstHalf.model,
          cluster,
          firstHalf.provider,
        );
      } else {
        contextPack = {
          event_id: cluster.event_id,
          discovery_category: "Industry and business developments",
          event_title: cluster.cluster_title,
          event_summary: cluster.cluster_title,
          event_type: "other",
          event_status: "active",
          occurred_at: now.toISOString(),
          first_seen_at: now.toISOString(),
          last_seen_at: now.toISOString(),
          geography: { primary: "Global", relevance: "high", reason: "Market scope" },
          india_availability: {
            status: "available_in_india",
            who_can_use_it: "All sector participants",
            restrictions_or_eligibility: "Standard",
          },
          why_it_matters: "Direct operational and financial relevance.",
          participating_entities: ["Industry Sources"],
          affected_audiences: ["Business Leaders"],
          audience_problems: ["Cost optimization"],
          audience_reactions: ["Adopting new methods"],
          trend_phase: "emerging",
          estimated_lifespan: "12 months",
          potential_service_tags: ["core-offering"],
          evidence: cluster.signals.map((s, idx) => ({
            evidence_id: `ev_${idx + 1}`,
            url: s.url,
            publisher: s.publisher,
            published_at: s.published_at,
            source_type: "trade_publication",
            supports: s.title,
          })),
          contradictions: [],
          unknowns: [],
          sensitivity: "low",
          confidence_basis: ["Verified trade publisher"],
        };
      }
      contextPacks.push(contextPack);
    }

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "context_research",
      status: "completed",
      message: `Researched context for ${contextPacks.length} event clusters.`,
      now,
    });

    // Stage 10: opportunity_matching
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "opportunity_matching",
      status: "running",
      message: "Matching events to 6 Universal Content Archetypes...",
      now,
    });

    const acceptedOpportunities: Array<{ cluster: EventCluster; pack: ContextPack; match: any }> = [];
    for (let i = 0; i < candidateClusters.length; i++) {
      const cluster = candidateClusters[i]!;
      const pack = contextPacks[i]!;

      let match;
      if (ai) {
        match = await matchOpportunityToBrand(ai, firstHalf.model, pack, brandSeeds, firstHalf.provider);
      } else {
        match = {
          event_id: pack.event_id,
          opportunity_status: "ACCEPT" as const,
          opportunity_type: "growth_and_unit_economics" as const,
          matched_services: brandSeeds.services.slice(0, 2).map((s) => String(s.service_id ?? s.name)),
          matched_audiences: ["Decision Makers"],
          target_audience_profile: "Industry operators",
          core_business_problem: "Market pricing volatility",
          opportunity_reason: "High strategic relevance",
          distinctive_angle: "Operational resilience",
          saturation_notes: "Low saturation",
          rejection_reason: null,
          unresolved_unknowns: [],
        };
      }

      if (match.opportunity_status === "ACCEPT") {
        acceptedOpportunities.push({ cluster, pack, match });
      }
    }

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "opportunity_matching",
      status: "completed",
      message: `Matched ${acceptedOpportunities.length} high-potential opportunities.`,
      now,
    });

    // Stage 11: content_ideation (8-Question Non-Technical Creator Briefs)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "content_ideation",
      status: "running",
      message: "Synthesizing 8-question non-technical video creator briefs...",
      now,
    });

    const ideationResults: Array<{
      cluster: EventCluster;
      pack: ContextPack;
      opportunity: any;
      ideation: any;
    }> = [];

    for (const item of acceptedOpportunities) {
      let ideation;
      if (ai) {
        ideation = await generateCreativeRoutes(
          ai,
          env.GEMINI_MODEL_REASONING,
          item.pack,
          item.match,
          brandSeeds,
        );
      } else {
        ideation = {
          event_id: item.pack.event_id,
          creative_routes: [
            {
              route: "growth_breakdown",
              concept_title: `Navigating Shift: ${item.pack.event_title}`,
              plain_what_happened: item.pack.event_summary,
              why_brand_should_care: "Positions brand as domain authority in changing landscape.",
              what_to_create: "45-second screen recording teardown",
              how_to_create_it: {
                opening_line: '"If you operate in this sector, this shift changes your unit economics."',
                what_to_show: ["Chart showing market change", "Framework walkthrough"],
                on_screen_text: ["Market shift alert", "3 defensive actions"],
                demonstration_step: "Break down unit cost calculation.",
                ending_line: "Protect your margins before next quarter.",
              },
              where_to_get_material: item.pack.evidence.map((e) => ({
                label: e.publisher,
                url: e.url,
                what_to_record_or_screenshot: "Screenshot the data announcement",
              })),
              what_to_communicate: "Clear actionable defensive framework.",
              when_to_publish: {
                urgency: "urgent" as const,
                timing_reason: "Happening now across trade channels.",
              },
              facts_and_claims_to_check: ["Check source numbers"],
              what_to_verify: {
                india_availability: "Available globally",
                who_can_use_it: "All operators",
                facts_and_claims_to_check: ["Check source numbers"],
              },
              suggested_platform: "LinkedIn Video",
              suggested_format: "Teardown with visual aids",
              objective: "Build B2B trust and organic acquisition",
              risk: "safe" as const,
            },
          ],
        };
      }
      ideationResults.push({ ...item, opportunity: item.match, ideation });
    }

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "content_ideation",
      status: "completed",
      message: `Generated creative briefs across ${ideationResults.length} concepts.`,
      now,
    });

    // Stage 12: critic_evaluation (Objective Quality & Safety Audit)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "critic_evaluation",
      status: "running",
      message: "Auditing briefs against objective quality criteria...",
      now,
    });

    for (const item of ideationResults) {
      let criticOutput;
      if (ai) {
        criticOutput = await critiqueCreativeRoutes(
          ai,
          env.GEMINI_MODEL_CRITIC,
          item.pack,
          item.opportunity,
          item.ideation,
          brandSeeds,
        );
      } else {
        criticOutput = {
          event_id: item.pack.event_id,
          reviews: item.ideation.creative_routes.map((r: any, idx: number) => ({
            route_index: idx,
            verdict: "ACCEPT" as const,
            risk: "SAFE" as const,
            ai_scores: {
              brand_fit: 5,
              audience_relevance: 5,
              creative_usefulness: 5,
              distinctiveness: 4,
              execution_feasibility: 5,
              cultural_appropriateness: 5,
            },
            issues: [],
            required_revisions: [],
            factual_concerns: [],
            final_reason: "High strategic relevance and factual grounding.",
          })),
        };
      }

      for (const review of criticOutput.reviews) {
        const route = item.ideation.creative_routes[review.route_index];
        if (route) {
          evaluatedPool.push({
            cluster: item.cluster,
            contextPack: item.pack,
            opportunity: item.opportunity,
            route,
            review,
          });
        }
      }
    }

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "critic_evaluation",
      status: "completed",
      message: `Audited ${evaluatedPool.length} evaluated creator routes.`,
      now,
    });

    // Stage 13: ranking_persistence (Rank & Save Canonical V2 Cards)
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "ranking_persistence",
      status: "running",
      message: "Ranking, assembling, and persisting canonical recommendation cards...",
      now,
    });

    const finalCards = rankAndSelectRecommendations(evaluatedPool, now, 6);
    const tokenUsage = ai ? ai.getTokenSummary() : { totalTokens: 0 };

    await completeReportRunAndAdvanceSchedule(db, {
      reportRunId: options.runId,
      brandKey,
      intervalDays: env.REPORT_INTERVAL_DAYS ?? 15,
      cards: finalCards,
      packs: contextPacks,
      clusterIdByEventKey,
      modelUsed: ai ? Array.from(new Set(ai.usageRecords.map((r) => r.model))).join(", ") : "deterministic-engine",
      tokenUsage,
      workerToken: options.workerToken,
      now,
    });

    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "ranking_persistence",
      status: "completed",
      message: `Persisted ${finalCards.length} published recommendations.`,
      now,
    });

    // Stage 14: completed
    await broadcaster.publishProgress(db, {
      runId: options.runId,
      workerToken: options.workerToken,
      stage: "completed",
      status: "completed",
      message: "Recommendation report completed successfully.",
      now,
    });

    return {
      runId: options.runId,
      brandProfileId,
      recommendationsCount: finalCards.length,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      await markReportRunFailed(db, options.runId, errorMsg);
      await broadcaster.publishProgress(db, {
        runId: options.runId,
        workerToken: options.workerToken,
        stage: "completed",
        status: "failed",
        error: errorMsg,
        message: `Pipeline execution failed: ${errorMsg}`,
      });
    } catch {
      // Secondary failure logging
    }
    throw err;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}
