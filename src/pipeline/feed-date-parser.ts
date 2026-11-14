/**
 * Pure date normalization and calendar-aware validation for RSS 2.0 and Atom feeds.
 * Supports RFC 822/2822, RFC 3339/ISO 8601, and timezone offset arithmetic
 * without external date libraries.
 */

export interface ParsedDateResult {
  iso: string | null;
  status: "valid" | "missing" | "invalid";
  reason?: string;
}

export interface NormalizedFeedEntry {
  title: string;
  url: string;
  entryId: string;
  publishedAt: string | null;
  updatedAt: string | null;
  activityAt: string | null;
  activityBasis: "published" | "updated" | "unknown";
  dateStatus: "valid" | "missing" | "invalid";
  publisher: string;
  rawPublished?: string | null;
  rawUpdated?: string | null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const TZ_ABBREVIATIONS: Record<string, number> = {
  utc: 0,
  gmt: 0,
  z: 0,
  edt: -240,
  est: -300,
  cdt: -300,
  cst: -360,
  mdt: -360,
  mst: -420,
  pdt: -420,
  pst: -480,
};

// Known ambiguous timezone abbreviations that MUST be rejected unless specified as numeric offsets
const AMBIGUOUS_TIMEZONES = new Set([
  "ist", // India (+05:30) vs Ireland (+01:00) vs Israel (+02:00)
  "bst", // British Summer Time (+01:00) vs Bangladesh (+06:00)
  "cat", // Central Africa (+02:00)
  "ast", // Atlantic (-04:00) vs Arabia (+03:00)
]);

/**
 * Returns the exact days in a given month (1-indexed month, e.g. 2 for Feb)
 * accurately accounting for leap years.
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses numeric or named timezone string into minutes of offset from UTC.
 * E.g., "+0530" -> 330, "-04:00" -> -240, "GMT" -> 0, "EST" -> -300.
 */
function parseTimezoneOffsetMinutes(tzStr?: string): number | null {
  if (!tzStr) return 0; // Default to UTC when not specified
  const trimmed = tzStr.trim();
  const lower = trimmed.toLowerCase();

  // Reject ambiguous timezone abbreviations that lack an explicit numeric offset
  if (AMBIGUOUS_TIMEZONES.has(lower)) {
    return null;
  }

  if (lower in TZ_ABBREVIATIONS) {
    return TZ_ABBREVIATIONS[lower] ?? 0;
  }

  // Matches +0530, -0400, +05:30, -04:00
  const match = trimmed.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (match && match[1] && match[2]) {
    const sign = match[1] === "-" ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    if (hours > 23 || minutes > 59) return null;
    return sign * (hours * 60 + minutes);
  }

  return null;
}

/**
 * Parses RFC 822 / RFC 2822 dates:
 * E.g., "Mon, 02 Jan 2006 15:04:05 GMT", "2 Jan 2006 15:04:05 +0530", "02 Jan 2006 15:04:05 EST"
 */
function parseRfc2822(raw: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; offsetMinutes: number } | null {
  const regex = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(?:([+-]\d{4}|[+-]\d{2}:\d{2})|([A-Za-z]{1,4}))?$/i;
  const match = raw.trim().match(regex);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4] || !match[5]) return null;

  const day = parseInt(match[1], 10);
  const monthName = match[2].toLowerCase();
  const month = MONTH_NAMES[monthName];
  if (!month) return null;

  let year = parseInt(match[3], 10);
  if (year < 100) {
    year += year < 70 ? 2000 : 1900;
  }
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = match[6] ? parseInt(match[6], 10) : 0;
  const tzToken = match[7] || match[8] || "UTC";

  const offsetMinutes = parseTimezoneOffsetMinutes(tzToken);
  if (offsetMinutes === null) return null;

  return { year, month, day, hour, minute, second, offsetMinutes };
}

/**
 * Parses RFC 3339 / ISO 8601 dates:
 * E.g., "2026-03-10T14:30:00Z", "2026-03-10T20:00:00+05:30", "2026-03-10 14:30:00"
 */
