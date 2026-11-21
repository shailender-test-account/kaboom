import { pool } from "@workspace/db";
import { splitSelections } from "./inboundAccounts";
import { inboundCategoryForInterest, loadInboundCategoryRules, type InboundCategoryConfig } from "./inboundTaxonomy";
import { isFreshPublicResearchEvidence } from "./researchFreshness";
import { normalizedResearchEvidenceKey } from "./researchIntentEvidence";
import { analyzeProductFitment } from "./signalProductFit";
import { researchSourceText } from "./researchSourceFacts";

type ContactRow = {
  id: number; first_name: string | null; last_name: string | null; lead_score: number;
};
type AnswerRow = {
  contact_id: number; product_interest: string | null; affinity_reviews: Record<string, unknown> | null;
};
type SelectedSignalRow = {
  contact_id: number; product_name: string | null; category_name: string | null; answer: string | null;
};
type CatalogProduct = { id: number; name: string; category: string };
type EvidenceRow = {
  id: number; event_type: string | null; occurred_at: Date; source_url: string | null;
  excerpt: string | null; confidence: number; context: Record<string, any> | null;
};

export type ContactAdditiveScore = {
  id: number; name: string; journeyPoints: number; affinityPoints: number;
  total: number; affinities: string[];
};
export type AccountSignalPoints = {
  evidenceId: number; eventType: string; occurredAt: Date; sourceUrl: string;
  category: string; productName: string; reason: string; points: 5;
};

const emptyAnswer = /^(?:n\/?a|none|no|nil|not interested|-+)$/i;
const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const eligibleCategory = (category: string) =>
  category !== "Needs categorization" && category !== "No Category";

/** An explicit answer earns one +10 award per contact, regardless of how many times it was submitted. */
export function contactAffinityLabels(
  answers: AnswerRow[],
  selectedSignals: SelectedSignalRow[],
  catalog: CatalogProduct[],
  categoryRules: InboundCategoryConfig,
) {
  const names = new Map<string, CatalogProduct>();
  const categories = new Set(catalog.map(product => normalized(product.category)));
  for (const product of catalog) names.set(normalized(product.name), product);
  const labels = new Map<number, Set<string>>();
  const add = (contactId: number, selection: string, reviews?: Record<string, unknown> | null) => {
    if (!selection.trim() || emptyAnswer.test(selection.trim()) || reviews?.[selection] === "rejected") return;
    const exact = names.get(normalized(selection));
    const assigned = inboundCategoryForInterest(selection, reviews, categoryRules);
    const category = exact?.category ?? (categories.has(normalized(selection)) ? selection : assigned.categoryName);
    if (!eligibleCategory(category)) return;
    const label = exact?.name ?? assigned.productName;
    const current = labels.get(contactId) ?? new Set<string>();
    current.add(label);
    labels.set(contactId, current);
  };
  for (const answer of answers)
    for (const selection of splitSelections(answer.product_interest)) add(answer.contact_id, selection, answer.affinity_reviews);
  for (const signal of selectedSignals) {
    if (signal.product_name && signal.category_name) add(signal.contact_id, signal.product_name);
    else for (const selection of splitSelections(signal.answer)) add(signal.contact_id, selection);
  }
  return new Map([...labels].map(([id, selections]) => [id, [...selections].sort()]));
}

/** Only recent, reviewed, product-linked news with a concrete fact-to-need explanation earns +5. */
export function scoredAccountSignals(rows: EvidenceRow[], catalog: CatalogProduct[], now = new Date()): AccountSignalPoints[] {
  const products = new Map(catalog.map(product => [product.id, product]));
  const seenSources = new Set<string>(), seenFacts = new Set<string>();
  const results: AccountSignalPoints[] = [];
  for (const row of rows) {
    const review = row.context?.aiReview;
    if (!row.event_type || !row.source_url || !row.excerpt
      || !isFreshPublicResearchEvidence(row.excerpt, row.occurred_at, now)
      || review?.relevant !== true || Number(review.confidence) < 70
      || !Array.isArray(review.fitments)
      || /automatic ai review was unavailable|specific product need should be validated in discovery/i.test(String(review.rationale ?? ""))) continue;
    const fitment = review.fitments
      .filter((fit: any) => (fit?.level === "confirmed_need" || fit?.level === "direct_intent")
        && Number(fit.points) > 0 && String(fit.reason ?? "").trim().length >= 35
        && products.has(Number(fit.productId)))
      .filter((fit: any) => {
        const product=products.get(Number(fit.productId))!;
        const supported=analyzeProductFitment({eventType:row.event_type,text:researchSourceText(row.excerpt,row.context??{})},
          {...product,subcategory:null});
        return supported && ["confirmed_need","direct_intent"].includes(supported.level);
      })
      .sort((a: any, b: any) => Number(b.points) - Number(a.points))[0];
    if (!fitment) continue;
    const sourceKey = normalizedResearchEvidenceKey({ sourceUrl: row.source_url });
    const fact = researchSourceText(row.excerpt,row.context??{}).trim();
    const factKey = `${row.event_type}:${row.occurred_at.toISOString().slice(0, 10)}:${normalized(fact).slice(0, 220)}`;
    if (seenSources.has(sourceKey) || seenFacts.has(factKey)) continue;
    seenSources.add(sourceKey);
    seenFacts.add(factKey);
    const product = products.get(Number(fitment.productId))!;
    results.push({
      evidenceId: row.id, eventType: row.event_type, occurredAt: row.occurred_at,
      sourceUrl: row.source_url, category: product.category, productName: product.name,
      reason: `${fact.slice(0, 240)} — ${String(fitment.reason).trim()}`,
      points: 5,
    });
  }
  return results;
}

