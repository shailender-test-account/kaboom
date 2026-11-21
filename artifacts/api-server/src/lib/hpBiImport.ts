import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { pool } from "@workspace/db";
import { isHpClientName } from "./hpClientScope";
import type { PoolClient } from "pg";
import { inboundCategories } from "./inboundTaxonomy";
import { matchHpRoster, rosterIdentityKey } from "./hpRosterMatch";
import { readHpWorkbook, type HpParsedWorkbook } from "./hpWorkbookReader.mjs";
import { readHpWorkbookAsync } from "./hpWorkbookAsync";
export { readHpWorkbook, readHpWorkbookAsync };

export const hpDimensions: Record<string, string> = {
  hp_id: "UNIQUE ID", deployment: "Deployment", gtm: "FY25 GTM", account_group: "GROUP",
  state_ut: "STATE/UT", zone: "ZONE", parent_sub: "PARENT/ SUB", top_id: "TOP_ID", top_name: "TOP_NAME",
  mid_id: "MID ID", mid_name: "MID_NAME", act_st: "ACT ST", st_name: "ST NAME",
  partial_st: "PARTIAL ST", partial_name: "PARTIAL_NAME", org_id: "ORG ID", opsi: "OPSI",
  legal_name: "SUBSIDIARY_LEGAL_NAME", city: "CITY", state: "STATE",
  relationship_link: "PARENT SUBSIDIARY RELATIONSHIP LINK", industry_vertical: "INDUSTRY VERTICAL",
  industry_segment: "INDUSTRY SEGMENT", hpi_segment: "HPI ACCT SEGMENT", e_cat: "E CAT",
  emp_size: "EMP SIZE", ps_tam_k: "PS TAM ($K)", prt_tam_k: "PRT TAM ($K)",
  ps_rad: "PS RAD", prt_rad: "PRT RAD", rtm_ps: "RTM - PS", ps_partners: 'PS PARTNERS (SEPRATED BY "/")',
  rtm_print: "RTM - PRINT", print_partners: 'PRINT PARTNERS (SEPRATED BY "/")',
  eam_email: "EAM email-ID", pam_email: "PAM email-ID", rm_email: "RM email-ID", isr_email: "ISR email-ID",
  zm_email: "ZM email-ID", poly_am_email: "Poly AM EMAIL-id", poly_mgr_email: "PolyMgr Email_ID",
};
export const hpContextFields: Record<string, string> = { top_200: "top200", abm_classification: "abmClassification",
  global_account: "globalAccount", profiled: "profiled", buying_behavior: "buyingBehavior", propensity: "propensity",
  buyer_categories: "buyerCategories", whitespace_categories: "whitespaceCategories" };
const list = (v: unknown) => Array.isArray(v) ? v.map(text).filter(Boolean) : usable(v) ? text(v).split(/[,;|\n]/).map(text).filter(Boolean) : null;
function contextFields(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(hpContextFields).map(([key, label]) => {
    const raw = field(row, label, key);
    return [key, /categories$/.test(key) ? list(raw) : ["top_200", "global_account", "profiled"].includes(key)
      ? usable(raw) ? /^(yes|true|1)$/i.test(text(raw)) : null : usable(raw) ? text(raw) : null];
  }));
}
export const text = (v: unknown) => String(v ?? "").trim();
export const norm = (v: unknown) => text(v).toLowerCase().replace(/[^a-z0-9]/g, "");
export const usable = (v: unknown) => text(v) && !/^(?:-|n\/?a|null|none)$/i.test(text(v));
export const positiveProduct = (v: unknown) => text(v).split(/[,;|\n]/).some(answer =>
  !["", "na", "none", "no", "nil", "notinterested", "nocategory", "noproduct", "noproductselected", "noservice", "notapplicable"]
    .includes(answer.toLowerCase().trim().replace(/[^a-z]/g, "")));
