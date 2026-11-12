import type { CanonicalSignal } from "../ai/schemas.js";
import { extractSignificantTokens } from "./normalize.js";

const TITLE_DEDUP_THRESHOLD = 0.82;
const DEDUP_WINDOW_MS = 72 * 60 * 60 * 1000;

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DeduplicationResult {
  uniqueSignals: CanonicalSignal[];
  droppedDuplicates: number;
}

export function deduplicateSignals(signals: CanonicalSignal[]): DeduplicationResult {
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const kept: Array<{ signal: CanonicalSignal; titleTokens: Set<string>; ts: number }> = [];
  let droppedDuplicates = 0;

  for (const sig of signals) {
    if (seenUrls.has(sig.url) || seenHashes.has(sig.content_hash)) {
      droppedDuplicates++;
      continue;
    }

    const titleTokens = new Set(extractSignificantTokens(sig.title));
    const ts = Date.parse(sig.published_at);

    const isNearDuplicateTitle = kept.some((existing) => {
      if (!Number.isNaN(ts) && !Number.isNaN(existing.ts)) {
        if (Math.abs(ts - existing.ts) > DEDUP_WINDOW_MS) return false;
      }
      return jaccardSimilarity(titleTokens, existing.titleTokens) >= TITLE_DEDUP_THRESHOLD;
    });

    if (isNearDuplicateTitle) {
      droppedDuplicates++;
      continue;
    }

    seenUrls.add(sig.url);
    seenHashes.add(sig.content_hash);
    kept.push({ signal: sig, titleTokens, ts });
  }

  return {
    uniqueSignals: kept.map((k) => k.signal),
    droppedDuplicates,
  };
}

