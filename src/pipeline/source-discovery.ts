import type { AppDb } from "../db/client.js";
import { brandSources, sources } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { GeminiPipelineClient } from "../ai/client.js";
import {
  type CandidatePublisher,
  SourceDiscoveryProposalsSchema,
} from "../ai/schemas.js";
import {
  type FeedValidationResult,
  probeAndValidateFeed,
} from "./source-validator.js";
import { validateUrlForSsrf } from "./ssrf-guard.js";

export interface BusinessProfileForDiscovery {
  industry: string;
  subIndustry?: string;
  businessModel?: string;
  offerings?: Array<{ name: string; category?: string }>;
  targetAudience?: string[];
  geographicMarket?: string;
}

export interface IndustryCoverageAssessment {
  industry: string;
  subIndustry?: string;
  isSufficientlyCovered: boolean;
  baselineMatchingSources: string[];
  coverageGaps: string[];
  reason: string;
}

export interface DiscoveredFeed {
  publisherName: string;
  websiteUrl: string;
  feedUrl: string;
  feedTitle: string;
  feedType: "rss" | "atom" | "unknown";
  validationStatus: "valid" | "degraded";
  validationReason: string;
  isSpecialist: boolean;
  sourceId?: string;
  dbSourceId?: number;
}

export interface RejectedCandidateFeed {
  publisherName: string;
  candidateUrl: string;
  reason: string;
}

export interface DiscoveryAndValidationOutput {
  coverage: IndustryCoverageAssessment;
  candidatePublishersProposed: number;
  acceptedSources: DiscoveredFeed[];
  rejectedCandidates: RejectedCandidateFeed[];
}

/**
 * Assesses whether the 22 baseline feeds adequately cover this business profile
 * or if specialized dynamic discovery is necessary.
 */
export function assessIndustryCoverage(
  profile: BusinessProfileForDiscovery,
): IndustryCoverageAssessment {
  const indLower = (profile.industry ?? "").toLowerCase();
  const subLower = (profile.subIndustry ?? "").toLowerCase();
  const modelLower = (profile.businessModel ?? "").toLowerCase();
  const combined = `${indLower} ${subLower} ${modelLower}`;

  // Check for SaaS / Digital Marketing / Tech Platform domains
  const isTechOrMarketing =
    combined.includes("saas") ||
    combined.includes("software") ||
    combined.includes("digital marketing") ||
    combined.includes("seo") ||
    combined.includes("martech") ||
    combined.includes("generative search") ||
    combined.includes("agency") ||
    combined.includes("ai tool");

  // Check for D2C Food & Beverage
  const isFoodOrBeverage =
    combined.includes("food") ||
    combined.includes("beverage") ||
    combined.includes("nutrition") ||
    combined.includes("fmcg") ||
    combined.includes("dairy") ||
    combined.includes("bakery") ||
    combined.includes("snack");

  // Check for Logistics & Freight & Supply Chain
  const isLogisticsOrSupplyChain =
    combined.includes("logistics") ||
    combined.includes("freight") ||
    combined.includes("supply chain") ||
    combined.includes("warehousing") ||
    combined.includes("trucking") ||
    combined.includes("cargo") ||
    combined.includes("shipping");

  // Check for Healthcare & Pharma
  const isHealthcareOrPharma =
    combined.includes("health") ||
    combined.includes("pharma") ||
    combined.includes("biotech") ||
    combined.includes("medical");

  if (isFoodOrBeverage) {
    return {
      industry: profile.industry,
      subIndustry: profile.subIndustry,
      isSufficientlyCovered: false,
      baselineMatchingSources: ["et-retail-ecommerce", "india-d2c-brand-campaigns"],
      coverageGaps: [
        "Food safety & standards compliance (e.g., FSSAI, FDA)",
        "F&B ingredient innovation and processing technology",
        "Agricultural commodities, packaging, and perishable supply chain trends",
      ],
      reason:
        "Baseline sources provide general e-commerce and retail coverage, but lack specialized food processing, agricultural commodity, and F&B regulatory signals.",
    };
  }

  if (isLogisticsOrSupplyChain) {
    return {
      industry: profile.industry,
      subIndustry: profile.subIndustry,
      isSufficientlyCovered: false,
      baselineMatchingSources: [],
      coverageGaps: [
        "Ocean, air, and surface freight market spot rates",
        "Intermodal freight, cold-chain transport, and fleet compliance",
        "3PL, contract warehousing, and international customs port operations",
      ],
      reason:
        "The 22 baseline feeds have zero freight, shipping, cold-chain, or warehouse logistics coverage.",
    };
  }

  if (isHealthcareOrPharma) {
    return {
      industry: profile.industry,
      subIndustry: profile.subIndustry,
      isSufficientlyCovered: false,
      baselineMatchingSources: [],
      coverageGaps: [
        "Clinical trials and drug regulatory approvals",
        "Healthcare provider and medical device operational shifts",
        "Pharmaceutical supply chain and biotechnology developments",
      ],
      reason: "Zero baseline coverage for medical devices, pharmaceuticals, and clinical regulations.",
    };
  }

  if (isTechOrMarketing) {
    return {
      industry: profile.industry,
      subIndustry: profile.subIndustry,
      isSufficientlyCovered: true,
      baselineMatchingSources: [
        "google-search-central",
        "seroundtable",
        "google-ads-dev",
        "google-official-blog",
        "openai-news",
        "saastr",
        "techcrunch",
        "techcrunch-enterprise",
        "b2b-saas-news",
        "saas-growth-plg",
        "et-brandequity-marketing",
        "et-brandequity-digital",
        "inc42",
        "yourstory",
      ],
      coverageGaps: [],
      reason:
        "Primary vertical (B2B SaaS, Digital Marketing & Search) is comprehensively covered by the 22 shared baseline feeds.",
    };
  }

  // Generic fallback for unfamiliar industries
  return {
    industry: profile.industry,
    subIndustry: profile.subIndustry,
    isSufficientlyCovered: false,
    baselineMatchingSources: ["inc42", "yourstory", "techcrunch"],
    coverageGaps: [`Industry-specific trade and regulatory publications for ${profile.industry}`],
    reason: `Baseline feeds provide general startup/tech news but lack dedicated industry signals for ${profile.industry}.`,
  };
}

