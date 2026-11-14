import type { EventCluster } from "../ai/schemas.js";

export type SensitivityLevel = "high" | "medium" | "low";

export interface SensitivityDimensions {
  aiRelevance: SensitivityLevel;
  supplyChainSensitivity: SensitivityLevel;
  regulatorySensitivity: SensitivityLevel;
}

export interface BrandSensitivityConfig {
  inferenceVersion: "1.0";
  inferred: SensitivityDimensions;
  overrides: Partial<SensitivityDimensions>;
  effective: SensitivityDimensions;
  inferredAt: string;
}

export interface CrossIndustryClassification {
  aiShiftScore: number;
  supplyChainScore: number;
  regulatoryScore: number;
  matchedTerms: {
    ai: string[];
    supplyChain: string[];
    regulatory: string[];
  };
  evidenceFields: string[];
  confidence: number;
}

export interface CrossIndustryRelevanceResult {
  compositeScore: number; // 0.0 - 1.0
  relevance100: number;   // 0 - 100
  primaryScore: number;
  secondaryScore: number;
  synergyBonus: number;
  classification: CrossIndustryClassification;
}

export const SENSITIVITY_MULTIPLIERS: Record<SensitivityLevel, number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.15,
};

export function resolveEffectiveSensitivity(
  inferred: SensitivityDimensions,
  overrides: Partial<SensitivityDimensions> = {},
): SensitivityDimensions {
  return {
    aiRelevance: overrides.aiRelevance ?? inferred.aiRelevance,
    supplyChainSensitivity: overrides.supplyChainSensitivity ?? inferred.supplyChainSensitivity,
    regulatorySensitivity: overrides.regulatorySensitivity ?? inferred.regulatorySensitivity,
  };
}

export function inferBrandSensitivities(params: {
  industry?: string;
  subIndustry?: string;
  businessModel?: string;
  offerings?: string[];
  targetAudiences?: string[];
  customerProblems?: string[];
}): SensitivityDimensions {
  const combinedText = [
    params.industry ?? "",
    params.subIndustry ?? "",
    params.businessModel ?? "",
    ...(params.offerings ?? []),
    ...(params.targetAudiences ?? []),
    ...(params.customerProblems ?? []),
  ]
    .join(" ")
    .toLowerCase();

  // 1. Infer AI Relevance
  let aiRelevance: SensitivityLevel = "low";
  const strongAiTerms = [
    "ai",
    "machine learning",
    "llm",
    "generative ai",
    "autonomous agent",
    "copilot",
    "natural language",
    "geo citation",
    "ai search",
    "deep learning",
  ];
  const generalTechTerms = ["software", "saas", "platform", "digital", "technology", "cloud", "api", "seo"];

  const hasStrongAi = strongAiTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));
  const hasTech = generalTechTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));

  if (hasStrongAi) {
    aiRelevance = "high";
  } else if (hasTech || !params.industry) {
    aiRelevance = "medium";
  } else {
    aiRelevance = "low";
  }

  // 2. Infer Supply Chain Sensitivity
  let supplyChainSensitivity: SensitivityLevel = "low";
  const strongSupplyTerms = [
    "freight",
    "logistics",
    "shipping",
    "cold chain",
    "refrigerated",
    "warehouse",
    "inventory",
    "sourcing",
    "coffee",
    "roasting",
    "raw material",
    "commodity",
    "import",
    "export",
    "customs",
    "3pl",
    "cargo",
    "demurrage",
  ];
  const physicalCommerceTerms = ["ecommerce", "e-commerce", "retail", "manufacturing", "d2c", "packaged goods", "food"];

  const hasStrongSupply = strongSupplyTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));
  const hasPhysical = physicalCommerceTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));

  if (hasStrongSupply) {
    supplyChainSensitivity = "high";
  } else if (hasPhysical) {
    supplyChainSensitivity = "medium";
  } else if (!params.industry) {
    supplyChainSensitivity = "medium"; // Unspecified defaults to medium
  } else {
    supplyChainSensitivity = "low";
  }

  // 3. Infer Regulatory Sensitivity
  let regulatorySensitivity: SensitivityLevel = "low";
  const heavyRegTerms = [
    "healthcare",
    "health",
    "telehealth",
    "clinical",
    "medical",
    "hipaa",
    "pharma",
    "finance",
    "fintech",
    "banking",
    "lending",
    "customs compliance",
    "fssai",
    "fda",
  ];
  const moderateRegTerms = ["data privacy", "gdpr", "compliance", "cross-border", "tax", "payments"];

  const hasHeavyReg = heavyRegTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));
  const hasModerateReg = moderateRegTerms.some((t) => new RegExp(`\\b${t}\\b`, "i").test(combinedText));

  if (hasHeavyReg) {
    regulatorySensitivity = "high";
  } else if (hasModerateReg) {
    regulatorySensitivity = "medium";
  } else if (!params.industry) {
    regulatorySensitivity = "medium";
  } else {
    regulatorySensitivity = "low";
  }

  return { aiRelevance, supplyChainSensitivity, regulatorySensitivity };
}

