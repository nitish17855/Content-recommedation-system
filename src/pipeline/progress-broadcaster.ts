import { EventEmitter } from "node:events";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../db/client.js";
import { reportRuns } from "../db/schema.js";

export const PIPELINE_STAGES = [
  "url_validation",
  "brand_lookup",
  "website_analysis",
  "brand_extraction",
  "competitor_research",
  "industry_sources",
  "signal_collection",
  "event_clustering",
  "context_research",
  "opportunity_matching",
  "content_ideation",
  "critic_evaluation",
  "ranking_persistence",
  "completed",
] as const;

export type ProgressStageName = (typeof PIPELINE_STAGES)[number];
export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StageProgress {
  name: ProgressStageName;
  status: StageStatus;
  label: string;
  startedAt?: string | null;
  completedAt?: string | null;
  details?: string | null;
}

export interface PipelineProgressSnapshot {
  runId: number;
  revision: number;
  currentStage: ProgressStageName;
  overallStatus: "pending" | "running" | "completed" | "failed";
  stages: Record<ProgressStageName, StageProgress>;
  completedStages: ProgressStageName[];
  startedAt: string;
  updatedAt: string;
  message: string;
  error?: string | null;
}

export const STAGE_DEFAULT_LABELS: Record<ProgressStageName, string> = {
  url_validation: "Validating business URL",
  brand_lookup: "Resolving brand profile",
  website_analysis: "Crawling website structure",
  brand_extraction: "Extracting brand offerings & audience",
  competitor_research: "Discovering verified trade competitors",
  industry_sources: "Discovering trade feeds & sources",
  signal_collection: "Collecting cross-industry signals",
  event_clustering: "Clustering candidate market events",
  context_research: "Gathering deep event evidence",
  opportunity_matching: "Matching 6 Universal Content Archetypes",
  content_ideation: "Synthesizing 8-question video briefs",
  critic_evaluation: "Objective critic quality audit",
  ranking_persistence: "Scoring, ranking & persisting recommendations",
  completed: "Recommendations ready",
};

export function createInitialSnapshot(
  runId: number,
  startedAt: Date = new Date(),
): PipelineProgressSnapshot {
  const startedIso = startedAt.toISOString();
  const stages: Record<ProgressStageName, StageProgress> = {} as any;

  for (const name of PIPELINE_STAGES) {
    stages[name] = {
      name,
      status: name === "url_validation" ? "running" : "pending",
      label: STAGE_DEFAULT_LABELS[name],
      startedAt: name === "url_validation" ? startedIso : null,
      completedAt: null,
      details: null,
    };
  }

  return {
    runId,
    revision: 1,
    currentStage: "url_validation",
    overallStatus: "running",
    stages,
    completedStages: [],
    startedAt: startedIso,
    updatedAt: startedIso,
    message: "Initializing recommendation pipeline...",
    error: null,
  };
}

export interface PublishProgressParams {
  runId: number;
  workerToken: string;
  stage: ProgressStageName;
  status?: StageStatus;
  message?: string;
  details?: string;
  error?: string | null;
  now?: Date;
  /**
   * Optional custom transformation function to mutate or mark stages
   * (e.g. marking cached stages as "skipped")
   */
  mutateSnapshot?: (snapshot: PipelineProgressSnapshot) => void;
}

export class ProgressBroadcaster {
  private emitter = new EventEmitter();
  private inMemorySnapshots = new Map<number, PipelineProgressSnapshot>();

  constructor() {
    // Accommodate many concurrent browser SSE listeners
    this.emitter.setMaxListeners(250);
  }

  public getSubscriberCount(runId: number): number {
    return this.emitter.listenerCount(`progress:${runId}`);
  }

  public async getLatestSnapshot(
    db: AppDb,
    runId: number,
  ): Promise<PipelineProgressSnapshot | null> {
    const [row] = await db
      .select({
        id: reportRuns.id,
        status: reportRuns.status,
        checkpointStage: reportRuns.checkpointStage,
        checkpointJson: reportRuns.checkpointJson,
        errorMessage: reportRuns.errorMessage,
        startedAt: reportRuns.startedAt,
      })
      .from(reportRuns)
      .where(eq(reportRuns.id, runId))
      .limit(1);

    if (!row) return null;

    if (row.checkpointJson && typeof row.checkpointJson === "object") {
      const snap = row.checkpointJson as PipelineProgressSnapshot;
      if (snap.revision && snap.stages && snap.currentStage) {
        this.inMemorySnapshots.set(runId, snap);
        return snap;
      }
    }

    // Fallback if checkpointJson has not been initialized
    const fallback = createInitialSnapshot(runId, row.startedAt);
    if (row.status === "failed") {
      fallback.overallStatus = "failed";
      fallback.error = row.errorMessage;
    } else if (row.status === "completed") {
      fallback.overallStatus = "completed";
      fallback.currentStage = "completed";
    }
    this.inMemorySnapshots.set(runId, fallback);
    return fallback;
  }

