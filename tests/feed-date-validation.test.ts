import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFeedDate,
  buildNormalizedEntry,
  getDaysInMonth,
} from "../src/pipeline/feed-date-parser.js";
import {
  parseFeedXml,
  evaluateFeedActivity,
} from "../src/pipeline/source-validator.js";

describe("Slice 3 — Date Normalization and Graded Activity Validation", () => {
  const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");

  // Helper to make an ISO string relative to FIXED_NOW
  function daysAgoIso(days: number): string {
    return new Date(FIXED_NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  // 1. Valid RSS RFC-style publication date
  it("1. parses valid RSS RFC 822/2822 publication dates into UTC ISO", () => {
    const res = parseFeedDate("Mon, 02 Jan 2006 15:04:05 GMT", FIXED_NOW);
    assert.equal(res.status, "valid");
    assert.equal(res.iso, "2006-01-02T15:04:05.000Z");

    const resTz = parseFeedDate("02 Jan 2006 15:04:05 EST", FIXED_NOW);
    assert.equal(resTz.status, "valid");
    assert.equal(resTz.iso, "2006-01-02T20:04:05.000Z");

    // Ambiguous abbreviation without numeric offset must be rejected
    const resAmbiguous = parseFeedDate("02 Jan 2006 15:04:05 IST", FIXED_NOW);
    assert.equal(resAmbiguous.status, "invalid");

    // Unambiguous numeric offset for same region must be accepted
    const resNumeric = parseFeedDate("02 Jan 2006 15:04:05 +0530", FIXED_NOW);
    assert.equal(resNumeric.status, "valid");
    assert.equal(resNumeric.iso, "2006-01-02T09:34:05.000Z");
  });

  // 2. Valid Atom RFC 3339 publication and update dates
  it("2. parses valid Atom RFC 3339 publication and update dates with precedence", () => {
    const pubIso = daysAgoIso(5);
    const updIso = daysAgoIso(2);
    const entry = buildNormalizedEntry({
      title: "Atom Entry",
      url: "https://example.com/post-1",
      entryId: "tag:example.com,2026:post-1",
      publisher: "TechCrunch",
      rawPublished: pubIso,
      rawUpdated: updIso,
      now: FIXED_NOW,
    });

    assert.equal(entry.dateStatus, "valid");
    assert.equal(entry.publishedAt, pubIso);
    assert.equal(entry.updatedAt, updIso);
    assert.equal(entry.activityAt, pubIso);
    assert.equal(entry.activityBasis, "published");
  });

  // 3. RSS extension date fields (dc:date, atom:updated)
  it("3. supports RSS extension date fields (dc:date and atom:updated)", () => {
    const xml = `
      <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
        <channel>
          <title>Extension Feed</title>
          <item>
            <title>Extension Item</title>
            <link>https://example.com/item-ext</link>
            <dc:date>2026-03-10T10:00:00Z</dc:date>
            <atom:updated>2026-03-11T12:00:00Z</atom:updated>
          </item>
        </channel>
      </rss>
    `;
    const parsed = parseFeedXml(xml, "Extension Pub", FIXED_NOW);
    assert.equal(parsed.entries.length, 1);
    const entry = parsed.entries[0]!;
    assert.equal(entry.dateStatus, "valid");
    assert.equal(entry.publishedAt, "2026-03-10T10:00:00.000Z");
    assert.equal(entry.updatedAt, "2026-03-11T12:00:00.000Z");
    assert.equal(entry.activityBasis, "published");
  });

  // 4. Missing publication date with valid update date
  it("4. handles missing publication date with valid update date (distinguishable basis)", () => {
    const updIso = daysAgoIso(3);
    const entry = buildNormalizedEntry({
      title: "Updated Only",
      url: "https://example.com/post-upd",
      entryId: "post-upd",
      publisher: "Release Notes",
      rawPublished: null,
      rawUpdated: updIso,
      now: FIXED_NOW,
    });

    assert.equal(entry.dateStatus, "valid");
    assert.equal(entry.publishedAt, null);
    assert.equal(entry.updatedAt, updIso);
    assert.equal(entry.activityAt, updIso);
    assert.equal(entry.activityBasis, "updated");
  });

  // 5. Missing both dates
  it("5. handles missing both dates (marks missing, unknown basis)", () => {
    const entry = buildNormalizedEntry({
      title: "Undated Item",
      url: "https://example.com/undated",
      entryId: "undated-1",
      publisher: "Static Site",
      rawPublished: null,
      rawUpdated: null,
      now: FIXED_NOW,
    });

    assert.equal(entry.dateStatus, "missing");
    assert.equal(entry.publishedAt, null);
    assert.equal(entry.updatedAt, null);
    assert.equal(entry.activityAt, null);
    assert.equal(entry.activityBasis, "unknown");
  });

  // 6. Malformed date
  it("6. flags malformed date string as invalid", () => {
    const res = parseFeedDate("not-a-real-date-string", FIXED_NOW);
    assert.equal(res.status, "invalid");
    assert.equal(res.iso, null);

    const entry = buildNormalizedEntry({
      title: "Malformed Item",
      url: "https://example.com/bad-date",
      entryId: "bad-1",
      publisher: "Blog",
      rawPublished: "corrupted_timestamp_value",
      now: FIXED_NOW,
    });
    assert.equal(entry.dateStatus, "invalid");
    assert.equal(entry.activityBasis, "unknown");
  });

  // 7. Invalid calendar date (e.g. Feb 31)
  it("7. strictly rejects invalid calendar dates without silent month rollover", () => {
    assert.equal(getDaysInMonth(2024, 2), 29); // Leap year
    assert.equal(getDaysInMonth(2023, 2), 28); // Non-leap year

    const feb31Rfc = parseFeedDate("31 Feb 2024 12:00:00 GMT", FIXED_NOW);
    assert.equal(feb31Rfc.status, "invalid");
    assert.match(feb31Rfc.reason ?? "", /Invalid calendar day 31 for month 2\/2024/);

    const apr31Iso = parseFeedDate("2026-04-31T12:00:00Z", FIXED_NOW);
    assert.equal(apr31Iso.status, "invalid");
    assert.match(apr31Iso.reason ?? "", /Invalid calendar day 31 for month 4\/2026/);
  });

  // 8. Different timezone offsets representing the same instant
  it("8. normalizes different timezone offsets to identical UTC ISO timestamps", () => {
    const utcRes = parseFeedDate("2026-03-10T14:30:00Z", FIXED_NOW);
    const istRes = parseFeedDate("2026-03-10T20:00:00+05:30", FIXED_NOW);
    const edtRes = parseFeedDate("2026-03-10T10:30:00-04:00", FIXED_NOW);

    assert.equal(utcRes.status, "valid");
    assert.equal(istRes.status, "valid");
    assert.equal(edtRes.status, "valid");
    assert.equal(utcRes.iso, "2026-03-10T14:30:00.000Z");
    assert.equal(istRes.iso, "2026-03-10T14:30:00.000Z");
    assert.equal(edtRes.iso, "2026-03-10T14:30:00.000Z");
  });

  // 9. Future timestamps
  it("9. rejects implausible future timestamps beyond the allowed 24h clock-skew window", () => {
    const futureDate = new Date(FIXED_NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const res = parseFeedDate(futureDate, FIXED_NOW);
    assert.equal(res.status, "invalid");
    assert.match(res.reason ?? "", /Implausible future timestamp/);
  });

  // 10. Old publication date with recent update
  it("10. preserves old publication date when recent update occurs (does not make old article appear newly published)", () => {
    const pubIso = daysAgoIso(60); // 60 days ago
    const updIso = daysAgoIso(2);  // 2 days ago

    const entry = buildNormalizedEntry({
      title: "Changelog Article",
      url: "https://example.com/old-with-update",
      entryId: "old-1",
      publisher: "Docs",
      rawPublished: pubIso,
      rawUpdated: updIso,
      now: FIXED_NOW,
    });

    assert.equal(entry.activityBasis, "published");
    assert.equal(entry.activityAt, pubIso);

    // Evaluate in feed activity:
    const evalRes = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: "Changelog",
      feedType: "rss",
      entries: [entry],
      now: FIXED_NOW,
    });

    // Published 60 days ago -> published counts for 14d and 30d MUST be 0!
    assert.equal(evalRes.counts.recentPublishedCount14d, 0);
    assert.equal(evalRes.counts.recentPublishedCount30d, 0);
    // Updated 2 days ago -> update count for 14d MUST be 1
    assert.equal(evalRes.counts.recentUpdatedCount14d, 1);
    // Graded status: should be "degraded" (recent update without new publications), NOT "valid"
    assert.equal(evalRes.status, "degraded");
  });

  // 11. Multiple entries with duplicate URLs
  it("11. deduplicates multiple entries sharing the same URL", () => {
    const xml = `
      <rss version="2.0">
        <channel>
          <title>Duplicate Feed</title>
          <item>
            <title>Duplicated Article</title>
            <link>https://example.com/post-dup?utm_source=rss</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 2 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
          <item>
            <title>Duplicated Article Copy</title>
            <link>https://example.com/post-dup?utm_campaign=daily</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 2 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
          <item>
            <title>Duplicated Article Without Tracking</title>
            <link>https://example.com/post-dup</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 2 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>
    `;
    const parsed = parseFeedXml(xml, "Dup Pub", FIXED_NOW);
    assert.equal(parsed.entries.length, 3); // 3 raw items

    const evalRes = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: parsed.feedTitle,
      feedType: parsed.feedType,
      entries: parsed.entries,
      now: FIXED_NOW,
    });

    // Normalized canonical URL deduplicates all 3 to 1 distinct entry
    assert.equal(evalRes.counts.distinctEntriesCount, 1);
    assert.equal(evalRes.counts.recentPublishedCount14d, 1);
  });

  // 12. Single-entry XML versus array-entry XML
  it("12. parses single-entry XML (object) and multi-entry XML (array) identically", () => {
    const singleXml = `
      <rss version="2.0">
        <channel>
          <title>Single Item Feed</title>
          <item>
            <title>Only Item</title>
            <link>https://example.com/item-single</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 1 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>
    `;
    const multiXml = `
      <rss version="2.0">
        <channel>
          <title>Multi Item Feed</title>
          <item>
            <title>Item 1</title>
            <link>https://example.com/item-1</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 1 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
          <item>
            <title>Item 2</title>
            <link>https://example.com/item-2</link>
            <pubDate>${new Date(FIXED_NOW.getTime() - 2 * 24 * 3600 * 1000).toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const parsedSingle = parseFeedXml(singleXml, "Single Pub", FIXED_NOW);
    assert.equal(parsedSingle.entries.length, 1);
    assert.equal(parsedSingle.entries[0]!.title, "Only Item");

    const parsedMulti = parseFeedXml(multiXml, "Multi Pub", FIXED_NOW);
    assert.equal(parsedMulti.entries.length, 2);
    assert.equal(parsedMulti.entries[0]!.title, "Item 1");
    assert.equal(parsedMulti.entries[1]!.title, "Item 2");
  });

  // 13. Feed-level timestamps that must not be counted as article dates
  it("13. never counts feed-level timestamps (channel.pubDate, lastBuildDate) as article dates", () => {
    const xml = `
      <rss version="2.0">
        <channel>
          <title>Feed With Header Dates</title>
          <lastBuildDate>Sun, 15 Mar 2026 11:00:00 GMT</lastBuildDate>
          <pubDate>Sun, 15 Mar 2026 11:00:00 GMT</pubDate>
          <item>
            <title>Undated Article in Modern Feed</title>
            <link>https://example.com/undated-item</link>
            <!-- Notice: no pubDate or dc:date here! -->
          </item>
        </channel>
      </rss>
    `;

    const parsed = parseFeedXml(xml, "Header Dates Pub", FIXED_NOW);
    assert.equal(parsed.entries.length, 1);
    const entry = parsed.entries[0]!;

    // Must NOT inherit lastBuildDate or channel pubDate!
    assert.equal(entry.dateStatus, "missing");
    assert.equal(entry.publishedAt, null);
    assert.equal(entry.updatedAt, null);
    assert.equal(entry.activityAt, null);
    assert.equal(entry.activityBasis, "unknown");

    const evalRes = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: parsed.feedTitle,
      feedType: parsed.feedType,
      entries: parsed.entries,
      now: FIXED_NOW,
    });

    assert.equal(evalRes.counts.undatedEntryCount, 1);
    assert.equal(evalRes.counts.recentPublishedCount14d, 0);
  });

  // Graded validation status tests
  it("classifies feeds into VALID (>= 3 in 14d) correctly", () => {
    const entries = [1, 2, 3, 4].map((i) =>
      buildNormalizedEntry({
        title: `Article ${i}`,
        url: `https://example.com/art-${i}`,
        entryId: `art-${i}`,
        publisher: "Daily News",
        rawPublished: daysAgoIso(i),
        now: FIXED_NOW,
      }),
    );

    const res = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: "Daily News",
      feedType: "rss",
      entries,
      now: FIXED_NOW,
    });

    assert.equal(res.status, "valid");
    assert.equal(res.counts.recentPublishedCount14d, 4);
  });

  it("classifies feeds into DEGRADED (1-2 in 14d or published in 30d) correctly", () => {
    const entries = [
      buildNormalizedEntry({
        title: "Article 1",
        url: "https://example.com/art-1",
        entryId: "art-1",
        publisher: "Weekly Review",
        rawPublished: daysAgoIso(20), // 20 days ago (in 30d window, but outside 14d)
        now: FIXED_NOW,
      }),
    ];

    const res = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: "Weekly Review",
      feedType: "rss",
      entries,
      now: FIXED_NOW,
    });

    assert.equal(res.status, "degraded");
    assert.equal(res.counts.recentPublishedCount14d, 0);
    assert.equal(res.counts.recentPublishedCount30d, 1);
  });

  it("classifies stale feeds (>30d old) as INVALID", () => {
    const entries = [
      buildNormalizedEntry({
        title: "Old Article",
        url: "https://example.com/art-old",
        entryId: "art-old",
        publisher: "Dead Blog",
        rawPublished: daysAgoIso(45), // 45 days ago
        now: FIXED_NOW,
      }),
    ];

    const res = evaluateFeedActivity({
      url: "https://example.com/feed.xml",
      feedTitle: "Dead Blog",
      feedType: "rss",
      entries,
      now: FIXED_NOW,
    });

    assert.equal(res.status, "invalid");
    assert.match(res.reason, /Stale feed/);
  });
});

