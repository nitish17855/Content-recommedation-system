import { hasAnyAiKey, loadEnv } from "../config/env.js";
import { loadSeedDataset } from "../data/loader.js";
import { createDb } from "../db/client.js";
import {
  claimOrResumeReportRun,
  completeReportRunAndAdvanceSchedule,
  isReportDue,
  loadRecentClustersFromDb,
  loadRecentRecommendationHistory,
  markReportRunFailed,
  syncSeedData,
  updateRunCheckpoint,
} from "../db/repositories/persistence.js";
import { SOURCE_REGISTRY } from "../sources/source-registry.js";
import { selectCandidateClusters } from "../pipeline/pre-filter.js";
import { GeminiPipelineClient, selectFirstHalfTarget } from "../ai/client.js";
import { researchClusterContext } from "../pipeline/context-research.js";
import { matchOpportunityToBrand } from "../pipeline/opportunity-match.js";
import { generateCreativeRoutes } from "../pipeline/ideation.js";
import { critiqueCreativeRoutes } from "../pipeline/critic.js";
import { scanIndiaMarketTrends, reorderClustersByMarketScan } from "../pipeline/market-scan.js";
import { rankAndSelectRecommendations, type EvaluatedCandidate } from "../pipeline/ranking.js";
import type { ContextPack, MarketScanOutput } from "../ai/schemas.js";

