import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 1. brand_profiles — Multi-tenant brand profile, normalized business identity, and schedule pointer
export const brandProfiles = pgTable(
  "brand_profiles",
  {
    id: serial("id").primaryKey(),
    brandKey: text("brand_key").notNull().unique(), // e.g. "nsp-india"
    businessKey: text("business_key").notNull().unique(), // e.g. "biz_nspglobalservices_com"
    originalUrl: text("original_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    brandName: text("brand_name").notNull(),
    industry: text("industry").notNull(),
    targetMarket: text("target_market").notNull(),
    primaryDomain: text("primary_domain").notNull(),
    secondaryDomain: text("secondary_domain"),
    onboardingStatus: text("onboarding_status").default("completed").notNull(), // pending | crawling | completed | failed
    onboardingError: text("onboarding_error"),
    profileJson: jsonb("profile_json").notNull(),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
    nextReportAt: timestamp("next_report_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("brand_profiles_business_key_idx").on(table.businessKey),
    index("brand_profiles_brand_key_idx").on(table.brandKey),
  ],
);

// 2. services — Brand-scoped service catalog with composite uniqueness
export const services = pgTable(
  "services",
  {
    id: serial("id").primaryKey(),
    brandProfileId: integer("brand_profile_id")
      .references(() => brandProfiles.id, { onDelete: "cascade" })
      .notNull(),
    serviceId: text("service_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    statusIndia: text("status_india").notNull(),
    indiaPricing: text("india_pricing"),
    detailsJson: jsonb("details_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("services_brand_service_idx").on(table.brandProfileId, table.serviceId),
    index("services_brand_profile_id_idx").on(table.brandProfileId),
  ],
);

// 3. competitors — Brand-scoped competitor tracking with composite uniqueness
export const competitors = pgTable(
  "competitors",
  {
    id: serial("id").primaryKey(),
    brandProfileId: integer("brand_profile_id")
      .references(() => brandProfiles.id, { onDelete: "cascade" })
      .notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    classification: text("classification").notNull(),
    website: text("website"),
    detailsJson: jsonb("details_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("competitors_brand_slug_idx").on(table.brandProfileId, table.slug),
    index("competitors_brand_profile_id_idx").on(table.brandProfileId),
  ],
);

// 4. sources — Global, shared reusable RSS/Atom public feeds
export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  sourceId: text("source_id").notNull().unique(),
  name: text("name").notNull(),
  feedUrl: text("feed_url").notNull().unique(),
  sourceType: text("source_type").notNull(),
  geoScope: text("geo_scope").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 5. brand_sources — Many-to-many link associating brands with baseline and dynamic feeds
export const brandSources = pgTable(
  "brand_sources",
  {
    id: serial("id").primaryKey(),
    brandProfileId: integer("brand_profile_id")
      .references(() => brandProfiles.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: integer("source_id")
      .references(() => sources.id, { onDelete: "cascade" })
      .notNull(),
    industryTag: text("industry_tag").default("baseline").notNull(),
    discoveryMethod: text("discovery_method").default("baseline").notNull(), // baseline | dynamic
    validationStatus: text("validation_status").default("valid").notNull(), // valid | degraded | invalid
    enabled: boolean("enabled").default(true).notNull(),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("brand_sources_brand_source_idx").on(table.brandProfileId, table.sourceId),
    index("brand_sources_brand_profile_id_idx").on(table.brandProfileId),
    index("brand_sources_source_id_idx").on(table.sourceId),
  ],
);

// 6. source_runs — Collection logs and isolated per-source error tracking
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

// 7. event_clusters — Grouped developments (defined before signals for FK reference)
export const eventClusters = pgTable(
  "event_clusters",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull().unique(),
    clusterTitle: text("cluster_title").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    independentSourceCount: integer("independent_source_count").default(1).notNull(),
    sourceDiversity: integer("source_diversity").default(1).notNull(),
    countryRelevance: text("country_relevance").notNull(),
    keywordsJson: jsonb("keywords_json").notNull(),
    entitiesJson: jsonb("entities_json"),
    topicTokensJson: jsonb("topic_tokens_json"),
    mergedIntoId: integer("merged_into_id"),
    status: text("status").default("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("event_clusters_last_seen_at_idx").on(table.lastSeenAt),
    index("event_clusters_status_idx").on(table.status),
  ],
);

// 8. signals — Individual collected records (bounded metadata + excerpts, never full copyrighted articles)
export const signals = pgTable(
  "signals",
  {
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
  },
  (table) => [
    index("signals_cluster_id_idx").on(table.clusterId),
    index("signals_published_at_idx").on(table.publishedAt),
  ],
);

// 9. context_packs — Grounded event research summaries and unknowns
export const contextPacks = pgTable("context_packs", {
  id: serial("id").primaryKey(),
  clusterId: integer("cluster_id").references(() => eventClusters.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  contextJson: jsonb("context_json").notNull(),
  modelUsed: text("model_used").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// 10. report_runs — Report execution history, idempotency (run_key), token logs, and checkpoints
export const reportRuns = pgTable(
  "report_runs",
  {
    id: serial("id").primaryKey(),
    brandProfileId: integer("brand_profile_id").references(() => brandProfiles.id, { onDelete: "cascade" }),
    runKey: text("run_key").notNull().unique(),
    status: text("status").notNull(), // running | completed | failed
    checkpointStage: text("checkpoint_stage"),
    checkpointJson: jsonb("checkpoint_json"),
    recommendationsCount: integer("recommendations_count").default(0).notNull(),
    tokenUsageJson: jsonb("token_usage_json"),
    errorMessage: text("error_message"),
    workerToken: text("worker_token"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("report_runs_brand_profile_id_idx").on(table.brandProfileId),
    uniqueIndex("report_runs_active_brand_idx")
      .on(table.brandProfileId)
      .where(sql`${table.status} = 'running'`),
  ],
);

// 11. recommendations — Final recommendation cards and intermediate candidates
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

// 12. owner_feedback — Owner decisions (Accept / Revise / Reject)
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
