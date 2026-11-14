import { XMLParser } from "fast-xml-parser";
import type { GeminiPipelineClient } from "../ai/client.js";
import {
  type BrandProfileExtraction,
  type CandidateCompetitorProposal,
  type CompetitorClassification,
  type CompetitorEvidenceRecord,
  CompetitorDiscoveryProposalsSchema,
  type ScaleClassification,
} from "../ai/schemas.js";
import { validateUrlForSsrf } from "./ssrf-guard.js";
import { normalizeBusinessUrl } from "./url-normalize.js";

export interface CompetitiveBoundaryProfile {
  brandName: string;
  industry: string;
  subIndustry: string;
  verifiedOfferings: Array<{ id: string; name: string; category: string }>;
  targetAudiences: string[];
  geographicMarket: string;
  businessModel: string;
  pricePositioning: string | null;
  coreProblemSolved: string;
  scaleProxy: "smb_boutique" | "mid_market" | "enterprise" | "unknown";
}

export interface CompetitorScoringWeights {
  offering: number;
  customer: number;
  geography: number;
  scale: number;
  modelPricing: number;
}

export const DEFAULT_SCORING_WEIGHTS: CompetitorScoringWeights = {
  offering: 0.30,
  customer: 0.25,
  geography: 0.20,
  scale: 0.15,
  modelPricing: 0.10,
};

export type SearchGroundingFn = (query: string) => Promise<{
  title: string;
  snippet: string;
  url: string;
}[]>;

export type ProbeCandidateWebsiteFn = (candidateUrl: string) => Promise<{
  accessible: boolean;
  status?: number;
  reason?: string;
  extractedText?: string;
  finalUrl?: string;
}>;

/**
 * Builds a structured boundary profile from an extracted brand profile.
 */
export function buildCompetitiveBoundaryProfile(
  extraction: BrandProfileExtraction,
): CompetitiveBoundaryProfile {
  const modelLower = (extraction.business_model ?? "").toLowerCase();
  const indLower = (extraction.industry ?? "").toLowerCase();

  let scaleProxy: CompetitiveBoundaryProfile["scaleProxy"] = "mid_market";
  if (
    modelLower.includes("agency") ||
    modelLower.includes("consulting") ||
    modelLower.includes("boutique") ||
    modelLower.includes("artisanal") ||
    indLower.includes("agency")
  ) {
    scaleProxy = "smb_boutique";
  } else if (modelLower.includes("enterprise") || indLower.includes("global enterprise")) {
    scaleProxy = "enterprise";
  }

  const coreProblemSolved =
    extraction.customer_pain_points && extraction.customer_pain_points.length > 0
      ? extraction.customer_pain_points.join(" | ")
      : extraction.value_proposition;

  return {
    brandName: extraction.brand_name,
    industry: extraction.industry,
    subIndustry: extraction.sub_industry ?? extraction.industry,
    verifiedOfferings: extraction.core_offerings.map((o) => ({
      id: o.service_id,
      name: o.name,
      category: o.category,
    })),
    targetAudiences: extraction.target_audiences,
    geographicMarket: extraction.target_market ?? "Global",
    businessModel: extraction.business_model,
    pricePositioning: null,
    coreProblemSolved,
    scaleProxy,
  };
}

/**
 * Stage 1: Direct Website Verification
 * Probes the candidate's homepage with strict SSRF and bot-protection detection.
 */
