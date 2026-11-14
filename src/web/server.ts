import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { hasAnyAiKey, loadEnv } from "../config/env.js";
import { loadSeedDataset } from "../data/loader.js";
import { createDb } from "../db/client.js";
import { brandProfiles, services, competitors } from "../db/schema.js";
import { getDashboardSnapshot } from "../db/repositories/dashboard.js";
import {
  claimActiveOrNewReportRun,
  loadRecentClustersFromDb,
} from "../db/repositories/persistence.js";
import { collectAndSyncSignals } from "../pipeline/collect-and-sync.js";
import { runDueReportGeneration } from "../cli/generate-report.js";
import { GeminiPipelineClient } from "../ai/client.js";
import { answerOnDemandRequest, selectOnDemandTarget } from "../pipeline/on-demand.js";
import { normalizeBusinessUrl } from "../pipeline/url-normalize.js";
import { runWebsiteRecommendationPipeline } from "../pipeline/orchestrator.js";
import {
  defaultProgressBroadcaster,
  createManagedSubscription,
} from "../pipeline/progress-broadcaster.js";

interface ManualJobState {
  status: "idle" | "running" | "completed" | "failed";
  phase: string;
  startedAt: string | null;
  finishedAt: string | null;
  runKey: string | null;
  recommendationsCount: number | null;
  error: string | null;
}