/**
 * Attempts to autodiscover RSS or Atom feeds from HTML `<link rel="alternate">` tags
 * or common endpoint conventions (/feed, /rss.xml, /feed/).
 */
export async function autodiscoverFeedUrls(homepageUrl: string): Promise<string[]> {
  const candidates: string[] = [];
  const ssrf = await validateUrlForSsrf(homepageUrl);
  if (!ssrf.safe) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(homepageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "NSP-BrandIntelligenceBot/0.1 (+https://www.nspglobalservices.com/)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      const html = await res.text();
      // Look for <link rel="alternate" type="application/rss+xml" href="...">
      const linkRegex = /<link[^>]+(?:type=["'](application\/rss\+xml|application\/atom\+xml)["'])[^>]+href=["']([^"']+)["']/gi;
      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(html)) !== null) {
        if (match[2]) {
          try {
            const resolved = new URL(match[2], homepageUrl).toString();
            candidates.push(resolved);
          } catch {
            // ignore malformed URLs
          }
        }
      }
    }
  } catch {
    // Timeout or network error
  }

  // Add standard conventional feed paths
  try {
    const base = new URL(homepageUrl);
    candidates.push(new URL("/feed", base).toString());
    candidates.push(new URL("/feed/", base).toString());
    candidates.push(new URL("/rss.xml", base).toString());
    candidates.push(new URL("/rss", base).toString());
  } catch {
    // ignore
  }

  return Array.from(new Set(candidates));
}

/**
 * Discovers and validates industry-specific news feeds for a business profile.
 */
