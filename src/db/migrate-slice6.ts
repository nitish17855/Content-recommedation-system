import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../config/env.js";

export async function runSlice6Migration() {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const sql = neon(env.DATABASE_URL);
  console.log("=== Starting Slice 6 Schema Migration (Heartbeat, Worker Token & Active Run Partial Index) ===");

  // 1. Add heartbeat_at and worker_token columns to report_runs
  console.log("[Migration] Adding heartbeat_at and worker_token to report_runs...");
  await sql`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamp with time zone;`;
  await sql`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS worker_token text;`;

  // 2. Mark any existing orphan/stalled running runs as failed so index creation is clean
  console.log("[Migration] Cleaning up any stale runs before partial unique index creation...");
  await sql`
    UPDATE report_runs
    SET status = 'failed',
        error_message = 'Marked failed during Slice 6 migration (stale pre-heartbeat run)',
        completed_at = NOW()
    WHERE status = 'running';
  `;

  // 3. Create partial unique index
  console.log("[Migration] Creating report_runs_active_brand_idx partial unique index...");
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS report_runs_active_brand_idx
    ON report_runs (brand_profile_id)
    WHERE status = 'running';
  `;

  console.log("=== Slice 6 Schema Migration Completed Successfully ===");
}

if (process.argv[1]?.endsWith("migrate-slice6.ts") || process.argv[1]?.endsWith("migrate-slice6.js")) {
  runSlice6Migration().catch((err) => {
    console.error("Slice 6 migration failed:", err);
    process.exit(1);
  });
}

