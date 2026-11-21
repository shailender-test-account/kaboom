import { pool } from "@workspace/db";
import { attachHpContact, ensureHpProfile, field, isHpClient, positiveProduct, queueHpMatch, resolveHpAccount, saveHpRecord, text } from "./hpBiImport";

/** Capture declared data, not an inferred opportunity or guessed monetary value. */
export async function captureHpLead(client: any, input: {
  tenantId: number; clientId: number; accountId?: number | null; contactId: number | null;
  newContact?: boolean; sourceKey: string; source: string; occurredAt: string | Date | null;
  fields: Record<string, unknown>; lineage?: unknown; actualLead?: boolean;
}) {
  if (!await isHpClient(input.tenantId, input.clientId, client)) return;
  const { tenantId, clientId, fields } = input;
  const email = text(field(fields, "email")).toLowerCase();
  if (!input.contactId && email) {
    const owner = await client.query("SELECT id FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2", [tenantId, email]);
    if (owner.rowCount) {
      await queueHpMatch(client, tenantId, clientId, input.sourceKey, "Email identity is conflicting or ambiguous; use contact identity review first", input);
      return;
    }
  }
  const name = text(field(fields, "companyName", "company", "company_name", "organization", "organisation", "accountName"));
  const hpId = text(field(fields, "hpId", "UNIQUE ID", "hp_id")) || null;
  const match = input.accountId ? { id: input.accountId, created: false }
    : await resolveHpAccount(client, tenantId, clientId, hpId, name, Boolean(input.contactId));
  if (!match.id) {
    await queueHpMatch(client, tenantId, clientId, input.sourceKey, (match as any).reason || "Missing account identity", input);
    return;
  }
  const owned = await client.query("SELECT name FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id=$3", [tenantId, clientId, match.id]);
  if (!owned.rows[0]) return;
  await ensureHpProfile(client, tenantId, clientId, match.id, owned.rows[0].name, true, input.source);
  if (input.contactId && !await attachHpContact(client, tenantId, clientId, match.id, input.contactId, input.source, Boolean(input.newContact))) {
    await queueHpMatch(client, tenantId, clientId, input.sourceKey, "Contact is already owned by a conflicting account/client or is anonymous", input);
    return;
  }
  // Undated questionnaire responses remain in source history, not fabricated fiscal buckets.
  if (!input.occurredAt) return;
  const rawValue = field(fields, "orderValue", "totalOrderValue", "Total Order Value", "ToV");
  const amount = rawValue === null || text(rawValue) === "" ? null : Number(text(rawValue).replace(/,/g, ""));
  const currency = text(field(fields, "currency", "orderCurrency")).toUpperCase() || null;
  const rawHorizon = field(fields, "horizonMonths", "purchaseTimeframeMonths");
  const months = rawHorizon === null || rawHorizon === "" ? null : Number(rawHorizon);
  const record = {
    kind: "lead", occurredAt: new Date(input.occurredAt).toISOString(),
    product: text(field(fields, "productInterest", "product", "service", "solution")) || null,
    category: text(field(fields, "category")) || null,
    horizonMonths: months !== null && Number.isFinite(months) && months >= 0 ? months : null,
    orderValue: amount !== null && Number.isFinite(amount) && amount >= 0 ? amount : null,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    status: null, sourceName: input.source, externalEventId: input.sourceKey,
  };
  if (input.actualLead !== false) await saveHpRecord(client, tenantId, clientId, match.id, input.contactId,
    record, input.source, input.sourceKey, input.lineage ?? fields);
  if (input.source === "questionnaire") await saveHpRecord(client, tenantId, clientId, match.id, input.contactId,
    { ...record, kind: "other", orderValue: null, currency: null, externalEventId: `${input.sourceKey}:response` },
    input.source, `${input.sourceKey}:response`, input.lineage ?? fields);
}

export async function captureHpJourneyForm(input: {
  tenantId: number; clientId: number; contactId: number | null; newContact: boolean;
  submissionId: number; fields: any[]; data: Record<string, unknown>; occurredAt: Date; configuredLead?: boolean;
}) {
  if (!await isHpClient(input.tenantId, input.clientId)) return;
  const mapped: Record<string, unknown> = { ...input.data };
  for (const f of input.fields) {
    if (input.data[f.id] !== undefined) {
      if (f.mapToContactField) mapped[f.mapToContactField] = input.data[f.id];
      if (f.mapToBiField) mapped[f.mapToBiField] = input.data[f.id];
      if (f.label) mapped[f.label] = input.data[f.id];
    }
  }
  const rawHorizon = field(mapped, "horizonMonths", "timeframe", "purchase horizon", "purchase timeline", "purchase timeframe");
  if (rawHorizon !== null) {
    const { parsePurchaseTimeframeMonths } = await import("./inboundAccounts");
    mapped.horizonMonths = parsePurchaseTimeframeMonths(rawHorizon);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [input.tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [input.tenantId, input.clientId]);
    await captureHpLead(client, { ...input, sourceKey: `form:${input.submissionId}`, source: "journey form", fields: mapped,
      actualLead: Boolean(input.configuredLead || positiveProduct(field(mapped, "productInterest", "product", "service", "solution"))) });
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

/** Identified journey visitors can add accounts, but a page view is never a lead. */
export async function linkHpJourneyIdentity(tenantId: number, clientId: number, contactId: number | null) {
  if (!contactId || !await isHpClient(tenantId, clientId)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
    const c = (await client.query(`SELECT company_name,company_id,client_id FROM contacts WHERE tenant_id=$1 AND id=$2 AND NOT is_anonymous FOR UPDATE`,
      [tenantId, contactId])).rows[0];
    if (c && (c.client_id === null || Number(c.client_id) === clientId)) {
      await captureHpLead(client, { tenantId, clientId, accountId: c.company_id, contactId,
        sourceKey: `identified-contact:${contactId}`, source: "identified journey contact", occurredAt: null,
        fields: { companyName: c.company_name }, actualLead: false });
    }
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