export const hpLeadStatus = (product: unknown, months: unknown): "hot" | "warm" | "cold" => {
  if (!positiveProduct(product) || months === null || months === undefined
    || (typeof months !== "number" && typeof months !== "string")
    || String(months).trim() === "") return "cold";
  const horizon = Number(months);
  if (!Number.isFinite(horizon) || horizon < 0 || horizon > 6) return "cold";
  return horizon <= 3 ? "hot" : "warm";
};
export function normalizeRad(v: unknown) {
  const raw = text(v).toUpperCase();
  return /^R[123]?$/.test(raw) || raw === "RETENTION" ? "Retention"
    : /^A[123]?$/.test(raw) || raw === "ACQUISITION" ? "Acquisition"
    : /^D[123]?$/.test(raw) || raw === "DEVELOPMENT" ? "Development" : "Unknown";
}
export function fiscalBounds(year: number) {
  return { start: `${year - 1}-11-01T00:00:00+05:30`, end: `${year}-11-01T00:00:00+05:30` };
}
export async function isHpClient(tenantId: number, clientId: number, client: any = pool) {
  const result = await client.query("SELECT id,name FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, clientId]);
  const row = result.rows[0];
  return row && isHpClientName(row.name) ? row : null;
}
export type SheetRow = { sheet: string; row: number; values: Record<string, unknown> };
export function field(row: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (row[name] !== undefined && text(row[name]) !== "") return row[name];
  const nameSet = new Set(names.map(norm));
  const key = Object.keys(row).find(k => nameSet.has(norm(k)));
  return key ? row[key] : null;
}
export function accountDimensions(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(hpDimensions).map(([key, label]) => [key, text(field(row, key, label)) || null]));
}
export function accountName(row: Record<string, unknown>) {
  return text(field(row, "accountName", "legal_name", hpDimensions.legal_name, "ST NAME", "PARTIAL_NAME", "MID_NAME", "TOP_NAME"));
}
export function occurrence(v: unknown): string | null {
  if (!usable(v)) return null;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}T${String(d.H).padStart(2, "0")}:${String(d.M).padStart(2, "0")}:${String(Math.floor(d.S)).padStart(2, "0")}+05:30` : null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const raw = text(v);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+05:30`
    : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw.replace(" ", "T")}+05:30` : raw;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}
export const activityKinds = ["invitation", "attendance", "digital", "content", "other", "interest", "lead", "opportunity", "closed_won"];
export function recordFromRow(row: Record<string, unknown>) {
  const number = (v: unknown) => usable(v) ? Number(text(v).replace(/,/g, "")) : null;
  return {
    kind: text(field(row, "kind", "activityType")).toLowerCase(),
    occurredAt: occurrence(field(row, "occurredAt", "date", "submittedAt")),
    category: text(field(row, "category")) || null, product: text(field(row, "product", "productInterest", "service")) || null,
    horizonMonths: number(field(row, "horizonMonths", "purchase horizon months")),
    orderValue: number(field(row, "orderValue", "Total Order Value", "ToV")),
    currency: text(field(row, "currency")).toUpperCase() || null,
    sourceName: text(field(row, "sourceName", "program", "campaign")) || null,
    status: text(field(row, "status")) || null,
    externalEventId: text(field(row, "externalEventId")) || null,
  };
}
export function previewHpImport(bytes: Buffer, kind: string, mappings: Record<string, string>, prepared?: HpParsedWorkbook) {
  const parsed = prepared ?? readHpWorkbook(bytes, kind, mappings);
  const errors: string[] = [], warnings: string[] = [];
  parsed.rows.forEach(({ values, sheet, row }) => {
    if (kind === "accounts") {
      if (!accountName(values)) errors.push(`${sheet} row ${row}: account name required.`);
      if (!usable(field(values, "hp_id", "hpId", "UNIQUE ID"))) warnings.push(`${sheet} row ${row}: missing HP ID; exact owned account-name matching only, with incomplete context flagged.`);
      for (const key of ["top200", "globalAccount", "profiled"]) {
        const raw = field(values, key);
        if (usable(raw) && !/^(yes|no|true|false|0|1)$/i.test(text(raw))) errors.push(`${sheet} row ${row}: ${key} must be yes/no or true/false.`);
      }
      const buyers = list(field(values, "buyerCategories")) ?? [], whitespace = list(field(values, "whitespaceCategories")) ?? [];
      if (buyers.some(b => whitespace.includes(b))) errors.push(`${sheet} row ${row}: a category cannot be both buyer and whitespace.`);
    } else {
      const r = recordFromRow(values);
      if (!activityKinds.includes(r.kind) || !r.occurredAt) errors.push(`${sheet} row ${row}: valid kind and occurrence date required.`);
      if ([r.orderValue, r.horizonMonths].some(v => v !== null && (!Number.isFinite(v) || v < 0))) errors.push(`${sheet} row ${row}: values must be non-negative numbers.`);
      if (r.currency && !/^[A-Z]{3}$/.test(r.currency)) errors.push(`${sheet} row ${row}: currency must be a three-letter code.`);
      if (!field(values, "hpId", "hp_id", "UNIQUE ID", "accountName")) errors.push(`${sheet} row ${row}: account identifier required.`);
      if (r.orderValue !== null && !r.currency) warnings.push(`${sheet} row ${row}: value has no currency and will not be totaled.`);
      if (!field(values, "recordId")) errors.push(`${sheet} row ${row}: recordId required for repeatable imports and corrections.`);
    }
  });
  if (!parsed.rows.length) errors.push("No data rows found.");
  if (kind === "accounts") warnings.push("Ownership emails are not prospect contacts. Duplicate IDs consolidate with source-row variants. TAM is not order value.");
  return { rows: parsed.rows.length, uniqueAccounts: new Set(parsed.rows.map(r => text(field(r.values, "hp_id", "hpId", "UNIQUE ID")) || accountName(r.values))).size,
    headers: parsed.headers, samples: parsed.rows.slice(0, 5).map(r => r.values), warnings: warnings.slice(0, 40), errors: errors.slice(0, 40), importKind: kind };
}
/** Validate large uploads without monopolizing the request event loop. */
export async function previewHpImportAsync(bytes: Buffer, kind: string, mappings: Record<string, string>, prepared?: HpParsedWorkbook) {
  const parsed = prepared ?? await readHpWorkbookAsync(bytes, kind, mappings);
  if (parsed.rows.length <= 200) return previewHpImport(bytes, kind, mappings, parsed);
  const accounts = new Set<string>();
  const errors: string[] = [], warnings = new Set<string>();
  let result: ReturnType<typeof previewHpImport> | undefined;
  for (let i = 0; i < parsed.rows.length; i += 200) {
    const rows = parsed.rows.slice(i, i + 200);
    const batch = previewHpImport(bytes, kind, mappings, { rows, headers: parsed.headers });
    result ??= batch;
    errors.push(...batch.errors.slice(0, Math.max(0, 40 - errors.length)));
    batch.warnings.forEach(w => { if (warnings.size < 40) warnings.add(w); });
    rows.forEach(r => accounts.add(text(field(r.values, "hp_id", "hpId", "UNIQUE ID")) || accountName(r.values)));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { ...result!, rows: parsed.rows.length, uniqueAccounts: accounts.size, errors, warnings: [...warnings] };
}
export async function queueHpMatch(client: any, tenantId: number, clientId: number, sourceKey: string, reason: string, payload: unknown) {
  await client.query(`INSERT INTO hp_bi_matches(tenant_id,client_id,source_key,reason,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,client_id,source_key)
    DO UPDATE SET reason=EXCLUDED.reason,payload=EXCLUDED.payload,resolved_account_id=NULL`,
  [tenantId, clientId, sourceKey, reason, JSON.stringify(payload)]);
}
/** No fuzzy/domain matching: IDs or one unambiguous client-owned name only. */
export async function resolveHpAccount(client: any, tenantId: number, clientId: number, hpId: string | null, name: string, create = false) {
  name = name.trim();
  // All HP writers take the same locks as roster imports and CRM deletion.
  // Callers that can create accounts must supply a transaction-owned client.
  await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
  await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
  if (hpId) {
    const canonical = await client.query("SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND hp_id=$3", [tenantId, clientId, hpId]);
    if (canonical.rows[0]) return { id: Number(canonical.rows[0].company_id), created: false };
  }
  const reviewed = await client.query(`SELECT DISTINCT m.resolved_account_id id FROM hp_bi_matches m
    JOIN companies c ON c.id=m.resolved_account_id AND c.tenant_id=m.tenant_id AND c.client_id=m.client_id
    WHERE m.tenant_id=$1 AND m.client_id=$2 AND m.resolved_account_id IS NOT NULL
      AND (($3::text IS NOT NULL AND COALESCE(m.payload->'fields'->>'hpId',m.payload->'values'->>'hpId',
          m.payload->'values'->>'hp_id',m.payload->'values'->>'UNIQUE ID')=$3)
        OR ($3::text IS NULL AND lower(COALESCE(m.payload->'fields'->>'companyName',m.payload->'values'->>'accountName',''))=lower($4)))`,
  [tenantId, clientId, hpId, name]);
  if (reviewed.rows.length === 1) return { id: Number(reviewed.rows[0].id), created: false };
  if (reviewed.rows.length > 1) return { id: null, created: false, reason: "Conflicting reviewed account mappings" };
  if (hpId) {
    // Unknown explicit IDs must be reviewed, not overridden with name matching.
    return { id: null, created: false, reason: "Unknown HP account ID" };
  }
  if (!usable(name)) return { id: null, created: false, reason: "Missing company identity" };
  const found = await client.query(`SELECT DISTINCT c.id FROM companies c LEFT JOIN hp_account_profiles p
    ON p.company_id=c.id AND p.tenant_id=c.tenant_id AND p.client_id=c.client_id
    WHERE c.tenant_id=$1 AND c.client_id=$2 AND (lower(btrim(c.name))=lower($3)
      OR EXISTS(SELECT 1 FROM unnest(p.aliases) a WHERE lower(btrim(a))=lower($3)))`, [tenantId, clientId, name]);
  if (found.rows.length === 1) return { id: Number(found.rows[0].id), created: false };
  if (found.rows.length > 1) return { id: null, created: false, reason: "Ambiguous account alias" };
  if (!create) return { id: null, created: false, reason: "Account not matched" };
  const made = await client.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id", [tenantId, clientId, name]);
  return { id: Number(made.rows[0].id), created: true };
}
export async function ensureHpProfile(client: any, tenantId: number, clientId: number, companyId: number, name: string, isNew: boolean, source: string) {
  await client.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,is_new,provenance,aliases)
    VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY[$5]) ON CONFLICT(tenant_id,client_id,company_id) DO NOTHING`,
  [tenantId, clientId, companyId, `company:${companyId}`, name, isNew, source]);
}

