import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

describe("End-to-End Server REST & SSE Endpoints Suite", () => {
  const testPort = 3399;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  before(async () => {
    process.env.PORT = String(testPort);
    // Dynamically import server to bind to testPort
    await import("../src/web/server.js");
    // Wait briefly for server to bind
    await new Promise((resolve) => setTimeout(resolve, 800));
  });

  after(async () => {
    setTimeout(() => {
      process.exit(0);
    }, 200).unref();
  });

  it("serves the modern web UI on GET / with 200 OK and UTF-8 HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const html = await res.text();
    assert.ok(html.includes("Autonomous Content Intelligence Platform"));
    assert.ok(html.includes("websiteUrlInput"));
    assert.ok(html.includes("stepperGrid"));
    assert.ok(html.includes("brandProfileBanner"));
  });

  it("returns dashboard snapshot on GET /api/dashboard with valid JSON", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.recentRuns !== undefined);
    assert.ok(Array.isArray(json.recommendations));
  });

  it("rejects invalid or missing URL on POST /api/recommendations/start with 400", async () => {
    const res = await fetch(`${baseUrl}/api/recommendations/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-valid-url" }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error);
  });

  it("claims or starts run and returns runId on POST /api/recommendations/start", async () => {
    const res = await fetch(`${baseUrl}/api/recommendations/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.nspglobalservices.com/" }),
    });
    // Can be 200 (if active run was reused) or 202 (if newly started)
    assert.ok([200, 202].includes(res.status));
    const json = await res.json();
    assert.ok(json.runId > 0);
    assert.equal(json.status, "running");
    assert.ok(typeof json.reused === "boolean");
    assert.ok(json.brandId > 0);
    assert.equal(json.businessKey, "biz_nspglobalservices_com");

    // Check status endpoint
    const statusRes = await fetch(`${baseUrl}/api/recommendations/status?runId=${json.runId}`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.runId, json.runId);
    assert.ok(statusJson.stages);
    assert.ok(statusJson.overallStatus);

    // Check brand details endpoint
    const brandRes = await fetch(`${baseUrl}/api/brand/details?brandId=${json.brandId}`);
    assert.equal(brandRes.status, 200);
    const brandJson = await brandRes.json();
    assert.equal(brandJson.brand.id, json.brandId);
    assert.ok(Array.isArray(brandJson.services));
    assert.ok(Array.isArray(brandJson.competitors));
  });

  it("opens SSE stream on GET /api/recommendations/stream and receives heartbeat or progress", async () => {
    // Start or reuse a run to get an active runId
    const startRes = await fetch(`${baseUrl}/api/recommendations/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.nspglobalservices.com/" }),
    });
    const { runId } = await startRes.json();

    const controller = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/recommendations/stream?runId=${runId}`, {
      signal: controller.signal,
    });

    assert.equal(streamRes.status, 200);
    assert.ok(streamRes.headers.get("content-type")?.includes("text/event-stream"));

    const reader = streamRes.body?.getReader();
    assert.ok(reader);

    // Read first chunk
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const text = new TextDecoder().decode(value);
    assert.ok(text.length > 0);
    assert.ok(text.includes("event: progress") || text.includes(": heartbeat") || text.includes("data:"));

    // Close stream
    controller.abort();
  });
});
