import { XMLParser } from "fast-xml-parser";
import { validateUrlForSsrf } from "./ssrf-guard.js";
import {
  type NormalizedFeedEntry,
  buildNormalizedEntry,
} from "./feed-date-parser.js";
import { canonicalizeUrl } from "./normalize.js";

export interface FeedValidationCounts {
  totalParsedEntries: number;
  distinctEntriesCount: number;
  recentPublishedCount14d: number;
  recentUpdatedCount14d: number;
  recentPublishedCount30d: number;
  recentUpdatedCount30d: number;
  undatedEntryCount: number;
  invalidDateCount: number;
}

export interface FeedValidationResult {
  url: string;
  status: "valid" | "degraded" | "invalid";
  reason: string;
  title: string;
  feedType: "rss" | "atom" | "unknown";
  counts: FeedValidationCounts;
  entries: NormalizedFeedEntry[];
}

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

/**
 * Parses raw XML into normalized entries and feed metadata.
 * Explicitly isolates feed-level timestamps from entry-level timestamps.
 */
export function parseFeedXml(
  xml: string,
  publisher = "Unknown",
  now: Date = new Date(),
): { feedTitle: string; feedType: "rss" | "atom" | "unknown"; entries: NormalizedFeedEntry[] } {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { feedTitle: "", feedType: "unknown", entries: [] };
  }

  // 1. RSS 2.0
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  if (channel) {
    const feedTitle = textOf(channel.title).trim();
    const rawItems = asArray(channel.item);
    const entries: NormalizedFeedEntry[] = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const title = textOf(rec.title).trim();
      const rawUrl = textOf(rec.link).trim();
      const guid = textOf(rec.guid).trim();
      const url = rawUrl || guid;
      if (!title || !url) continue;

      // Extract entry-level dates ONLY (never fall back to channel.pubDate or channel.lastBuildDate)
      const rawPublished = textOf(rec.pubDate) || textOf(rec["dc:date"]) || null;
      const rawUpdated = textOf(rec["atom:updated"]) || textOf(rec.updated) || null;

      entries.push(
        buildNormalizedEntry({
          title,
          url,
          entryId: guid || url,
          publisher,
          rawPublished,
          rawUpdated,
          now,
        }),
      );
    }
    return { feedTitle, feedType: "rss", entries };
  }

  // 2. Atom
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    const feedTitle = textOf(feed.title).trim();
    const rawEntries = asArray(feed.entry);
    const entries: NormalizedFeedEntry[] = [];

    for (const raw of rawEntries) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const title = textOf(rec.title).trim();
      const url = extractAtomLink(rec.link).trim() || textOf(rec.id).trim();
      const entryId = textOf(rec.id).trim() || url;
      if (!title || !url) continue;

      // Extract entry-level dates ONLY (never fall back to feed.updated)
      const rawPublished = textOf(rec.published) || null;
      const rawUpdated = textOf(rec.updated) || null;

      entries.push(
        buildNormalizedEntry({
          title,
          url,
          entryId,
          publisher,
          rawPublished,
          rawUpdated,
          now,
        }),
      );
    }
    return { feedTitle, feedType: "atom", entries };
  }

  return { feedTitle: "", feedType: "unknown", entries: [] };
}

/**
 * Evaluates activity counts and assigns graded validation status
 * according to the Architecture Decision rules.
 */
