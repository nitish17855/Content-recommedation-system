import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../config/env.js";

export async function runSlice1Migration() {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const sql = neon(env.DATABASE_URL);
  console.log("=== Starting Slice 1 Multi-Tenant Schema Migration & Backfill ===");

  // 1. Audit current counts before changes
  const [existingBrands] = (await sql`SELECT COUNT(*)::int as count FROM brand_profiles`) as [{ count: number }];
  console.log(`[Audit] Found ${existingBrands.count} existing brand profile(s).`);

  // 2. Add columns to brand_profiles
  console.log("[Migration] Adding multi-tenant columns to brand_profiles...");
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS business_key text;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS original_url text;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS canonical_url text;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS industry text;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS onboarding_status text DEFAULT 'completed' NOT NULL;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS onboarding_error text;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS last_crawled_at timestamp with time zone;`;
  await sql`ALTER TABLE brand_profiles ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL;`;

  // 3. Backfill existing NSP brand profile
  console.log("[Migration] Backfilling 'nsp-india' brand profile metadata...");
  await sql`
    UPDATE brand_profiles
    SET
      business_key = COALESCE(business_key, 'biz_nspglobalservices_com'),
      original_url = COALESCE(original_url, 'https://www.nspglobalservices.com/'),
      canonical_url = COALESCE(canonical_url, 'https://nspglobalservices.com'),
      industry = COALESCE(industry, 'B2B Digital Marketing & Technology'),
      onboarding_status = 'completed',
      last_crawled_at = COALESCE(last_crawled_at, NOW())
    WHERE brand_key = 'nsp-india';
  `;

  // Enforce NOT NULL on business_key and create unique index
  await sql`ALTER TABLE brand_profiles ALTER COLUMN business_key SET NOT NULL;`;
  await sql`ALTER TABLE brand_profiles ALTER COLUMN original_url SET NOT NULL;`;
  await sql`ALTER TABLE brand_profiles ALTER COLUMN canonical_url SET NOT NULL;`;
  await sql`ALTER TABLE brand_profiles ALTER COLUMN industry SET NOT NULL;`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS brand_profiles_business_key_idx ON brand_profiles (business_key);`;
  await sql`CREATE INDEX IF NOT EXISTS brand_profiles_brand_key_idx ON brand_profiles (brand_key);`;

  // Get NSP profile ID
  const nspRows = (await sql`SELECT id FROM brand_profiles WHERE brand_key = 'nsp-india' LIMIT 1`) as Array<{ id: number }>;
  if (nspRows.length === 0) {
    throw new Error("Could not find 'nsp-india' brand profile in database to backfill!");
  }
  const nspId = nspRows[0]!.id;
  console.log(`[Migration] Confirmed NSP Brand ID: ${nspId}`);

  // 4. Update services table
  console.log("[Migration] Scoping services to brand_profile_id...");
  await sql`ALTER TABLE services ADD COLUMN IF NOT EXISTS brand_profile_id integer REFERENCES brand_profiles(id) ON DELETE CASCADE;`;
  await sql`UPDATE services SET brand_profile_id = ${nspId} WHERE brand_profile_id IS NULL;`;
  await sql`ALTER TABLE services ALTER COLUMN brand_profile_id SET NOT NULL;`;

  // Drop old global unique constraint on service_id if it exists
  const serviceConstraints = (await sql`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'services'::regclass AND contype = 'u';
  `) as Array<{ conname: string }>;
  for (const c of serviceConstraints) {
    console.log(`[Migration] Dropping old global unique constraint: ${c.conname}`);
    await sql.query(`ALTER TABLE services DROP CONSTRAINT IF EXISTS "${c.conname}";`);
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS services_brand_service_idx ON services (brand_profile_id, service_id);`;
  await sql`CREATE INDEX IF NOT EXISTS services_brand_profile_id_idx ON services (brand_profile_id);`;

  // 5. Update competitors table
  console.log("[Migration] Scoping competitors to brand_profile_id...");
  await sql`ALTER TABLE competitors ADD COLUMN IF NOT EXISTS brand_profile_id integer REFERENCES brand_profiles(id) ON DELETE CASCADE;`;
  await sql`UPDATE competitors SET brand_profile_id = ${nspId} WHERE brand_profile_id IS NULL;`;
  await sql`ALTER TABLE competitors ALTER COLUMN brand_profile_id SET NOT NULL;`;

  // Drop old global unique constraint on slug if it exists
  const competitorConstraints = (await sql`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'competitors'::regclass AND contype = 'u';
  `) as Array<{ conname: string }>;
  for (const c of competitorConstraints) {
    console.log(`[Migration] Dropping old global unique constraint: ${c.conname}`);
    await sql.query(`ALTER TABLE competitors DROP CONSTRAINT IF EXISTS "${c.conname}";`);
  }
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS competitors_brand_slug_idx ON competitors (brand_profile_id, slug);`;
  await sql`CREATE INDEX IF NOT EXISTS competitors_brand_profile_id_idx ON competitors (brand_profile_id);`;

  // 6. Update report_runs table
  console.log("[Migration] Scoping report_runs to brand_profile_id...");
  await sql`ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS brand_profile_id integer REFERENCES brand_profiles(id) ON DELETE CASCADE;`;
  await sql`UPDATE report_runs SET brand_profile_id = ${nspId} WHERE brand_profile_id IS NULL;`;
  await sql`CREATE INDEX IF NOT EXISTS report_runs_brand_profile_id_idx ON report_runs (brand_profile_id);`;

  // 7. Create brand_sources association table
  console.log("[Migration] Creating brand_sources table...");
  await sql`
    CREATE TABLE IF NOT EXISTS brand_sources (
      id serial PRIMARY KEY,
      brand_profile_id integer NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
      source_id integer NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      industry_tag text DEFAULT 'baseline' NOT NULL,
      discovery_method text DEFAULT 'baseline' NOT NULL,
      validation_status text DEFAULT 'valid' NOT NULL,
      enabled boolean DEFAULT true NOT NULL,
      last_validated_at timestamp with time zone DEFAULT now() NOT NULL
    );
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS brand_sources_brand_source_idx ON brand_sources (brand_profile_id, source_id);`;
  await sql`CREATE INDEX IF NOT EXISTS brand_sources_brand_profile_id_idx ON brand_sources (brand_profile_id);`;
  await sql`CREATE INDEX IF NOT EXISTS brand_sources_source_id_idx ON brand_sources (source_id);`;

  // 8. Backfill brand_sources with all existing baseline sources for NSP
  console.log("[Migration] Backfilling brand_sources linking all 22 baseline feeds to NSP...");
  await sql`
    INSERT INTO brand_sources (brand_profile_id, source_id, industry_tag, discovery_method, validation_status, enabled, last_validated_at)
    SELECT
      ${nspId} as brand_profile_id,
      sources.id as source_id,
      'baseline' as industry_tag,
      'baseline' as discovery_method,
      'valid' as validation_status,
      true as enabled,
      NOW() as last_validated_at
    FROM sources
    ON CONFLICT (brand_profile_id, source_id) DO NOTHING;
  `;

  console.log("=== Slice 1 Migration & Backfill Completed Successfully! ===");
}

// Direct execution
if (process.argv[1]?.endsWith("migrate-slice1.ts") || process.argv[1]?.endsWith("migrate-slice1.js")) {
  runSlice1Migration().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