export async function discoverAndValidateIndustrySources(params: {
  ai?: GeminiPipelineClient;
  model?: string;
  profile: BusinessProfileForDiscovery;
  mockProposals?: CandidatePublisher[];
  now?: Date;
}): Promise<DiscoveryAndValidationOutput> {
  const now = params.now ?? new Date();
  const coverage = assessIndustryCoverage(params.profile);

  if (coverage.isSufficientlyCovered) {
    return {
      coverage,
      candidatePublishersProposed: 0,
      acceptedSources: [],
      rejectedCandidates: [],
    };
  }

  // Obtain candidate publishers either from mock (for tests) or Gemini
  let candidatePublishers: CandidatePublisher[] = [];

  if (params.mockProposals && params.mockProposals.length > 0) {
    candidatePublishers = params.mockProposals;
  } else if (params.ai && params.model) {
    try {
      const result = await params.ai.generateStructured({
        stage: "source-discovery",
        provider: "gemini",
        model: params.model,
        promptName: "source-discovery",
        inputPayload: {
          industry: params.profile.industry,
          sub_industry: params.profile.subIndustry ?? "",
          business_model: params.profile.businessModel ?? "",
          offerings: params.profile.offerings ?? [],
          target_audience: params.profile.targetAudience ?? [],
          geographic_market: params.profile.geographicMarket ?? "Global",
          coverage_gaps: coverage.coverageGaps,
        },
        schema: SourceDiscoveryProposalsSchema,
        maxOutputTokens: 2500,
        temperature: 0.2,
      });
      candidatePublishers = result.publishers;
    } catch (err) {
      console.warn(
        `[SourceDiscovery] LLM proposal failed for ${params.profile.industry}:`,
        err instanceof Error ? err.message : String(err),
      );
      candidatePublishers = [];
    }
  }

  const acceptedSources: DiscoveredFeed[] = [];
  const rejectedCandidates: RejectedCandidateFeed[] = [];
  const seenFeedUrls = new Set<string>();

  for (const pub of candidatePublishers) {
    let validatedResult: FeedValidationResult | null = null;
    let acceptedUrl: string | null = null;

    // Check proposed candidate feed URLs first
    const candidateUrls = [...pub.candidate_feed_urls];

    // If candidate URLs are empty, try autodiscovering from website URL
    if (candidateUrls.length === 0 && pub.website_url) {
      const discovered = await autodiscoverFeedUrls(pub.website_url);
      candidateUrls.push(...discovered);
    }

    for (const url of candidateUrls) {
      if (seenFeedUrls.has(url.toLowerCase())) continue;

      const probe = await probeAndValidateFeed(url, pub.publisher_name, {
        now,
        allowHighCredibilitySpecialist: pub.is_specialist_or_regulatory,
      });

      if (probe.status === "valid" || probe.status === "degraded") {
        validatedResult = probe;
        acceptedUrl = url;
        seenFeedUrls.add(url.toLowerCase());
        break; // Found a working feed for this publisher
      } else {
        rejectedCandidates.push({
          publisherName: pub.publisher_name,
          candidateUrl: url,
          reason: probe.reason,
        });
      }
    }

    if (validatedResult && acceptedUrl) {
      acceptedSources.push({
        publisherName: pub.publisher_name,
        websiteUrl: pub.website_url,
        feedUrl: acceptedUrl,
        feedTitle: validatedResult.title || pub.publisher_name,
        feedType: validatedResult.feedType,
        validationStatus: validatedResult.status as "valid" | "degraded",
        validationReason: validatedResult.reason,
        isSpecialist: pub.is_specialist_or_regulatory,
      });
    }
  }

  return {
    coverage,
    candidatePublishersProposed: candidatePublishers.length,
    acceptedSources,
    rejectedCandidates,
  };
}

/**
 * Persists discovered sources to the database:
 * 1. Inserts globally into `sources` (or reuses existing rows by feedUrl).
 * 2. Links to the brand in `brand_sources` with discovery_method = 'dynamic'.
 * 3. Enforces idempotency via composite unique key (brandProfileId, sourceId).
 */
export async function syncDiscoveredSourcesToDb(params: {
  db: AppDb;
  brandProfileId: number;
  industryTag: string;
  sourcesToSync: DiscoveredFeed[];
}): Promise<{ createdSourcesCount: number; linkedBrandSourcesCount: number }> {
  const { db, brandProfileId, industryTag, sourcesToSync } = params;
  let createdSourcesCount = 0;
  let linkedBrandSourcesCount = 0;

  for (const src of sourcesToSync) {
    // 1. Check if source already exists globally by feedUrl
    const existing = await db
      .select({ id: sources.id, sourceId: sources.sourceId })
      .from(sources)
      .where(eq(sources.feedUrl, src.feedUrl))
      .limit(1);

    let dbSourceId: number;
    let sourceIdStr: string;

    if (existing.length > 0 && existing[0]) {
      dbSourceId = existing[0].id;
      sourceIdStr = existing[0].sourceId;
    } else {
      // Create new global source
      const slug = src.publisherName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      sourceIdStr = `dyn_${slug}`;

      const [inserted] = await db
        .insert(sources)
        .values({
          sourceId: sourceIdStr,
          name: src.publisherName,
          feedUrl: src.feedUrl,
          sourceType: src.isSpecialist ? "official_platform" : "industry_news",
          geoScope: "global",
          enabled: true,
        })
        .onConflictDoUpdate({
          target: sources.sourceId,
          set: {
            feedUrl: src.feedUrl,
            updatedAt: new Date(),
          },
        })
        .returning({ id: sources.id, sourceId: sources.sourceId });

      if (!inserted) {
        // Fallback fetch
        const [refetched] = await db
          .select({ id: sources.id, sourceId: sources.sourceId })
          .from(sources)
          .where(eq(sources.feedUrl, src.feedUrl))
          .limit(1);
        dbSourceId = refetched!.id;
      } else {
        dbSourceId = inserted.id;
        createdSourcesCount++;
      }
    }

    src.sourceId = sourceIdStr;
    src.dbSourceId = dbSourceId;

    // 2. Link into brand_sources
    await db
      .insert(brandSources)
      .values({
        brandProfileId,
        sourceId: dbSourceId,
        industryTag,
        discoveryMethod: "dynamic",
        validationStatus: src.validationStatus,
        enabled: true,
        lastValidatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [brandSources.brandProfileId, brandSources.sourceId],
        set: {
          validationStatus: src.validationStatus,
          industryTag,
          lastValidatedAt: new Date(),
        },
      });

    linkedBrandSourcesCount++;
  }

  return { createdSourcesCount, linkedBrandSourcesCount };
}
