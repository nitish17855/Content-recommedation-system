import { validateUrlForSsrf } from "./ssrf-guard.js";
import { normalizeBusinessUrl } from "./url-normalize.js";

export interface ScrapedPage {
  url: string;
  title: string;
  pageCategory: "homepage" | "offerings" | "about" | "industries" | "proof_or_pricing" | "general";
  anchorText: string;
  extractedText: string;
  selectionScore: number;
  selectionRationale: string;
  fetchStatus: "ok" | "failed" | "skipped";
}

export interface CrawlResult {
  homepage: ScrapedPage;
  selectedPages: ScrapedPage[];
  extractedPagesCount: number;
  allDiscoveredCount: number;
  warnings: string[];
}

interface DiscoveredLink {
  resolvedUrl: string;
  anchorText: string;
  context: "nav_header" | "main_content" | "footer" | "other";
  category: "offerings" | "about" | "industries" | "proof_or_pricing" | "general";
  score: number;
  rationale: string;
}

const MAX_PAGE_BYTES = 128 * 1024; // 128 KB
const PAGE_TIMEOUT_MS = 8000; // 8 seconds per page
const USER_AGENT = "Mozilla/5.0 (compatible; BrandIntelligenceBot/1.0; +https://nspglobalservices.com)";

const DISALLOWED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".zip", ".tar", ".gz", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".mp4", ".mp3", ".avi", ".mov", ".wav",
  ".css", ".js", ".mjs", ".xml", ".json", ".rss", ".atom",
]);

const EXCLUDED_PATH_KEYWORDS = [
  "/login", "/signin", "/sign-in", "/signup", "/sign-up", "/register",
  "/auth", "/oauth", "/cart", "/checkout", "/account", "/my-account",
  "/privacy", "/privacy-policy", "/terms", "/terms-of-service", "/tos",
  "/legal", "/disclaimer", "/cookies", "/cookie-policy", "/gdpr",
  "/accessibility", "/sitemap", "/search",
];

const PENALIZED_PATH_KEYWORDS = [
  "/blog", "/news", "/press", "/articles", "/posts", "/tag/",
  "/category/", "/author/", "/page/", "/events", "/webinars",
];

const CATEGORY_MATCHERS: Array<{
  category: "offerings" | "about" | "industries" | "proof_or_pricing";
  keywords: string[];
  baseWeight: number;
}> = [
  {
    category: "offerings",
    keywords: [
      "service", "services", "product", "products", "solution", "solutions",
      "feature", "features", "what we do", "what-we-do", "capabilities", "offerings", "platform",
    ],
    baseWeight: 100,
  },
  {
    category: "about",
    keywords: [
      "about", "about us", "about-us", "company", "who we are", "who-we-are", "our story", "our-story", "mission", "team", "overview",
    ],
    baseWeight: 90,
  },
  {
    category: "industries",
    keywords: [
      "industry", "industries", "use case", "use cases", "use-case", "use-cases", "sectors", "who we serve", "who-we-serve", "verticals",
    ],
    baseWeight: 80,
  },
  {
    category: "proof_or_pricing",
    keywords: [
      "case study", "case studies", "case-study", "case-studies", "customer", "customers", "client", "clients",
      "pricing", "plans", "how it works", "how-it-works", "portfolio", "results", "testimonials",
    ],
    baseWeight: 70,
  },
];

/**
 * Strips HTML tags, script, style, SVG blocks, and decodes HTML entities into clean readable prose.
 */
export function sanitizeHtmlText(html: string, maxChars = 12000): string {
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, " ") // Exclude repeated nav boilerplate
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, " ") // Exclude footer boilerplate
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, maxChars);
}

/**
 * Extracts page title and meta description.
 */
function extractPageMetadata(html: string): { title: string; description: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.replace(/<[^>]+>/g, "").trim() : "";

  const descMatch =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const description = descMatch ? descMatch[1]!.trim() : "";

  return { title, description };
}

/**
 * Safely fetches an HTML document over HTTP/HTTPS with:
 * - Pre-flight SSRF validation.
 * - Redirect hopping with SSRF check on every hop.
 * - 8s timeout.
 * - 128 KB byte limit.
 */
