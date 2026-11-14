import {
  extractInternalLinks,
  sanitizeHtmlText,
  selectDiverseCandidatePages,
} from "../src/pipeline/crawler.js";
import { isPrivateIPv4, isPrivateIPv6, validateUrlForSsrf } from "../src/pipeline/ssrf-guard.js";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

async function runAll() {
  console.log("=== Testing Slice 2 Crawler, SSRF Guard & Link Discovery ===");

  // 1. SSRF Guard Unit Tests
  console.log("\n[Test 1] Testing SSRF Guard on Private & Cloud Metadata IPs...");
  {
    assert(isPrivateIPv4("127.0.0.1"), "127.0.0.1 must be private");
    assert(isPrivateIPv4("127.10.0.5"), "127.* must be private");
    assert(isPrivateIPv4("10.0.1.20"), "10.0.0.0/8 must be private");
    assert(isPrivateIPv4("192.168.1.1"), "192.168.0.0/16 must be private");
    assert(isPrivateIPv4("172.16.5.1"), "172.16.0.0/12 must be private");
    assert(isPrivateIPv4("169.254.169.254"), "AWS metadata IP must be private");
    assert(isPrivateIPv4("0.0.0.0"), "0.0.0.0 must be private");
    assert(!isPrivateIPv4("8.8.8.8"), "8.8.8.8 must be public");
    assert(!isPrivateIPv4("104.26.10.230"), "Cloudflare IP must be public");

    assert(isPrivateIPv6("::1"), "::1 loopback must be private");
    assert(isPrivateIPv6("fe80::1"), "Link-local IPv6 must be private");
    assert(isPrivateIPv6("fc00::1"), "Unique local IPv6 must be private");
    console.log("✓ IPv4 and IPv6 range checker passed");
  }

  // 2. Dangerous URLs SSRF Guard Tests
  console.log("\n[Test 2] Testing validateUrlForSsrf on dangerous target URLs...");
  {
    const badUrls = [
      "http://127.0.0.1:3000/api/dashboard",
      "http://localhost:8080",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/secret",
      "ftp://ftp.example.com/file.txt",
      "gopher://example.com/",
      "http://192.168.1.100/admin",
      "http://example.com:8443/custom-port",
    ];

    for (const url of badUrls) {
      const res = await validateUrlForSsrf(url);
      assert(!res.safe, `URL "${url}" MUST be blocked by SSRF guard! Reason: ${res.reason}`);
      console.log(`  ✓ Blocked dangerous URL: ${url} (${res.reason})`);
    }

    const safeRes = await validateUrlForSsrf("https://www.google.com");
    assert(safeRes.safe, "google.com must be allowed");
    console.log("  ✓ Allowed public URL: https://www.google.com");
  }

  // 3. Link Extraction: Conventional Corporate Website
  console.log("\n[Test 3] Testing Link Extraction on Conventional Corporate Site...");
  {
    const mockHtml = `
      <html>
        <head><title>Acme Corp</title></head>
        <body>
          <header>
            <nav>
              <a href="/about">About Us</a>
              <a href="/services">Our Services</a>
              <a href="/pricing">Pricing Plans</a>
              <a href="/case-studies">Customer Case Studies</a>
              <a href="/login">Customer Login</a>
              <a href="/terms">Terms of Service</a>
              <a href="https://twitter.com/acme">Twitter</a>
              <a href="/brochure.pdf">Download Brochure</a>
            </nav>
          </header>
          <main>
            <h1>Welcome to Acme</h1>
            <p>We build software.</p>
          </main>
        </body>
      </html>
    `;

    const links = extractInternalLinks(mockHtml, "https://acme.com");
    const urls = links.map((l) => l.resolvedUrl);

    assert(urls.includes("https://acme.com/about"), "Must extract /about");
    assert(urls.includes("https://acme.com/services"), "Must extract /services");
    assert(urls.includes("https://acme.com/pricing"), "Must extract /pricing");
    assert(urls.includes("https://acme.com/case-studies"), "Must extract /case-studies");

    assert(!urls.includes("https://acme.com/login"), "Must reject /login");
    assert(!urls.includes("https://acme.com/terms"), "Must reject /terms");
    assert(!urls.some((u) => u.includes("twitter.com")), "Must reject external twitter.com");
    assert(!urls.some((u) => u.endsWith(".pdf")), "Must reject .pdf");

    console.log(`✓ Conventional links extracted (${links.length} valid internal links)`);
  }

  // 4. Link Extraction: Unconventional Paths (/what-we-do, /who-we-are)
  console.log("\n[Test 4] Testing Unconventional Paths (/what-we-do, /who-we-are)...");
  {
    const mockHtml = `
      <header class="nav-bar">
        <a href="/what-we-do">What We Do</a>
        <a href="/who-we-are">Who We Are</a>
        <a href="/our-clients">Our Clients &amp; Work</a>
        <a href="/sectors/healthcare">Healthcare Sector</a>
      </header>
    `;

    const links = extractInternalLinks(mockHtml, "https://agency.co");
    const whatWeDo = links.find((l) => l.resolvedUrl === "https://agency.co/what-we-do");
    const whoWeAre = links.find((l) => l.resolvedUrl === "https://agency.co/who-we-are");
    const clients = links.find((l) => l.resolvedUrl === "https://agency.co/our-clients");
    const sectors = links.find((l) => l.resolvedUrl === "https://agency.co/sectors/healthcare");

    assert(whatWeDo?.category === "offerings", "what-we-do should categorize as offerings");
    assert(whoWeAre?.category === "about", "who-we-are should categorize as about");
    assert(clients?.category === "proof_or_pricing", "our-clients should categorize as proof_or_pricing");
    assert(sectors?.category === "industries", "sectors should categorize as industries");

    console.log("✓ Unconventional paths correctly categorized into business categories");
  }

  // 5. Page Diversity Selection
  console.log("\n[Test 5] Testing Page Diversity Selection...");
  {
    const mockLinks = [
      { resolvedUrl: "https://x.com/services/seo", anchorText: "SEO", context: "nav_header" as const, category: "offerings" as const, score: 120, rationale: "" },
      { resolvedUrl: "https://x.com/services/ppc", anchorText: "PPC", context: "nav_header" as const, category: "offerings" as const, score: 110, rationale: "" },
      { resolvedUrl: "https://x.com/services/cro", anchorText: "CRO", context: "nav_header" as const, category: "offerings" as const, score: 105, rationale: "" },
      { resolvedUrl: "https://x.com/about-us", anchorText: "About", context: "nav_header" as const, category: "about" as const, score: 95, rationale: "" },
      { resolvedUrl: "https://x.com/industries/fintech", anchorText: "Fintech", context: "nav_header" as const, category: "industries" as const, score: 85, rationale: "" },
      { resolvedUrl: "https://x.com/case-studies", anchorText: "Case Studies", context: "nav_header" as const, category: "proof_or_pricing" as const, score: 80, rationale: "" },
    ];

    const diverse = selectDiverseCandidatePages(mockLinks, 4);
    const categories = diverse.map((d) => d.category);

    assert(diverse.length === 4, "Must select exactly 4 diverse pages");
    assert(categories.includes("offerings"), "Must include offerings");
    assert(categories.includes("about"), "Must include about");
    assert(categories.includes("industries"), "Must include industries");
    assert(categories.includes("proof_or_pricing"), "Must include proof_or_pricing");
    const offeringCount = categories.filter((c) => c === "offerings").length;
    assert(offeringCount === 1, `Expected 1 offering page for diversity, got ${offeringCount}`);

    console.log("✓ Page diversity algorithm selected 4 distinct categories:", categories.join(", "));
  }

  // 6. HTML Sanitizer & Text Cleanup
  console.log("\n[Test 6] Testing HTML Sanitizer & Content Isolation...");
  {
    const dirtyHtml = `
      <html>
        <head>
          <script>alert("ignore");</script>
          <style>.hide { display:none; }</style>
        </head>
        <body>
          <nav><a href="/">Home</a></nav>
          <main>
            <h1>Leading Global B2B SaaS Platform</h1>
            <p>We accelerate revenue pipeline for &amp; enterprise &lt;growth&gt; teams.</p>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const clean = sanitizeHtmlText(dirtyHtml);
    assert(!clean.includes("alert"), "Must strip scripts");
    assert(!clean.includes("display:none"), "Must strip styles");
    assert(clean.includes("Leading Global B2B SaaS Platform"), "Must preserve H1 text");
    assert(clean.includes("pipeline for & enterprise <growth> teams"), "Must decode entities &amp; and &lt;");

    console.log("✓ HTML sanitized cleanly:", clean.slice(0, 70), "...");
  }

  console.log("\n🎉 ALL CRAWLER & SSRF GUARD TESTS PASSED SUCCESSFULLY!");
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