async function contactScores(tenantId: number, contacts: ContactRow[], accountId: number | null) {
  if (!contacts.length) return [] as ContactAdditiveScore[];
  const ids = contacts.map(contact => contact.id);
  const [answers, selected, products, categoryRules] = await Promise.all([
    pool.query<AnswerRow>(`SELECT contact_id,product_interest,affinity_reviews
      FROM intent_inbound_submissions
      WHERE tenant_id=$1 AND contact_id=ANY($2::int[]) AND ($3::int IS NULL OR account_id=$3)`,
      [tenantId, ids, accountId]),
    pool.query<SelectedSignalRow>(`SELECT s.contact_id,p.name AS product_name,pc.name AS category_name,
        s.payload->'answer'->>'value' AS answer
      FROM intent_signals s
      JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
      LEFT JOIN intent_products p ON p.id=s.product_id AND p.tenant_id=s.tenant_id AND p.active=true
      LEFT JOIN intent_product_categories pc ON pc.id=p.category_id AND pc.tenant_id=p.tenant_id
      WHERE s.tenant_id=$1 AND s.contact_id=ANY($2::int[]) AND st.key='questionnaire_product_interest'
        AND ($3::int IS NULL OR s.account_id IS NULL OR s.account_id=$3)`,
      [tenantId, ids, accountId]),
    pool.query<CatalogProduct>(`SELECT p.id,p.name,pc.name AS category
      FROM intent_products p JOIN intent_product_categories pc ON pc.id=p.category_id AND pc.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`, [tenantId]),
    loadInboundCategoryRules(tenantId),
  ]);
  const affinity = contactAffinityLabels(answers.rows, selected.rows, products.rows, categoryRules);
  return contacts.map(contact => {
    const affinities = affinity.get(contact.id) ?? [];
    const journeyPoints = Number(contact.lead_score) || 0;
    const affinityPoints = affinities.length ? 10 : 0;
    return {
      id: contact.id, name: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || `Contact ${contact.id}`,
      journeyPoints, affinityPoints, total: journeyPoints + affinityPoints, affinities,
    };
  });
}

export async function readContactAdditiveScore(tenantId: number, contactId: number) {
  const contact = await pool.query<ContactRow & { company_id: number | null }>(
    `SELECT id,first_name,last_name,lead_score,company_id FROM contacts
     WHERE tenant_id=$1 AND id=$2 AND is_anonymous=false`, [tenantId, contactId]);
  if (!contact.rows[0]) return null;
  return (await contactScores(tenantId, contact.rows, contact.rows[0].company_id))[0];
}

export async function readAccountAdditiveScore(tenantId: number, accountId: number) {
  const account = await pool.query<{ id: number }>(
    "SELECT id FROM companies WHERE tenant_id=$1 AND id=$2", [tenantId, accountId]);
  if (!account.rows[0]) return null;
  const [contacts, evidence, products] = await Promise.all([
    pool.query<ContactRow>(`SELECT id,first_name,last_name,lead_score FROM contacts
      WHERE tenant_id=$1 AND company_id=$2 AND is_anonymous=false ORDER BY id`, [tenantId, accountId]),
    pool.query<EvidenceRow>(`SELECT id,event_type,occurred_at,source_url,excerpt,confidence,context
      FROM intent_evidence
      WHERE tenant_id=$1 AND account_id=$2 AND contact_id IS NULL AND review_status='approved'
        AND evidence_kind='public_event' AND occurred_at>=NOW()-INTERVAL '3 months'
      ORDER BY occurred_at DESC,id DESC`, [tenantId, accountId]),
    pool.query<CatalogProduct>(`SELECT p.id,p.name,pc.name AS category
      FROM intent_products p JOIN intent_product_categories pc ON pc.id=p.category_id AND pc.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`, [tenantId]),
  ]);
  const [contactRows, signals] = await Promise.all([
    contactScores(tenantId, contacts.rows, accountId),
    Promise.resolve(scoredAccountSignals(evidence.rows, products.rows)),
  ]);
  const contactPoints = contactRows.reduce((total, contact) => total + contact.total, 0);
  const accountSignalPoints = signals.length * 5;
  return { accountId, total: contactPoints + accountSignalPoints, contactPoints,
    accountSignalPoints, contacts: contactRows, signals };
}