// --- Term matchers and disambiguation rules ---

interface MatchRule {
  term: string;
  weight: number;
  isPhrase?: boolean;
}

const AI_STRONG_PHRASES: MatchRule[] = [
  { term: "artificial intelligence", weight: 0.8, isPhrase: true },
  { term: "generative ai", weight: 0.8, isPhrase: true },
  { term: "large language model", weight: 0.8, isPhrase: true },
  { term: "autonomous agent", weight: 0.75, isPhrase: true },
  { term: "ai agent", weight: 0.75, isPhrase: true },
  { term: "ai model", weight: 0.7, isPhrase: true },
  { term: "reasoning model", weight: 0.75, isPhrase: true },
  { term: "machine learning", weight: 0.7, isPhrase: true },
  { term: "ai-powered", weight: 0.75, isPhrase: true },
  { term: "ai search", weight: 0.7, isPhrase: true },
  { term: "neural network", weight: 0.7, isPhrase: true },
];

const AI_UNAMBIGUOUS_TOKENS: MatchRule[] = [
  { term: "llm", weight: 0.7 },
  { term: "chatgpt", weight: 0.75 },
  { term: "copilot", weight: 0.7 },
  { term: "gemini", weight: 0.65 },
  { term: "claude", weight: 0.65 },
  { term: "openai", weight: 0.7 },
  { term: "anthropic", weight: 0.7 },
  { term: "deepseek", weight: 0.7 },
];

const SUPPLY_CHAIN_TERMS: MatchRule[] = [
  { term: "port congestion", weight: 0.85, isPhrase: true },
  { term: "shipping rates", weight: 0.8, isPhrase: true },
  { term: "container freight", weight: 0.85, isPhrase: true },
  { term: "container shortage", weight: 0.85, isPhrase: true },
  { term: "cold chain", weight: 0.8, isPhrase: true },
  { term: "refrigerated transport", weight: 0.85, isPhrase: true },
  { term: "intermodal freight", weight: 0.8, isPhrase: true },
  { term: "demurrage", weight: 0.8 },
  { term: "detention fee", weight: 0.8, isPhrase: true },
  { term: "ocean freight", weight: 0.8, isPhrase: true },
  { term: "freight forwarder", weight: 0.75, isPhrase: true },
  { term: "spot rates", weight: 0.75, isPhrase: true },
  { term: "supply chain", weight: 0.7, isPhrase: true },
  { term: "freight", weight: 0.65 },
  { term: "arabica", weight: 0.8 },
  { term: "green coffee", weight: 0.85, isPhrase: true },
  { term: "coffee futures", weight: 0.85, isPhrase: true },
  { term: "raw materials", weight: 0.65, isPhrase: true },
  { term: "procurement", weight: 0.6 },
  { term: "inventory", weight: 0.55 },
  { term: "logistics", weight: 0.55 },
  { term: "warehousing", weight: 0.6 },
  { term: "commodity", weight: 0.6 },
  { term: "commodities", weight: 0.6 },
];