const manualJob: ManualJobState = {
  status: "idle",
  phase: "Idle",
  startedAt: null,
  finishedAt: null,
  runKey: null,
  recommendationsCount: null,
  error: null,
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > 64 * 1024) {
      throw new Error("Request body too large.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function runManualReportJob() {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured in .env.");
  }

  const now = new Date();
  const runKey = `manual-${now.toISOString().replace(/[:.]/g, "-")}`;
  manualJob.status = "running";
  manualJob.phase = "Collecting live RSS signals across 18 independent channels (AI/tech, startups, ecommerce, social, campaigns & trends)...";
  manualJob.startedAt = now.toISOString();
  manualJob.finishedAt = null;
  manualJob.runKey = runKey;
  manualJob.recommendationsCount = null;
  manualJob.error = null;

  try {
    const db = createDb(env.DATABASE_URL);
    const seeds = await loadSeedDataset();

    await collectAndSyncSignals({
      db,
      seeds,
      lookbackDays: env.LOOKBACK_DAYS,
      now,
      runKeyPrefix: "manual-collect",
    });

    manualJob.phase = "Running multi-provider AI reasoning (OpenRouter + Gemini) & ranking...";
    const reportResult = await runDueReportGeneration({
      force: true,
      runKey,
    });

    manualJob.status = "completed";
    manualJob.phase = "Completed";
    manualJob.finishedAt = new Date().toISOString();
    manualJob.recommendationsCount = "recommendationsCount" in reportResult ? (reportResult.recommendationsCount ?? 0) : 0;
  } catch (err) {
    manualJob.status = "failed";
    manualJob.phase = "Failed";
    manualJob.finishedAt = new Date().toISOString();
    manualJob.error = err instanceof Error ? err.message : String(err);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && reqUrl.pathname === "/") {
    const htmlPath = path.resolve("src", "web", "index.html");
    const html = await readFile(htmlPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/job") {
    sendJson(res, 200, manualJob);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/dashboard") {
    const env = loadEnv();
    if (!env.DATABASE_URL) {
      sendJson(res, 500, { error: "DATABASE_URL is not configured in .env." });
      return;
    }
    const db = createDb(env.DATABASE_URL);
    const runIdParam = reqUrl.searchParams.get("runId");
    const brandIdParam = reqUrl.searchParams.get("brandId");
    const businessKeyParam = reqUrl.searchParams.get("businessKey");
    const requestedRunId = runIdParam ? Number(runIdParam) : undefined;
    const brandIdentifier = brandIdParam ? Number(brandIdParam) : (businessKeyParam ?? undefined);
    const snapshot = await getDashboardSnapshot(
      db,
      requestedRunId && Number.isFinite(requestedRunId) ? requestedRunId : undefined,
      brandIdentifier,
    );
    sendJson(res, 200, {
      ...snapshot,
      manualJob,
      aiConfigured: hasAnyAiKey(env),
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/trigger-report") {
    if (manualJob.status === "running") {
      sendJson(res, 409, { error: "A manual report generation job is already running.", manualJob });
      return;
    }
    void runManualReportJob();
    sendJson(res, 202, { started: true, manualJob });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/ask-now") {
    const body = await readJsonBody(req);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const platformPreference = typeof body.platform === "string" ? body.platform.trim() : "";

    if (!question) {
      sendJson(res, 400, { error: "Please enter what you need content about right now." });
      return;
    }

    const env = loadEnv();
    const seeds = await loadSeedDataset();
    const db = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;

    let clusters = db ? (await loadRecentClustersFromDb(db, env.LOOKBACK_DAYS)).map((r) => r.cluster) : [];
    if (clusters.length === 0) {
      const collected = await collectAndSyncSignals({
        db,
        seeds,
        lookbackDays: env.LOOKBACK_DAYS,
        runKeyPrefix: "ondemand-collect",
      });
      clusters = collected.clusters;
    }

    const ai = new GeminiPipelineClient(env);
    const target = selectOnDemandTarget(env);
    const answer = await answerOnDemandRequest({
      ai,
      model: target.model,
      provider: target.provider,
      question,
      platformPreference,
      clusters,
      seeds,
    });

    sendJson(res, 200, {
      answeredAt: new Date().toISOString(),
      providerUsed: ai.usageRecords[ai.usageRecords.length - 1]?.provider ?? target.provider,
      modelUsed: ai.usageRecords[ai.usageRecords.length - 1]?.model ?? target.model,
      tokenUsage: ai.getTokenSummary(),
      answer,
    });
    return;
  }

  // Slice 6 Endpoint 1: Start website recommendation run with in-flight deduplication
  if (req.method === "POST" && reqUrl.pathname === "/api/recommendations/start") {
    const body = await readJsonBody(req);
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!rawUrl) {
      sendJson(res, 400, { error: "Website URL is required." });
      return;
    }

    let canonicalUrl: string;
    let businessKey: string;
    try {
      const normalized = normalizeBusinessUrl(rawUrl);
      canonicalUrl = normalized.canonicalUrl;
      businessKey = normalized.businessKey;
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid website URL." });
      return;
    }

    const env = loadEnv();
    if (!env.DATABASE_URL) {
      sendJson(res, 500, { error: "DATABASE_URL is not configured." });
      return;
    }
    const db = createDb(env.DATABASE_URL);

    // 1. Resolve or create pending brand profile
    let [brand] = await db
      .select()
      .from(brandProfiles)
      .where(eq(brandProfiles.businessKey, businessKey))
      .limit(1);

    if (!brand) {
      const parsedUrl = new URL(canonicalUrl);
      const host = parsedUrl.hostname.replace(/^www\./, "");
      const brandKey = `brand_${businessKey.replace(/^biz_/, "")}`;
      const [insertedBrand] = await db
        .insert(brandProfiles)
        .values({
          brandKey,
          businessKey,
          originalUrl: rawUrl,
          canonicalUrl,
          brandName: host,
          industry: "General",
          targetMarket: "Global",
          primaryDomain: host,
          onboardingStatus: "pending",
          profileJson: {},
        })
        .returning();
      brand = insertedBrand!;
    }

    // 2. Claim active or new report run with database-level deduplication
    const runKey = `run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const workerToken = crypto.randomUUID();
    const claim = await claimActiveOrNewReportRun(
      db,
      brand.id,
      runKey,
      {},
      workerToken,
    );

    if (claim.reused) {
      // Return existing active run without re-crawling or restarting work
      sendJson(res, 200, {
        runId: claim.run.id,
        status: "running",
        reused: true,
        brandId: brand.id,
        businessKey,
      });
      return;
    }

    // 3. Launch recommendation pipeline asynchronously in the background
    const refreshProfile = Boolean(body.refreshProfile);
    void runWebsiteRecommendationPipeline(db, {
      url: rawUrl,
      runId: claim.run.id,
      workerToken,
      refreshProfile,
      broadcaster: defaultProgressBroadcaster,
    }).catch((err) => {
      console.error(`[pipeline] Background execution failed for runId=${claim.run.id}:`, err);
    });

    sendJson(res, 202, {
      runId: claim.run.id,
      status: "running",
      reused: false,
      brandId: brand.id,
      businessKey,
    });
    return;
  }

  // Slice 6 Endpoint 2: Real-time progress delivery via Server-Sent Events (SSE)
  if (req.method === "GET" && reqUrl.pathname === "/api/recommendations/stream") {
    const runIdParam = reqUrl.searchParams.get("runId");
    const runId = runIdParam ? Number(runIdParam) : NaN;
    if (!Number.isFinite(runId) || runId <= 0) {
      sendJson(res, 400, { error: "A valid positive integer runId query parameter is required." });
      return;
    }

    const env = loadEnv();
    if (!env.DATABASE_URL) {
      sendJson(res, 500, { error: "DATABASE_URL is not configured." });
      return;
    }
    const db = createDb(env.DATABASE_URL);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let isClosed = false;
    let subscription: { unsubscribe: () => void } | null = null;

    const keepAliveTimer = setInterval(() => {
      if (!isClosed) {
        res.write(": heartbeat\n\n");
      }
    }, 15_000);

    req.on("close", () => {
      isClosed = true;
      clearInterval(keepAliveTimer);
      if (subscription) {
        subscription.unsubscribe();
      }
    });

    try {
      subscription = await createManagedSubscription(
        db,
        runId,
        (snapshot) => {
          if (!isClosed) {
            res.write(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`);
          }
        },
        defaultProgressBroadcaster,
      );
    } catch (err) {
      console.error(`[sse] Subscription error for runId=${runId}:`, err);
      if (!isClosed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
    }
    return;
  }

  // Slice 6 Endpoint 3: Snapshot status query for recovery and polling fallback
  if (req.method === "GET" && reqUrl.pathname === "/api/recommendations/status") {
    const runIdParam = reqUrl.searchParams.get("runId");
    const runId = runIdParam ? Number(runIdParam) : NaN;
    if (!Number.isFinite(runId) || runId <= 0) {
      sendJson(res, 400, { error: "A valid positive integer runId query parameter is required." });
      return;
    }

    const env = loadEnv();
    if (!env.DATABASE_URL) {
      sendJson(res, 500, { error: "DATABASE_URL is not configured." });
      return;
    }
    const db = createDb(env.DATABASE_URL);

    const snapshot = await defaultProgressBroadcaster.getLatestSnapshot(db, runId);
    if (!snapshot) {
      sendJson(res, 404, { error: `No active or recent run found for runId=${runId}` });
      return;
    }
    sendJson(res, 200, snapshot);
    return;
  }

  // Slice 6 Endpoint 4: Brand details, verified offerings and trade competitors
  if (req.method === "GET" && reqUrl.pathname === "/api/brand/details") {
    const brandIdParam = reqUrl.searchParams.get("brandId");
    const businessKeyParam = reqUrl.searchParams.get("businessKey");

    const env = loadEnv();
    if (!env.DATABASE_URL) {
      sendJson(res, 500, { error: "DATABASE_URL is not configured." });
      return;
    }
    const db = createDb(env.DATABASE_URL);

    let brand = null;
    if (brandIdParam) {
      const bId = Number(brandIdParam);
      if (Number.isFinite(bId)) {
        const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.id, bId)).limit(1);
        brand = rows[0] ?? null;
      }
    } else if (businessKeyParam) {
      const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.businessKey, businessKeyParam)).limit(1);
      brand = rows[0] ?? null;
    }

    if (!brand) {
      sendJson(res, 404, { error: "Brand profile not found." });
      return;
    }

    const brandServices = await db.select().from(services).where(eq(services.brandProfileId, brand.id));
    const brandCompetitors = await db.select().from(competitors).where(eq(competitors.brandProfileId, brand.id));

    sendJson(res, 200, {
      brand: {
        id: brand.id,
        brandKey: brand.brandKey,
        businessKey: brand.businessKey,
        brandName: brand.brandName,
        industry: brand.industry,
        targetMarket: brand.targetMarket,
        canonicalUrl: brand.canonicalUrl,
        onboardingStatus: brand.onboardingStatus,
        lastCrawledAt: brand.lastCrawledAt?.toISOString() ?? null,
        profileJson: brand.profileJson,
      },
      services: brandServices.map((s) => ({
        serviceId: s.serviceId,
        name: s.name,
        category: s.category,
        detailsJson: s.detailsJson,
      })),
      competitors: brandCompetitors.map((c) => ({
        slug: c.slug,
        name: c.name,
        classification: c.classification,
        website: c.website,
        detailsJson: c.detailsJson,
      })),
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const port = Number(process.env.PORT || 3000);
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[dashboard] Request error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal server error" });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`NSP Brand Intelligence Dashboard running at http://127.0.0.1:${port}`);
});

