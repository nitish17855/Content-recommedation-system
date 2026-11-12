import type {
  ContextPack,
  CreativeRoute,
  CriticRouteReview,
  EventCluster,
  OpportunityMatch,
  RecommendationCard,
} from "../ai/schemas.js";

export interface EvaluatedCandidate {
  cluster: EventCluster;
  contextPack: ContextPack;
  opportunity: OpportunityMatch;
  route: CreativeRoute;
  review: CriticRouteReview;
}

function computeDeterministicEvidenceScore(
  cluster: EventCluster,
  contextPack: ContextPack,
  now: Date,
): { score: number; level: "high" | "medium" | "low"; basis: string } {
  const metrics: Array<{ name: string; weight: number; value: number }> = [];

  // 1. Source recency
  const lastTs = Date.parse(cluster.last_seen_at);
  if (!Number.isNaN(lastTs)) {
    const ageDays = Math.max(0, (now.getTime() - lastTs) / (1000 * 60 * 60 * 24));
    const recency = ageDays <= 2 ? 1.0 : ageDays <= 5 ? 0.8 : ageDays <= 10 ? 0.55 : 0.3;
    metrics.push({ name: "recency", weight: 0.35, value: recency });
  }

  // 2. Independent source count
  const sourceCount = Math.min(cluster.independent_source_count, 3) / 3;
  metrics.push({ name: "corroboration", weight: 0.30, value: sourceCount });

  // 3. Source diversity + official platform signal
  const hasOfficial = cluster.signals.some((s) => s.source_type === "official_platform");
  const diversityVal = Math.min(1, cluster.source_diversity * 0.4 + (hasOfficial ? 0.4 : 0));
  metrics.push({ name: "source_quality", weight: 0.20, value: diversityVal });

  // 4. Evidence completeness (non-empty excerpts, fewer unknowns)
  const hasSummary = contextPack.event_summary.trim().length > 20;
  const hasEvidence = contextPack.evidence.length > 0;
  const unknownPenalty = Math.min(0.4, contextPack.unknowns.length * 0.1);
  const completeness = Math.max(0.2, (hasSummary ? 0.5 : 0) + (hasEvidence ? 0.5 : 0) - unknownPenalty);
  metrics.push({ name: "completeness", weight: 0.15, value: completeness });

  // Renormalize weights cleanly across available metrics
  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0);
  const normalizedScore =
    totalWeight > 0
      ? metrics.reduce((sum, m) => sum + (m.value * m.weight) / totalWeight, 0)
      : 0;

  const rounded = Number(normalizedScore.toFixed(2));
  const level = rounded >= 0.72 ? "high" : rounded >= 0.48 ? "medium" : "low";
  const basis = `${cluster.independent_source_count} independent source(s), ${cluster.signals.length} signal(s), last seen ${cluster.last_seen_at.slice(0, 10)}${hasOfficial ? ", includes official source" : ""}`;

  return { score: rounded, level, basis };
}

function computeAiRubricScore(review: CriticRouteReview): number {
  const s = review.ai_scores;
  const avg =
    (s.brand_fit +
      s.audience_relevance +
      s.creative_usefulness +
      s.distinctiveness +
      s.execution_feasibility +
      s.cultural_appropriateness) /
    6;
  return Number((avg / 5).toFixed(2));
}

function inferUrgency(contextPack: ContextPack, cluster: EventCluster, now: Date): "immediate" | "soon" | "flexible" {
  const ageDays = (now.getTime() - Date.parse(cluster.last_seen_at)) / (1000 * 60 * 60 * 24);
  if (contextPack.trend_phase === "peak" && ageDays <= 3) return "immediate";
  if (contextPack.trend_phase === "emerging" || contextPack.trend_phase === "growing") return "soon";
  if (contextPack.trend_phase === "evergreen") return "flexible";
  return ageDays <= 5 ? "soon" : "flexible";
}

export function rankAndSelectRecommendations(
  candidates: EvaluatedCandidate[],
  now: Date = new Date(),
  maxRecommendations = 6,
): RecommendationCard[] {
  const eligible = candidates.filter(
    (c) => c.review.verdict !== "REJECT" && c.review.risk !== "BLOCKED",
  );

  const scored = eligible.map((c) => {
    const det = computeDeterministicEvidenceScore(c.cluster, c.contextPack, now);
    const aiScore = computeAiRubricScore(c.review);
    const verdictPenalty = c.review.verdict === "REVISE" ? 0.1 : 0;
    const baseCombined = Number((det.score * 0.4 + aiScore * 0.6 - verdictPenalty).toFixed(3));
    return { item: c, det, aiScore, baseCombined };
  });

  const selected: RecommendationCard[] = [];
  const usedEvents = new Set<string>();
  const usedRoutes = new Set<string>();
  const usedServices = new Set<string>();
  const usedPlatforms = new Set<string>();
  const remaining = [...scored];

  while (selected.length < maxRecommendations && remaining.length > 0) {
    let bestIdx = 0;
    let bestAdjusted = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      let penalty = 0;

      // Diversity penalties across event, route, service, and platform/format
      if (usedEvents.has(cand.item.cluster.event_id)) penalty += 0.35;
      if (usedRoutes.has(cand.item.route.route.toLowerCase())) penalty += 0.12;
      if (
        cand.item.opportunity.matched_services.some((s) =>
          usedServices.has(s.toLowerCase()),
        )
      ) {
        penalty += 0.10;
      }
      const platformFmt = `${cand.item.route.suggested_platform}:${cand.item.route.suggested_format}`.toLowerCase();
      if (usedPlatforms.has(platformFmt)) penalty += 0.08;

      const adjusted = cand.baseCombined - penalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]!;
    // Don't pad report with weak leftovers after strong threshold fails
    if (bestAdjusted < 0.42) break;

    const { item, det, aiScore } = chosen;
    usedEvents.add(item.cluster.event_id);
    usedRoutes.add(item.route.route.toLowerCase());
    for (const s of item.opportunity.matched_services) usedServices.add(s.toLowerCase());
    usedPlatforms.add(`${item.route.suggested_platform}:${item.route.suggested_format}`.toLowerCase());

    const revisionsNote =
      item.review.verdict === "REVISE" && item.review.required_revisions.length > 0
        ? ` | Critic revisions needed: ${item.review.required_revisions.join("; ")}`
        : "";

    selected.push({
      title: item.route.concept_title,
      category: item.route.route,
      what_happened: item.contextPack.event_summary,
      why_now: item.route.why_timely,
      brand_connection: item.route.brand_connection,
      what_to_post: item.route.what_to_communicate,
      suggested_platform: item.route.suggested_platform,
      suggested_format: item.route.suggested_format,
      objective: item.route.objective,
      evidence: item.cluster.signals.slice(0, 5).map((s) => ({
        url: s.url,
        publisher: s.publisher,
        published_at: s.published_at,
      })),
      urgency: inferUrgency(item.contextPack, item.cluster, now),
      risk: item.review.risk.toLowerCase() as "safe" | "caution" | "blocked",
      evidence_confidence: {
        level: det.level,
        score: det.score,
        factual_basis: det.basis,
      },
      execution_note: `${item.route.execution_note}${revisionsNote}`,
      metadata: {
        event_id: item.cluster.event_id,
        creative_route: item.route.route,
        matched_services: item.opportunity.matched_services,
        critic_verdict: item.review.verdict === "REVISE" ? "REVISE" : "ACCEPT",
        deterministic_evidence_score: det.score,
        ai_rubric_score: aiScore,
        combined_rank_score: Number(bestAdjusted.toFixed(3)),
      },
    });
  }

  return selected;
}

