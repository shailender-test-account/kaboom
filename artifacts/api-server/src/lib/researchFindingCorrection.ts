import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { reassessResearchFinding, type StoredResearchFinding } from "./researchFindingReassessment";
import { RESEARCH_FITMENT_POLICY_VERSION, rebuildStoredResearchOpportunityLocally } from "./researchOpportunityInterpreter";
import type { SignalProduct } from "./signalProductFit";

type Actor = { id: number; tenantId: number; role: string };
type Finding = StoredResearchFinding & {
  accountId: number; signalId: number | null; occurredAt: Date; confidence: number;
  rawEvidence: { excerpt?: string } | null; reviewedBy: number | null; reviewedAt: Date | null;
};
type Signal = {
  id: number; productId: number | null; signalTypeId: number; source: string;
  payload: Record<string, any>; shared: boolean; [key: string]: unknown;
};
export class ResearchCorrectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function authorize(actor: Actor) {
  if (actor.role !== "admin") throw new ResearchCorrectionError(403, "Admins only");
}
function canonical(value: any): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function correctionSourceVersion(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function evidenceOwnsSignal(row: Finding, signal: Signal) {
  const owner = signal.payload?.evidenceId;
  return signal.source === "public_event" && !signal.shared
    && (owner == null ? signal.id === row.signalId : String(owner) === String(row.id));
}
async function account(client: PoolClient, actor: Actor, accountId: number) {
  authorize(actor);
  const result = await client.query("SELECT id FROM companies WHERE tenant_id=$1 AND id=$2 FOR SHARE", [actor.tenantId, accountId]);
  if (!result.rows.length) throw new ResearchCorrectionError(404, "Account not found in this tenant");
}
async function snapshot(client: PoolClient, tenantId: number, accountId: number, evidenceId: number) {
  const row = (await client.query<Finding>(`SELECT id,account_id AS "accountId",signal_id AS "signalId",
    event_type AS "eventType",excerpt,source_url AS "sourceUrl",review_status AS "reviewStatus",
    product_id AS "productId",context,raw_evidence AS "rawEvidence",occurred_at AS "occurredAt",confidence,
    reviewed_by AS "reviewedBy",reviewed_at AS "reviewedAt"
    FROM intent_evidence WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND evidence_kind='public_event' FOR UPDATE`,
  [tenantId, accountId, evidenceId])).rows[0];
  if (!row) throw new ResearchCorrectionError(404, "Public research finding not found for this account");
  if (row.reviewStatus !== "approved") throw new ResearchCorrectionError(409, "Only approved public research can be corrected");
  const signals = (await client.query<Signal>(`SELECT s.*,s.product_id AS "productId",s.signal_type_id AS "signalTypeId",
    EXISTS(SELECT 1 FROM intent_evidence other WHERE other.tenant_id=s.tenant_id AND other.signal_id=s.id AND other.id<>$3) AS shared
    FROM intent_signals s WHERE s.tenant_id=$1 AND s.account_id=$2
      AND (s.payload->>'evidenceId'=$3::text OR s.id=$4) ORDER BY s.id FOR UPDATE OF s`,
  [tenantId, accountId, evidenceId, row.signalId])).rows;
  const catalog = (await client.query<SignalProduct>(`SELECT p.id,p.name,c.name AS category,s.name AS subcategory
    FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
    LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    WHERE p.tenant_id=$1 AND p.active=true ORDER BY p.id FOR SHARE OF p,c`, [tenantId])).rows;
  const originalExcerpt = row.rawEvidence?.excerpt || row.context?.originalExcerpt;
  if (typeof originalExcerpt !== "string" || !originalExcerpt.trim()) {
    throw new ResearchCorrectionError(409, "Original provider facts are unavailable; this finding cannot be applied");
  }
  const sourceVersion = correctionSourceVersion({ row, signals, catalog, policy: RESEARCH_FITMENT_POLICY_VERSION });
  const owned = signals.filter(signal => evidenceOwnsSignal(row, signal));
  const protectedSignals = signals.filter(signal => !evidenceOwnsSignal(row, signal));
  const proposal = reassessResearchFinding({ ...row, linkedSignalProductIds: owned
    .map(signal => signal.productId).filter((id): id is number => id != null),
    context: { ...row.context, originalExcerpt } }, catalog);
  return { row, signals, owned, sourceVersion, proposal: {
    ...proposal, policyVersion: RESEARCH_FITMENT_POLICY_VERSION, sourceVersion,
    exactRemovals: {
      // All owned signals are replaced, including supported products whose fitment points changed.
      signals: owned.map(signal => ({ id: signal.id, productId: signal.productId, source: signal.source, payload: signal.payload })),
      productIds: proposal.proposed.removedProductIds,
      primaryProductId: row.productId,
      primarySignalId: row.signalId,
    },
    protectedSignals: protectedSignals.map(signal => ({ id: signal.id, productId: signal.productId, source: signal.source, shared: signal.shared })),
  } };
}

/** Generates one durable, expiring proposal. JSON command exports cannot call the apply path. */
export async function proposeResearchCorrection(actor: Actor, accountId: number, evidenceId: number) {
  authorize(actor);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await account(client, actor, accountId);
    const current = await snapshot(client, actor.tenantId, accountId, evidenceId);
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    await client.query(`INSERT INTO intent_research_corrections(id,tenant_id,account_id,evidence_id,source_version,proposal,proposed_by,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [
      proposalId, actor.tenantId, accountId, evidenceId, current.sourceVersion, JSON.stringify(current.proposal), actor.id, expiresAt,
    ]);
    await client.query("COMMIT");
    return { proposalId, expiresAt, ...current.proposal };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

export type CorrectionApproval = {
  proposalId: string; evidenceId: number; sourceVersion: string; approved: true; reason: string;
};
export async function applyResearchCorrection(actor: Actor, accountId: number, input: CorrectionApproval) {
  authorize(actor);
  if (input.approved !== true || !input.reason?.trim() || input.reason.trim().length < 8) {
    throw new ResearchCorrectionError(400, "Explicit per-finding approval and a review reason are required");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Match the research-view refresh lock to serialize concurrent corrections.
    await client.query("SELECT pg_advisory_xact_lock($1,$2)", [actor.tenantId, accountId]);
    await account(client, actor, accountId);
    const saved = (await client.query<{ evidence_id: number; source_version: string; proposal: unknown; status: string; expires_at: Date }>(
      `SELECT evidence_id,source_version,proposal,status,expires_at FROM intent_research_corrections
       WHERE id=$1 AND tenant_id=$2 AND account_id=$3 FOR UPDATE`, [input.proposalId, actor.tenantId, accountId])).rows[0];
    if (!saved) throw new ResearchCorrectionError(404, "Server-issued correction proposal not found");
    if (saved.status !== "proposed") throw new ResearchCorrectionError(409, "This proposal was already applied");
    if (saved.expires_at.getTime() <= Date.now()) throw new ResearchCorrectionError(409, "Proposal expired. Preview this finding again");
    if (saved.evidence_id !== input.evidenceId || saved.source_version !== input.sourceVersion) {
      throw new ResearchCorrectionError(409, "Approval does not match this finding and source version");
    }
    const current = await snapshot(client, actor.tenantId, accountId, input.evidenceId);
    if (current.sourceVersion !== saved.source_version || canonical(current.proposal) !== canonical(saved.proposal)) {
      throw new ResearchCorrectionError(409, "Source, signals or catalog changed. Preview and approve again");
    }
    // Never detach a primary signal owned by another source or shared finding.
    if (current.proposal.protectedSignals.some(signal => signal.id === current.row.signalId)) {
      throw new ResearchCorrectionError(409, "The primary signal is shared or not public-research owned; correction is blocked");
    }
    const fitments = current.proposal.proposed.fitments;
    const correctedSignalType = current.proposal.proposed.eventType ?? current.row.context?.aiReview?.signalType ?? null;
    let signalTypeId: number | undefined;
    if (fitments.length) {
      // Resolve the corrected event, never reuse a type belonging to the old classification.
      signalTypeId = (await client.query<{ id: number }>(
        "SELECT id FROM intent_signal_types WHERE tenant_id=$1 AND key=$2",
        [actor.tenantId, correctedSignalType])).rows[0]?.id;
      if (!signalTypeId) throw new ResearchCorrectionError(409, "No configured public-research signal type. Nothing was changed");
    }
    const removedSignalIds = current.owned.map(signal => signal.id);
    if (removedSignalIds.length) await client.query(`DELETE FROM intent_signals WHERE tenant_id=$1 AND account_id=$2
      AND source='public_event' AND id=ANY($3::int[])`, [actor.tenantId, accountId, removedSignalIds]);
    const addedSignals: Array<{ id: number; productId: number }> = [];
    for (const fit of fitments) {
      const added = await client.query<{ id: number }>(`INSERT INTO intent_signals
        (tenant_id,account_id,product_id,signal_type_id,source,row_hash,summary,strength,occurred_at,payload)
        VALUES($1,$2,$3,$4,'public_event',$5,$6,$7,$8,$9::jsonb) RETURNING id`, [
        actor.tenantId, accountId, fit.productId, signalTypeId, `${input.evidenceId}:correction:${input.proposalId}:${fit.productId}`,
        current.proposal.sourceFact, Math.max(0, Math.min(100, current.row.confidence)), current.row.occurredAt,
        JSON.stringify({ evidenceId: input.evidenceId, sourceUrl: current.row.sourceUrl, catalogProductIds: fitments.map(f => f.productId),
          fitmentPoints: fit.points, fitmentLevel: fit.level, fitmentRelevance: fit.relevance, fitmentReason: fit.reason,
          correctionId: input.proposalId, policyVersion: RESEARCH_FITMENT_POLICY_VERSION }),
      ]);
      addedSignals.push({ id: added.rows[0].id, productId: fit.productId });
    }
    const aiReview = { ...(current.row.context?.aiReview ?? {}), signalType: correctedSignalType,
      fitments, catalogProductIds: fitments.map(f => f.productId),
      inferredCategories: [...new Set(fitments.map(f => f.category))], correctionId: input.proposalId,
      rationale: current.proposal.reason, extractedSignal: current.proposal.sourceFact };
    await client.query(`UPDATE intent_evidence SET product_id=$1,signal_id=$2,event_type=$3,
      context=(context-'opportunityBrief')||jsonb_build_object('aiReview',$4::jsonb,'researchCorrectionId',$5::text)
      WHERE tenant_id=$6 AND account_id=$7 AND id=$8 AND evidence_kind='public_event'`, [
      fitments[0]?.productId ?? null, addedSignals[0]?.id ?? null, current.proposal.proposed.eventType,
      JSON.stringify(aiReview), input.proposalId, actor.tenantId, accountId, input.evidenceId,
    ]);
    // reviewed_by is an existing account-attribution permission, not fitment approval.
    // Preserve it and reviewed_at exactly; the correction's own audit holds reviewer and time.
    const delta = { removedSignalIds, addedSignals, removedProductIds: current.proposal.proposed.removedProductIds };
    await client.query(`UPDATE intent_research_corrections SET status='applied',approved_by=$1,reason=$2,
      applied_delta=$3::jsonb,applied_at=NOW() WHERE id=$4 AND tenant_id=$5`, [
      actor.id, input.reason.trim(), JSON.stringify(delta), input.proposalId, actor.tenantId,
    ]);
    await client.query("COMMIT");
    return { applied: true as const, evidenceId: input.evidenceId, proposalId: input.proposalId, delta };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined); throw error;
  } finally { client.release(); }
}

/** Research-only derived views. Deliberately no CRM recomputation, routing or BI writers. */
export async function refreshCorrectedResearch(tenantId: number, accountId: number) {
  await rebuildStoredResearchOpportunityLocally(tenantId, accountId, true);
}
