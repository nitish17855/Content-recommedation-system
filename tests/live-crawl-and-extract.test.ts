import { crawlBusinessWebsite } from "../src/pipeline/crawler.js";
import { extractBrandProfileFromCrawl } from "../src/pipeline/brand-extractor.js";
import { GeminiPipelineClient } from "../src/ai/client.js";
import { loadEnv } from "../src/config/env.js";

async function testLiveExtraction() {
  console.log("=== Testing Live Website Crawl & Gemini Brand Profile Extraction ===");
  const env = loadEnv();
  const testUrl = "https://www.nspglobalservices.com/";

  console.log(`[Crawler] Crawling ${testUrl}...`);
  const crawl = await crawlBusinessWebsite(testUrl);

  console.log(`✓ Crawl Complete:`);
  console.log(`  - Homepage Title: "${crawl.homepage.title}"`);
  console.log(`  - Subpages Selected: ${crawl.selectedPages.length}`);
  for (const page of crawl.selectedPages) {
    console.log(`    * [${page.pageCategory}] ${page.url} (${page.title})`);
  }

  console.log(`\n[AI Extractor] Running Gemini Brand Extraction...`);
  const ai = new GeminiPipelineClient(env);
  const extraction = await extractBrandProfileFromCrawl({
    ai,
    model: env.GEMINI_MODEL_LIGHT,
    crawl,
    canonicalUrl: "https://nspglobalservices.com",
  });

  console.log(`\n✓ Extracted Brand Profile:`);
  console.log(`  - Brand Name: "${extraction.brand_name}"`);
  console.log(`  - Industry: "${extraction.industry}" (${extraction.business_model})`);
  console.log(`  - Value Proposition: "${extraction.value_proposition}"`);
  console.log(`  - Core Offerings Count: ${extraction.core_offerings.length}`);
  for (const off of extraction.core_offerings.slice(0, 5)) {
    console.log(`    * [${off.service_id}] ${off.name} (${off.category})`);
  }
  console.log(`  - Target Audiences: ${extraction.target_audiences.join(" | ")}`);
  console.log(`  - Customer Pain Points: ${extraction.customer_pain_points.slice(0, 3).join(" | ")}`);
  console.log(`  - Verified Differentiators: ${extraction.verified_differentiators.slice(0, 3).join(" | ")}`);

  console.log("\n🎉 Live Crawl & Gemini Brand Extraction PASSED successfully!");
}

testLiveExtraction().catch((err) => {
  console.error("Live extraction test failed:", err);
  process.exit(1);
});

