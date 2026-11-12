CREATE TABLE "brand_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_key" text NOT NULL,
	"brand_name" text NOT NULL,
	"target_market" text NOT NULL,
	"primary_domain" text NOT NULL,
	"secondary_domain" text,
	"profile_json" jsonb NOT NULL,
	"next_report_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_profiles_brand_key_unique" UNIQUE("brand_key")
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"market" text NOT NULL,
	"classification" text NOT NULL,
	"website" text,
	"details_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "context_packs" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" integer,
	"event_key" text NOT NULL,
	"context_json" jsonb NOT NULL,
	"model_used" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"cluster_title" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"independent_source_count" integer DEFAULT 1 NOT NULL,
	"source_diversity" integer DEFAULT 1 NOT NULL,
	"country_relevance" text NOT NULL,
	"keywords_json" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_clusters_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "owner_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"recommendation_id" integer NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"notes" text,
	"was_executed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_run_id" integer NOT NULL,
	"cluster_id" integer,
	"event_key" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"risk" text NOT NULL,
	"critic_verdict" text NOT NULL,
	"deterministic_score" double precision NOT NULL,
	"ai_rubric_score" double precision NOT NULL,
	"combined_rank_score" double precision NOT NULL,
	"card_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"status" text NOT NULL,
	"checkpoint_stage" text,
	"checkpoint_json" jsonb,
	"recommendations_count" integer DEFAULT 0 NOT NULL,
	"token_usage_json" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "report_runs_run_key_unique" UNIQUE("run_key")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"status_india" text NOT NULL,
	"india_pricing" text,
	"details_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_service_id_unique" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"source_id" text NOT NULL,
	"cluster_id" integer,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"publisher" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"country_relevance" text NOT NULL,
	"excerpt" text NOT NULL,
	"keywords_json" jsonb NOT NULL,
	"summary" text,
	CONSTRAINT "signals_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "signals_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_key" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"in_window_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"feed_url" text NOT NULL,
	"source_type" text NOT NULL,
	"geo_scope" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_cluster_id_event_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."event_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_feedback" ADD CONSTRAINT "owner_feedback_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_report_run_id_report_runs_id_fk" FOREIGN KEY ("report_run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_cluster_id_event_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."event_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_cluster_id_event_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."event_clusters"("id") ON DELETE set null ON UPDATE no action;