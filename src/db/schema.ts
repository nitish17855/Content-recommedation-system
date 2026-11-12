import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

// 1. brand_profiles — NSP profile, target market configuration, and exact 15-day schedule pointer
export const brandProfiles = pgTable("brand_profiles", {
  id: serial("id").primaryKey(),
  brandKey: text("brand_key").notNull().unique(),
  brandName: text("brand_name").notNull(),
  targetMarket: text("target_market").notNull(),
  primaryDomain: text("primary_domain").notNull(),
  secondaryDomain: text("secondary_domain"),
  profileJson: jsonb("profile_json").notNull(),
  nextReportAt: timestamp("next_report_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 2. services — Full NSP service catalog with status_india and pricing metadata
export const services = pgTable("services", {
  id: serial("id").primaryKey(),
  serviceId: text("service_id").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  statusIndia: text("status_india").notNull(),
  indiaPricing: text("india_pricing"),
  detailsJson: jsonb("details_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 3. competitors — Seeded Indian + UK/adjacent competitors
export const competitors = pgTable("competitors", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  market: text("market").notNull(),
  classification: text("classification").notNull(),
  website: text("website"),
  detailsJson: jsonb("details_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 4. sources — Configured RSS/public feeds
export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  sourceId: text("source_id").notNull().unique(),
  name: text("name").notNull(),
  feedUrl: text("feed_url").notNull(),
  sourceType: text("source_type").notNull(),
  geoScope: text("geo_scope").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 5. source_runs — Collection logs and isolated per-source error tracking
export const sourceRuns = pgTable("source_runs", {
  id: serial("id").primaryKey(),
  runKey: text("run_key").notNull(),
  sourceId: text("source_id").notNull(),
  status: text("status").notNull(),
  fetchedCount: integer("fetched_count").default(0).notNull(),
  inWindowCount: integer("in_window_count").default(0).notNull(),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).defaultNow().notNull(),
});

// 6. event_clusters — Grouped developments (defined before signals for FK reference)
export const eventClusters = pgTable("event_clusters", {
  id: serial("id").primaryKey(),
  eventKey: text("event_key").notNull().unique(),
  clusterTitle: text("cluster_title").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  independentSourceCount: integer("independent_source_count").default(1).notNull(),
  sourceDiversity: integer("source_diversity").default(1).notNull(),
  countryRelevance: text("country_relevance").notNull(),
  keywordsJson: jsonb("keywords_json").notNull(),
  status: text("status").default("active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 7. signals — Individual collected records (strictly bounded metadata + excerpts, never full copyrighted articles)
export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  contentHash: text("content_hash").notNull().unique(),
  sourceId: text("source_id").notNull(),
  clusterId: integer("cluster_id").references(() => eventClusters.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  publisher: text("publisher").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  sourceType: text("source_type").notNull(),
  countryRelevance: text("country_relevance").notNull(),
  excerpt: text("excerpt").notNull(),
  keywordsJson: jsonb("keywords_json").notNull(),
  summary: text("summary"),
});

// 8. context_packs — Grounded event research summaries and unknowns
export const contextPacks = pgTable("context_packs", {
  id: serial("id").primaryKey(),
  clusterId: integer("cluster_id").references(() => eventClusters.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  contextJson: jsonb("context_json").notNull(),
  modelUsed: text("model_used").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 9. report_runs — Report execution history, idempotency (run_key), token logs, and checkpoints
export const reportRuns = pgTable("report_runs", {
  id: serial("id").primaryKey(),
  runKey: text("run_key").notNull().unique(),
  status: text("status").notNull(), // running | completed | failed
  checkpointStage: text("checkpoint_stage"),
  checkpointJson: jsonb("checkpoint_json"),
  recommendationsCount: integer("recommendations_count").default(0).notNull(),
  tokenUsageJson: jsonb("token_usage_json"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// 10. recommendations — Final 14-field recommendation cards and intermediate candidates
export const recommendations = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  reportRunId: integer("report_run_id")
    .references(() => reportRuns.id, { onDelete: "cascade" })
    .notNull(),
  clusterId: integer("cluster_id").references(() => eventClusters.id, { onDelete: "set null" }),
  eventKey: text("event_key").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull(), // published | rejected
  risk: text("risk").notNull(), // safe | caution | blocked
  criticVerdict: text("critic_verdict").notNull(), // ACCEPT | REVISE | REJECT
  deterministicScore: doublePrecision("deterministic_score").notNull(),
  aiRubricScore: doublePrecision("ai_rubric_score").notNull(),
  combinedRankScore: doublePrecision("combined_rank_score").notNull(),
  cardJson: jsonb("card_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 11. owner_feedback — Owner decisions (Accept / Revise / Reject), standardized reasons, and execution status
export const ownerFeedback = pgTable("owner_feedback", {
  id: serial("id").primaryKey(),
  recommendationId: integer("recommendation_id")
    .references(() => recommendations.id, { onDelete: "cascade" })
    .notNull(),
  decision: text("decision").notNull(), // Accept | Revise | Reject
  reason: text("reason"),
  notes: text("notes"),
  wasExecuted: boolean("was_executed").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