export async function runDueReportGeneration(options?: { force?: boolean; runKey?: string }) {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.log("[generate-report] DATABASE_URL is not set. Skipping persistent report generation.");
    return { executed: false, reason: "missing_database_url" };
  }
  if (!hasAnyAiKey(env)) {
    console.log("[generate-report] Neither GEMINI_API_KEY(S) nor OPENROUTER_API_KEY is set. Skipping persistent report generation.");
    return { executed: false, reason: "missing_ai_api_key" };
  }

  const db = createDb(env.DATABASE_URL);
  const seeds = await loadSeedDataset();
  await syncSeedData(db, seeds, SOURCE_REGISTRY);

  const now = new Date();
  const brandKey = "nsp-india";
  const dueStatus = await isReportDue(db, brandKey, now);

  if (!options?.force && !dueStatus.due) {
    console.log(
      `[generate-report] Report not due yet (next_report_at=${dueStatus.nextReportAt?.toISOString()}). Skipping.`,
    );
    return { executed: false, reason: "not_due", nextReportAt: dueStatus.nextReportAt };
  }

  const runKey =
    options?.runKey ??
    (options?.force
      ? `manual-cli-${now.toISOString().replace(/[:.]/g, "-")}`
      : `nsp-in-15d-${now.toISOString().slice(0, 10)}`);
  const claim = await claimOrResumeReportRun(db, runKey);

  if (claim.action === "already_completed") {
    console.log(`[generate-report] Run key "${runKey}" already completed. Preventing duplicate report.`);
    return { executed: false, reason: "already_completed", runKey };
  }

  const reportRunId = claim.run.id;
  console.log(`[generate-report] ${claim.action.toUpperCase()} report run id=${reportRunId} runKey=${runKey}`);

  try {
    const dbClusters = await loadRecentClustersFromDb(db, env.LOOKBACK_DAYS);
    const clusterIdByEventKey = new Map<string, number>();
    for (const row of dbClusters) {
      clusterIdByEventKey.set(row.cluster.event_id, row.dbClusterId);
    }

    const history = await loadRecentRecommendationHistory(db, 30);
    let broadPool = selectCandidateClusters(
      dbClusters.map((r) => r.cluster),
      24,
      now,
      history,
    );
    if (broadPool.length < 4) {
      broadPool = selectCandidateClusters(
        dbClusters.map((r) => r.cluster),
        24,
        now,
        { eventKeys: history.eventKeys, evidenceUrls: history.evidenceUrls, priorTitles: [] },
      );
    }

    const checkpoint = (claim.run.checkpointJson as { evaluatedPool?: EvaluatedCandidate[]; contextPacks?: ContextPack[]; completedEventIds?: string[]; marketScan?: MarketScanOutput | null } | null) ?? {};
    const evaluatedPool: EvaluatedCandidate[] = checkpoint.evaluatedPool ?? [];
    const contextPacks: ContextPack[] = checkpoint.contextPacks ?? [];
    const completedIds = new Set<string>(checkpoint.completedEventIds ?? []);

    const ai = new GeminiPipelineClient(env);
    const firstHalf = selectFirstHalfTarget(env);

    let marketScan: MarketScanOutput | null = checkpoint.marketScan ?? null;
    if (!marketScan && broadPool.length > 0) {
      try {
        console.log(`[generate-report] Running Gemini India market & competitor trend check across ${broadPool.length} clusters...`);
        marketScan = await scanIndiaMarketTrends({
          ai,
          model: env.GEMINI_MODEL_LIGHT,
          clusters: broadPool,
          seeds,
        });
      } catch (scanErr) {
        console.warn(
          "[generate-report] Market scan skipped (falling back to deterministic ranking):",
          scanErr instanceof Error ? scanErr.message : String(scanErr),
        );
      }
    }

    const candidates = marketScan
      ? reorderClustersByMarketScan(broadPool, marketScan, env.MAX_CLUSTERS_FOR_LLM)
      : broadPool.slice(0, env.MAX_CLUSTERS_FOR_LLM);

    for (const cluster of candidates) {
      if (completedIds.has(cluster.event_id)) {
        console.log(`[generate-report] Skipping already checkpointed cluster ${cluster.event_id}`);
        continue;
      }
      try {
        const contextPack = await researchClusterContext(ai, firstHalf.model, cluster, firstHalf.provider);
        contextPacks.push(contextPack);

        const opportunity = await matchOpportunityToBrand(ai, firstHalf.model, contextPack, seeds, firstHalf.provider);
        if (opportunity.opportunity_status === "ACCEPT") {
          const ideation = await generateCreativeRoutes(ai, env.GEMINI_MODEL_REASONING, contextPack, opportunity, seeds);
          const criticOutput = await critiqueCreativeRoutes(ai, env.GEMINI_MODEL_CRITIC, contextPack, opportunity, ideation, seeds);

          for (const review of criticOutput.reviews) {
            const route = ideation.creative_routes[review.route_index];
            if (route) {
              evaluatedPool.push({ cluster, contextPack, opportunity, route, review });
            }
          }
        }

        completedIds.add(cluster.event_id);
        await updateRunCheckpoint(db, reportRunId, `cluster:${cluster.event_id}`, {
          evaluatedPool,
          contextPacks,
          completedEventIds: Array.from(completedIds),
          marketScan,
        });
      } catch (clusterErr) {
        console.error(
          `[generate-report] Cluster ${cluster.event_id} failed:`,
          clusterErr instanceof Error ? clusterErr.message : String(clusterErr),
        );
      }
    }

    const cards = rankAndSelectRecommendations(evaluatedPool, now, 6);
    const tokenUsage = ai.getTokenSummary();
    const modelsUsed = Array.from(new Set(ai.usageRecords.map((r) => r.model))).join(", ") || env.GEMINI_MODEL_LIGHT;

    await completeReportRunAndAdvanceSchedule(db, {
      reportRunId,
      brandKey,
      intervalDays: env.REPORT_INTERVAL_DAYS,
      cards,
      packs: contextPacks,
      clusterIdByEventKey,
      modelUsed: modelsUsed,
      tokenUsage: { summary: tokenUsage, breakdown: ai.usageRecords, marketScan },
    });

    console.log(
      `[generate-report] Completed runKey=${runKey} with ${cards.length} recommendations. Next report scheduled in ${env.REPORT_INTERVAL_DAYS} days.`,
    );
    return { executed: true, runKey, recommendationsCount: cards.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markReportRunFailed(db, reportRunId, msg);
    throw err;
  }
}

const isDirectExecution = process.argv[1]?.endsWith("generate-report.ts") || process.argv[1]?.endsWith("generate-report.js");
if (isDirectExecution) {
  const force = process.argv.includes("--force");
  const runKeyArg = process.argv.find((a) => a.startsWith("--runKey="))?.slice("--runKey=".length);
  runDueReportGeneration({ force, runKey: runKeyArg }).catch((err) => {
    console.error("Report generation failed:", err);
    process.exitCode = 1;
  });
}

