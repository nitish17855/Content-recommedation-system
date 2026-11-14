import { createHash } from "node:crypto";

export interface NormalizedUrlResult {
  originalUrl: string;
  canonicalUrl: string;
  hostname: string;
  businessKey: string;
}

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "source",
]);

/**
 * Normalizes any user-entered website URL into a canonical domain and deterministic business identity key.
 *
 * Rules:
 * 1. Trims whitespace, guarantees 'https://' protocol if missing.
 * 2. Strips 'www.' prefix while preserving legitimate subdomains (e.g. app.example.com, blog.example.com).
 * 3. Removes all marketing tracking query parameters (utm_*, gclid, fbclid, etc.).
 * 4. Removes URL fragments (#hash).
 * 5. Removes trailing slashes from path, default ports (80/443).
 * 6. Generates a human-readable, database-safe businessKey (e.g. "biz_nspglobalservices_com").
 */
export function normalizeBusinessUrl(input: string): NormalizedUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Website URL cannot be empty.");
  }

  let withProto = trimmed;
  if (!/^https?:\/\//i.test(withProto)) {
    withProto = `https://${withProto}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new Error(`Invalid website URL format: "${input}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol "${parsed.protocol}". Expected http:// or https://`);
  }

  // 1. Normalize hostname: lowercase & strip 'www.'
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("www.")) {
    hostname = hostname.slice(4);
  }

  if (!hostname || !hostname.includes(".")) {
    throw new Error(`Invalid hostname: "${hostname}". A valid domain with TLD is required.`);
  }

  // 2. Clean query params
  const cleanParams = new URLSearchParams();
  for (const [key, value] of parsed.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (!TRACKING_QUERY_PARAMS.has(lowerKey) && !lowerKey.startsWith("utm_")) {
      cleanParams.set(key, value);
    }
  }

  // 3. Normalize path: strip trailing slash (except root)
  let cleanPath = parsed.pathname;
  if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
    cleanPath = cleanPath.slice(0, -1);
  }
  if (cleanPath === "/") {
    cleanPath = "";
  }

  const queryString = cleanParams.toString() ? `?${cleanParams.toString()}` : "";
  const canonicalUrl = `https://${hostname}${cleanPath}${queryString}`;

  // 4. Derive businessKey from canonical hostname (and clean subpath if a dedicated subsite)
  const hostSlug = hostname.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const businessKey = `biz_${hostSlug}`;

  return {
    originalUrl: trimmed,
    canonicalUrl,
    hostname,
    businessKey,
  };
}

