import { loadEnv } from "../config/env.js";
import { loadSeedDataset } from "../data/loader.js";
import { createDb } from "../db/client.js";
import { collectAndSyncSignals } from "../pipeline/collect-and-sync.js";
import { runDueReportGeneration } from "./generate-report.js";

async function main() {
  const env = loadEnv();
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);

  console.log(`=== Daily Collector & 15-Day Schedule Check (${dateStamp}) ===`);
  const seeds = await loadSeedDataset();
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;

  const result = await collectAndSyncSignals({
    db,
    seeds,
    lookbackDays: env.LOOKBACK_DAYS,
    now,
  });

  for (const run of result.sourceRuns) {
    const detail = run.error ? `error="${run.error}"` : `fetched=${run.fetchedCount}, inWindow=${run.inWindowCount}`;
    console.log(`- [${run.status.toUpperCase()}] ${run.sourceName}: ${detail}`);
  }

  console.log(
    `\nCollected: uniqueSignals=${result.uniqueSignalsCount}, droppedDuplicates=${result.droppedDuplicates}, clusters=${result.clusters.length}`,
  );

  if (!result.persistedToDb) {
    console.log("\n[DB SKIPPED] DATABASE_URL is not set in .env. Set Neon DATABASE_URL to persist signals and check next_report_at.");
    return;
  }

  console.log("[DB] Synced seeds, source_runs, signals, and event_clusters to Neon PostgreSQL.");

  // Check exact 15-day due timestamp stored in PostgreSQL and generate report ONLY when due
  await runDueReportGeneration({ force: false });
}

main().catch((err) => {
  console.error("Daily collection failed:", err);
  process.exitCode = 1;
});