const REGULATORY_TERMS: MatchRule[] = [
  { term: "fssai", weight: 0.85 },
  { term: "fda", weight: 0.8 },
  { term: "hipaa", weight: 0.85 },
  { term: "gdpr", weight: 0.8 },
  { term: "dpdp", weight: 0.85 },
  { term: "antitrust", weight: 0.8 },
  { term: "food safety legislation", weight: 0.85, isPhrase: true },
  { term: "food safety", weight: 0.75, isPhrase: true },
  { term: "customs tariff", weight: 0.8, isPhrase: true },
  { term: "customs duty", weight: 0.8, isPhrase: true },
  { term: "import tariff", weight: 0.8, isPhrase: true },
  { term: "customs compliance", weight: 0.8, isPhrase: true },
  { term: "statutory compliance", weight: 0.75, isPhrase: true },
  { term: "compliance", weight: 0.5 },
  { term: "regulation", weight: 0.65 },
  { term: "regulations", weight: 0.65 },
  { term: "regulatory", weight: 0.65 },
  { term: "legislation", weight: 0.75 },
  { term: "court injunction", weight: 0.75, isPhrase: true },
  { term: "enforcement action", weight: 0.75, isPhrase: true },
  { term: "law enacted", weight: 0.8, isPhrase: true },
  { term: "legal mandate", weight: 0.75, isPhrase: true },
];

export function classifyCrossIndustryEvent(cluster: EventCluster): CrossIndustryClassification {
  const title = cluster.cluster_title.toLowerCase();
  const excerpts = cluster.signals.map((s) => s.excerpt).join(" ").toLowerCase();
  const keywords = cluster.keywords.join(" ").toLowerCase();
  const topicTokens = (cluster.topic_tokens ?? []).join(" ").toLowerCase();
  const entities = (cluster.entities ?? []).join(" ").toLowerCase();

  const fullText = `${title} ${excerpts} ${keywords} ${topicTokens} ${entities}`;

  const evidenceFields: string[] = [];
  const matchedTerms = {
    ai: [] as string[],
    supplyChain: [] as string[],
    regulatory: [] as string[],
  };

  // 1. AI Classification & Disambiguation
  let aiScore = 0;
  // Disambiguation: check if text talks about "travel agent", "booking agent", "real estate agent"
  const isFalseAgent = /\b(travel|booking|real estate|insurance|literary|talent)\s+agent/i.test(fullText);

  for (const rule of AI_STRONG_PHRASES) {
    if (fullText.includes(rule.term)) {
      aiScore = Math.max(aiScore, rule.weight);
      matchedTerms.ai.push(rule.term);
      evidenceFields.push(`ai_phrase:${rule.term}`);
    }
  }

  for (const rule of AI_UNAMBIGUOUS_TOKENS) {
    if (new RegExp(`\\b${rule.term}\\b`, "i").test(fullText)) {
      aiScore = Math.max(aiScore, rule.weight);
      matchedTerms.ai.push(rule.term);
      evidenceFields.push(`ai_token:${rule.term}`);
    }
  }

  // Bare "agent" token: only valid if co-occurring with AI/tech signals and not in false agent context
  if (!isFalseAgent && /\bagent\b/i.test(fullText)) {
    const hasAiContext = /\b(ai|llm|model|autonomous|software|code|multi-agent|agentic)\b/i.test(fullText);
    if (hasAiContext) {
      aiScore = Math.max(aiScore, 0.6);
      matchedTerms.ai.push("agent (tech-context)");
      evidenceFields.push("ai_context_agent");
    }
  }

  // Word-boundary check for bare "ai" token
  if (/\bai\b/i.test(fullText) && !matchedTerms.ai.includes("ai")) {
    aiScore = Math.max(aiScore, 0.55);
    matchedTerms.ai.push("ai");
    evidenceFields.push("ai_word");
  }

  // If false agent and no other strong AI evidence, strictly zero out AI score
  if (isFalseAgent && matchedTerms.ai.length === 0) {
    aiScore = 0;
  }

  // Multi-term accumulation bonus
  if (matchedTerms.ai.length >= 2) {
    aiScore = Math.min(1.0, aiScore + 0.15);
  }

  // 2. Supply Chain / Commodity Classification
  let supplyScore = 0;
  for (const rule of SUPPLY_CHAIN_TERMS) {
    const matched = rule.isPhrase
      ? fullText.includes(rule.term)
      : new RegExp(`\\b${rule.term}\\b`, "i").test(fullText);
    if (matched) {
      supplyScore = Math.max(supplyScore, rule.weight);
      matchedTerms.supplyChain.push(rule.term);
      evidenceFields.push(`supply:${rule.term}`);
    }
  }
  if (matchedTerms.supplyChain.length >= 2) {
    supplyScore = Math.min(1.0, supplyScore + 0.15);
  }

  // 3. Regulatory / Policy Classification
  let regScore = 0;
  for (const rule of REGULATORY_TERMS) {
    const matched = rule.isPhrase
      ? fullText.includes(rule.term)
      : new RegExp(`\\b${rule.term}\\b`, "i").test(fullText);
    if (matched) {
      regScore = Math.max(regScore, rule.weight);
      matchedTerms.regulatory.push(rule.term);
      evidenceFields.push(`reg:${rule.term}`);
    }
  }
  if (matchedTerms.regulatory.length >= 2) {
    regScore = Math.min(1.0, regScore + 0.15);
  }

  // Title emphasis bonus: terms appearing in title increase confidence
  if (matchedTerms.ai.some((t) => title.includes(t.toLowerCase()))) aiScore = Math.min(1.0, aiScore + 0.1);
  if (matchedTerms.supplyChain.some((t) => title.includes(t.toLowerCase()))) supplyScore = Math.min(1.0, supplyScore + 0.1);
  if (matchedTerms.regulatory.some((t) => title.includes(t.toLowerCase()))) regScore = Math.min(1.0, regScore + 0.1);

  // Confidence estimation based on corroboration and term density
  const totalTerms = matchedTerms.ai.length + matchedTerms.supplyChain.length + matchedTerms.regulatory.length;
  const confidence = totalTerms > 0 ? Math.min(1.0, 0.4 + totalTerms * 0.15) : 0;

  return {
    aiShiftScore: Number(aiScore.toFixed(3)),
    supplyChainScore: Number(supplyScore.toFixed(3)),
    regulatoryScore: Number(regScore.toFixed(3)),
    matchedTerms,
    evidenceFields: Array.from(new Set(evidenceFields)),
    confidence: Number(confidence.toFixed(2)),
  };
}

