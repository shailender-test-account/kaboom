export type UploadedAnswerSignal = {
  signalTypeKey: string;
  label: string;
  field: string;
  value: string;
  strength: number;
  reason: string;
};

export type QuestionnaireRule = {
  id: string;
  label: string;
  keywords: string[];
  strength: number;
};

export type QuestionnaireDimension = {
  key: string;
  label: string;
  maxPoints: number;
  rules: QuestionnaireRule[];
};

/**
 * Tenant-uploaded answers are treated as approved evidence because the
 * uploader controls the source file. They remain product-scoped and can be
 * rejected later through the evidence review workflow.
 */
export const UPLOADED_ANSWER_APPROVAL_POLICY = {
  reviewStatus: "approved" as const,
  rationale: "Authenticated tenant uploads are approved at ingestion; malformed or ambiguous rows are not ingested.",
};

export const UPLOADED_ANSWER_SIGNAL_TYPES = [
  ["questionnaire_knowledge_intent", "Knowledge intent answer", "questionnaire", 0, 180],
  ["questionnaire_product_interest", "Product interest answer", "questionnaire", 34, 128],
  ["questionnaire_budget", "Budget answer", "questionnaire", 24, 90],
  ["questionnaire_timeframe", "Buying timeframe answer", "questionnaire", 30, 60],
  ["questionnaire_decision_role", "Decision role answer", "questionnaire", 20, 90],
  ["questionnaire_rating", "Rating answer", "questionnaire", 15, 45],
  ["questionnaire_challenge", "Business challenge answer", "questionnaire", 18, 90],
  ["questionnaire_qualification", "Qualification answer", "questionnaire", 28, 60],
] as const;

export const QUESTIONNAIRE_DIMENSION_DEFAULTS: QuestionnaireDimension[] = [
  {
    key: "product_interest",
    label: "Product interest",
    maxPoints: 34,
    rules: [
      { id: "negative", label: "Low or negative interest", keywords: ["no", "not interested", "not now", "none"], strength: 5 },
      { id: "exploratory", label: "Exploring or learning", keywords: ["maybe", "explor", "learn", "curious", "consider"], strength: 60 },
      { id: "positive", label: "Active interest", keywords: ["yes", "interested", "demo", "pricing", "quote", "buy", "purchase", "more", "connect"], strength: 95 },
    ],
  },
  {
    key: "budget",
    label: "Budget",
    maxPoints: 24,
    rules: [
      { id: "uncommitted", label: "No committed budget", keywords: ["no budget", "none", "unknown", "not sure", "not allocated"], strength: 10 },
      { id: "approved", label: "Approved or allocated", keywords: ["approved", "allocated", "ready", "existing budget", "funded"], strength: 95 },
    ],
  },
  {
    key: "timeframe",
    label: "Buying timeframe",
    maxPoints: 30,
    rules: [
      { id: "unknown", label: "No timeframe", keywords: ["unknown", "not sure", "no timeline", "later"], strength: 20 },
      { id: "near-term", label: "Near-term purchase", keywords: ["immediately", "now", "this month", "this quarter", "3-6", "next quarter"], strength: 80 },
      { id: "medium-term", label: "Medium-term purchase", keywords: ["6-12", "next 6", "next year", "12 months"], strength: 50 },
      { id: "long-term", label: "Longer-term purchase", keywords: ["year", "12+", "long term"], strength: 30 },
    ],
  },
  {
    key: "decision_role",
    label: "Decision role",
    maxPoints: 20,
    rules: [
      { id: "none", label: "No buying role", keywords: ["no role", "not involved", "none"], strength: 5 },
      { id: "authority", label: "Final buying authority", keywords: ["final", "decision maker", "decision-maker", "approver", "budget owner", "economic buyer"], strength: 100 },
      { id: "influencer", label: "Influences the decision", keywords: ["influenc", "sponsor", "recommen"], strength: 75 },
      { id: "evaluator", label: "Evaluates or shortlists", keywords: ["evaluat", "technical", "procurement", "shortlist"], strength: 55 },
      { id: "user", label: "Researches or uses", keywords: ["research", "aware", "user", "end user"], strength: 35 },
    ],
  },
  {
    key: "rating",
    label: "Rating",
    maxPoints: 15,
    rules: [
      { id: "positive", label: "Positive rating", keywords: ["excellent", "great", "very good", "high", "yes", "satisfied", "good", "positive", "interested"], strength: 85 },
      { id: "negative", label: "Low rating", keywords: ["poor", "low", "no", "bad", "dissatisfied"], strength: 20 },
    ],
  },
  {
    key: "challenge",
    label: "Business challenge",
    maxPoints: 18,
    rules: [
      { id: "none", label: "No challenge", keywords: ["none", "no challenge", "not applicable", "n/a"], strength: 5 },
      { id: "disclosed", label: "Challenge disclosed", keywords: [], strength: 75 },
    ],
  },
  {
    key: "qualification",
    label: "Qualification",
    maxPoints: 28,
    rules: [
      { id: "unqualified", label: "Not qualified", keywords: ["disqualif", "unqualified", "not qualified", "no"], strength: 5 },
      { id: "qualified", label: "Sales qualified", keywords: ["sql", "sales qualified", "qualified", "approved", "ready", "yes"], strength: 100 },
      { id: "partial", label: "Partially qualified", keywords: ["mql", "marketing qualified", "warm", "review"], strength: 70 },
    ],
  },
];

