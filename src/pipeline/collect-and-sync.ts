import type { AppDb } from "../db/client.js";
import { persistCollectionRun, syncSeedData } from "../db/repositories/persistence.js";
import type { SeedDataset } from "../data/loader.js";
import { collectRssSources } from "../sources/rss-collector.js";
import { SOURCE_REGISTRY } from "../sources/source-registry.js";
import { normalizeSignals } from "./normalize.js";
import { deduplicateSignals } from "./deduplicate.js";
import { clusterSignals } from "./cluster.js";
import type { EventCluster, SourceRunResult } from "../ai/schemas.js";

export interface CollectAndSyncResult {
  sourceRuns: SourceRunResult[];
  uniqueSignalsCount: number;
  droppedDuplicates: number;
  clusters: EventCluster[];
  persistedToDb: boolean;
}

/**
 * Shared RSS collection, normalization, deduplication, clustering, and optional Neon persistence.
 * Used by both `collect-daily` CLI and the on-demand dashboard trigger.
 */
export async function collectAndSyncSignals(params: {
  db: AppDb | null;
  seeds: SeedDataset;
  lookbackDays: number;
  now?: Date;
  runKeyPrefix?: string;
}): Promise<CollectAndSyncResult> {
  const now = params.now ?? new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const collectionRunKey = `${params.runKeyPrefix ?? "collect"}-${dateStamp}`;

  const { items, sourceRuns } = await collectRssSources(SOURCE_REGISTRY, params.lookbackDays, now);
  const normalized = normalizeSignals(items, now);
  const { uniqueSignals, droppedDuplicates } = deduplicateSignals(normalized);
  const clusters = clusterSignals(uniqueSignals);

  let persistedToDb = false;
  if (params.db) {
    await syncSeedData(params.db, params.seeds, SOURCE_REGISTRY);
    await persistCollectionRun(params.db, collectionRunKey, sourceRuns, clusters);
    persistedToDb = true;
  }

  return {
    sourceRuns,
    uniqueSignalsCount: uniqueSignals.length,
    droppedDuplicates,
    clusters,
    persistedToDb,
  };
}

