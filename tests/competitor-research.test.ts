import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { brandProfiles, competitors } from "../src/db/schema.js";
import { eq, inArray } from "drizzle-orm";
import {
  buildCompetitiveBoundaryProfile,
  discoverAndVerifyCompetitors,
  scoreAndClassifyCompetitor,
  type CompetitiveBoundaryProfile,
  type SearchGroundingFn,
} from "../src/pipeline/competitor-research.js";
import {
  saveBrandOnboardingRecord,
  lookupBrandOrOnboard,
} from "../src/db/repositories/persistence.js";
import type { CandidateCompetitorProposal } from "../src/ai/schemas.js";

describe("Slice 4 — Evidence-First, Scale-Aware Competitor Research & Scoped Persistence", () => {
  const env = loadEnv();
  const db = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;
  const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

  const testBrandIds: number[] = [];

  after(async () => {
    if (!db || testBrandIds.length === 0) return;
    try {
      await db.delete(brandProfiles).where(inArray(brandProfiles.id, testBrandIds));
    } catch (err) {
      console.warn("Cleanup warning:", err);
    }
  });

  // Sample Boundary Profile for a Boutique SEO & AI Search Agency in India (like NSP)
  const agencyBoundary: CompetitiveBoundaryProfile = {
    brandName: "NSP Global Services",
    industry: "Digital Marketing & SEO Agency",
    subIndustry: "Search & AI Optimization",
    verifiedOfferings: [
      { id: "seo", name: "Search Engine Optimization", category: "Organic Search" },
      { id: "geo", name: "Generative Engine Optimization (GEO)", category: "AI Search" },
      { id: "cro", name: "Conversion Rate Optimization", category: "CRO" },
    ],
    targetAudiences: ["SaaS Startups", "E-Commerce Brands", "Local Businesses"],
    geographicMarket: "India",
    businessModel: "Agency Retainer & Consulting",
    pricePositioning: "SMB to Mid-Market",
    coreProblemSolved: "Low organic search visibility and lack of presence in AI answers",
    scaleProxy: "smb_boutique",
  };

  // 1. Accessible competitor website (Direct Website Verification)
  it("1. verifies accessible competitor website via direct_website method", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "PageTraffic India",
        website: "https://www.pagetraffic.in",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "Full-service SEO, AI search optimization, and enterprise link building",
        target_customer_rationale: "SaaS and E-commerce businesses seeking search growth",
        competitive_rationale: "Longstanding India direct peer agency with matching retainers",
      },
    ];

    const mockProbe = async () => ({
      accessible: true,
      status: 200,
      extractedText: "PageTraffic is an award-winning SEO agency offering search engine optimization, generative engine optimization (GEO), and conversion optimization for SaaS and eCommerce brands in India and globally.",
      finalUrl: "https://www.pagetraffic.in",
    });

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      mockProbeFn: mockProbe,
      now: FIXED_NOW,
    });

    assert.equal(result.length, 1);
    const c = result[0]!;
    assert.equal(c.canonical_domain, "pagetraffic.in");
    assert.equal(c.verification_status, "verified");
    assert.equal(c.verification_method, "direct_website");
    assert.equal(c.classification, "direct");
    assert.ok(c.overlap_scores.composite_score >= 0.6);
  });

  // 2. HTTP 403 with strong search-grounded evidence
  it("2. falls back to search-grounded verification when website returns HTTP 403", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "Protected Agency Peer",
        website: "https://protected-agency.com",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "SEO optimization and digital PR services in India",
        target_customer_rationale: "B2B SaaS companies",
        competitive_rationale: "Direct regional competitor with restrictive firewall",
      },
    ];

    // Mock search function returning authoritative search results
    const mockSearch: SearchGroundingFn = async () => [
      {
        title: "Protected Agency Peer — SEO & Digital Marketing Agency India",
        snippet: "Protected Agency Peer (protected-agency.com) provides search engine optimization, generative AI search, and digital marketing retainers for SaaS companies in Delhi and Bangalore.",
        url: "https://industry-directory.in/profile/protected-agency",
      },
      {
        title: "Top 10 Indian B2B SEO Agencies in 2026",
        snippet: "Protected Agency Peer offers data-backed SEO and conversion rate optimization campaigns for tech startups.",
        url: "https://marketing-watch.in/top-agencies-2026",
      },
    ];

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      customSearchFn: mockSearch,
      now: FIXED_NOW,
    });

    assert.equal(result.length, 1);
    const c = result[0]!;
    assert.equal(c.verification_method, "search_grounded");
    assert.equal(c.verification_status, "verified");
    assert.equal(c.classification, "direct");
    assert.ok(c.supporting_evidence_urls.length >= 1);
    assert.ok(c.verified_facts.length >= 1);
  });

  // 3 & 4. Cloudflare / JS-Heavy website with indexed search evidence
  it("3 & 4. handles Cloudflare / JS-heavy shells via search-grounded fallback", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "SinglePage App Digital",
        website: "https://spa-digital-agency.io",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "AEO, GEO, and search engine optimization",
        target_customer_rationale: "D2C brands and tech founders",
        competitive_rationale: "React SPA marketing agency",
      },
    ];

    const mockSearch: SearchGroundingFn = async () => [
      {
        title: "SinglePage App Digital (spa-digital-agency.io) Official Overview",
        snippet: "SPA Digital is a new-age organic search agency specializing in generative engine optimization (GEO) and search marketing for Indian D2C brands.",
        url: "https://tech-index.io/spa-digital",
      },
    ];

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      customSearchFn: mockSearch,
      now: FIXED_NOW,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]!.verification_method, "search_grounded");
    assert.equal(result[0]!.verification_status, "verified");
  });

  // 5. Company exists but domain association is uncertain (Excluded)
  it("5. excludes candidate when company exists but domain association is contradictory", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "Real Brand Wrong Domain",
        website: "https://fake-mismatched-domain.xyz",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "SEO services",
        target_customer_rationale: "SMEs",
        competitive_rationale: "Misattributed domain",
      },
    ];

    // Search results talk about the brand, but never mention or associate with the candidate domain
    const mockSearch: SearchGroundingFn = async () => [
      {
        title: "Real Brand Announces Expansion on official-real-brand.com",
        snippet: "Real Brand (operating exclusively at official-real-brand.com) announced new services.",
        url: "https://news.com/real-brand",
      },
    ];

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      customSearchFn: mockSearch,
      now: FIXED_NOW,
    });

    // Must be completely excluded because candidate domain "fake-mismatched-domain.xyz" is unverified!
    assert.equal(result.length, 0);
  });

  // 6. Company exists but service overlap cannot be established (Excluded)
  it("6. excludes candidate when company exists but offers zero service overlap", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "Irrelevant Heavy Machinery Co",
        website: "https://heavy-machinery-india.com",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "Completely unrelated manufacturing equipment",
        target_customer_rationale: "Construction firms",
        competitive_rationale: "No marketing overlap",
      },
    ];

    const mockSearch: SearchGroundingFn = async () => [
      {
        title: "Heavy Machinery India (heavy-machinery-india.com) Industrial Cranes",
        snippet: "Heavy Machinery India manufactures hydraulic excavators, industrial cranes, and earth-moving machinery.",
        url: "https://heavy-machinery-india.com",
      },
    ];

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      customSearchFn: mockSearch,
      now: FIXED_NOW,
    });

    // Zero overlap with agencyBoundary (SEO, GEO, CRO) -> fails hard gate -> excluded
    assert.equal(result.length, 0);
  });

  // 7 & 8. Fake company / Hallucinated domain / Weak listing (Excluded)
  it("7 & 8. excludes fake companies and weak third-party listings without corroboration", async () => {
    const candidates: CandidateCompetitorProposal[] = [
      {
        name: "Phantom Ghost Agency",
        website: "https://phantom-nonexistent-agency-12345.com",
        claimed_market: "India",
        proposed_classification: "direct",
        scale_fit: "comparable",
        offering_overlap_rationale: "SEO",
        target_customer_rationale: "Startups",
        competitive_rationale: "Hallucinated company",
      },
    ];

    // Search returns empty or generic spam
    const mockSearch: SearchGroundingFn = async () => [];

    const result = await discoverAndVerifyCompetitors({
      boundary: agencyBoundary,
      mockCandidates: candidates,
      customSearchFn: mockSearch,
      now: FIXED_NOW,
    });

    assert.equal(result.length, 0); // Excluded without fabricating an alternative category
  });

  // 9 & Anti-Monopoly: Enterprise Monopoly Downgrade Test
  it("9. downgrades massive global enterprises from DIRECT to INDIRECT or ADJACENT for boutique SMBs", () => {
    const enterpriseCandidate: CandidateCompetitorProposal = {
      name: "Global Megacorp Digital",
      website: "https://globalmegacorp.com",
      claimed_market: "Global",
      proposed_classification: "direct", // Proposed as direct by LLM
      scale_fit: "larger",               // But scale is LARGER (enterprise monopoly)
      offering_overlap_rationale: "Global enterprise consulting and full-stack digital marketing",
      target_customer_rationale: "Fortune 500 corporations",
      competitive_rationale: "Massive global consulting conglomerate",
    };

    const scored = scoreAndClassifyCompetitor({
      boundary: agencyBoundary, // agency is smb_boutique
      candidate: enterpriseCandidate,
      verifiedEvidenceText: "Global Megacorp provides search engine optimization, generative engine optimization, and enterprise advertising for Fortune 500 clients.",
    });

    // Anti-monopoly scale gate must downgrade from "direct" to "indirect"
    assert.equal(scored.classification, "indirect");
    assert.equal(scored.scaleClassification, "larger");
  });

  // 10. Database Persistence & Domain-Based Slug Reclassification Idempotency
  it("10. updates competitor classification in-place without duplicate records upon re-research", async () => {
    if (!db) {
      console.log("Skipping DB test (no DATABASE_URL)");
      return;
    }

    const [testBrand] = await db
      .insert(brandProfiles)
      .values({
        brandKey: "test-agency-reclass",
        businessKey: "biz_testagencyreclass_com",
        originalUrl: "https://testagencyreclass.com",
        canonicalUrl: "https://testagencyreclass.com",
        industry: "Digital Marketing Agency",
        brandName: "Test Agency Reclass",
        targetMarket: "India",
        primaryDomain: "https://testagencyreclass.com",
        profileJson: { test: true },
      })
      .returning({ id: brandProfiles.id });
    testBrandIds.push(testBrand!.id);

    const initialCompetitor = {
      name: "Competitor Peer",
      website: "https://competitorpeer.in",
      canonical_domain: "competitorpeer.in",
      classification: "direct" as const,
      scale_classification: "comparable" as const,
      verification_method: "direct_website" as const,
      verification_status: "verified" as const,
      overlap_scores: {
        offering: 0.9,
        customer: 0.8,
        geography: 0.9,
        scale: 1.0,
        model_pricing: 0.8,
        composite_score: 0.88,
      },
      competitive_rationale: "Direct India peer",
      verified_facts: ["Verified India SEO agency"],
      inferred_judgments: ["Direct competitor"],
      supporting_evidence_urls: ["https://competitorpeer.in"],
      confidence: "high" as const,
      unknowns: [],
      last_verified_at: FIXED_NOW.toISOString(),
    };

    // Initial Save: Persists competitor as DIRECT
    const save1 = await saveBrandOnboardingRecord(db, {
      businessKey: "biz_testagencyreclass_com",
      originalUrl: "https://testagencyreclass.com",
      canonicalUrl: "https://testagencyreclass.com",
      brandName: "Test Agency Reclass",
      industry: "Digital Marketing Agency",
      targetMarket: "India",
      profileJson: { test: true },
      servicesList: [],
      competitorsList: [initialCompetitor],
    });

    assert.equal(save1.competitorsSavedCount, 1);
    const comps1 = await db.select().from(competitors).where(eq(competitors.brandProfileId, testBrand!.id));
    assert.equal(comps1.length, 1);
    assert.equal(comps1[0]!.classification, "direct");
    assert.equal(comps1[0]!.slug, "comp_competitorpeer_in");

    // Re-research: Competitor is reclassified as INDIRECT
    const updatedCompetitor = {
      ...initialCompetitor,
      classification: "indirect" as const,
      competitive_rationale: "Reclassified to indirect DIY tool alternative",
    };

    const save2 = await saveBrandOnboardingRecord(db, {
      businessKey: "biz_testagencyreclass_com",
      originalUrl: "https://testagencyreclass.com",
      canonicalUrl: "https://testagencyreclass.com",
      brandName: "Test Agency Reclass",
      industry: "Digital Marketing Agency",
      targetMarket: "India",
      profileJson: { test: true },
      servicesList: [],
      competitorsList: [updatedCompetitor],
    });

    assert.equal(save2.competitorsSavedCount, 1);
    const comps2 = await db.select().from(competitors).where(eq(competitors.brandProfileId, testBrand!.id));
    // MUST STILL BE EXACTLY 1 ROW (updated in-place, zero duplicate records!)
    assert.equal(comps2.length, 1);
    assert.equal(comps2[0]!.classification, "indirect");
    assert.equal(comps2[0]!.slug, "comp_competitorpeer_in");

    // Test Caching: lookupBrandOrOnboard returns cached brand when fresh (<30 days)
    const cacheResult = await lookupBrandOrOnboard(db, "biz_testagencyreclass_com", 30, FIXED_NOW);
    assert.equal(cacheResult.cached, true);
    assert.equal(cacheResult.competitors?.length, 1);
    assert.equal(cacheResult.competitors?.[0]?.classification, "indirect");
  });
});