const DIMENSION_FOR_FIELD: Record<string, string> = {
  knowledge_interest: "knowledge_interest",
  product_interest: "product_interest",
  product_service_interest: "product_interest",
  budget: "budget",
  purchase_timeframe: "timeframe",
  decision_role: "decision_role",
  rating: "rating",
  event_rating: "rating",
  session_rating: "rating",
  business_challenge: "challenge",
  challenges: "challenge",
  qualification: "qualification",
};

const ANSWER_FIELDS: Array<{ field: string; signalTypeKey: string; label: string }> = [
  { field: "knowledge_interest", signalTypeKey: "questionnaire_knowledge_intent", label: "Knowledge intent" },
  { field: "product_interest", signalTypeKey: "questionnaire_product_interest", label: "Product interest" },
  { field: "product_service_interest", signalTypeKey: "questionnaire_product_interest", label: "Product interest" },
  { field: "budget", signalTypeKey: "questionnaire_budget", label: "Budget" },
  { field: "purchase_timeframe", signalTypeKey: "questionnaire_timeframe", label: "Buying timeframe" },
  { field: "decision_role", signalTypeKey: "questionnaire_decision_role", label: "Decision role" },
  { field: "rating", signalTypeKey: "questionnaire_rating", label: "Rating" },
  { field: "event_rating", signalTypeKey: "questionnaire_rating", label: "Event rating" },
  { field: "session_rating", signalTypeKey: "questionnaire_rating", label: "Session rating" },
  { field: "business_challenge", signalTypeKey: "questionnaire_challenge", label: "Business challenge" },
  { field: "challenges", signalTypeKey: "questionnaire_challenge", label: "Business challenge" },
  { field: "qualification", signalTypeKey: "questionnaire_qualification", label: "Qualification" },
];

function valuesFor(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(valuesFor);
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  return text ? [text] : [];
}