export function evaluateFeedActivity(params: {
  url: string;
  feedTitle: string;
  feedType: "rss" | "atom" | "unknown";
  entries: NormalizedFeedEntry[];
  now?: Date;
  allowHighCredibilitySpecialist?: boolean;
}): FeedValidationResult {
  const now = params.now ?? new Date();
  const nowMs = now.getTime();
  const window14dMs = 14 * 24 * 60 * 60 * 1000;
  const window30dMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff14d = nowMs - window14dMs;
  const cutoff30d = nowMs - window30dMs;
  const maxFuture = nowMs + 24 * 60 * 60 * 1000;

  // Deduplicate entries by canonical URL or entryId
  const distinctEntries: NormalizedFeedEntry[] = [];
  const seenKeys = new Set<string>();

  for (const entry of params.entries) {
    const key = (canonicalizeUrl(entry.url) || entry.entryId).toLowerCase();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    distinctEntries.push(entry);
  }

  let recentPublishedCount14d = 0;
  let recentUpdatedCount14d = 0;
  let recentPublishedCount30d = 0;
  let recentUpdatedCount30d = 0;
  let undatedEntryCount = 0;
  let invalidDateCount = 0;

  for (const entry of distinctEntries) {
    if (entry.dateStatus === "invalid") {
      invalidDateCount++;
    } else if (entry.dateStatus === "missing") {
      undatedEntryCount++;
    }

    if (entry.publishedAt) {
      const ts = Date.parse(entry.publishedAt);
      if (ts >= cutoff14d && ts <= maxFuture) {
        recentPublishedCount14d++;
      }
      if (ts >= cutoff30d && ts <= maxFuture) {
        recentPublishedCount30d++;
      }
    }

    if (entry.updatedAt) {
      const ts = Date.parse(entry.updatedAt);
      if (ts >= cutoff14d && ts <= maxFuture) {
        recentUpdatedCount14d++;
      }
      if (ts >= cutoff30d && ts <= maxFuture) {
        recentUpdatedCount30d++;
      }
    }
  }

  const counts: FeedValidationCounts = {
    totalParsedEntries: params.entries.length,
    distinctEntriesCount: distinctEntries.length,
    recentPublishedCount14d,
    recentUpdatedCount14d,
    recentPublishedCount30d,
    recentUpdatedCount30d,
    undatedEntryCount,
    invalidDateCount,
  };

  // Status classification
  let status: "valid" | "degraded" | "invalid";
  let reason: string;

  if (params.feedType === "unknown" || distinctEntries.length === 0) {
    status = "invalid";
    reason = "No usable article entries found or unsupported feed format";
  } else if (recentPublishedCount14d >= 3) {
    status = "valid";
    reason = `Active: ${recentPublishedCount14d} distinct articles published within last 14 days`;
  } else if (recentPublishedCount14d >= 1) {
    status = "degraded";
    reason = `Moderate publication activity: ${recentPublishedCount14d} article(s) published within 14 days`;
  } else if (recentPublishedCount30d >= 1) {
    status = "degraded";
    reason = `Low publication activity: ${recentPublishedCount30d} article(s) published within 30 days (none in last 14 days)`;
  } else if (recentUpdatedCount14d >= 1 && recentPublishedCount30d === 0) {
    status = "degraded";
    reason = `Update activity: ${recentUpdatedCount14d} article(s) updated within last 14 days without new publications`;
  } else if (undatedEntryCount > 0 && recentPublishedCount30d === 0 && recentUpdatedCount30d === 0) {
    if (params.allowHighCredibilitySpecialist) {
      status = "degraded";
      reason = `Undated specialist source: ${undatedEntryCount} entries found without timestamps (accepted under specialist policy)`;
    } else {
      status = "degraded";
      reason = `Undated feed: ${undatedEntryCount} entries missing date fields; requires publisher review`;
    }
  } else {
    status = "invalid";
    reason = "Stale feed: No valid publications or updates within the last 30 days";
  }

  return {
    url: params.url,
    status,
    reason,
    title: params.feedTitle,
    feedType: params.feedType,
    counts,
    entries: distinctEntries,
  };
}

/**
 * Validates a live feed endpoint with full SSRF guard, redirect safety,
 * XML parsing, and graded activity scoring.
 */
export async function probeAndValidateFeed(
  feedUrl: string,
  publisher = "Unknown",
  options: { now?: Date; timeoutMs?: number; allowHighCredibilitySpecialist?: boolean } = {},
): Promise<FeedValidationResult> {
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? 10_000;

  // SSRF pre-flight validation
  const ssrfCheck = await validateUrlForSsrf(feedUrl);
  if (!ssrfCheck.safe) {
    return {
      url: feedUrl,
      status: "invalid",
      reason: `Blocked by SSRF guard: ${ssrfCheck.reason}`,
      title: "",
      feedType: "unknown",
      counts: {
        totalParsedEntries: 0,
        distinctEntriesCount: 0,
        recentPublishedCount14d: 0,
        recentUpdatedCount14d: 0,
        recentPublishedCount30d: 0,
        recentUpdatedCount30d: 0,
        undatedEntryCount: 0,
        invalidDateCount: 0,
      },
      entries: [],
    };
  }

  // Fetch with manual redirect loop to enforce SSRF check on every redirect hop
  let currentUrl = feedUrl;
  let responseText = "";

  try {
    for (let hop = 0; hop < 5; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: "manual",
          headers: {
            "User-Agent": "NSP-BrandIntelligenceBot/0.1 (+https://www.nspglobalservices.com/)",
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
          },
        });

        // Handle redirects
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) throw new Error("Redirect response missing Location header");
          const nextUrl = new URL(location, currentUrl).toString();
          const nextCheck = await validateUrlForSsrf(nextUrl);
          if (!nextCheck.safe) {
            throw new Error(`Redirect target unsafe: ${nextCheck.reason}`);
          }
          currentUrl = nextUrl;
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        responseText = await res.text();
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    return {
      url: feedUrl,
      status: "invalid",
      reason: err instanceof Error ? err.message : String(err),
      title: "",
      feedType: "unknown",
      counts: {
        totalParsedEntries: 0,
        distinctEntriesCount: 0,
        recentPublishedCount14d: 0,
        recentUpdatedCount14d: 0,
        recentPublishedCount30d: 0,
        recentUpdatedCount30d: 0,
        undatedEntryCount: 0,
        invalidDateCount: 0,
      },
      entries: [],
    };
  }

  if (!responseText) {
    return {
      url: feedUrl,
      status: "invalid",
      reason: "Empty response body or too many redirects",
      title: "",
      feedType: "unknown",
      counts: {
        totalParsedEntries: 0,
        distinctEntriesCount: 0,
        recentPublishedCount14d: 0,
        recentUpdatedCount14d: 0,
        recentPublishedCount30d: 0,
        recentUpdatedCount30d: 0,
        undatedEntryCount: 0,
        invalidDateCount: 0,
      },
      entries: [],
    };
  }

  const { feedTitle, feedType, entries } = parseFeedXml(responseText, publisher, now);
  return evaluateFeedActivity({
    url: feedUrl,
    feedTitle,
    feedType,
    entries,
    now,
    allowHighCredibilitySpecialist: options.allowHighCredibilitySpecialist,
  });
}
