import { XMLParser } from "fast-xml-parser";
import type { RawFeedItem, SourceConfig, SourceRunResult } from "../ai/schemas.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap per feed

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function textOf(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (val && typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (typeof rec["#text"] === "string") return rec["#text"];
  }
  return "";
}

function extractAtomLink(linkField: unknown): string {
  for (const candidate of asArray(linkField)) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object") {
      const rec = candidate as Record<string, unknown>;
      const rel = String(rec["@_rel"] ?? "alternate");
      const href = rec["@_href"];
      if (typeof href === "string" && (rel === "alternate" || !rec["@_rel"])) {
        return href;
      }
    }
  }
  return "";
}

function extractCategories(catField: unknown): string[] {
  return asArray(catField)
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const rec = c as Record<string, unknown>;
        return String(rec["@_term"] ?? rec["#text"] ?? "");
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFeedXml(xml: string, source: SourceConfig): RawFeedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const items: RawFeedItem[] = [];

  // RSS 2.0 (also handles Google Trends <ht:news_item> & <ht:approx_traffic>)
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (channel?.item) {
    for (const raw of asArray(channel.item).slice(0, source.maxItems)) {
      const rec = raw as Record<string, unknown>;
      const rawTitle = textOf(rec.title).trim();
      const rawUrl = textOf(rec.link).trim();
      const newsItems = asArray(rec["ht:news_item"] as Record<string, unknown> | undefined);
      const firstNews = newsItems[0] as Record<string, unknown> | undefined;
      const newsUrl = firstNews ? textOf(firstNews["ht:news_item_url"]).trim() : "";
      const newsTitle = firstNews ? textOf(firstNews["ht:news_item_title"]).trim() : "";
      const newsSnippet = firstNews ? textOf(firstNews["ht:news_item_snippet"]).trim() : "";
      const approxTraffic = textOf(rec["ht:approx_traffic"]).trim();

      const url = newsUrl || rawUrl;
      const title = newsTitle && rawTitle && newsTitle.toLowerCase() !== rawTitle.toLowerCase()
        ? `${rawTitle}: ${newsTitle}`
        : rawTitle;
      const baseExcerpt = textOf(rec.description) || textOf(rec["content:encoded"]) || newsSnippet;
      const excerptRaw = approxTraffic
        ? `Google Trends India (${approxTraffic} searches): ${baseExcerpt || newsTitle || rawTitle}`
        : baseExcerpt;

      if (!title || !url) continue;
      items.push({
        sourceId: source.id,
        publisher: source.name,
        sourceType: source.sourceType,
        geoScope: source.geoScope,
        title,
        url,
        publishedAtRaw: textOf(rec.pubDate) || textOf(rec["dc:date"]) || null,
        excerptRaw,
        categories: extractCategories(rec.category),
      });
    }
    return items;
  }

  // Atom
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed?.entry) {
    for (const raw of asArray(feed.entry).slice(0, source.maxItems)) {
      const rec = raw as Record<string, unknown>;
      const title = textOf(rec.title).trim();
      const url = extractAtomLink(rec.link).trim();
      if (!title || !url) continue;
      items.push({
        sourceId: source.id,
        publisher: source.name,
        sourceType: source.sourceType,
        geoScope: source.geoScope,
        title,
        url,
        publishedAtRaw: textOf(rec.published) || textOf(rec.updated) || null,
        excerptRaw: textOf(rec.summary) || textOf(rec.content) || "",
        categories: extractCategories(rec.category),
      });
    }
  }

  return items;
}

async function fetchWithRetry(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "NSP-BrandIntelligenceBot/0.1 (+https://www.nspglobalservices.com/)",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error(`Feed exceeded max size cap (${MAX_RESPONSE_BYTES} bytes)`);
      }
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delayMs = 800 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export interface CollectionOutput {
  items: RawFeedItem[];
  sourceRuns: SourceRunResult[];
}

export async function collectRssSources(
  sources: SourceConfig[],
  lookbackDays: number,
  now: Date = new Date(),
): Promise<CollectionOutput> {
  const cutoffMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const items: RawFeedItem[] = [];
  const sourceRuns: SourceRunResult[] = [];

  for (const source of sources) {
    if (!source.enabled) {
      sourceRuns.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "skipped",
        fetchedCount: 0,
        inWindowCount: 0,
      });
      continue;
    }

    try {
      const xml = await fetchWithRetry(source.feedUrl);
      const parsed = parseFeedXml(xml, source);
      const inWindow = parsed.filter((item) => {
        if (!item.publishedAtRaw) return true;
        const ts = Date.parse(item.publishedAtRaw);
        return Number.isNaN(ts) || ts >= cutoffMs;
      });
      items.push(...inWindow);
      sourceRuns.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "ok",
        fetchedCount: parsed.length,
        inWindowCount: inWindow.length,
      });
    } catch (err) {
      // Source-level errors must not stop the complete run
      sourceRuns.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "error",
        fetchedCount: 0,
        inWindowCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { items, sourceRuns };
}

