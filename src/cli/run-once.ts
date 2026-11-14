import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasAnyAiKey, loadEnv } from "../config/env.js";
import { loadSeedDataset } from "../data/loader.js";
import { collectRssSources } from "../sources/rss-collector.js";
import { SOURCE_REGISTRY } from "../sources/source-registry.js";
import { normalizeSignals } from "../pipeline/normalize.js";
import { deduplicateSignals } from "../pipeline/deduplicate.js";
import { clusterSignals } from "../pipeline/cluster.js";
import { selectCandidateClusters } from "../pipeline/pre-filter.js";
import { GeminiPipelineClient, selectFirstHalfTarget } from "../ai/client.js";
import { researchClusterContext } from "../pipeline/context-research.js";
import { matchOpportunityToBrand } from "../pipeline/opportunity-match.js";
import { generateCreativeRoutes } from "../pipeline/ideation.js";
import { critiqueCreativeRoutes } from "../pipeline/critic.js";
import { scanIndiaMarketTrends, reorderClustersByMarketScan } from "../pipeline/market-scan.js";
import { rankAndSelectRecommendations, type EvaluatedCandidate } from "../pipeline/ranking.js";
import type { MarketScanOutput } from "../ai/schemas.js";
import { buildComparisonNotesTemplate, generateDirectBaseline } from "../pipeline/report.js";

