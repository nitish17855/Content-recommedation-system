import { createHash } from "node:crypto";
import type { CanonicalSignal, RawFeedItem } from "../ai/schemas.js";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "how", "in", "into", "is", "it", "its", "more", "new", "of", "on", "or", "our",
  "out", "over", "says", "that", "the", "their", "this", "to", "up", "via", "what",
  "when", "why", "will", "with", "you", "your",
]);

const DOMAIN_TERMS = [
  "seo", "geo", "aeo", "ai overviews", "ai overview", "ai search", "chatgpt",
  "gemini", "perplexity", "search console", "core update", "google search",
  "google ads", "performance max", "pmax", "meta ads", "ecommerce", "e-commerce",
  "shopify", "d2c", "saas", "b2b", "startup", "startups", "india", "indian",
  "marketing", "advertising", "digital", "content", "brand", "branding",
  "conversion", "cro", "analytics", "privacy", "shopping", "structured data",
  "schema", "crawl", "indexing", "ranking", "rankings", "youtube", "instagram",
  "linkedin", "festive", "quick commerce", "upi", "fintech", "retail",
];

const NON_INDIA_GEO_ONLY = [
  "united states only", "us-only", "eea only", "european economic area only",
  "uk only", "canada only", "dma", "eu digital markets act",
];

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    const dropParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "mc_cid", "mc_eid"];
    for (const p of dropParams) {
      parsed.searchParams.delete(p);
    }
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function stripHtmlToExcerpt(raw: string, maxChars = 420): string {
  const plain = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars - 3).trimEnd()}...`;
}

export function extractSignificantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function extractKeywords(title: string, excerpt: string, categories: string[]): string[] {
  const combined = `${title} ${excerpt}`.toLowerCase();
  const found = new Set<string>();

  for (const term of DOMAIN_TERMS) {
    if (combined.includes(term)) {
      found.add(term);
    }
  }
  for (const cat of categories) {
    const clean = cat.trim().toLowerCase();
    if (clean && clean.length <= 40) {
      found.add(clean);
    }
  }
  for (const tok of extractSignificantTokens(title).slice(0, 6)) {
    found.add(tok);
  }
  return Array.from(found).slice(0, 12);
}

function classifyCountryRelevance(
  item: RawFeedItem,
  excerpt: string,
): CanonicalSignal["country_relevance"] {
  if (item.geoScope === "india") return "India";
  const lower = `${item.title} ${excerpt}`.toLowerCase();
  if (lower.includes("india") || lower.includes("indian") || lower.includes("apac")) {
    return "Global (India-relevant)";
  }
  if (NON_INDIA_GEO_ONLY.some((marker) => lower.includes(marker))) {
    return "Global (needs India review)";
  }
  return "Global (India-relevant)";
}

export function normalizeSignals(
  rawItems: RawFeedItem[],
  fetchedAt: Date = new Date(),
): CanonicalSignal[] {
  const fetchedIso = fetchedAt.toISOString();
  return rawItems.map((item, idx) => {
    const url = canonicalizeUrl(item.url);
    const title = stripHtmlToExcerpt(item.title, 240);
    const excerpt = stripHtmlToExcerpt(item.excerptRaw, 420);
    const parsedTs = item.publishedAtRaw ? Date.parse(item.publishedAtRaw) : NaN;
    const publishedIso = Number.isNaN(parsedTs) ? fetchedIso : new Date(parsedTs).toISOString();
    const contentHash = createHash("sha256")
      .update(`${url}|${title.toLowerCase()}|${excerpt.toLowerCase()}`)
      .digest("hex");

    return {
      signal_id: `sig_${String(idx + 1).padStart(3, "0")}`,
      source_id: item.sourceId,
      title,
      url,
      publisher: item.publisher,
      published_at: publishedIso,
      fetched_at: fetchedIso,
      source_type: item.sourceType,
      country_relevance: classifyCountryRelevance(item, excerpt),
      excerpt,
      content_hash: contentHash,
      keywords: extractKeywords(title, excerpt, item.categories),
      summary: null,
    };
  });
}

