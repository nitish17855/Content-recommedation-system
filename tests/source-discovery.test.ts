import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { brandProfiles, brandSources, sources } from "../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import {
  assessIndustryCoverage,
  discoverAndValidateIndustrySources,
  syncDiscoveredSourcesToDb,
  type BusinessProfileForDiscovery,
} from "../src/pipeline/source-discovery.js";
import { getActiveSourcesForBrand } from "../src/db/repositories/persistence.js";
import { collectRssSources } from "../src/sources/rss-collector.js";

describe("Slice 3 — Dynamic Source Discovery, Validation & Multi-Tenant Persistence", () => {
  const env = loadEnv();
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;
  const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

  // Track created test brand IDs for cleanup
  const testBrandIds: number[] = [];
  const testSourceIds: number[] = [];

  after(async () => {
    if (!db) return;
    try {
      if (testBrandIds.length > 0) {
        await db.delete(brandProfiles).where(inArray(brandProfiles.id, testBrandIds));
      }
      if (testSourceIds.length > 0) {
        // Only delete dynamically created test sources, never baseline sources
        for (const sid of testSourceIds) {
          const [src] = await db.select().from(sources).where(eq(sources.id, sid)).limit(1);
          if (src && src.sourceId.startsWith("dyn_")) {
            await db.delete(sources).where(eq(sources.id, sid));
          }
        }
      }
    } catch (err) {
      console.warn("Cleanup warning:", err);
    }
  });

  // 1. Industry Coverage Assessment across 3 Verticals
  describe("1. Industry Coverage Assessment", () => {
    it("evaluates SaaS / Digital Marketing as sufficiently covered by baseline feeds", () => {
      const saasProfile: BusinessProfileForDiscovery = {
        industry: "B2B SaaS & Growth Marketing",
        subIndustry: "Marketing Automation",
        businessModel: "B2B Subscription SaaS",
        offerings: [
          { name: "SEO Optimization", category: "Organic Search" },
          { name: "AI Search Marketing", category: "Generative Search" },
        ],
        targetAudience: ["Growth Marketers", "SaaS Founders"],
      };

      const result = assessIndustryCoverage(saasProfile);
      assert.equal(result.isSufficientlyCovered, true);
      assert.ok(result.baselineMatchingSources.length >= 10);
      assert.ok(result.baselineMatchingSources.includes("google-search-central"));
      assert.ok(result.baselineMatchingSources.includes("saastr"));
      assert.equal(result.coverageGaps.length, 0);
    });

    it("evaluates D2C Food as insufficiently covered and flags specific gaps", () => {
      const foodProfile: BusinessProfileForDiscovery = {
        industry: "D2C Food & Beverage",
        subIndustry: "Artisanal Specialty Coffee & Cold Brew",
        businessModel: "Direct to Consumer E-Commerce",
        offerings: [
          { name: "Single Origin Coffee Beans", category: "Packaged Goods" },
          { name: "Ready-to-Drink Cold Brew", category: "Beverages" },
        ],
        targetAudience: ["Coffee Enthusiasts", "Retail Consumers"],
      };

      const result = assessIndustryCoverage(foodProfile);
      assert.equal(result.isSufficientlyCovered, false);
      assert.ok(result.coverageGaps.some((g) => g.includes("Food safety")));
      assert.ok(result.coverageGaps.some((g) => g.includes("ingredient innovation")));
      assert.ok(result.baselineMatchingSources.includes("et-retail-ecommerce"));
    });

    it("evaluates Freight & Logistics as having zero baseline coverage and flags critical gaps", () => {
      const logisticsProfile: BusinessProfileForDiscovery = {
        industry: "Freight Logistics & Supply Chain",
        subIndustry: "Cold-Chain Intermodal Transport",
        businessModel: "B2B 3PL Logistics Services",
        offerings: [
          { name: "Refrigerated Truckload", category: "Temperature Controlled Freight" },
          { name: "Customs Brokerage", category: "Cross-Border Logistics" },
        ],
        targetAudience: ["Shippers", "Supply Chain Directors"],
      };

      const result = assessIndustryCoverage(logisticsProfile);
      assert.equal(result.isSufficientlyCovered, false);
      assert.equal(result.baselineMatchingSources.length, 0);
      assert.ok(result.coverageGaps.some((g) => g.includes("Ocean, air, and surface freight")));
      assert.ok(result.coverageGaps.some((g) => g.includes("cold-chain transport")));
    });
  });

  // 2. Candidate Discovery & Probe Validation
  describe("2. Candidate Discovery & Probe Validation", () => {
    it("accepts active feeds and specialist degraded feeds, while rejecting invalid candidate URLs", async () => {
      const logisticsProfile: BusinessProfileForDiscovery = {
        industry: "Freight Logistics",
        subIndustry: "Ocean & Air Cargo",
      };

      // Mock candidate proposals containing:
      // 1) A feed with active articles (TechCrunch category - valid)
      // 2) An SSRF private IP URL (must be rejected by SSRF guard)
      // 3) An invalid / malformed URL (must be rejected)
      // 4) A real active RSS feed
      const result = await discoverAndValidateIndustrySources({
        profile: logisticsProfile,
        now: new Date(),
        mockProposals: [
          {
            publisher_name: "TechCrunch Enterprise",
            website_url: "https://techcrunch.com",
            candidate_feed_urls: [
              "https://techcrunch.com/category/enterprise/feed/",
            ],
            coverage_focus: "Enterprise & supply chain software",
            is_specialist_or_regulatory: false,
          },
          {
            publisher_name: "Malicious Candidate",
            website_url: "http://169.254.169.254",
            candidate_feed_urls: ["http://169.254.169.254/latest/meta-data/feed.xml"],
            coverage_focus: "AWS metadata attack",
            is_specialist_or_regulatory: false,
          },
          {
            publisher_name: "Broken Candidate",
            website_url: "https://example.com",
            candidate_feed_urls: ["https://example.com/not-a-feed.xml"],
            coverage_focus: "Dead endpoint",
            is_specialist_or_regulatory: false,
          },
        ],
      });

      assert.equal(result.candidatePublishersProposed, 3);
      // Valid feed accepted
      assert.ok(result.acceptedSources.length >= 1);
      const accepted = result.acceptedSources[0]!;
      assert.equal(accepted.publisherName, "TechCrunch Enterprise");
      assert.ok(accepted.validationStatus === "valid" || accepted.validationStatus === "degraded");

      // Dangerous and broken feeds rejected
      assert.ok(result.rejectedCandidates.length >= 2);
      const ssrfRejected = result.rejectedCandidates.find((r) => r.publisherName === "Malicious Candidate");
      assert.ok(ssrfRejected);
      assert.match(ssrfRejected.reason, /SSRF guard/);
    });
  });

  // 3. Database Persistence, Idempotency & Multi-Brand Sharing
  describe("3. Database Persistence & Multi-Brand Sharing", () => {
    it("persists discovered sources and links them cleanly in brand_sources", async () => {
      if (!db) {
        console.log("Skipping DB persistence test (no DATABASE_URL)");
        return;
      }

      // Create two distinct test brands: Brand A (D2C Food 1) and Brand B (D2C Food 2)
      const [brandA] = await db
        .insert(brandProfiles)
        .values({
          brandKey: "test-food-a",
          businessKey: "biz_testfooda_com",
          originalUrl: "https://testfooda.com",
          canonicalUrl: "https://testfooda.com",
          industry: "D2C Food & Beverage",
          brandName: "Artisanal Coffee Co",
          targetMarket: "Global",
          primaryDomain: "https://testfooda.com",
          profileJson: { test: true },
        })
        .returning({ id: brandProfiles.id });
      testBrandIds.push(brandA!.id);

      const [brandB] = await db
        .insert(brandProfiles)
        .values({
          brandKey: "test-food-b",
          businessKey: "biz_testfoodb_com",
          originalUrl: "https://testfoodb.com",
          canonicalUrl: "https://testfoodb.com",
          industry: "D2C Food & Beverage",
          brandName: "Specialty Teas Co",
          targetMarket: "Global",
          primaryDomain: "https://testfoodb.com",
          profileJson: { test: true },
        })
        .returning({ id: brandProfiles.id });
      testBrandIds.push(brandB!.id);

      const sharedFeedUrl = "https://techcrunch.com/category/startups/feed/";
      const mockDiscoveredSources = [
        {
          publisherName: "TechCrunch Startups",
          websiteUrl: "https://techcrunch.com",
          feedUrl: sharedFeedUrl,
          feedTitle: "TechCrunch Startups",
          feedType: "rss" as const,
          validationStatus: "valid" as const,
          validationReason: "Active publications in last 14 days",
          isSpecialist: false,
        },
      ];

      // Sync for Brand A: creates 1 new global source and links Brand A
      const syncA = await syncDiscoveredSourcesToDb({
        db,
        brandProfileId: brandA!.id,
        industryTag: "D2C Food & Beverage",
        sourcesToSync: mockDiscoveredSources,
      });
      assert.equal(syncA.createdSourcesCount, 1);
      assert.equal(syncA.linkedBrandSourcesCount, 1);

      const createdDbSourceId = mockDiscoveredSources[0]!.dbSourceId!;
      testSourceIds.push(createdDbSourceId);

      // Sync for Brand B with the SAME feed URL:
      // Must REUSE the existing global source (createdSourcesCount = 0) and link Brand B
      const syncB = await syncDiscoveredSourcesToDb({
        db,
        brandProfileId: brandB!.id,
        industryTag: "D2C Food & Beverage",
        sourcesToSync: mockDiscoveredSources,
      });
      assert.equal(syncB.createdSourcesCount, 0); // Reused!
      assert.equal(syncB.linkedBrandSourcesCount, 1);

      // Verify Brand A and Brand B both have the source linked in brand_sources
      const brandASources = await getActiveSourcesForBrand(db, brandA!.id);
      const brandBSources = await getActiveSourcesForBrand(db, brandB!.id);
      assert.equal(brandASources.length, 1);
      assert.equal(brandBSources.length, 1);
      assert.equal(brandASources[0]!.feedUrl, sharedFeedUrl);
      assert.equal(brandBSources[0]!.feedUrl, sharedFeedUrl);

      // Idempotency: Running sync again for Brand A must NOT duplicate records
      const syncAgain = await syncDiscoveredSourcesToDb({
        db,
        brandProfileId: brandA!.id,
        industryTag: "D2C Food & Beverage",
        sourcesToSync: mockDiscoveredSources,
      });
      assert.equal(syncAgain.createdSourcesCount, 0);
      assert.equal(syncAgain.linkedBrandSourcesCount, 1);

      const brandASourcesAfter = await getActiveSourcesForBrand(db, brandA!.id);
      assert.equal(brandASourcesAfter.length, 1); // Still exactly 1!
    });
  });

  // 4. Actual Feed Collection Integration
  describe("4. Feed Collection Integration with Dynamic Sources", () => {
    it("collects articles successfully from dynamically discovered sources for a brand", async () => {
      if (!db) return;

      const [testBrand] = await db
        .insert(brandProfiles)
        .values({
          brandKey: "test-logistics-brand",
          businessKey: "biz_testlogistics_com",
          originalUrl: "https://testlogistics.com",
          canonicalUrl: "https://testlogistics.com",
          industry: "Freight Logistics",
          brandName: "Global Freightline",
          targetMarket: "Global",
          primaryDomain: "https://testlogistics.com",
          profileJson: { test: true },
        })
        .returning({ id: brandProfiles.id });
      testBrandIds.push(testBrand!.id);

      // Link a real live feed that is distinct from baseline feeds
      const dynamicFeedUrl = "https://feeds.feedburner.com/oreilly/radar/atom";
      const testSources = [
        {
          publisherName: "OReilly Radar Dynamic",
          websiteUrl: "https://www.oreilly.com/radar/",
          feedUrl: dynamicFeedUrl,
          feedTitle: "O'Reilly Radar",
          feedType: "atom" as const,
          validationStatus: "valid" as const,
          validationReason: "Active feed",
          isSpecialist: false,
        },
      ];

      await syncDiscoveredSourcesToDb({
        db,
        brandProfileId: testBrand!.id,
        industryTag: "Freight Logistics",
        sourcesToSync: testSources,
      });
      if (testSources[0]!.dbSourceId) {
        testSourceIds.push(testSources[0]!.dbSourceId);
      }

      // Verify getActiveSourcesForBrand returns this dynamic source
      const activeBrandSources = await getActiveSourcesForBrand(db, testBrand!.id);
      assert.ok(activeBrandSources.length >= 1);
      const dynamicSource = activeBrandSources.find((s) => s.feedUrl === dynamicFeedUrl);
      assert.ok(dynamicSource);

      // Test real collection with collectRssSources
      const collectionResult = await collectRssSources([dynamicSource!], 14);
      assert.equal(collectionResult.sourceRuns.length, 1);
      assert.equal(collectionResult.sourceRuns[0]!.status, "ok");
      assert.ok(collectionResult.sourceRuns[0]!.fetchedCount > 0);
      assert.ok(collectionResult.items.length > 0);
    });
  });
});