async function main() {
  const env = loadEnv();
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);

  console.log(`=== NSP India Vertical Slice Run (${dateStamp}) ===`);
  console.log(`Lookback: ${env.LOOKBACK_DAYS} days | Candidate LLM cap: ${env.MAX_CLUSTERS_FOR_LLM}\n`);

  // Step 1 & 2: Load seed data + collect, normalize, deduplicate, cluster & pre-filter
  const seeds = await loadSeedDataset();
  const { items, sourceRuns } = await collectRssSources(SOURCE_REGISTRY, env.LOOKBACK_DAYS, now);

  for (const run of sourceRuns) {
    const detail = run.error ? `error="${run.error}"` : `fetched=${run.fetchedCount}, inWindow=${run.inWindowCount}`;
    console.log(`- [${run.status.toUpperCase()}] ${run.sourceName}: ${detail}`);
  }

  const normalized = normalizeSignals(items, now);
  const { uniqueSignals, droppedDuplicates } = deduplicateSignals(normalized);
  const clusters = clusterSignals(uniqueSignals);
  const broadPool = selectCandidateClusters(clusters, 24, now);

  console.log(
    `\nDeterministic summary: uniqueSignals=${uniqueSignals.length}, droppedDuplicates=${droppedDuplicates}, clusters=${clusters.length}, broadPool=${broadPool.length}`,
  );

  const outDir = path.resolve("reports", dateStamp);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "signals-snapshot.json"),
    JSON.stringify(
      {
        generated_at: now.toISOString(),
        lookback_days: env.LOOKBACK_DAYS,
        source_runs: sourceRuns,
        total_signals: uniqueSignals.length,
        total_clusters: clusters.length,
        selected_candidate_ids: broadPool.map((c) => c.event_id),
        clusters,
      },
      null,
      2,
    ),
    "utf8",
  );

  if (!hasAnyAiKey(env)) {
    console.log("\n[STOPPED BEFORE AI STAGES] Neither GEMINI_API_KEY(S) nor OPENROUTER_API_KEY is set in .env.");
    console.log("Selected candidate clusters for AI reasoning:");
    for (const c of broadPool) {
      console.log(`  * ${c.event_id} [${c.country_relevance}] ${c.cluster_title}`);
    }
    console.log("\nAdd GEMINI_API_KEY / GEMINI_API_KEYS to .env and re-run `npm run report:once` to generate the 8-question report & baseline comparison.");
    return;
  }

  // Step 3: Multi-stage AI reasoning pipeline
  // Multi-provider quota split: OpenRouter free tier (if set) for context + matching, Gemini for ideation + critic
  const ai = new GeminiPipelineClient(env);
  const firstHalf = selectFirstHalfTarget(env);
  let marketScan: MarketScanOutput | null = null;
  if (broadPool.length > 0) {
    try {
      console.log(`\nRunning Gemini India market & competitor trend check across ${broadPool.length} clusters...`);
      marketScan = await scanIndiaMarketTrends({
        ai,
        model: env.GEMINI_MODEL_LIGHT,
        clusters: broadPool,
        seeds,
      });
    } catch (scanErr) {
      console.warn(
        "  -> [Market Scan Skipped] Falling back to deterministic ranking:",
        scanErr instanceof Error ? scanErr.message : String(scanErr),
      );
    }
  }
  const candidates = marketScan
    ? reorderClustersByMarketScan(broadPool, marketScan, env.MAX_CLUSTERS_FOR_LLM)
    : broadPool.slice(0, env.MAX_CLUSTERS_FOR_LLM);
  const contextPacks = [];
  const opportunityResults = [];
  const evaluatedPool: EvaluatedCandidate[] = [];

  for (const cluster of candidates) {
    console.log(`\nResearching ${cluster.event_id}: ${cluster.cluster_title}`);
    try {
      const contextPack = await researchClusterContext(ai, firstHalf.model, cluster, firstHalf.provider);
      contextPacks.push(contextPack);

      const opportunity = await matchOpportunityToBrand(ai, firstHalf.model, contextPack, seeds, firstHalf.provider);
      opportunityResults.push(opportunity);

      if (opportunity.opportunity_status === "REJECT") {
        console.log(`  -> Opportunity REJECTED: ${opportunity.rejection_reason ?? "No natural fit"}`);
        continue;
      }

      console.log(`  -> Opportunity ACCEPTED (${opportunity.matched_services.join(", ")}) -> Generating creative routes...`);
      const ideation = await generateCreativeRoutes(ai, env.GEMINI_MODEL_REASONING, contextPack, opportunity, seeds);

      console.log(`  -> Running isolated critic (${env.GEMINI_MODEL_CRITIC}) on ${ideation.creative_routes.length} routes...`);
      const criticOutput = await critiqueCreativeRoutes(ai, env.GEMINI_MODEL_CRITIC, contextPack, opportunity, ideation, seeds);

      for (const review of criticOutput.reviews) {
        const route = ideation.creative_routes[review.route_index];
        if (route) {
          evaluatedPool.push({ cluster, contextPack, opportunity, route, review });
        }
      }
    } catch (err) {
      console.error(
        `  -> [Cluster Error] ${cluster.event_id} skipped:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const recommendations = rankAndSelectRecommendations(evaluatedPool, now, 6);

  // Step 4: Direct-LLM Baseline on exact same candidate signals
  console.log("\nRunning Direct-LLM Baseline (Prompt E) on identical candidate clusters...");
  const baseline = await generateDirectBaseline(ai, env.GEMINI_MODEL_REASONING, candidates, seeds);
  const comparisonNotes = buildComparisonNotesTemplate(dateStamp, recommendations, baseline);
  const tokenSummary = ai.getTokenSummary();
  const actualModelsUsed = Array.from(new Set(ai.usageRecords.map((r) => r.model)));
  const baselineUsage = ai.usageRecords.find((r) => r.stage === "baseline:direct-llm");

  await Promise.all([
    writeFile(
      path.join(outDir, "pipeline-report.json"),
      JSON.stringify(
        {
          generated_at: now.toISOString(),
          target_market: "India",
          configured_models: {
            first_half_provider: firstHalf.provider,
            first_half_model: firstHalf.model,
            light: env.GEMINI_MODEL_LIGHT,
            reasoning: env.GEMINI_MODEL_REASONING,
            critic: env.GEMINI_MODEL_CRITIC,
            fallback: env.GEMINI_MODEL_FALLBACK,
          },
          actual_models_used: actualModelsUsed,
          token_usage: tokenSummary,
          usage_breakdown: ai.usageRecords,
          market_scan: marketScan,
          recommendations_count: recommendations.length,
          recommendations,
          context_packs: contextPacks,
          opportunities: opportunityResults,
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(
      path.join(outDir, "direct-baseline.json"),
      JSON.stringify(
        {
          generated_at: now.toISOString(),
          model: baselineUsage?.model ?? env.GEMINI_MODEL_REASONING,
          ideas_count: baseline.ideas.length,
          ...baseline,
        },
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(
      path.join(outDir, "comparison-notes.json"),
      JSON.stringify(comparisonNotes, null, 2),
      "utf8",
    ),
  ]);

  console.log(`\n=== Report Complete ===`);
  console.log(`Pipeline recommendations: ${recommendations.length} | Baseline ideas: ${baseline.ideas.length}`);
  console.log(`Gemini calls: ${tokenSummary.calls} | Total tokens: ${tokenSummary.totalTokens} (in=${tokenSummary.inputTokens}, out=${tokenSummary.outputTokens})`);
  console.log(`Saved files to ${outDir}`);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exitCode = 1;
});