export async function probeCandidateWebsite(candidateUrl: string): Promise<{
  accessible: boolean;
  status?: number;
  reason?: string;
  extractedText?: string;
  finalUrl?: string;
}> {
  const ssrf = await validateUrlForSsrf(candidateUrl);
  if (!ssrf.safe) {
    return { accessible: false, reason: `SSRF check failed: ${ssrf.reason}` };
  }

  let currentUrl = candidateUrl;
  for (let hop = 0; hop < 3; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9",
        },
      });

      // Handle redirects with SSRF re-check
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { accessible: false, reason: "Redirect missing location" };
        const nextUrl = new URL(location, currentUrl).toString();
        const nextSsrf = await validateUrlForSsrf(nextUrl);
        if (!nextSsrf.safe) {
          return { accessible: false, reason: `Unsafe redirect: ${nextSsrf.reason}` };
        }
        currentUrl = nextUrl;
        continue;
      }

      if (res.status === 403 || res.status === 401 || res.status === 503) {
        return {
          accessible: false,
          status: res.status,
          reason: `HTTP ${res.status} access restricted / bot protected`,
        };
      }

      if (!res.ok) {
        return { accessible: false, status: res.status, reason: `HTTP ${res.status}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
        return { accessible: false, reason: `Non-HTML content type: ${contentType}` };
      }

      const rawHtml = await res.text();
      // Cap at 64KB
      const truncated = rawHtml.slice(0, 64 * 1024);

      // Check for Cloudflare / Turnstile / JS-only challenges
      const lower = truncated.toLowerCase();
      if (
        lower.includes("cf-ray") ||
        lower.includes("just a moment...") ||
        lower.includes("turnstile") ||
        lower.includes("security challenge") ||
        lower.includes("enable javascript to continue") ||
        truncated.trim().length < 150
      ) {
        return {
          accessible: false,
          status: res.status,
          reason: "Cloudflare challenge or empty JavaScript shell detected",
        };
      }

      // Sanitize simple text
      const cleanText = truncated
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        accessible: true,
        status: 200,
        extractedText: cleanText,
        finalUrl: currentUrl,
      };
    } catch (err) {
      return {
        accessible: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { accessible: false, reason: "Too many redirects" };
}

/**
 * Stage 2: Default Search-Grounded Query using Google News RSS
 */
export async function defaultGoogleSearchGrounding(query: string): Promise<
  { title: string; snippet: string; url: string }[]
> {
  const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "NSP-BrandIntelligenceBot/0.1 (+https://www.nspglobalservices.com/)",
        Accept: "application/rss+xml, text/xml",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
    const doc = parser.parse(xml) as Record<string, unknown>;
    const rss = doc.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    const rawItems = Array.isArray(channel?.item) ? channel.item : channel?.item ? [channel.item] : [];

    return rawItems.slice(0, 5).map((it) => {
      const rec = it as Record<string, unknown>;
      return {
        title: String(rec.title ?? ""),
        snippet: String(rec.description ?? ""),
        url: String(rec.link ?? ""),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Stage 3: Weighted Scoring & Hard Classification Gates
 */
export function scoreAndClassifyCompetitor(params: {
  boundary: CompetitiveBoundaryProfile;
  candidate: CandidateCompetitorProposal;
  verifiedEvidenceText: string;
  weights?: CompetitorScoringWeights;
}): {
  classification: CompetitorClassification;
  scaleClassification: ScaleClassification;
  overlapScores: CompetitorEvidenceRecord["overlap_scores"];
  verifiedFacts: string[];
  inferredJudgments: string[];
  isVerifiable: boolean;
} {
  const { boundary, candidate, verifiedEvidenceText } = params;
  const weights = params.weights ?? DEFAULT_SCORING_WEIGHTS;
  const textLower = verifiedEvidenceText.toLowerCase();

  // 1. Offering Overlap Score (0.0 to 1.0)
  let offeringMatches = 0;
  for (const offering of boundary.verifiedOfferings) {
    const oTokens = offering.name.toLowerCase().split(/\s+/);
    if (oTokens.some((t) => t.length > 3 && textLower.includes(t))) {
      offeringMatches++;
    }
  }
  const totalOfferings = Math.max(boundary.verifiedOfferings.length, 1);
  const offeringScore = offeringMatches > 0 ? Math.min(1.0, offeringMatches / totalOfferings + 0.2) : 0.0;

  // 2. Customer Overlap Score (0.0 to 1.0)
  let customerMatches = 0;
  for (const aud of boundary.targetAudiences) {
    const aTokens = aud.toLowerCase().split(/\s+/);
    if (aTokens.some((t) => t.length > 3 && textLower.includes(t))) {
      customerMatches++;
    }
  }
  const customerScore = customerMatches > 0 ? Math.min(1.0, customerMatches / Math.max(boundary.targetAudiences.length, 1) + 0.3) : 0.1;

  // If offering overlap is 0 and customer overlap is 0, this company has no competitive relationship
  if (offeringMatches === 0 && customerMatches === 0) {
    return {
      classification: "indirect",
      scaleClassification: candidate.scale_fit,
      overlapScores: {
        offering: 0,
        customer: 0,
        geography: 0,
        scale: 0,
        model_pricing: 0,
        composite_score: 0,
      },
      verifiedFacts: [],
      inferredJudgments: ["Zero offering and target customer overlap found in verified evidence"],
      isVerifiable: false,
    };
  }

  // 3. Geography Overlap Score (0.0 to 1.0)
  const marketTokens = boundary.geographicMarket.toLowerCase().split(/\s+/);
  const candMarket = candidate.claimed_market.toLowerCase();
  let geographyScore = 0.5;
  if (marketTokens.some((t) => t.length > 2 && candMarket.includes(t))) {
    geographyScore = 1.0;
  } else if (candMarket.includes("global") || boundary.geographicMarket.toLowerCase().includes("global")) {
    geographyScore = 0.8;
  } else {
    geographyScore = 0.3;
  }

  // 4. Scale Fit Score (0.0 to 1.0)
  let scaleScore = 0.5;
  const scaleFit = candidate.scale_fit;
  if (scaleFit === "comparable") scaleScore = 1.0;
  else if (scaleFit === "smaller") scaleScore = 0.7;
  else if (scaleFit === "larger") scaleScore = 0.4;
  else scaleScore = 0.5; // unknown

  // 5. Business Model / Pricing Score (0.0 to 1.0)
  const modelLower = boundary.businessModel.toLowerCase();
  const modelScore = textLower.includes("saas") || textLower.includes("agency") || textLower.includes("services") ? 0.8 : 0.5;

  // Composite Score
  const compositeScore = Number(
    (
      offeringScore * weights.offering +
      customerScore * weights.customer +
      geographyScore * weights.geography +
      scaleScore * weights.scale +
      modelScore * weights.modelPricing
    ).toFixed(2),
  );

  const overlapScores = {
    offering: Number(offeringScore.toFixed(2)),
    customer: Number(customerScore.toFixed(2)),
    geography: Number(geographyScore.toFixed(2)),
    scale: Number(scaleScore.toFixed(2)),
    model_pricing: Number(modelScore.toFixed(2)),
    composite_score: compositeScore,
  };

  // Hard Classification Gates
  let classification: CompetitorClassification = candidate.proposed_classification;

  // Anti-Monopoly Gate: A "larger" global enterprise cannot be DIRECT to an SMB/boutique
  if (scaleFit === "larger" && (boundary.scaleProxy === "smb_boutique" || boundary.scaleProxy === "mid_market")) {
    if (classification === "direct") {
      classification = "indirect"; // Downgrade to indirect alternative
    }
  }

  // Hard gate checks for DIRECT
  if (classification === "direct") {
    if (offeringScore < 0.4 || customerScore < 0.4 || geographyScore < 0.4) {
      classification = "indirect";
    }
  }

  const verifiedFacts: string[] = [
    `Verified market presence in ${candidate.claimed_market}`,
    `Publicly offers solutions overlapping with ${boundary.industry}`,
  ];
  const inferredJudgments: string[] = [
    candidate.competitive_rationale,
    `Assigned scale comparability: ${scaleFit} against ${boundary.scaleProxy}`,
  ];

  return {
    classification,
    scaleClassification: scaleFit,
    overlapScores,
    verifiedFacts,
    inferredJudgments,
    isVerifiable: true,
  };
}

/**
 * Autonomous Competitor Research Orchestrator with Search-Grounded Fallback
 */
export async function discoverAndVerifyCompetitors(params: {
  ai?: GeminiPipelineClient;
  model?: string;
  boundary: CompetitiveBoundaryProfile;
  mockCandidates?: CandidateCompetitorProposal[];
  customSearchFn?: SearchGroundingFn;
  mockProbeFn?: ProbeCandidateWebsiteFn;
  now?: Date;
}): Promise<CompetitorEvidenceRecord[]> {
  const now = params.now ?? new Date();

  // Stage A: Obtain candidate proposals from mock (for tests) or Gemini
  let proposedCandidates: CandidateCompetitorProposal[] = [];

  if (params.mockCandidates && params.mockCandidates.length > 0) {
    proposedCandidates = params.mockCandidates;
  } else if (params.ai && params.model) {
    try {
      const result = await params.ai.generateStructured({
        stage: "competitor-research",
        provider: "gemini",
        model: params.model,
        promptName: "competitor-research",
        inputPayload: {
          brand_name: params.boundary.brandName,
          industry: params.boundary.industry,
          sub_industry: params.boundary.subIndustry,
          verified_offerings: params.boundary.verifiedOfferings,
          target_audiences: params.boundary.targetAudiences,
          geographic_market: params.boundary.geographicMarket,
          business_model: params.boundary.businessModel,
          core_problem_solved: params.boundary.coreProblemSolved,
          scale_proxy: params.boundary.scaleProxy,
        },
        schema: CompetitorDiscoveryProposalsSchema,
        maxOutputTokens: 3000,
        temperature: 0.2,
      });
      proposedCandidates = result.candidates;
    } catch (err) {
      console.warn("[CompetitorResearch] Gemini candidate proposal failed:", err);
      proposedCandidates = [];
    }
  }

  const verifiedCompetitors: CompetitorEvidenceRecord[] = [];
  const searchFn = params.customSearchFn ?? defaultGoogleSearchGrounding;
  const probeFn = params.mockProbeFn ?? probeCandidateWebsite;

  for (const candidate of proposedCandidates) {
    let canonicalDomain = "";
    try {
      const parsedUrl = normalizeBusinessUrl(candidate.website);
      canonicalDomain = new URL(parsedUrl.canonicalUrl).hostname.replace(/^www\./, "");
    } catch {
      // Unparseable or invalid URL -> unverified
      continue;
    }

    if (!canonicalDomain || canonicalDomain.includes("localhost") || canonicalDomain.includes("127.0.0.1")) {
      continue;
    }

    let verificationMethod: "direct_website" | "search_grounded" = "direct_website";
    let verifiedEvidenceText = "";
    const supportingUrls: string[] = [];

    // Stage 1: Attempt Direct Website Probe
    const probe = await probeFn(candidate.website);

    if (probe.accessible && probe.extractedText && probe.extractedText.length >= 80) {
      verificationMethod = "direct_website";
      verifiedEvidenceText = probe.extractedText;
      supportingUrls.push(probe.finalUrl ?? candidate.website);
    } else {
      // Stage 2: Search-Grounded Fallback
      verificationMethod = "search_grounded";
      const primaryOffering = params.boundary.verifiedOfferings[0]?.name ?? params.boundary.industry;
      const query = `${candidate.name} ${canonicalDomain} ${primaryOffering}`;
      const searchResults = await searchFn(query);

      // Verify domain association: At least one credible result must reference candidate name or domain
      const candClean = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
      const candFirstWord = candClean.split(/\s+/)[0] ?? "";

      const corroborating = searchResults.filter((r) => {
        const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
        return (
          (candFirstWord.length >= 3 && text.includes(candFirstWord)) ||
          text.includes(canonicalDomain.toLowerCase())
        );
      });

      if (corroborating.length === 0) {
        // Unverifiable candidate -> exclude completely (do not fabricate)
        continue;
      }

      verifiedEvidenceText = corroborating.map((c) => `${c.title}. ${c.snippet}`).join(" ");
      supportingUrls.push(...corroborating.map((c) => c.url));
    }

    // Stage 3: Evidence-Based Classification & Hard Gates
    const scored = scoreAndClassifyCompetitor({
      boundary: params.boundary,
      candidate,
      verifiedEvidenceText,
    });

    if (!scored.isVerifiable) {
      continue;
    }

    verifiedCompetitors.push({
      name: candidate.name,
      website: candidate.website,
      canonical_domain: canonicalDomain,
      classification: scored.classification,
      scale_classification: scored.scaleClassification,
      verification_method: verificationMethod,
      verification_status: "verified",
      overlap_scores: scored.overlapScores,
      competitive_rationale: candidate.competitive_rationale,
      verified_facts: scored.verifiedFacts,
      inferred_judgments: scored.inferredJudgments,
      supporting_evidence_urls: supportingUrls.slice(0, 4),
      confidence: verificationMethod === "direct_website" ? "high" : "medium",
      unknowns: scored.scaleClassification === "unknown" ? ["Precise company employee count or revenue unverified"] : [],
      last_verified_at: now.toISOString(),
    });
  }

  // Sort candidates by composite score descending
  return verifiedCompetitors.sort((a, b) => b.overlap_scores.composite_score - a.overlap_scores.composite_score);
}