function bounded(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function keywordMatches(value: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return false;
  if (!/[a-z0-9]/i.test(normalizedKeyword)) return value.includes(normalizedKeyword);
  const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}`, "i").test(value);
}

function configuredAnswerStrength(
  field: string,
  value: string,
  settings: QuestionnaireDimension[] = QUESTIONNAIRE_DIMENSION_DEFAULTS,
): [number, string] | null {
  const dimensionKey = DIMENSION_FOR_FIELD[field];
  const dimension = settings.find((candidate) => candidate.key === dimensionKey);
  if (!dimension) return null;
  const normalized = value.toLowerCase();
  const rule = dimension.rules.find((candidate) => candidate.keywords.some((keyword) => keywordMatches(normalized, keyword)));
  if (!rule) return null;
  return [bounded(rule.strength), `Matched ${dimension.label} rule: ${rule.label}`];
}

function scoreProductInterest(value: string): [number, string] {
  const normalized = value.toLowerCase();
  if (/\b(no|not interested|not now|none)\b/.test(normalized)) return [5, "Explicitly low product interest"];
  if (/\b(maybe|explor|learn|curious|consider)\b/.test(normalized)) return [60, "Exploratory product interest"];
  if (/\b(yes|interested|demo|pricing|quote|buy|purchase|more|connect)\b/.test(normalized)) return [95, "Explicit product interest"];
  return [70, "Product or service named in the answer"];
}

function scoreBudget(value: string): [number, string] {
  const normalized = value.toLowerCase();
  if (/\b(no budget|none|unknown|not sure|not allocated)\b/.test(normalized)) return [10, "No committed budget disclosed"];
  if (/\b(approved|allocated|ready|existing budget|funded)\b/.test(normalized)) return [95, "Budget is approved or allocated"];
  const amounts = [...normalized.matchAll(/(?:[$€£₹]\s*)?(\d+(?:[.,]\d+)?)\s*(k|m|million|thousand)?/g)]
    .map(match => {
      const amount = Number(match[1].replace(/,/g, ""));
      const unit = match[2] ?? "";
      return amount * (/^(m|million)$/.test(unit) ? 1_000_000 : /^(k|thousand)$/.test(unit) ? 1_000 : 1);
    })
    .filter(Number.isFinite);
  if (amounts.length) return [bounded(35 + Math.log10(Math.max(...amounts)) * 14), "Numeric budget range supplied"];
  return [55, "Budget range or funding intent supplied"];
}

function scoreTimeframe(value: string): [number, string] {
  const normalized = value.toLowerCase();
  if (/\b(no plans?|not planning|never|none|not applicable|n\/a)\b/.test(normalized)) return [5, "Cold — no purchase plans"];
  if (/\b(now|immediate|immediately|asap|this week|this month|0\s*(?:-|–|to)\s*3|within\s+3)\b/.test(normalized)) return [100, "Hot — estimated purchase timeframe is 0–3 months"];
  if (/6\s*(?:months?)?\s*\+/.test(normalized) || /\b(6\s*(?:-|–|to)\s*12|more than 6|after 6|next year|12 months?|year|later|long term)\b/.test(normalized)) return [45, "Warm — estimated purchase timeframe is more than 6 months"];
  if (/\b(3\s*(?:-|–|to)\s*6|within\s+6|up to 6|next quarter|6\s*months?)\b/.test(normalized)) return [60, "Warm — estimated purchase timeframe is 3–6 months"];
  return [60, "Warm — purchase timeframe was supplied but did not match a standard range"];
}

function scoreDecisionRole(value: string): [number, string] {
  const normalized = value.toLowerCase();
  if (/\b(no role|not involved|none)\b/.test(normalized)) return [5, "No buying role disclosed"];
  if (/\b(final|decision maker|decision-maker|approver|budget owner|economic buyer)\b/.test(normalized)) return [100, "Final buying authority"];
  if (/\b(influenc|sponsor|recommen)\b/.test(normalized)) return [75, "Influences the buying decision"];
  if (/\b(evaluat|technical|procurement|shortlist)\b/.test(normalized)) return [55, "Evaluates or shortlists solutions"];
  if (/\b(research|aware|user|end user)\b/.test(normalized)) return [35, "Researches or uses the solution"];
  return [60, "Buying role supplied"];
}

function scoreRating(value: string): [number, string] {
  const numeric = Number(value.replace(",", ".").match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (Number.isFinite(numeric)) {
    const maximum = numeric <= 5 ? 5 : numeric <= 10 ? 10 : 100;
    return [bounded((numeric / maximum) * 100), "Numeric rating normalized to intent strength"];
  }
  const normalized = value.toLowerCase();
  if (/\b(excellent|great|very good|high|yes|satisfied)\b/.test(normalized)) return [90, "Strong positive rating"];
  if (/\b(good|positive|interested)\b/.test(normalized)) return [70, "Positive rating"];
  if (/\b(poor|low|no|bad|dissatisfied)\b/.test(normalized)) return [20, "Low rating"];
  return [50, "Rating supplied"];
}

function scoreChallenge(value: string): [number, string] {
  if (/\b(none|no challenge|not applicable|n\/a)\b/i.test(value)) return [5, "No business challenge disclosed"];
  return [75, "A business challenge was disclosed"];
}

function scoreQualification(value: string): [number, string] {
  const normalized = value.toLowerCase();
  if (/\b(disqualif|unqualified|not qualified|no)\b/.test(normalized)) return [5, "Not qualified for follow-up"];
  if (/\b(sql|sales qualified|qualified|approved|ready|yes)\b/.test(normalized)) return [100, "Explicitly qualified for follow-up"];
  if (/\b(mql|marketing qualified|warm|review)\b/.test(normalized)) return [70, "Partially qualified for follow-up"];
  return [55, "Qualification answer supplied"];
}

function scoreAnswer(field: string, value: string, settings?: QuestionnaireDimension[]): [number, string] {
  if (field === "knowledge_interest") return [0, "Knowledge intent — requested topic for future content"];
  if (field === "purchase_timeframe") return scoreTimeframe(value);
  const configured = configuredAnswerStrength(field, value, settings);
  if (configured) return configured;
  if (field === "product_interest" || field === "product_service_interest") return scoreProductInterest(value);
  if (field === "budget") return scoreBudget(value);
  if (field === "decision_role") return scoreDecisionRole(value);
  if (field === "rating" || field === "event_rating" || field === "session_rating") return scoreRating(value);
  if (field === "business_challenge" || field === "challenges") return scoreChallenge(value);
  return scoreQualification(value);
}

export function uploadedAnswerSignals(
  mappedPayload: Record<string, unknown>,
  settings: QuestionnaireDimension[] = QUESTIONNAIRE_DIMENSION_DEFAULTS,
): UploadedAnswerSignal[] {
  const seen = new Set<string>();
  const signals: UploadedAnswerSignal[] = [];
  for (const definition of ANSWER_FIELDS) {
    for (const value of valuesFor(mappedPayload[definition.field])) {
      const dedupeKey = `${definition.field}:${value.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const [strength, reason] = scoreAnswer(definition.field, value, settings);
      signals.push({
        signalTypeKey: definition.signalTypeKey,
        label: definition.label,
        field: definition.field,
        value,
        strength,
        reason,
      });
    }
  }
  return signals;
}