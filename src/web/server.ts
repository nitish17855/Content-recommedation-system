import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../config/env.js";
import { loadSeedDataset } from "../data/loader.js";
import { createDb } from "../db/client.js";
import { getDashboardSnapshot } from "../db/repositories/dashboard.js";
import { loadRecentClustersFromDb } from "../db/repositories/persistence.js";
import { collectAndSyncSignals } from "../pipeline/collect-and-sync.js";
import { runDueReportGeneration } from "../cli/generate-report.js";
import { GeminiPipelineClient } from "../ai/client.js";
import { answerOnDemandRequest, selectOnDemandTarget } from "../pipeline/on-demand.js";

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
  manualJob.phase = "Collecting live RSS signals across 6 feeds and syncing Neon...";
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
    const requestedRunId = runIdParam ? Number(runIdParam) : undefined;
    const snapshot = await getDashboardSnapshot(
      db,
      requestedRunId && Number.isFinite(requestedRunId) ? requestedRunId : undefined,
    );
    sendJson(res, 200, {
      ...snapshot,
      manualJob,
      aiConfigured: Boolean(env.GEMINI_API_KEY || env.OPENROUTER_API_KEY),
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

