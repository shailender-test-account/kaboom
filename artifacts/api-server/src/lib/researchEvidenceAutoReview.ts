import { isUnattributedResearch as isUnattributedProcurement } from "./publicResearchAttribution";
import { pool } from "@workspace/db";
import { z } from "zod/v4";
import { ensureIntentDefaults } from "./alwaysOnIntent";
import { researchAnalysisAvailability } from "./researchOpportunityInterpreter";
import { deriveProductFitments, type ProductFitment } from "./signalProductFit";
import { researchSourceText, workforceFacts } from "./researchSourceFacts";
import { isResearchGeographyEligible, researchGeographyAssessment } from "./researchGeography";

const publicEventTypes = [
  "funding", "layoffs", "hiring", "branch_opening", "merger_acquisition",
  "procurement", "cxo_appointment", "partnership", "quarterly_financial",
  "technology_integration", "capital_investment", "regulatory_action", "operational_risk",
] as const;

const reviewSchema = z.object({ reviews: z.array(z.unknown()).max(50) }).passthrough();

type PendingEvidence = {
  id: number;
  event_type: typeof publicEventTypes[number];
  excerpt: string;
  source_url: string | null;
  occurred_at: Date;
  context: Record<string, unknown>;
  raw_evidence?: unknown;
};

type EvidenceReview = {
  evidenceId: number;
  relevant: boolean;
  confidence: number;
  signalType: typeof publicEventTypes[number];
  extractedSignal: string;
  rationale: string;
  inferredCategories: string[];
  catalogProductIds: number[];
  fitments?: ProductFitment[];
  dealStage?: "intent" | "announced" | "closed" | null;
  dealType?: "company_acquisition" | "asset_or_plant_acquisition" | "merger" | "divestment" | null;
  capexType?: "technology" | "operational" | "offices_sites" | null;
  publishedDate?: string | null;
};

const typeAliases: Record<string, typeof publicEventTypes[number]> = {
  earnings: "quarterly_financial",
  financial: "quarterly_financial",
  financial_results: "quarterly_financial",
  mergers: "merger_acquisition",
  acquisition: "merger_acquisition",
  executive_appointment: "cxo_appointment",
  technology: "technology_integration",
  investment: "capital_investment",
  compliance: "regulatory_action",
  risk: "operational_risk",
};

function fallbackReview(row: PendingEvidence): EvidenceReview {
  const text = `${row.event_type} ${row.excerpt}`.toLowerCase();
  const category =
    row.event_type === "hiring" ? "Workforce & Talent" :
    row.event_type === "procurement" ? "Active Procurement" :
    row.event_type === "quarterly_financial" || row.event_type === "funding" || row.event_type === "capital_investment" ? "Finance & Cost Optimization" :
    row.event_type === "merger_acquisition" ? "M&A & Transformation" :
    row.event_type === "partnership" ? "Strategic Partnerships" :
    row.event_type === "branch_opening" ? "Expansion & Infrastructure" :
    row.event_type === "technology_integration" ? "Digital Transformation" :
    row.event_type === "regulatory_action" ? "Risk, Compliance & Governance" :
    row.event_type === "operational_risk" ? "Operational Resilience" :
    row.event_type === "layoffs" ? "Workforce & Talent" : "Executive Strategy";
  const extractedSignal = row.excerpt.trim().slice(0, 600) || `${row.event_type.replace(/_/g, " ")} reported for ${row.occurred_at.toISOString().slice(0, 10)}`;
  return {
    evidenceId: row.id,
    relevant: text.length > 20,
    confidence: 72,
    signalType: row.event_type,
    extractedSignal,
    rationale: `The source reports ${row.event_type.replace(/_/g, " ")} activity for this account. This is an actionable business-context signal; the specific product need should be validated in discovery.`,
    inferredCategories: [category],
    catalogProductIds: [],
  };
}