function parseRfc3339(raw: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; offsetMinutes: number } | null {
  const regex = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:(Z)|([+-]\d{2}(?::?\d{2})?))?)?$/i;
  const match = raw.trim().match(regex);
  if (!match || !match[1] || !match[2] || !match[3]) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = match[4] ? parseInt(match[4], 10) : 0;
  const minute = match[5] ? parseInt(match[5], 10) : 0;
  const second = match[6] ? parseInt(match[6], 10) : 0;
  const isZ = Boolean(match[7]);
  const tzOffsetStr = match[8];

  let offsetMinutes = 0;
  if (!isZ && tzOffsetStr) {
    const parsedOffset = parseTimezoneOffsetMinutes(tzOffsetStr);
    if (parsedOffset === null) return null;
    offsetMinutes = parsedOffset;
  }

  return { year, month, day, hour, minute, second, offsetMinutes };
}

/**
 * Normalizes an arbitrary RSS/Atom date string into UTC ISO 8601.
 * Enforces calendar boundary checks (no Feb 31 rollover) and rejects
 * implausible future timestamps (> 24 hours into future).
 */
export function parseFeedDate(
  rawDate: string | null | undefined,
  now: Date = new Date(),
  maxFutureHours = 24,
): ParsedDateResult {
  if (!rawDate || typeof rawDate !== "string" || !rawDate.trim()) {
    return { iso: null, status: "missing" };
  }

  const trimmed = rawDate.trim();

  // 1. Try RFC 3339 / ISO 8601, then RFC 822 / RFC 2822
  const parsed = parseRfc3339(trimmed) || parseRfc2822(trimmed);
  if (!parsed) {
    return { iso: null, status: "invalid", reason: `Malformed date syntax: "${trimmed}"` };
  }

  const { year, month, day, hour, minute, second, offsetMinutes } = parsed;

  // 2. Calendar validation (strict calendar day bounds)
  if (year < 1990 || year > 2100) {
    return { iso: null, status: "invalid", reason: `Year out of bounds: ${year}` };
  }
  if (month < 1 || month > 12) {
    return { iso: null, status: "invalid", reason: `Month out of bounds: ${month}` };
  }
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    return {
      iso: null,
      status: "invalid",
      reason: `Invalid calendar day ${day} for month ${month}/${year} (max: ${maxDays})`,
    };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { iso: null, status: "invalid", reason: `Time component out of bounds: ${hour}:${minute}:${second}` };
  }

  // 3. Compute epoch timestamp in UTC
  const epochUtc = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000;
  const dateObj = new Date(epochUtc);

  // 4. Future timestamp check
  const maxFutureEpoch = now.getTime() + maxFutureHours * 60 * 60 * 1000;
  if (epochUtc > maxFutureEpoch) {
    return {
      iso: null,
      status: "invalid",
      reason: `Implausible future timestamp: ${dateObj.toISOString()} (beyond +${maxFutureHours}h window)`,
    };
  }

  return { iso: dateObj.toISOString(), status: "valid" };
}

/**
 * Builds a NormalizedFeedEntry strictly implementing the Architecture Decision Contract.
 * Applies date selection precedence: activityAt = publishedAt ?? updatedAt.
 */
export function buildNormalizedEntry(params: {
  title: string;
  url: string;
  entryId: string;
  publisher: string;
  rawPublished?: string | null;
  rawUpdated?: string | null;
  now?: Date;
}): NormalizedFeedEntry {
  const now = params.now ?? new Date();
  const pub = parseFeedDate(params.rawPublished, now);
  const upd = parseFeedDate(params.rawUpdated, now);

  const publishedAt = pub.status === "valid" ? pub.iso : null;
  const updatedAt = upd.status === "valid" ? upd.iso : null;

  // Precedence rule: publishedAt takes precedence over updatedAt for activity
  let activityAt: string | null = null;
  let activityBasis: "published" | "updated" | "unknown" = "unknown";

  if (publishedAt) {
    activityAt = publishedAt;
    activityBasis = "published";
  } else if (updatedAt) {
    activityAt = updatedAt;
    activityBasis = "updated";
  } else {
    activityAt = null;
    activityBasis = "unknown";
  }

  // Entry-level dateStatus
  let dateStatus: "valid" | "missing" | "invalid" = "missing";
  if (pub.status === "valid" || upd.status === "valid") {
    dateStatus = "valid";
  } else if (pub.status === "invalid" || upd.status === "invalid") {
    dateStatus = "invalid";
  } else {
    dateStatus = "missing";
  }

  return {
    title: params.title.trim(),
    url: params.url.trim(),
    entryId: params.entryId.trim(),
    publishedAt,
    updatedAt,
    activityAt,
    activityBasis,
    dateStatus,
    publisher: params.publisher.trim(),
    rawPublished: params.rawPublished,
    rawUpdated: params.rawUpdated,
  };
}