export async function safeFetchHtml(targetUrl: string, maxRedirects = 5): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  html?: string;
  error?: string;
}> {
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ssrf = await validateUrlForSsrf(currentUrl);
    if (!ssrf.safe) {
      return {
        ok: false,
        status: 400,
        finalUrl: currentUrl,
        error: `SSRF Blocked: ${ssrf.reason}`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timer);

      // Handle redirect status codes manually to inspect target IP before jumping
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return { ok: false, status: response.status, finalUrl: currentUrl, error: "Redirect without Location header." };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          finalUrl: currentUrl,
          error: `HTTP Error ${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        return {
          ok: false,
          status: response.status,
          finalUrl: currentUrl,
          error: `Unsupported content-type "${contentType}". Expected text/html.`,
        };
      }

      // Stream body up to 128 KB
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        return { ok: true, status: response.status, finalUrl: currentUrl, html: text.slice(0, MAX_PAGE_BYTES) };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalBytes += value.length;
          if (totalBytes >= MAX_PAGE_BYTES) {
            await reader.cancel();
            break;
          }
        }
      }

      const rawBuffer = Buffer.concat(chunks);
      const html = rawBuffer.toString("utf8");
      return { ok: true, status: response.status, finalUrl: currentUrl, html };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: 408,
        finalUrl: currentUrl,
        error: isAbort ? `Page fetch timed out after ${PAGE_TIMEOUT_MS}ms.` : String(err),
      };
    }
  }

  return { ok: false, status: 310, finalUrl: currentUrl, error: "Too many redirects (max 5)." };
}

/**
 * Extracts candidate navigation and content links from the homepage HTML.
 */
export function extractInternalLinks(homepageHtml: string, baseUrl: string): DiscoveredLink[] {
  const baseParsed = new URL(baseUrl);
  const baseHostname = baseParsed.hostname.toLowerCase().replace(/^www\./, "");

  // Match all anchors with attributes
  const anchorRegex = /<a\s+([^>]*?)href=["']([^"'#\s>]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const discoveredMap = new Map<string, DiscoveredLink>();

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(homepageHtml)) !== null) {
    const rawHref = match[2]?.trim();
    const rawAnchor = match[4]?.replace(/<[^>]+>/g, "").trim() || "";
    if (!rawHref) continue;

    // Reject non-http protocols
    if (/^(mailto:|tel:|javascript:|ftp:|data:|blob:)/i.test(rawHref)) {
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }

    // Reject different domains/subdomains (must match base hostname)
    const resolvedHostname = resolved.hostname.toLowerCase().replace(/^www\./, "");
    if (resolvedHostname !== baseHostname) {
      continue;
    }

    // Check file extension
    const pathnameLower = resolved.pathname.toLowerCase();
    const ext = pathnameLower.includes(".") ? pathnameLower.slice(pathnameLower.lastIndexOf(".")) : "";
    if (DISALLOWED_EXTENSIONS.has(ext)) {
      continue;
    }

    // Check excluded paths (auth, cart, legal)
    if (EXCLUDED_PATH_KEYWORDS.some((kw) => pathnameLower.includes(kw))) {
      continue;
    }

    // Clean canonical URL (strip query unless significant, strip trailing slash)
    let cleanPath = resolved.pathname;
    if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
      cleanPath = cleanPath.slice(0, -1);
    }
    const cleanUrl = `https://${resolvedHostname}${cleanPath === "/" ? "" : cleanPath}`;

    // Skip root homepage link itself
    const baseCleanUrl = `https://${baseHostname}${baseParsed.pathname.replace(/\/$/, "")}`;
    if (cleanUrl === baseCleanUrl || cleanUrl === `https://${baseHostname}`) {
      continue;
    }

    // Determine context (heuristic from position in HTML or attributes)
    const matchIndex = match.index;
    const surroundingSnippet = homepageHtml.slice(Math.max(0, matchIndex - 300), matchIndex + 300).toLowerCase();
    let context: DiscoveredLink["context"] = "other";
    if (surroundingSnippet.includes("<nav") || surroundingSnippet.includes("class=\"nav") || surroundingSnippet.includes("<header")) {
      context = "nav_header";
    } else if (surroundingSnippet.includes("<footer") || surroundingSnippet.includes("class=\"footer")) {
      context = "footer";
    } else if (surroundingSnippet.includes("<main") || surroundingSnippet.includes("<article")) {
      context = "main_content";
    }

    // Score link based on keywords in URL path and anchor text
    const textCorpus = `${pathnameLower.replace(/[/_-]/g, " ")} ${rawAnchor.toLowerCase()}`;
    let bestCategory: DiscoveredLink["category"] = "general";
    let highestScore = 10;
    let rationale = "General internal page";

    for (const cat of CATEGORY_MATCHERS) {
      let matchedKwCount = 0;
      for (const kw of cat.keywords) {
        if (textCorpus.includes(kw)) {
          matchedKwCount++;
        }
      }

      if (matchedKwCount > 0) {
        let score = cat.baseWeight + matchedKwCount * 15;
        if (context === "nav_header") score += 20;
        else if (context === "main_content") score += 10;
        else if (context === "footer") score += 5;

        // Path depth penalty (prefer top-level pages like /services over /services/archive/2021/item)
        const pathSegments = cleanPath.split("/").filter(Boolean);
        if (pathSegments.length > 2) {
          score -= (pathSegments.length - 2) * 8;
        }

        // Penalize blogs or news archives
        if (PENALIZED_PATH_KEYWORDS.some((kw) => pathnameLower.includes(kw))) {
          score -= 40;
        }

        if (score > highestScore) {
          highestScore = score;
          bestCategory = cat.category;
          rationale = `Matched ${cat.category} keywords (${matchedKwCount}) in context ${context}`;
        }
      }
    }

    if (!discoveredMap.has(cleanUrl) || (discoveredMap.get(cleanUrl)?.score ?? 0) < highestScore) {
      discoveredMap.set(cleanUrl, {
        resolvedUrl: cleanUrl,
        anchorText: rawAnchor || cleanPath,
        context,
        category: bestCategory,
        score: highestScore,
        rationale,
      });
    }
  }

  return Array.from(discoveredMap.values());
}