function normalizeReview(value: unknown, row: PendingEvidence): EvidenceReview {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawType = String(source.signalType ?? row.event_type).toLowerCase().replace(/\s+/g, "_");
  const signalType = (publicEventTypes as readonly string[]).includes(rawType)
    ? rawType as typeof publicEventTypes[number]
    : typeAliases[rawType] ?? row.event_type;
  const inferredCategories = Array.isArray(source.inferredCategories)
    ? source.inferredCategories.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim().slice(0, 160)).slice(0, 8)
    : [];
  const catalogProductIds = Array.isArray(source.catalogProductIds)
    ? source.catalogProductIds.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 8)
    : [];
  const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
    allowed.includes(value as T) ? value as T : null;
  return {
    evidenceId: Number(source.evidenceId) === row.id ? row.id : row.id,
    relevant: typeof source.relevant === "boolean" ? source.relevant : true,
    confidence: Math.max(0, Math.min(100, Math.round(Number(source.confidence) || 72))),
    signalType,
    extractedSignal: typeof source.extractedSignal === "string" && source.extractedSignal.trim() ? source.extractedSignal.trim().slice(0, 600) : fallbackReview(row).extractedSignal,
    rationale: typeof source.rationale === "string" && source.rationale.trim() ? source.rationale.trim().slice(0, 800) : fallbackReview(row).rationale,
    inferredCategories: inferredCategories.length ? inferredCategories : fallbackReview(row).inferredCategories,
    catalogProductIds,
    dealStage: enumValue(source.dealStage, ["intent","announced","closed"] as const),
    dealType: enumValue(source.dealType, ["company_acquisition","asset_or_plant_acquisition","merger","divestment"] as const),
    capexType: enumValue(source.capexType, ["technology","operational","offices_sites"] as const),
    publishedDate: typeof source.publishedDate === "string" ? source.publishedDate.slice(0,10) : null,
  };
}

export function addGrowthOpportunityFit(
  review: EvidenceReview,
  row: PendingEvidence,
  products: Array<{ id: number; name: string; category: string; subcategory: string | null }>,
): EvidenceReview {
  if (`${row.event_type} ${row.excerpt}`.trim().length < 20) return review;
  const sourceText = researchSourceText(row.excerpt, row.context);
  const contraction = workforceFacts(sourceText).contraction || row.event_type === "layoffs";
  const signalType = contraction ? "layoffs" : review.signalType;
  const fitments = deriveProductFitments({
    eventType: signalType,
    text: sourceText,
    confidence: review.confidence,
    aiProductIds: review.catalogProductIds,
  }, products);
  const inferredCategories = [...new Set([
    ...(fitments.length ? [] : fallbackReview({ ...row, event_type: signalType }).inferredCategories),
    ...fitments.map(fitment => fitment.category),
  ])].slice(0, 12);
  const uniqueProductIds = [...new Set(fitments.map(fitment => fitment.productId))].slice(0, 12);
  const fitmentSummary = fitments.slice(0, 4).map(fitment => `${fitment.productName} (${fitment.points} pts)`).join(", ");
  return {
    ...review,
    signalType,
    extractedSignal: sourceText.trim().slice(0, 600),
    relevant: review.relevant,
    confidence: Math.max(65, review.confidence),
    inferredCategories,
    catalogProductIds: uniqueProductIds,
    fitments,
    rationale: `${fallbackReview({ ...row, event_type: signalType }).rationale}${fitmentSummary ? ` Product fitment analysis identified: ${fitmentSummary}.` : " No specific catalog product has a defensible fact-to-need fit yet; retain this as account context."} Possible-fit hypotheses require validation and are not claims of a confirmed purchase.`,
  };
}

