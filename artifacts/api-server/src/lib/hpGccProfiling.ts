import { pool } from "@workspace/db";
import { isHpClient, text, usable } from "./hpBiImport";

export type GccValues = {
  companyName: string; name: string; title: string; email: string; email2: string;
  phone: string; phone2: string; city: string;
};
export type GccSourceRow = { sourceRow: number; values: GccValues };
export type GccApproval = { sourceCompany: string; accountId: number; hpId: string; allowSharedEmails?: boolean };
export type GccSourceRecord = GccSourceRow & {
  fileHash: string; fileName: string; sheet: "GCC"; importedAt: string; contactId: number | null; identityReview?: string;
  sharedEmailApproved?: boolean;
};
export type GccImportResult = { sourceRow: number; companyName: string; accountId: number | null;
  contactId: number | null; outcome: "created" | "enriched" | "held"; reason: string };
const email = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null;
const digits = (v: string) => v.replace(/\D/g, "");
const phone = (v: string) => {
  const n = digits(v);
  return n.length === 10 ? `+91${n}` : n.length >= 11 && n.length <= 15 ? `+${n}` : null;
};
const missing = (v: unknown) => !usable(v);
const personName = (v: string) => text(v).toLowerCase().replace(/\s+/g, " ");

/** Approved directory enrichment only: no lead records, intent events, routing or sends. */
export async function importApprovedGccProfiling(tenantId: number, clientId: number,
  source: { fileName: string; fileHash: string; rows: GccSourceRow[] },
  approvals: GccApproval[], apply = false) {
  if (!/^[a-f0-9]{64}$/.test(source.fileHash)) throw new Error("A source SHA-256 is required.");
  if (!await isHpClient(tenantId, clientId)) throw new Error("Select a tenant-owned HP client.");
  if (new Set(approvals.map(a => a.sourceCompany.toLowerCase())).size !== approvals.length) throw new Error("Duplicate approval.");
  const approvalByName = new Map(approvals.map(a => [a.sourceCompany.trim().toLowerCase(), a]));
  const client = await pool.connect();
  const results: GccImportResult[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
    const owned = await client.query(`SELECT c.id,p.hp_id,p.dimensions FROM companies c
      JOIN hp_account_profiles p ON p.company_id=c.id AND p.tenant_id=c.tenant_id AND p.client_id=c.client_id
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=ANY($3::int[]) FOR UPDATE OF c,p`,
    [tenantId, clientId, approvals.map(a => a.accountId)]);
    const profiles = new Map<number, any>(owned.rows.map(p => [Number(p.id), p]));
    for (const a of approvals) {
      if (profiles.get(a.accountId)?.hp_id !== a.hpId) throw new Error(`Approved HP identity changed for ${a.sourceCompany}; review again.`);
    }
    const writes = new Map<number, GccSourceRecord[]>();
    for (const row of source.rows) {
      const v = row.values, a = approvalByName.get(v.companyName.trim().toLowerCase());
      const result: GccImportResult = { sourceRow: row.sourceRow, companyName: v.companyName,
        accountId: a?.accountId ?? null, contactId: null, outcome: "held", reason: "" };
      results.push(result);
      if (!a) { result.reason = "No approved unique account mapping"; continue; }
      const stored: any[] = Array.isArray(profiles.get(a.accountId).dimensions?._gccProfiling)
        ? profiles.get(a.accountId).dimensions._gccProfiling : [];
      const prior = stored.find(r => r.fileHash === source.fileHash && r.sourceRow === row.sourceRow);
      if (prior?.deleted) { result.reason = "Previously removed source contact; explicit restoration review required"; continue; }
      const allowSharedEmails = a.allowSharedEmails === true || prior?.sharedEmailApproved === true;
      if (prior?.identityReview && !allowSharedEmails) { result.reason = "Shared contact identity requires explicit review before import"; continue; }
      const emails = [...new Set([email(v.email), email(v.email2)].filter(Boolean))];
      const primaryPhone = phone(v.phone) ?? phone(v.phone2);
      if (!emails.length && !primaryPhone) { result.reason = "No valid email or phone"; continue; }
      const identifier = `gcc:${source.fileHash}:${row.sourceRow}`;
      const matches = await client.query(`SELECT * FROM contacts WHERE tenant_id=$1 AND (
        identifier=$2 OR lower(btrim(email))=ANY($3::text[]) OR
        ($4::text IS NOT NULL AND right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=$4) OR id=$5::int)
        FOR UPDATE`, [tenantId, identifier, emails, primaryPhone ? digits(primaryPhone).slice(-10) : null, prior?.contactId ?? null]);
      let candidates = matches.rows;
      if (allowSharedEmails) {
        // An approved shared address is not a person identifier. Prefer the durable
        // source link, then the supplied phone/name, never an email-only namesake.
        const stable = candidates.filter(c => c.identifier === identifier || Number(c.id) === prior?.contactId);
        if (stable.length) candidates = stable;
        else {
          if (candidates.some(c => Number(c.client_id) !== clientId || Number(c.company_id) !== a.accountId || c.is_anonymous)) {
            result.reason = "Existing contact belongs to a different or unassigned account; ownership preserved"; continue;
          }
          candidates = candidates.filter(c =>
            (primaryPhone && digits(c.phone ?? "").slice(-10) === digits(primaryPhone).slice(-10)) ||
            (usable(v.name) && personName(v.name) === personName([c.first_name, c.last_name].filter(Boolean).join(" "))));
          if (!candidates.length && matches.rows.length && (!primaryPhone || !usable(v.name))) {
            result.reason = "A distinct supplied name and phone are required to separate shared-email contacts"; continue;
          }
        }
      }
      if (candidates.length > 1) { result.reason = "Email/phone matches multiple existing contacts"; continue; }
      const existing = candidates[0];
      if (existing && (Number(existing.client_id) !== clientId || Number(existing.company_id) !== a.accountId || existing.is_anonymous)) {
        result.reason = "Existing contact belongs to a different or unassigned account; ownership preserved"; continue;
      }
      if (existing && usable(v.name) && usable(existing.first_name) &&
        personName(v.name) !== personName([existing.first_name, existing.last_name].filter(Boolean).join(" "))) {
        result.reason = "Email/phone matches a differently named contact; identity review required"; continue;
      }
      if (prior?.contactId && !existing) { result.reason = "Previously imported contact no longer exists; review required"; continue; }
      const words = text(v.name).split(/\s+/);
      const values = { first_name: words[0] || null, last_name: words.slice(1).join(" ") || null,
        email: emails[0] ?? null, phone: primaryPhone, title: usable(v.title) ? v.title : null,
        designation: usable(v.title) ? v.title : null, city: usable(v.city) ? v.city : null,
        company_name: v.companyName };
      const now = new Date().toISOString();
      if (existing) {
        result.contactId = Number(existing.id); result.outcome = "enriched";
        result.reason = "Existing ownership and populated fields preserved; source fields retained separately";
        if (apply) {
          const fill = Object.entries(values).filter(([k, value]) => missing(existing[k]) && value != null);
          if (fill.length) await client.query(`UPDATE contacts SET ${fill.map(([k], i) => `${k}=$${i + 3}`).join(",")},updated_at=now()
            WHERE tenant_id=$1 AND id=$2`, [tenantId, existing.id, ...fill.map(([, value]) => value)]);
        }
      } else {
        result.outcome = "created"; result.reason = "New directory contact; no activity or qualification created";
        if (apply) {
          const created = await client.query(`INSERT INTO contacts
            (tenant_id,client_id,company_id,identifier,first_name,last_name,email,phone,title,designation,city,company_name,source,tags,
              intent_score,raw_intent_score,lead_score,intent_state,stage)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'gcc_profiling',ARRAY['GCC profiling'],
              0,0,0,'Browsing','pre-aware') RETURNING id`,
          [tenantId, clientId, a.accountId, identifier, ...Object.values(values)]);
          result.contactId = Number(created.rows[0].id);
        }
      }
      if (apply && result.contactId) {
        if (!writes.has(a.accountId)) writes.set(a.accountId, [...stored]);
        const records = writes.get(a.accountId)!;
        const index = records.findIndex(r => r.fileHash === source.fileHash && r.sourceRow === row.sourceRow);
        const record: GccSourceRecord = { ...row, fileHash: source.fileHash, fileName: source.fileName,
          sheet: "GCC", importedAt: prior?.importedAt ?? now, contactId: result.contactId,
          ...(allowSharedEmails ? { sharedEmailApproved: true } : {}) };
        if (index < 0) records.push(record); else records[index] = record;
      }
    }
    for (const [accountId, records] of writes) {
      await client.query(`UPDATE hp_account_profiles SET dimensions=jsonb_set(dimensions,'{_gccProfiling}',$4::jsonb),
        edits=edits||jsonb_build_array(jsonb_build_object('at',now(),'action','approved-gcc-directory-import',
          'fileName',$5::text,'fileHash',$6::text)),updated_at=now()
        WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`,
      [tenantId, clientId, accountId, JSON.stringify(records), source.fileName, source.fileHash]);
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { applied: apply, accounts: writes.size, results };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
