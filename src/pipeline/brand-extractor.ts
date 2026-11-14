import type { GeminiPipelineClient } from "../ai/client.js";
import {
  BrandProfileExtractionSchema,
  type BrandProfileExtraction,
} from "../ai/schemas.js";
import type { CrawlResult } from "./crawler.js";

/**
 * Extracts a structured, grounded brand profile from scraped website pages using Gemini.
 *
 * Implements strict prompt-injection defenses by wrapping all scraped HTML/text inside
 * untrusted XML enclosures and instructing the LLM to neutrally extract business attributes.
 */
export async function extractBrandProfileFromCrawl(params: {
  ai: GeminiPipelineClient;
  model: string;
  crawl: CrawlResult;
  canonicalUrl: string;
}): Promise<BrandProfileExtraction> {
  const { crawl, canonicalUrl, ai, model } = params;

  // Format all extracted pages into isolated content blocks
  const pageBlocks: string[] = [];

  pageBlocks.push(
    `=== HOMEPAGE (${crawl.homepage.url}) ===\n${crawl.homepage.extractedText}`,
  );

  for (const page of crawl.selectedPages) {
    pageBlocks.push(
      `=== SUBPAGE: ${page.pageCategory.toUpperCase()} (${page.url}) ===\n${page.extractedText}`,
    );
  }

  const combinedPagesText = pageBlocks.join("\n\n--------------------\n\n");

  const payload = {
    website_domain: canonicalUrl,
    pages_crawled_count: crawl.extractedPagesCount,
    untrusted_scraped_website_content: combinedPagesText,
  };

  const extraction = await ai.generateStructured({
    stage: "brand-extraction",
    provider: "gemini",
    model,
    promptName: "brand-extraction",
    inputPayload: payload,
    schema: BrandProfileExtractionSchema,
    maxOutputTokens: 2500,
    temperature: 0.15,
  });

  return extraction;
}

