import type {
  ContextPack,
  CreativeRoute,
  CriticRouteReview,
  EventCluster,
  OpportunityMatch,
  RecommendationCard,
} from "../ai/schemas.js";
import {
  areClustersSameStory,
  getClusterChannel,
  type DiscoveryChannel,
} from "./pre-filter.js";

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

function mapUrgency(
  routeUrgency: CreativeRoute["when_to_publish"]["urgency"],
  contextPack: ContextPack,
  cluster: EventCluster,
  now: Date,
): "urgent" | "this_week" | "flexible" {
  if (routeUrgency === "urgent" || routeUrgency === "this_week" || routeUrgency === "flexible") {
    return routeUrgency;
  }
  const ageDays = (now.getTime() - Date.parse(cluster.last_seen_at)) / (1000 * 60 * 60 * 24);
  if (contextPack.trend_phase === "peak" && ageDays <= 3) return "urgent";
  if (contextPack.trend_phase === "emerging" || contextPack.trend_phase === "growing") return "this_week";
  return ageDays <= 5 ? "this_week" : "flexible";
}

export function rankAndSelectRecommendations(
  candidates: EvaluatedCandidate[],
  now: Date = new Date(),
  maxRecommendations = 6,
): RecommendationCard[] {
  // Human-in-the-loop: Surface all candidates to human decision-maker, withholding only harmful content (risk === "BLOCKED")
  const eligible = candidates.filter((c) => c.review.risk !== "BLOCKED");

  const scored = eligible.map((c) => {
    const det = computeDeterministicEvidenceScore(c.cluster, c.contextPack, now);
    const aiScore = computeAiRubricScore(c.review);
    const verdictPenalty =
      c.review.verdict === "REJECT" ? 0.22 : c.review.verdict === "REVISE" ? 0.08 : 0;
    const baseCombined = Number((det.score * 0.4 + aiScore * 0.6 - verdictPenalty).toFixed(3));
    return { item: c, det, aiScore, baseCombined };
  });

  const selected: RecommendationCard[] = [];
  const selectedClusters: EventCluster[] = [];
  const usedEvents = new Set<string>();
  const usedCategories = new Map<string, number>();
  const usedChannels = new Map<DiscoveryChannel, number>();
  const usedRoutes = new Set<string>();
  const usedServices = new Set<string>();
  const usedPlatforms = new Set<string>();
  const remaining = [...scored];

  while (selected.length < maxRecommendations && remaining.length > 0) {
    let bestIdx = -1;
    let bestAdjusted = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;

      // Rule 1 & Rule 2: Strict 1 recommendation per underlying event/story
      if (usedEvents.has(cand.item.cluster.event_id)) continue;
      if (selectedClusters.some((picked) => areClustersSameStory(picked, cand.item.cluster))) {
        continue;
      }

      // Rule 3 & Rule 4: Penalize concentration in same category, channel, service, or format
      let penalty = 0;
      const catCount = usedCategories.get(cand.item.contextPack.discovery_category) ?? 0;
      penalty += catCount * 0.14;

      const ch = getClusterChannel(cand.item.cluster);
      const chCount = usedChannels.get(ch) ?? 0;
      penalty += chCount * 0.12;

      if (usedRoutes.has(cand.item.route.route.toLowerCase())) penalty += 0.08;
      if (
        cand.item.opportunity.matched_services.some((s) =>
          usedServices.has(s.toLowerCase()),
        )
      ) {
        penalty += 0.06;
      }
      const platformFmt = `${cand.item.route.suggested_platform}:${cand.item.route.suggested_format}`.toLowerCase();
      if (usedPlatforms.has(platformFmt)) penalty += 0.05;

      const adjusted = cand.baseCombined - penalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const chosen = remaining.splice(bestIdx, 1)[0]!;
    // Quality beats quotas: stop rather than pad with weak or repetitive leftovers
    if (bestAdjusted < 0.45) break;

    const { item, det, aiScore } = chosen;
    selectedClusters.push(item.cluster);
    usedEvents.add(item.cluster.event_id);
    const cat = item.contextPack.discovery_category;
    usedCategories.set(cat, (usedCategories.get(cat) ?? 0) + 1);
    const ch = getClusterChannel(item.cluster);
    usedChannels.set(ch, (usedChannels.get(ch) ?? 0) + 1);
    usedRoutes.add(item.route.route.toLowerCase());
    for (const s of item.opportunity.matched_services) usedServices.add(s.toLowerCase());
    usedPlatforms.add(`${item.route.suggested_platform}:${item.route.suggested_format}`.toLowerCase());

    const revisionsList =
      item.review.verdict === "REVISE" && item.review.required_revisions?.length > 0
        ? item.review.required_revisions
        : [];
    const routeFacts = Array.isArray(item.route.facts_and_claims_to_check)
      ? item.route.facts_and_claims_to_check
      : Array.isArray((item.route as any).what_to_verify?.facts_and_claims_to_check)
        ? (item.route as any).what_to_verify.facts_and_claims_to_check
        : [];
    const reviewConcerns = Array.isArray(item.review.factual_concerns)
      ? item.review.factual_concerns
      : [];
    const factsToVerify = Array.from(
      new Set([
        ...routeFacts,
        ...reviewConcerns,
        ...revisionsList.map((r) => `Editor check: ${r}`),
      ]),
    );

    const allowedUrls = new Set(item.cluster.signals.map((s) => s.url));
    const rawMaterial = Array.isArray(item.route.where_to_get_material) ? item.route.where_to_get_material : [];
    const groundedMaterial = rawMaterial.filter((m) => allowedUrls.has(m.url));
    const material =
      groundedMaterial.length > 0
        ? groundedMaterial
        : item.cluster.signals.slice(0, 2).map((s) => ({
            label: s.publisher,
            url: s.url,
            what_to_record_or_screenshot: `Open ${s.publisher}'s article headline and key announcement excerpt.`,
          }));

    selected.push({
      schemaVersion: 2,
      title: item.route.concept_title,
      category: item.contextPack.discovery_category,
      what_happened: item.route.plain_what_happened,
      why_brand_should_care: item.route.why_brand_should_care,
      what_to_create: item.route.what_to_create,
      how_to_create_it: item.route.how_to_create_it,
      where_to_get_material: material,
      what_to_communicate: item.route.what_to_communicate,
      when_to_publish: {
        urgency: mapUrgency(item.route.when_to_publish.urgency, item.contextPack, item.cluster, now),
        timing_reason: item.route.when_to_publish.timing_reason,
      },
      what_to_verify: {
        india_availability: `${item.contextPack.india_availability.status.replace(/_/g, " ")} — ${item.contextPack.india_availability.restrictions_or_eligibility}`,
        who_can_use_it: item.contextPack.india_availability.who_can_use_it,
        facts_and_claims_to_check: factsToVerify,
      },
      suggested_platform: item.route.suggested_platform,
      suggested_format: item.route.suggested_format,
      objective: item.route.objective,
      evidence: item.cluster.signals.slice(0, 5).map((s) => ({
        url: s.url,
        publisher: s.publisher,
        published_at: s.published_at,
      })),
      risk: item.review.risk.toLowerCase() as "safe" | "caution" | "blocked",
      evidence_confidence: {
        level: det.level,
        score: det.score,
        factual_basis: det.basis,
      },
      metadata: {
        event_id: item.cluster.event_id,
        creative_route: item.route.route,
        matched_services: item.opportunity.matched_services,
        target_audience_profile: item.opportunity.target_audience_profile,
        core_business_problem: item.opportunity.core_business_problem,
        opportunity_type: item.opportunity.opportunity_type,
        critic_verdict: item.review.verdict,
        deterministic_evidence_score: det.score,
        ai_rubric_score: aiScore,
        combined_rank_score: Number(bestAdjusted.toFixed(3)),
      },
    });
  }

  return selected;
}