  /**
   * Database-First Progress Publishing:
   * 1. Verifies worker ownership and active run in DB.
   * 2. Builds next immutable snapshot with monotonically incremented revision.
   * 3. Awaits successful PostgreSQL update before emitting events.
   * 4. If DB fails or worker is fenced, throws and does NOT emit.
   * 5. Safely broadcasts to all active SSE subscribers without interruption on subscriber errors.
   */
  public async publishProgress(
    db: AppDb,
    params: PublishProgressParams,
  ): Promise<PipelineProgressSnapshot> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();

    // 1. Verify worker ownership & active lease first
    const [activeRun] = await db
      .select({
        id: reportRuns.id,
        status: reportRuns.status,
        workerToken: reportRuns.workerToken,
        checkpointJson: reportRuns.checkpointJson,
        startedAt: reportRuns.startedAt,
      })
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.id, params.runId),
          inArray(reportRuns.status, ["running", "completed"]),
          eq(reportRuns.workerToken, params.workerToken),
        ),
      )
      .limit(1);

    if (!activeRun) {
      throw new Error(
        `Worker fenced: lost active run ownership for reportRunId=${params.runId}. Cannot publish progress.`,
      );
    }

    // 2. Load previous snapshot or create initial
    let prevSnapshot: PipelineProgressSnapshot;
    if (
      activeRun.checkpointJson &&
      typeof activeRun.checkpointJson === "object" &&
      "stages" in activeRun.checkpointJson &&
      (activeRun.checkpointJson as any).stages
    ) {
      prevSnapshot = activeRun.checkpointJson as PipelineProgressSnapshot;
    } else if (this.inMemorySnapshots.has(params.runId)) {
      prevSnapshot = this.inMemorySnapshots.get(params.runId)!;
    } else {
      prevSnapshot = createInitialSnapshot(params.runId, activeRun.startedAt);
    }

    // 3. Compute new snapshot with monotonic revision
    const nextRevision = (prevSnapshot.revision ?? 0) + 1;
    const initialStages = createInitialSnapshot(params.runId, activeRun.startedAt).stages;
    const stages: Record<ProgressStageName, StageProgress> = {
      ...initialStages,
      ...(prevSnapshot.stages ?? {}),
    };

    // Advance previous running stages to completed (unless skipping or failing)
    const completedSet = new Set<ProgressStageName>(prevSnapshot.completedStages ?? []);
    if (prevSnapshot.currentStage && prevSnapshot.currentStage !== params.stage) {
      const prevStageObj = stages[prevSnapshot.currentStage];
      if (prevStageObj && prevStageObj.status === "running") {
        stages[prevSnapshot.currentStage] = {
          ...prevStageObj,
          status: "completed",
          completedAt: nowIso,
        };
        completedSet.add(prevSnapshot.currentStage);
      }
    }

    // Set status for current requested stage
    const targetStatus = params.status ?? "running";
    const currentStageObj = stages[params.stage] ?? {
      name: params.stage,
      label: STAGE_DEFAULT_LABELS[params.stage] ?? params.stage,
      status: "pending",
    };

    stages[params.stage] = {
      ...currentStageObj,
      status: targetStatus,
      startedAt: currentStageObj.startedAt ?? nowIso,
      completedAt: targetStatus === "completed" ? nowIso : currentStageObj.completedAt,
      details: params.details ?? currentStageObj.details,
    };

    if (targetStatus === "completed") {
      completedSet.add(params.stage);
    }

    let overallStatus: "pending" | "running" | "completed" | "failed" = prevSnapshot.overallStatus;
    if (targetStatus === "failed" || params.error) {
      overallStatus = "failed";
    } else if (params.stage === "completed" && targetStatus === "completed") {
      overallStatus = "completed";
    }

    const nextSnapshot: PipelineProgressSnapshot = {
      runId: params.runId,
      revision: nextRevision,
      currentStage: params.stage,
      overallStatus,
      stages,
      completedStages: Array.from(completedSet),
      startedAt: prevSnapshot.startedAt,
      updatedAt: nowIso,
      message: params.message ?? STAGE_DEFAULT_LABELS[params.stage] ?? "Processing...",
      error: params.error ?? null,
    };

    if (params.mutateSnapshot) {
      params.mutateSnapshot(nextSnapshot);
    }

    // 4. PostgreSQL write with fencing protection
    const [updatedRecord] = await db
      .update(reportRuns)
      .set({
        checkpointStage: nextSnapshot.currentStage,
        checkpointJson: nextSnapshot,
        heartbeatAt: now,
        ...(overallStatus === "failed"
          ? {
              status: "failed",
              errorMessage: params.error ?? "Pipeline execution failed",
              completedAt: now,
            }
          : overallStatus === "completed"
            ? {
                status: "completed",
                completedAt: now,
              }
            : {}),
      })
      .where(
        and(
          eq(reportRuns.id, params.runId),
          inArray(reportRuns.status, ["running", "completed"]),
          eq(reportRuns.workerToken, params.workerToken),
        ),
      )
      .returning({ id: reportRuns.id });

    if (!updatedRecord) {
      throw new Error(
        `Worker fenced: failed atomic database update for reportRunId=${params.runId}. Lost lease ownership.`,
      );
    }

    // 5. Update in-memory snapshot cache
    this.inMemorySnapshots.set(params.runId, nextSnapshot);

    // 6. Safe Emission to all SSE subscribers (individual subscriber failures do NOT affect worker)
    this.emitProgress(params.runId, nextSnapshot);

    return nextSnapshot;
  }

  private emitProgress(runId: number, snapshot: PipelineProgressSnapshot): void {
    const listeners = this.emitter.listeners(`progress:${runId}`);
    for (const listener of listeners) {
      try {
        (listener as (s: PipelineProgressSnapshot) => void)(snapshot);
      } catch (err) {
        // Individual disconnected client error caught and suppressed
      }
    }
  }

  public subscribe(
    runId: number,
    listener: (snapshot: PipelineProgressSnapshot) => void,
  ): () => void {
    const channel = `progress:${runId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  public clearRun(runId: number): void {
    this.emitter.removeAllListeners(`progress:${runId}`);
    this.inMemorySnapshots.delete(runId);
  }
}

export const defaultProgressBroadcaster = new ProgressBroadcaster();

/**
 * Race-Free SSE Client Subscription Helper:
 * 1. Registers the listener immediately into buffer mode.
 * 2. Fetches the latest database snapshot.
 * 3. Delivers the initial snapshot to the client.
 * 4. Delivers any buffered events with revision > initialSnapshot.revision.
 * 5. Guarantees strictly monotonic revision delivery and zero lost events.
 */
export async function createManagedSubscription(
  db: AppDb,
  runId: number,
  onEvent: (snapshot: PipelineProgressSnapshot) => void,
  broadcaster: ProgressBroadcaster = defaultProgressBroadcaster,
): Promise<{ initialSnapshot: PipelineProgressSnapshot | null; unsubscribe: () => void }> {
  let initialDelivered = false;
  let lastDeliveredRevision = 0;
  const buffer: PipelineProgressSnapshot[] = [];

  const rawListener = (snapshot: PipelineProgressSnapshot) => {
    if (!initialDelivered) {
      buffer.push(snapshot);
    } else {
      if (snapshot.revision > lastDeliveredRevision) {
        lastDeliveredRevision = snapshot.revision;
        try {
          onEvent(snapshot);
        } catch {
          // ignore client push errors
        }
      }
    }
  };

  const unsubscribe = broadcaster.subscribe(runId, rawListener);

  try {
    const dbSnapshot = await broadcaster.getLatestSnapshot(db, runId);
    if (dbSnapshot) {
      lastDeliveredRevision = dbSnapshot.revision;
      initialDelivered = true;
      try {
        onEvent(dbSnapshot);
      } catch {
        // ignore client push errors
      }
    } else {
      initialDelivered = true;
    }

    // Flush any events that arrived while awaiting DB read
    for (const buffered of buffer) {
      if (buffered.revision > lastDeliveredRevision) {
        lastDeliveredRevision = buffered.revision;
        try {
          onEvent(buffered);
        } catch {
          // ignore
        }
      }
    }

    return { initialSnapshot: dbSnapshot, unsubscribe };
  } catch (err) {
    unsubscribe();
    throw err;
  }
}