/**
 * Selects up to 4 diverse, high-value pages across different categories.
 */
export function selectDiverseCandidatePages(discovered: DiscoveredLink[], maxPages = 4): DiscoveredLink[] {
  const sorted = [...discovered].sort((a, b) => b.score - a.score);
  const selected: DiscoveredLink[] = [];
  const coveredCategories = new Set<string>();

  // Pass 1: Select the top candidate from each priority category
  const priorityCategories: Array<DiscoveredLink["category"]> = [
    "offerings",
    "about",
    "industries",
    "proof_or_pricing",
  ];

  for (const cat of priorityCategories) {
    if (selected.length >= maxPages) break;
    const match = sorted.find((link) => link.category === cat && !selected.some((s) => s.resolvedUrl === link.resolvedUrl));
    if (match) {
      selected.push(match);
      coveredCategories.add(cat);
    }
  }

  // Pass 2: Backfill remaining slots up to maxPages with the next highest-scoring candidates
  for (const link of sorted) {
    if (selected.length >= maxPages) break;
    if (!selected.some((s) => s.resolvedUrl === link.resolvedUrl)) {
      selected.push(link);
    }
  }

  return selected;
}

/**
 * Main bounded crawler for website-driven brand onboarding.
 *
 * 1. Safely fetches homepage (SSRF guarded, 8s timeout, 128KB ceiling).
 * 2. Extracts title, description, and clean text.
 * 3. Discovers internal links and scores them for business identity value.
 * 4. Selects up to 4 diverse candidate pages across categories.
 * 5. Safely fetches candidates (concurrency: max 3).
 * 6. Returns structured ScrapedPage records for the brand extractor.
 */
export async function crawlBusinessWebsite(rawInputUrl: string): Promise<CrawlResult> {
  const normalized = normalizeBusinessUrl(rawInputUrl);
  const warnings: string[] = [];

  // 1. Fetch Homepage
  const homepageFetch = await safeFetchHtml(normalized.canonicalUrl);
  if (!homepageFetch.ok || !homepageFetch.html) {
    throw new Error(`Failed to crawl homepage ${normalized.canonicalUrl}: ${homepageFetch.error || "Unknown error"}`);
  }

  const hpMeta = extractPageMetadata(homepageFetch.html);
  const hpText = sanitizeHtmlText(homepageFetch.html);

  if (hpText.length < 50) {
    warnings.push("Homepage contains very little text content. Information extraction may be limited.");
  }

  const homepageRecord: ScrapedPage = {
    url: homepageFetch.finalUrl,
    title: hpMeta.title || normalized.hostname,
    pageCategory: "homepage",
    anchorText: "Home",
    extractedText: `[Page: Homepage]\nTitle: ${hpMeta.title}\nDescription: ${hpMeta.description}\n\n${hpText}`,
    selectionScore: 1000,
    selectionRationale: "Root business homepage",
    fetchStatus: "ok",
  };

  // 2. Discover internal links
  const discoveredLinks = extractInternalLinks(homepageFetch.html, homepageFetch.finalUrl);
  const chosenLinks = selectDiverseCandidatePages(discoveredLinks, 4);

  // 3. Concurrently fetch selected subpages (in chunks of 3)
  const selectedPages: ScrapedPage[] = [];
  const concurrency = 3;

  for (let i = 0; i < chosenLinks.length; i += concurrency) {
    const batch = chosenLinks.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (candidate): Promise<ScrapedPage> => {
        const fetchRes = await safeFetchHtml(candidate.resolvedUrl);
        if (!fetchRes.ok || !fetchRes.html) {
          return {
            url: candidate.resolvedUrl,
            title: candidate.anchorText,
            pageCategory: candidate.category,
            anchorText: candidate.anchorText,
            extractedText: "",
            selectionScore: candidate.score,
            selectionRationale: candidate.rationale,
            fetchStatus: "failed",
          };
        }

        const meta = extractPageMetadata(fetchRes.html);
        const text = sanitizeHtmlText(fetchRes.html);

        return {
          url: fetchRes.finalUrl,
          title: meta.title || candidate.anchorText,
          pageCategory: candidate.category,
          anchorText: candidate.anchorText,
          extractedText: `[Page: ${candidate.category.toUpperCase()}]\nTitle: ${meta.title}\nDescription: ${meta.description}\n\n${text}`,
          selectionScore: candidate.score,
          selectionRationale: candidate.rationale,
          fetchStatus: "ok",
        };
      }),
    );

    for (const r of results) {
      if (r.fetchStatus === "ok" && r.extractedText.length > 40) {
        selectedPages.push(r);
      } else {
        warnings.push(`Subpage ${r.url} returned insufficient text or failed to fetch.`);
      }
    }
  }

  return {
    homepage: homepageRecord,
    selectedPages,
    extractedPagesCount: 1 + selectedPages.length,
    allDiscoveredCount: discoveredLinks.length,
    warnings,
  };
}
