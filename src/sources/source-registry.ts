import type { SourceConfig } from "../ai/schemas.js";

/**
 * Multi-category zero-cost public discovery feeds covering all 6 NSP intelligence categories:
 * 1. New tools & product launches (OpenAI, Google, Shopify, Meta, Canva, Adobe)
 * 2. Customer discovery changes (Google Search, AI search/shopping)
 * 3. Marketing & advertising developments (Google Ads, Meta Ads, social formats)
 * 4. Competitor & brand campaigns (Indian agencies + brand marketing)
 * 5. Industry & business developments (Inc42, AI business in India)
 * 6. Cultural & emerging conversations (Google Trends India + festive/brand culture)
 */
export const SOURCE_REGISTRY: SourceConfig[] = [
  {
    id: "google-search-central",
    name: "Google Search Central Blog",
    feedUrl: "https://developers.google.com/search/blog/feed.xml",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "google-ads-dev",
    name: "Google Ads Developer Blog",
    feedUrl: "https://developers.google.com/ads/blog/rss.xml",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "google-official-blog",
    name: "Google Official Blog",
    feedUrl: "https://blog.google/rss/",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "openai-news",
    name: "OpenAI News",
    feedUrl: "https://openai.com/news/rss.xml",
    sourceType: "official_platform",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "platforms-commerce-india",
    name: "Google News India — Platforms & Commerce",
    feedUrl:
      "https://news.google.com/rss/search?q=(Shopify+OR+%22Meta+Ads%22+OR+Canva+OR+Adobe+OR+WhatsApp)+business+India+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "ai-business-india",
    name: "Google News India — AI & Business Tools",
    feedUrl:
      "https://news.google.com/rss/search?q=(ChatGPT+OR+Gemini+OR+%22Google+Ads%22+OR+AI)+business+India+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "competitors-india",
    name: "Google News India — Agency & Competitor Watch",
    feedUrl:
      "https://news.google.com/rss/search?q=(PageTraffic+OR+Techmagnate+OR+GrowthSpree+OR+Wildnet+OR+%22digital+marketing+agency%22+OR+%22marketing+campaign%22)+India+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "competitor_blog",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "google-trends-india",
    name: "Google Trends India",
    feedUrl: "https://trends.google.com/trending/rss?geo=IN",
    sourceType: "google_trends",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "et-brandequity-marketing",
    name: "ET BrandEquity Marketing",
    feedUrl: "https://brandequity.economictimes.indiatimes.com/rss/marketing",
    sourceType: "industry_news",
    geoScope: "india",
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
  {
    id: "inc42",
    name: "Inc42",
    feedUrl: "https://inc42.com/feed/",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 25,
  },
  {
    id: "yourstory",
    name: "YourStory India Startups & Business",
    feedUrl: "https://yourstory.com/feed",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "techcrunch",
    name: "TechCrunch AI & Tech Launches",
    feedUrl: "https://techcrunch.com/feed/",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "et-retail-ecommerce",
    name: "ET Retail — E-Commerce & D2C India",
    feedUrl: "https://retail.economictimes.indiatimes.com/rss/e-commerce",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "social-platforms-india",
    name: "Google News India — Social Platforms & Creators",
    feedUrl:
      "https://news.google.com/rss/search?q=(Instagram+OR+YouTube+OR+LinkedIn+OR+WhatsApp)+(%22new+feature%22+OR+creators+OR+marketing)+India+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "india-d2c-brand-campaigns",
    name: "Google News India — D2C & Brand Campaigns",
    feedUrl:
      "https://news.google.com/rss/search?q=(D2C+OR+Zomato+OR+Blinkit+OR+Zepto+OR+Shopify+OR+ecommerce)+(campaign+OR+launch+OR+growth)+India+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "competitor_blog",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "seroundtable",
    name: "Search Engine Roundtable",
    feedUrl: "https://www.seroundtable.com/index.xml",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "social-media-examiner",
    name: "Social Media Examiner",
    feedUrl: "https://www.socialmediaexaminer.com/feed/",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 15,
  },
  {
    id: "saastr",
    name: "SaaStr B2B SaaS & Growth",
    feedUrl: "https://www.saastr.com/feed/",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 15,
  },
  {
    id: "techcrunch-enterprise",
    name: "TechCrunch Enterprise & B2B Software",
    feedUrl: "https://techcrunch.com/category/enterprise/feed/",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "b2b-saas-news",
    name: "Google News — B2B SaaS & Enterprise Cloud",
    feedUrl:
      "https://news.google.com/rss/search?q=(SaaS+OR+%22B2B+software%22+OR+%22cloud+software%22)+(India+OR+global)+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "industry_news",
    geoScope: "india",
    enabled: true,
    maxItems: 20,
  },
  {
    id: "saas-growth-plg",
    name: "Google News — SaaS Growth, PLG & Metrics",
    feedUrl:
      "https://news.google.com/rss/search?q=(%22product-led+growth%22+OR+%22customer+acquisition%22+OR+churn+OR+pricing)+SaaS+when:14d&hl=en-IN&gl=IN&ceid=IN:en",
    sourceType: "industry_news",
    geoScope: "global",
    enabled: true,
    maxItems: 20,
  },
];

export function getEnabledSources(registry: SourceConfig[] = SOURCE_REGISTRY): SourceConfig[] {
  return registry.filter((s) => s.enabled);
}
