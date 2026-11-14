import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import {
  brandProfiles,
  brandSources,
  competitors,
  eventClusters,
  recommendations,
  reportRuns,
  services,
  signals,
  sources,
} from "../src/db/schema.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function verifySlice1Migration() {
  console.log("=== Post-Migration Verification (Slice 1 Multi-Tenant Integrity) ===");
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing.");
  }
  const db = createDb(env.DATABASE_URL);

  // 1. Verify exactly one NSP brand profile is retained with normalized identity
  const nspBrands = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.brandKey, "nsp-india"));
  assert(nspBrands.length === 1, "Expected exactly 1 NSP brand profile");
  const nsp = nspBrands[0]!;
  assert(nsp.id === 1, "NSP primary key must be preserved as 1");
  assert(nsp.businessKey === "biz_nspglobalservices_com", "businessKey must be biz_nspglobalservices_com");
  assert(nsp.canonicalUrl === "https://nspglobalservices.com", "canonicalUrl must be normalized");
  assert(nsp.onboardingStatus === "completed", "onboardingStatus must be completed");
  console.log(`✓ Requirement 1 Passed: Exactly 1 NSP brand profile (ID=${nsp.id}, Key=${nsp.businessKey})`);

  // 2. Verify all confirmed NSP services are associated with it
  const nspServices = await db
    .select()
    .from(services)
    .where(eq(services.brandProfileId, nsp.id));
  assert(nspServices.length === 18, `Expected 18 NSP services, got ${nspServices.length}`);
  const orphanServices = await db
    .select()
    .from(services)
    .where(sql`${services.brandProfileId} IS NULL`);
  assert(orphanServices.length === 0, "No services should have NULL brandProfileId");
  console.log(`✓ Requirement 2 Passed: All ${nspServices.length} confirmed NSP services linked to brand ${nsp.id}`);

  // 3. Verify all confirmed NSP competitors are associated with it
  const nspCompetitors = await db
    .select()
    .from(competitors)
    .where(eq(competitors.brandProfileId, nsp.id));
  assert(nspCompetitors.length === 15, `Expected 15 NSP competitors, got ${nspCompetitors.length}`);
  const orphanCompetitors = await db
    .select()
    .from(competitors)
    .where(sql`${competitors.brandProfileId} IS NULL`);
  assert(orphanCompetitors.length === 0, "No competitors should have NULL brandProfileId");
  console.log(`✓ Requirement 3 Passed: All ${nspCompetitors.length} confirmed NSP competitors linked to brand ${nsp.id}`);

  // 4. Verify all 22 configured baseline feeds are linked in brand_sources
  const nspSources = await db
    .select()
    .from(brandSources)
    .where(eq(brandSources.brandProfileId, nsp.id));
  assert(nspSources.length === 22, `Expected 22 linked feeds in brand_sources, got ${nspSources.length}`);
  console.log(`✓ Requirement 4 Passed: All ${nspSources.length} baseline feeds linked in brand_sources`);

  // 5. Verify no duplicate brand-source associations exist
  const duplicates = await db
    .select({
      brandProfileId: brandSources.brandProfileId,
      sourceId: brandSources.sourceId,
      count: sql<number>`count(*)::int`,
    })
    .from(brandSources)
    .groupBy(brandSources.brandProfileId, brandSources.sourceId)
    .having(sql`count(*) > 1`);
  assert(duplicates.length === 0, "Zero duplicate brand-source associations allowed");
  console.log("✓ Requirement 5 Passed: Zero duplicate brand-source associations confirmed");

  // 6. Verify existing signals and event clusters remain intact
  const [sigCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signals);
  const [clustCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventClusters);
  assert((sigCount?.count ?? 0) >= 530, `Signals count must be >= 530, got ${sigCount?.count}`);
  assert((clustCount?.count ?? 0) >= 465, `Clusters count must be >= 465, got ${clustCount?.count}`);
  console.log(`✓ Requirement 6 Passed: Existing ${sigCount?.count} signals & ${clustCount?.count} event clusters intact`);

  // 7. Verify existing NSP recommendations remain accessible
  const [recsCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recommendations);
  assert((recsCount?.count ?? 0) >= 22, `Recommendations count must be >= 22, got ${recsCount?.count}`);
  console.log(`✓ Requirement 7 Passed: Existing ${recsCount?.count} recommendations accessible`);

  // 8. Verify Composite Uniqueness (Multi-Tenant isolation proof)
  // Prove that a hypothetical second brand can register a service with the same serviceId (e.g. "b2b-saas-seo-growth") without collision
  console.log("[Test] Verifying composite uniqueness isolation with temporary brand...");
  const [mockBrand] = await db
    .insert(brandProfiles)
    .values({
      brandKey: "test-brand-isolation",
      businessKey: "biz_testisolation_com",
      originalUrl: "https://testisolation.com",
      canonicalUrl: "https://testisolation.com",
      brandName: "Test Brand Isolation",
      industry: "E-Commerce Logistics",
      targetMarket: "Global",
      primaryDomain: "https://testisolation.com",
      profileJson: {},
      onboardingStatus: "completed",
    })
    .onConflictDoNothing()
    .returning();

  if (mockBrand) {
    // Insert a service for mockBrand with the exact same serviceId as NSP's existing service
    const sameServiceId = nspServices[0]!.serviceId;
    await db
      .insert(services)
      .values({
        brandProfileId: mockBrand.id,
        serviceId: sameServiceId,
        name: "Mock Service with identical serviceId",
        category: "Test",
        statusIndia: "active",
        detailsJson: {},
      });

    // Verify both exist side-by-side
    const collidingServices = await db
      .select()
      .from(services)
      .where(eq(services.serviceId, sameServiceId));
    assert(collidingServices.length === 2, "Expected 2 independent services with same serviceId across 2 brands");
    console.log(`✓ Requirement 8 Passed: Composite uniqueness validated! 2 distinct brands safely share serviceId="${sameServiceId}"`);

    // Clean up temporary isolation test rows
    await db.delete(brandProfiles).where(eq(brandProfiles.id, mockBrand.id));
    console.log("✓ Cleaned up temporary test brand");
  }

  console.log("\n🎉 ALL 8 POST-MIGRATION VERIFICATION CHECKS PASSED SUCCESSFULLY!");
}

verifySlice1Migration().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