/**
 * Aggregates the multi-label cross-industry classification against a brand's effective sensitivity
 * applying a small, capped synergy bonus for genuine multi-category developments.
 */
export function calculateCrossIndustryRelevance(
  classification: CrossIndustryClassification,
  effective: SensitivityDimensions,
): CrossIndustryRelevanceResult {
  const weightedAi = classification.aiShiftScore * SENSITIVITY_MULTIPLIERS[effective.aiRelevance];
  const weightedSupply = classification.supplyChainScore * SENSITIVITY_MULTIPLIERS[effective.supplyChainSensitivity];
  const weightedReg = classification.regulatoryScore * SENSITIVITY_MULTIPLIERS[effective.regulatorySensitivity];

  // Sort categories descending: primary >= secondary >= tertiary
  const scores = [
    { cat: "ai" as const, score: weightedAi, terms: classification.matchedTerms.ai },
    { cat: "supply" as const, score: weightedSupply, terms: classification.matchedTerms.supplyChain },
    { cat: "reg" as const, score: weightedReg, terms: classification.matchedTerms.regulatory },
  ].sort((a, b) => b.score - a.score);

  const primary = scores[0]!;
  const secondary = scores[1]!;

  // Synergy bonus: applies ONLY when both primary & secondary have matched terms from actual content
  // and secondary score meets the significance threshold (>= 0.35)
  const hasEvidenceForBoth = primary.terms.length > 0 && secondary.terms.length > 0;
  const synergyBonus =
    secondary.score >= 0.35 && hasEvidenceForBoth ? Math.min(0.08, 0.1 * secondary.score) : 0;

  const compositeScore = Math.min(1.0, primary.score + synergyBonus);
  const relevance100 = Math.round(compositeScore * 100);

  return {
    compositeScore: Number(compositeScore.toFixed(3)),
    relevance100,
    primaryScore: Number(primary.score.toFixed(3)),
    secondaryScore: Number(secondary.score.toFixed(3)),
    synergyBonus: Number(synergyBonus.toFixed(3)),
    classification,
  };
}