async function classify(
  company: { name: string; domain: string | null },
  products: Array<{ id: number; name: string; category: string; subcategory: string | null }>,
  evidence: PendingEvidence[],
) {
  const prompt = `Classify public research for B2B sales intent.
- Reject landing-page menus, concatenated case-study titles, and customer stories not attributable to the researched company. Country, account identity and operational consequence must be established in the same local source passage, not scattered across a page. Financial news alone is context, not a product requirement. Prefer actual publication dates over update or retrieval dates; preserve unknown ownership, local scale and purchase timing.

Company: ${JSON.stringify(company)}
Configured catalog: ${JSON.stringify(products)}
Evidence: ${JSON.stringify(evidence.map(row => ({ evidenceId: row.id, eventType: row.event_type, date: row.occurred_at, text: row.excerpt, sourceUrl: row.source_url })))}

For every evidence item:
- Decide whether the text contains a credible, actionable business signal for this company.
- Extract one concise factual signal. Do not repeat the whole article.
- Extract dealStage (intent, announced, or closed) and dealType when acquisition activity is present. Evaluating or pursuing an unnamed deal is intent, never closed.
- Extract capexType as technology, operational, or offices_sites. Manufacturing or API capacity investment is operational unless technology spend is explicitly named.
- Extract publishedDate from the supplied evidence when available; otherwise return null.
- Infer all relevant solution categories, including categories absent from the configured catalog.
- Evaluate the full configured catalog without favoring any preselected category. Return every plausible configured product ID when the evidence fact -> operational need -> product capability chain is credible.
- Positive events can establish a possible-fit category even when they do not prove a purchase. Preserve that distinction in the rationale instead of returning no opportunity.
- Always include useful out-of-catalog solution categories in inferredCategories when the evidence suggests an operational need not covered by the catalog.
- Treat loans, financing, investment, partnerships, acquisitions, and generic growth as account context unless the article also establishes a product-specific operational need.
- Validate workforce direction and units: job cuts, redundancies and existing headcount are not growth; currency, percentages, floor area and installed capacity are not new employees. Require a category-specific operational/deployment mechanism. Office expansion alone never supports industrial or 3D printing.
- Treat procurement as purchase-stage evidence only when the fetched page itself identifies this company as buyer/issuer and contains a current RFP, RFQ, tender, invitation to bid, vendor evaluation, or purchase-order action. Search-result wording alone is insufficient.
- A category mention alone is not enough for Hot: require a direct buying action, a confirmed operational need, or corroborated evidence. Return catalogProductIds only when the fact -> operational need -> product capability chain is defensible.
- Clearly label possible-fit hypotheses rather than confirmed purchases. Never spread a generic event across every catalog category.
- Do not invent systems, budgets, needs, or strategy.
- Use the supplied event type unless the text clearly supports a better event type from the allowed list.
- relevant=false for duplicates, irrelevant mentions, vague marketing copy, or text that does not concern the company.
- Do not assign Hot/Warm/Cold, matrix strength, or attribution. The deterministic rules engine owns those decisions.
- Return JSON only: {"reviews":[{"evidenceId":number,"relevant":boolean,"confidence":0-100,"signalType":"allowed value","extractedSignal":"fact","rationale":"why this is or is not actionable","inferredCategories":["category"],"catalogProductIds":[number],"dealStage":"intent|announced|closed|null","dealType":"company_acquisition|asset_or_plant_acquisition|merger|divestment|null","capexType":"technology|operational|offices_sites|null","publishedDate":"YYYY-MM-DD|null"}]}.`;

  let content: string | undefined;
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_INTENT_MODEL || "gpt-5.4-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a conservative B2B intent analyst. Extract facts, preserve uncertainty, and never invent evidence." },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenAI evidence classification failed with HTTP ${response.status}`);
    content = (await response.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  } else {
    const { openai } = await import("@workspace/integrations-openai-ai-server");
    const response = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a conservative B2B intent analyst. Extract facts, preserve uncertainty, and never invent evidence." },
        { role: "user", content: prompt },
      ],
    }, { timeout: 30_000, maxRetries: 1 });
    content = response.choices[0]?.message?.content ?? undefined;
  }
  const parsed = reviewSchema.safeParse(JSON.parse(content ?? "{}"));
  if (!parsed.success) return evidence.map(row => addGrowthOpportunityFit(fallbackReview(row), row, products));
  const byId = new Map<number, EvidenceReview>();
  for (const item of parsed.data.reviews) {
    if (!item || typeof item !== "object") continue;
    const id = Number((item as Record<string, unknown>).evidenceId);
    const row = evidence.find(candidate => candidate.id === id);
    if (row) byId.set(id, normalizeReview(item, row));
  }
  return evidence.map(row => addGrowthOpportunityFit(byId.get(row.id) ?? fallbackReview(row), row, products));
}

export async function autoReviewPendingResearch(tenantId: number, accountId: number, limit = 40) {
  if (!researchAnalysisAvailability().analysisConfigured) return { reviewed: 0, approved: 0, rejected: 0, pending: 0 };
  await ensureIntentDefaults(tenantId);
  const [companyResult, productResult, evidenceResult] = await Promise.all([
    pool.query<{ name: string; domain: string | null }>("SELECT name,domain FROM companies WHERE tenant_id=$1 AND id=$2", [tenantId, accountId]),
    pool.query<{ id: number; name: string; category: string; subcategory: string | null }>(
      `SELECT p.id,p.name,c.name AS category,s.name AS subcategory
         FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
        WHERE p.tenant_id=$1 AND p.active=true ORDER BY c.name,p.name LIMIT 250`,
      [tenantId],
    ),
    pool.query<PendingEvidence>(
       `SELECT id,event_type,excerpt,source_url,occurred_at,context,raw_evidence
         FROM intent_evidence
        WHERE tenant_id=$1 AND account_id=$2 AND evidence_kind='public_event' AND review_status='pending_review'
        ORDER BY occurred_at DESC,id DESC`,
      [tenantId, accountId],
    ),
  ]);
  const company = companyResult.rows[0];
  if (!company || !evidenceResult.rows.length) return { reviewed: 0, approved: 0, rejected: 0, pending: 0 };

   // Limit the reviewable batch, not the audit records examined. Otherwise a
   // full newest batch of retained foreign evidence permanently hides older India evidence.
   const eligible = evidenceResult.rows.filter(row => isResearchGeographyEligible({...row, companyName: company.name}))
     .slice(0, Math.max(1, Math.min(limit, 40)));
   const geographyBlocked = evidenceResult.rows.length - eligible.length;
   // Preserve out-of-market evidence pending for audit, without AI/provider calls.
   if (!eligible.length) return { reviewed: 0, approved: 0, rejected: 0, pending: geographyBlocked };
   const evidenceById = new Map(eligible.map(row => [row.id, row]));
  const allowedProductIds = new Set(productResult.rows.map(row => row.id));
  let reviews: EvidenceReview[];
  try {
    reviews = await classify(company, productResult.rows, eligible);
  } catch {
    // Do not leave a whole account stuck because OpenAI timed out or returned malformed JSON.
    // Provider-normalized research is still useful evidence, so retain it with a conservative
    // non-product opportunity theme and make the failure visible in the audit context.
    reviews = eligible.map(row => {
      const fallback = addGrowthOpportunityFit(fallbackReview(row), row, productResult.rows);
      return {
        ...fallback,
        rationale: `${fallback.rationale} Automatic AI review was unavailable for this batch; this classification is a conservative fallback.`,
      };
    });
  }
  const client = await pool.connect();
  let approved = 0, rejected = 0, pending = geographyBlocked;
  try {
    await client.query("BEGIN");
    for (const review of reviews) {
      const evidence = evidenceById.get(review.evidenceId);
      if (!evidence) continue;
      const productIds = [...new Set(review.catalogProductIds.filter(id => allowedProductIds.has(id)))];
      const primaryProductId = productIds[0] ?? null;
      const attributed = !isUnattributedProcurement({
        eventType: evidence.event_type,
        searchKind: typeof evidence.context?.searchKind === "string" ? evidence.context.searchKind : null,
        excerpt: evidence.excerpt,
        sourceUrl: evidence.source_url,
        companyName: company.name,
        companyDomain: company.domain,
      });
      const reviewStatus = review.relevant && attributed ? "approved" : "rejected";
      let signalId: number | null = null;
      if (reviewStatus === "approved" && productIds.length) {
        const type = await client.query<{ id: number }>("SELECT id FROM intent_signal_types WHERE tenant_id=$1 AND key=$2", [tenantId, review.signalType]);
        for (const matchedProductId of productIds) {
          const rowHash = `${evidence.id}:ai:${matchedProductId}`;
          const fitment = review.fitments?.find(item => item.productId === matchedProductId);
          const signal = await client.query<{ id: number }>(
            `INSERT INTO intent_signals(tenant_id,product_id,signal_type_id,account_id,source,row_hash,summary,strength,occurred_at,payload)
             VALUES($1,$2,$3,$4,'public_event',$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING RETURNING id`,
            [tenantId, matchedProductId, type.rows[0]?.id, accountId, rowHash, review.extractedSignal, review.confidence, evidence.occurred_at, {
              evidenceId: evidence.id,
              sourceUrl: evidence.source_url,
              inferredCategories: review.inferredCategories,
              catalogProductIds: productIds,
              rationale: review.rationale,
              fitmentPoints: fitment?.points,
              fitmentLevel: fitment?.level,
              fitmentRelevance: fitment?.relevance,
              fitmentReason: fitment?.reason,
            }],
          );
          const matchedSignalId = signal.rows[0]?.id ?? (await client.query<{ id: number }>(
            "SELECT id FROM intent_signals WHERE tenant_id=$1 AND source='public_event' AND row_hash=$2",
            [tenantId, rowHash],
          )).rows[0]?.id ?? null;
          if (matchedProductId === primaryProductId) signalId = matchedSignalId;
        }
      }
      await client.query(
        `UPDATE intent_evidence
            SET signal_id=$1,product_id=$2,event_type=$3,excerpt=$4,confidence=$5,review_status=$6,
                reviewed_at=CASE WHEN $6='pending_review' THEN NULL ELSE NOW() END,
                context=context || $7::jsonb
          WHERE tenant_id=$8 AND id=$9 AND review_status='pending_review'`,
        [signalId, primaryProductId, review.signalType, review.extractedSignal, review.confidence, reviewStatus, JSON.stringify({
          aiReview: {
            relevant: review.relevant,
            confidence: review.confidence,
            rationale: review.rationale,
            inferredCategories: review.inferredCategories,
            catalogProductIds: productIds,
            catalogMatched: productIds.length > 0,
            fitments: review.fitments ?? [],
            dealStage: review.dealStage,
            dealType: review.dealType,
            capexType: review.capexType,
            publishedDate: review.publishedDate,
            reviewedBy: "openai",
          },
          originalExcerpt: evidence.excerpt,
          researchGeography: researchGeographyAssessment({...evidence, companyName: company.name}),
        }), tenantId, evidence.id],
      );
      if (reviewStatus === "approved") approved += 1;
      else if (reviewStatus === "rejected") rejected += 1;
      else pending += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { reviewed: reviews.length, approved, rejected, pending };
}
