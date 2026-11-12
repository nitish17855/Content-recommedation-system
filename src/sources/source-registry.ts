import type { SourceConfig } from "../ai/schemas.js";

export const SOURCE_REGISTRY: SourceConfig[] = [
  {
    id: "google-search-central",
    name: "Google Search Central Blog",
    feedUrl: "https://developers.google.com/search/blog/feed.xml",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 25,
  },
  {
    id: "google-ads-dev",
    name: "Google Ads Developer Blog",
    feedUrl: "https://developers.google.com/ads/blog/rss.xml",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 25,
  },
  {
    id: "et-brandequity-marketing",
    name: "ET BrandEquity Marketing",
    feedUrl: "https://brandequity.economictimes.indiatimes.com/rss/marketing",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 30,
  },
  {
    id: "inc42",
    name: "Inc42",
    feedUrl: "https://inc42.com/feed/",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 30,
  },
  // Expansion feeds — enabled in Step 6
  {
    id: "seroundtable",
    name: "Search Engine Roundtable",
    feedUrl: "https://www.seroundtable.com/index.xml",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 25,
  },
  {
    id: "et-brandequity-digital",
    name: "ET BrandEquity Digital",
    feedUrl: "https://brandequity.economictimes.indiatimes.com/rss/digital",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 25,
  },
];

export function getEnabledSources(registry: SourceConfig[] = SOURCE_REGISTRY): SourceConfig[] {
  return registry.filter((s) => s.enabled);
}

