import { normalizeBusinessUrl } from "../src/pipeline/url-normalize.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

console.log("=== Testing URL Normalization & Business Key Resolution ===");

// 1. Basic www stripping and https enforcement
{
  const res = normalizeBusinessUrl("www.nspglobalservices.com");
  assert(res.hostname === "nspglobalservices.com", "Should strip www.");
  assert(res.canonicalUrl === "https://nspglobalservices.com", "Should enforce https://");
  assert(res.businessKey === "biz_nspglobalservices_com", "Should derive correct businessKey");
  console.log("✓ www.nspglobalservices.com ->", res.canonicalUrl, res.businessKey);
}

// 2. Trailing slash and protocol handling
{
  const res = normalizeBusinessUrl("https://nspglobalservices.com/");
  assert(res.canonicalUrl === "https://nspglobalservices.com", "Should strip trailing slash from root domain");
  assert(res.businessKey === "biz_nspglobalservices_com", "businessKey must match");
  console.log("✓ https://nspglobalservices.com/ ->", res.canonicalUrl);
}

// 3. Tracking query parameter stripping
{
  const res = normalizeBusinessUrl(
    "https://www.example.com/pricing/?utm_source=twitter&utm_medium=cpc&ref=producthunt#details"
  );
  assert(res.hostname === "example.com", "Should strip www");
  assert(res.canonicalUrl === "https://example.com/pricing", "Should strip utm_*, ref, and fragment");
  assert(res.businessKey === "biz_example_com", "Should derive biz_example_com");
  console.log("✓ URL with tracking parameters ->", res.canonicalUrl, res.businessKey);
}

// 4. Legitimate subdomains preservation
{
  const res = normalizeBusinessUrl("https://app.slack.com/");
  assert(res.hostname === "app.slack.com", "Should preserve legitimate subdomain");
  assert(res.canonicalUrl === "https://app.slack.com", "Should preserve subdomain in canonicalUrl");
  assert(res.businessKey === "biz_app_slack_com", "Should derive distinct businessKey for subdomain");
  console.log("✓ Subdomain ->", res.canonicalUrl, res.businessKey);
}

// 5. Invariant equivalence across user input variations
{
  const v1 = normalizeBusinessUrl("nspglobalservices.com");
  const v2 = normalizeBusinessUrl("http://www.nspglobalservices.com/");
  const v3 = normalizeBusinessUrl("https://nspglobalservices.com/?utm_source=linkedin");

  assert(v1.canonicalUrl === v2.canonicalUrl, "v1 and v2 canonical URLs must match");
  assert(v2.canonicalUrl === v3.canonicalUrl, "v2 and v3 canonical URLs must match");
  assert(v1.businessKey === v2.businessKey && v2.businessKey === v3.businessKey, "All businessKeys must be identical");
  console.log("✓ Invariant equivalence passed for all NSP URL variations:", v1.businessKey);
}

// 6. Validation error handling
{
  let failed = false;
  try {
    normalizeBusinessUrl("not-a-domain");
  } catch {
    failed = true;
  }
  assert(failed, "Invalid domain without dot must throw");
  console.log("✓ Invalid domain rejected cleanly");
}

console.log("\nAll URL normalization tests PASSED successfully!");