/** Additive repair: every owned HP company participates, even with blank context.
 * Never merge companies or rewrite their contacts, scores, submissions or history. */
export async function ensureHpAccountRegister(tenantId: number, clientId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
    await client.query(`INSERT INTO hp_account_profiles
      (tenant_id,client_id,company_id,parent_key,parent_name,is_new,provenance,aliases)
      SELECT c.tenant_id,c.client_id,c.id,'company:'||c.id,c.name,false,'CRM account register',ARRAY[c.name]
      FROM companies c
      WHERE c.tenant_id=$1 AND c.client_id=$2
        AND NOT EXISTS(SELECT 1 FROM hp_account_profiles p
          WHERE p.tenant_id=c.tenant_id AND p.client_id=c.client_id AND p.company_id=c.id)
      ON CONFLICT(tenant_id,client_id,company_id) DO NOTHING`, [tenantId, clientId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function attachHpContact(client: any, tenantId: number, clientId: number, accountId: number, contactId: number, source: string, isNew: boolean) {
  const result = await client.query(`UPDATE contacts SET company_id=$3,client_id=$2,updated_at=now()
    WHERE tenant_id=$1 AND id=$4 AND (client_id=$2 OR client_id IS NULL)
      AND (company_id=$3 OR company_id IS NULL) AND NOT is_anonymous RETURNING id`,
  [tenantId, clientId, accountId, contactId]);
  if (!result.rowCount) return false;
  await client.query(`INSERT INTO hp_bi_contacts(tenant_id,client_id,contact_id,is_new,source)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,client_id,contact_id) DO NOTHING`,
  [tenantId, clientId, contactId, isNew, source]);
  return true;
}
export async function saveHpRecord(client: any, tenantId: number, clientId: number, accountId: number, contactId: number | null,
  record: ReturnType<typeof recordFromRow>, source: string, sourceKey: string, lineage: unknown) {
  await client.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,category,product,
    horizon_months,order_value,currency,status,source,source_name,source_key,external_event_id,lineage)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    ON CONFLICT(tenant_id,client_id,source_key) DO UPDATE SET account_id=EXCLUDED.account_id,contact_id=EXCLUDED.contact_id,
    kind=EXCLUDED.kind,occurred_at=EXCLUDED.occurred_at,category=EXCLUDED.category,product=EXCLUDED.product,
    horizon_months=EXCLUDED.horizon_months,order_value=EXCLUDED.order_value,currency=EXCLUDED.currency,status=EXCLUDED.status,
    source_name=EXCLUDED.source_name,external_event_id=EXCLUDED.external_event_id,lineage=EXCLUDED.lineage,
    history=CASE WHEN (hp_bi_records.account_id,hp_bi_records.contact_id,hp_bi_records.kind,hp_bi_records.occurred_at,
      hp_bi_records.category,hp_bi_records.product,hp_bi_records.horizon_months,hp_bi_records.order_value,hp_bi_records.currency)
      IS DISTINCT FROM (EXCLUDED.account_id,EXCLUDED.contact_id,EXCLUDED.kind,EXCLUDED.occurred_at,EXCLUDED.category,
      EXCLUDED.product,EXCLUDED.horizon_months,EXCLUDED.order_value,EXCLUDED.currency)
      THEN hp_bi_records.history || jsonb_build_array(jsonb_build_object('correctedAt',now(),'previous',
        to_jsonb(hp_bi_records)-'history')) ELSE hp_bi_records.history END,updated_at=now()`,
  [tenantId, clientId, accountId, contactId, record.kind, record.occurredAt, record.category, record.product,
    record.horizonMonths, record.orderValue, record.currency, record.status, source, record.sourceName, sourceKey, record.externalEventId, JSON.stringify(lineage)]);
}
export function groupHpAccountRows(rows: SheetRow[], fileName: string, grouped = new Map<string, any>(), finalize = true) {
  for (const row of rows) {
    const d = accountDimensions(row.values);
    d.legal_name = accountName(row.values);
    const key = rosterIdentityKey({ hp_id: text(d.hp_id) || null, name: accountName(row.values) });
    d.hp_id = text(d.hp_id) || null;
    const existing = grouped.get(key);
    const variant = { ...row.values, _source: { fileName, sheet: row.sheet, row: row.row } };
    if (existing) { existing.variants.push(variant); existing.aliases = [...new Set([...existing.aliases, accountName(row.values)])]; continue; }
    const parent = usable(d.top_id) && usable(d.top_name) ? { key: `hp-top:${d.top_id}`, name: text(d.top_name) }
      : usable(d.mid_id) && usable(d.mid_name) ? { key: `hp-mid:${d.mid_id}`, name: text(d.mid_name) }
      : { key: `hp:${key}`, name: accountName(row.values) };
    grouped.set(key, { ...d, ...contextFields(row.values), name: accountName(row.values), parent_key: parent.key, parent_name: parent.name,
      dimensions: row.values, variants: [variant], aliases: [accountName(row.values)] });
  }
  if (finalize) finalizeHpHierarchy([...grouped.values()]);
  return grouped;
}
function finalizeHpHierarchy(entries: any[]) {
  // Inconsistent hierarchy IDs stay independent until reviewed.
  for (const entry of entries) {
    const parents = new Set(entry.variants.map((r: any) => {
      const d = accountDimensions(r);
      return usable(d.top_id) && usable(d.top_name) ? `hp-top:${d.top_id}` : usable(d.mid_id) && usable(d.mid_name) ? `hp-mid:${d.mid_id}` : `hp:${rosterIdentityKey(entry)}`;
    }));
    if (parents.size > 1) { entry.parent_key = `hp:${rosterIdentityKey(entry)}`; entry.parent_name = entry.name; entry.dimensions._hierarchyReview = "Conflicting source parent identifiers"; }
  }
}
async function rosterDecisions(client: any, tenantId: number, clientId: number, rows: SheetRow[], fileName: string, context = false) {
  const grouped = new Map<string, any>();
  // Preserve workbook-wide identity/hierarchy matching while yielding between
  // bounded CPU batches. Do not classify each batch as an independent roster.
  for (let i = 0; i < rows.length; i += 200) {
    groupHpAccountRows(rows.slice(i, i + 200), fileName, grouped, false);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const entries = [...grouped.values()];
  for (let i = 0; i < entries.length; i += 200) {
    finalizeHpHierarchy(entries.slice(i, i + 200));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const columns = [...new Set(["company_id", "hp_id", "aliases", "parent_key", "parent_name",
    ...(context ? ["is_new", "dimensions", ...Object.keys(hpDimensions), ...Object.keys(hpContextFields)] : [])])];
  const existing = (await client.query(`SELECT c.id AS "crmId",c.name,${columns.map(c => `p.${c}`).join(",")}
    ${context ? ",jsonb_path_query_array(p.edits,'$[*] ? (exists(@.values))') AS edits" : ""} FROM companies c LEFT JOIN hp_account_profiles p
    ON p.company_id=c.id AND p.tenant_id=c.tenant_id AND p.client_id=c.client_id
    WHERE c.tenant_id=$1 AND c.client_id=$2`, [tenantId, clientId])).rows;
  const reviewed = (await client.query(`SELECT substring(source_key from 8) AS hp_id,resolved_account_id FROM hp_bi_matches
    WHERE tenant_id=$1 AND client_id=$2 AND source_key LIKE 'roster:%' AND resolved_account_id IS NOT NULL`, [tenantId, clientId])).rows;
  return { grouped, existing, decisions: matchHpRoster([...grouped.values()], existing,
    new Map(reviewed.map((r: any) => [r.hp_id, Number(r.resolved_account_id)]))) };
}
export async function previewHpAccountImpact(tenantId: number, clientId: number, bytes: Buffer, mappings: Record<string, string>, prepared?: HpParsedWorkbook) {
  const rows = (prepared ?? await readHpWorkbookAsync(bytes, "accounts", mappings)).rows;
  const { grouped, existing, decisions } = await rosterDecisions(pool, tenantId, clientId, rows, "preview");
  const safe = decisions.filter(d => !d.reason);
  const replaced = new Set(safe.map(d => d.existing?.crmId).filter(Boolean));
  const profiles = existing.filter((e: any) => e.company_id != null);
  return {
    sourceRows: rows.length, legalAccounts: grouped.size, duplicateRows: rows.length - grouped.size,
    sourceParentGroups: new Set([...grouped.values()].map(r => r.parent_key)).size,
    existingMatches: safe.filter(d => d.existing).length, newAccounts: safe.filter(d => !d.existing).length,
    conflicts: decisions.filter(d => d.reason).length,
    resultingLegalAccounts: profiles.length + safe.filter(d => !d.existing?.company_id).length,
    resultingParentGroups: new Set([...profiles.filter((e: any) => !replaced.has(e.crmId)).map((e: any) => e.parent_key),
      ...safe.map(d => d.row.parent_key)]).size,
    hierarchyReviews: [...grouped.values()].filter(r => r.dimensions._hierarchyReview).length,
    conflictExamples: decisions.filter(d => d.reason).slice(0, 20).map(d => ({ hpId: d.row.hp_id, name: d.row.name, reason: d.reason })),
    note: "Exact HP IDs or unambiguous owned legal names only. Conflicts are held for identity review. Existing contacts, activity and edited context are preserved. Counts are a preview; the importer rechecks current identities under a lock.",
  };
}
export async function importAccountRows(client: PoolClient, tenantId: number, clientId: number, rows: SheetRow[], fileName: string) {
  const baseline = !(await client.query("SELECT 1 FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 AND kind='accounts' LIMIT 1", [tenantId, clientId])).rowCount;
  const { decisions } = await rosterDecisions(client, tenantId, clientId, rows, fileName, true);
  const entries: any[] = [];
  for (const d of decisions) {
    if (d.reason) {
      await queueHpMatch(client, tenantId, clientId, `roster:${rosterIdentityKey(d.row)}`, d.reason, { roster: true, fileName, values: d.row });
      continue;
    }
    const entry: any = d.row, previous = d.existing;
    entry.company_id = previous?.crmId ?? null;
    entry.is_new = previous?.company_id ? previous.is_new : !baseline;
    if (previous?.company_id) {
      // Preserve user-edited context, but allow reviewed source hierarchy updates.
      if (!usable(entry.top_id) && !usable(entry.mid_id)) {
        entry.parent_key = previous.parent_key;
        entry.parent_name = previous.parent_name;
      }
      for (const column of Object.keys(hpDimensions)) if (!usable(entry[column])) entry[column] = previous[column] ?? null;
      const edits = Array.isArray(previous.edits) ? previous.edits : [];
      entry.dimensions = { ...(previous.dimensions ?? {}), ...Object.fromEntries(
        Object.entries(entry.dimensions).filter(([, value]) => usable(value))) };
      for (const [column, key] of Object.entries(hpContextFields)) {
        const edited = edits.some((e: any) => e.values && Object.hasOwn(e.values, key));
        if (edited || entry[column] == null) entry[column] = previous[column];
      }
      const identity = new Set(["hp_id", "top_id", "top_name", "mid_id", "mid_name", "act_st", "st_name", "partial_st", "partial_name", "legal_name"]);
      for (const edit of edits) for (const [key, value] of Object.entries(edit.values?.dimensions ?? {})) {
        const column = Object.keys(hpDimensions).find(c => c === key || hpDimensions[c] === key);
        if (column && !identity.has(column)) {
          entry[column] = text(value) || null; entry.dimensions[key] = value;
        }
      }
      entry.aliases = [...new Set([...(previous.aliases ?? []), ...entry.aliases])];
    }
    entries.push(entry);
  }
  const columns = Object.keys(hpDimensions);
  const optional = Object.keys(hpContextFields);
  const optionalType = (c: string) => /categories$/.test(c) ? "text[]" : ["top_200", "global_account", "profiled"].includes(c) ? "boolean" : "text";
  await client.query(`CREATE TEMP TABLE hp_stage ON COMMIT DROP AS SELECT * FROM hp_account_profiles WITH NO DATA`);
  for (let offset = 0; offset < entries.length; offset += 500) {
    const chunk = entries.slice(offset, offset + 500);
    await client.query(`INSERT INTO hp_stage(tenant_id,client_id,company_id,${columns.join(",")},parent_key,parent_name,dimensions,variants,aliases,is_new,provenance,updated_at,${optional.join(",")})
      SELECT $1,$2,COALESCE(x.company_id,nextval('companies_id_seq')::int),${columns.map(c => `x.${c}`).join(",")},
        x.parent_key,x.parent_name,x.dimensions,x.variants,x.aliases,x.is_new,$4,now(),
        ${optional.map(c => `COALESCE(x.${c}${/categories$/.test(c) ? ",'{}'::text[]" : c === "top_200" ? ",false" : ""})`).join(",")}
      FROM jsonb_to_recordset($3::jsonb) AS x(${columns.map(c => `${c} text`).join(",")}, company_id int,is_new boolean,name text,parent_key text,parent_name text,dimensions jsonb,variants jsonb,aliases text[],${optional.map(c => `${c} ${optionalType(c)}`).join(",")})`,
    [tenantId, clientId, JSON.stringify(chunk), `HP roster: ${fileName}`]);
  }
  // Matching has already held conflicting identities. Fail rather than clone
  // them, and avoid a quadratic self-join across the entire staged roster.
  if ((await client.query("SELECT company_id FROM hp_stage GROUP BY company_id HAVING count(*)>1 LIMIT 1")).rowCount)
    throw Object.assign(new Error("Conflicting staged CRM identities require review; no accounts were imported."), { status: 409 });
  const created = await client.query(`INSERT INTO companies(id,tenant_id,client_id,name,industry)
    SELECT s.company_id,$1,$2,s.legal_name,s.industry_vertical FROM hp_stage s
    WHERE NOT EXISTS(SELECT 1 FROM companies c WHERE c.id=s.company_id) RETURNING id`, [tenantId, clientId]);
  const all = ["tenant_id", "client_id", "company_id", ...columns, "parent_key", "parent_name", "dimensions", "variants", "aliases", "is_new", "provenance", "updated_at", ...optional];
  await client.query(`INSERT INTO hp_account_profiles(${all.join(",")}) SELECT ${all.join(",")} FROM hp_stage
    ON CONFLICT(tenant_id,client_id,company_id) DO UPDATE SET ${[...columns, "parent_key", "parent_name", "dimensions", "variants", "aliases", "provenance", "updated_at", ...optional].map(c => `${c}=EXCLUDED.${c}`).join(",")},
    edits=CASE WHEN hp_account_profiles.dimensions IS DISTINCT FROM EXCLUDED.dimensions
      OR hp_account_profiles.variants IS DISTINCT FROM EXCLUDED.variants
      OR hp_account_profiles.parent_key IS DISTINCT FROM EXCLUDED.parent_key
      THEN hp_account_profiles.edits || jsonb_build_array(jsonb_build_object('changedAt',now(),'source','account import',
        'previousDimensions',hp_account_profiles.dimensions,'previousParentKey',hp_account_profiles.parent_key))
      ELSE hp_account_profiles.edits END`);
  // Fresh bulk-import scopes otherwise look empty to the planner, which can
  // choose repeated roster scans for the first dashboard read. Analyze only
  // narrow identity columns, never the large Excel JSON/history columns.
  if (entries.length >= 500) {
    await client.query("ANALYZE companies (id,tenant_id,client_id)");
    await client.query("ANALYZE hp_account_profiles (tenant_id,client_id,company_id,parent_key)");
  }
  const linked = await client.query(`WITH aliases AS MATERIALIZED (
    SELECT p.company_id,lower(btrim(a)) name FROM hp_account_profiles p CROSS JOIN LATERAL unnest(p.aliases) a
    WHERE p.tenant_id=$1 AND p.client_id=$2), candidates AS (
    SELECT c.id,min(p.company_id) account_id FROM contacts c JOIN aliases p ON lower(btrim(c.company_name))=p.name
    WHERE c.tenant_id=$1 AND c.company_id IS NULL AND (c.client_id=$2 OR c.client_id IS NULL) AND NOT c.is_anonymous
    GROUP BY c.id HAVING count(DISTINCT p.company_id)=1)
    UPDATE contacts c SET company_id=x.account_id,client_id=$2 FROM candidates x WHERE c.id=x.id RETURNING c.id`, [tenantId, clientId]);
  // Existing matched contacts are explicitly baseline, not newly acquired.
  await client.query(`INSERT INTO hp_bi_contacts(tenant_id,client_id,contact_id,is_new,source)
    SELECT $1,$2,c.id,false,'existing CRM baseline' FROM contacts c JOIN hp_account_profiles p ON p.company_id=c.company_id AND p.tenant_id=c.tenant_id
    WHERE c.tenant_id=$1 AND p.client_id=$2 AND NOT c.is_anonymous ON CONFLICT DO NOTHING`, [tenantId, clientId]);
  return { imported: entries.length, created: created.rowCount ?? 0, linkedContacts: linked.rowCount ?? 0, unresolved: decisions.length - entries.length };
}
export async function importHpWorkbook(tenantId: number, clientId: number, bytes: Buffer, fileName: string, kind: string, mappings: Record<string, string>, userId: number | null, prepared?: HpParsedWorkbook) {
  const parsed = prepared ?? await readHpWorkbookAsync(bytes, kind, mappings);
  const preview = await previewHpImportAsync(bytes, kind, mappings, parsed);
  if (preview.errors.length) throw new Error(preview.errors.join("\n"));
  const rows = parsed.rows;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
    let result = { imported: 0, created: 0, linkedContacts: 0, unresolved: 0 };
    if (kind === "accounts") result = await importAccountRows(client, tenantId, clientId, rows, fileName);
    else for (const row of rows) {
      const sourceKey = `excel:${text(field(row.values, "sourceName", "program", "campaign"))}:${text(field(row.values, "recordId"))}`;
      const match = await resolveHpAccount(client, tenantId, clientId, text(field(row.values, "hpId", "hp_id", "UNIQUE ID")) || null, accountName(row.values));
      if (!match.id) { await queueHpMatch(client, tenantId, clientId, sourceKey, match.reason!, { ...row, fileName }); result.unresolved++; continue; }
      const record = recordFromRow(row.values);
      const approved = (await client.query("SELECT payload->>'correctedCategory' category FROM hp_bi_matches WHERE tenant_id=$1 AND client_id=$2 AND source_key=$3 AND resolved_account_id=$4",
        [tenantId, clientId, sourceKey, match.id])).rows[0]?.category;
      if (approved) record.category = approved;
      if (record.category && !inboundCategories.includes(record.category)) {
        await queueHpMatch(client, tenantId, clientId, sourceKey, "Unknown reporting category; choose a saved category", { ...row, fileName });
        result.unresolved++; continue;
      }
      const email = text(field(row.values, "email")).toLowerCase();
      const contacts = email ? await client.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND client_id=$2
        AND company_id=$3 AND lower(btrim(email))=$4 AND NOT is_anonymous`, [tenantId, clientId, match.id, email]) : null;
      if (email && contacts?.rows.length !== 1) {
        await queueHpMatch(client, tenantId, clientId, sourceKey, "Email is unmatched or conflicts; review contact identity", { ...row, fileName });
        result.unresolved++; continue;
      }
      await saveHpRecord(client, tenantId, clientId, match.id, contacts?.rows[0]?.id ?? null, record, "excel", sourceKey,
        { fileName, sheet: row.sheet, row: row.row, raw: row.values });
      result.imported++;
    }
    const complete = { ...result, rows: rows.length };
    await client.query(`INSERT INTO hp_bi_imports(tenant_id,client_id,file_name,file_hash,kind,rows,accounts,result,imported_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [tenantId, clientId, fileName, createHash("sha256").update(bytes).digest("hex"),
      kind, rows.length, preview.uniqueAccounts, JSON.stringify(complete), userId]);
    await client.query("COMMIT");
    return complete;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
