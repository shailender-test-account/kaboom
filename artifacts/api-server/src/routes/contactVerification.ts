import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { apolloCommitteeConfig } from "../lib/buyingCommittee";

const router: IRouter = Router();
router.use("/contacts/:id/verification", requireAuth);
router.use("/contact-verification-usage", requireAuth, (req, res, next) => {
  // Do not use delegated section permissions to grant budget administration.
  if ((req.user as { role: string }).role !== "admin") {
    res.status(403).json({ error: "Only admins can manage verification usage." }); return;
  }
  next();
});

async function usage(tenantId: number) {
  const result = await pool.query(`SELECT request_limit,attempts,responses,legacy_attempts
    FROM contact_verification_usage WHERE tenant_id=$1`, [tenantId]);
  const row = result.rows[0] ?? { request_limit: 0, attempts: 0, responses: 0, legacy_attempts: 0 };
  return { requestLimit: row.request_limit, attempts: row.attempts, responses: row.responses,
    legacyAttempts: row.legacy_attempts, unconfirmedAttempts: row.attempts - row.responses,
    remaining: Math.max(0, row.request_limit - row.attempts) };
}

router.get("/contact-verification-usage", async (req, res, next) => {
  try { res.json(await usage((req.user as { tenantId: number }).tenantId)); }
  catch (error) { next(error); }
});

router.patch("/contact-verification-usage", async (req, res, next) => {
  const limit = req.body?.requestLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 1_000_000) {
    res.status(400).json({ error: "Request limit must be a whole number from 0 to 1,000,000." }); return;
  }
  try {
    const tenantId = (req.user as { tenantId: number }).tenantId;
    await pool.query(`INSERT INTO contact_verification_usage(tenant_id,request_limit) VALUES($1,$2)
      ON CONFLICT(tenant_id) DO UPDATE SET request_limit=EXCLUDED.request_limit`, [tenantId, limit]);
    res.json(await usage(tenantId));
  } catch (error) { next(error); }
});
const fields = ["first_name", "last_name", "phone", "title", "designation", "linkedin_url", "city", "state", "country"] as const;
type Field = typeof fields[number];
type Values = Partial<Record<Field, string | null>>;
const safeId = (value: string) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const normalizedEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const clean = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 255) : "";
function view(row?: Record<string, any>) {
  return row ? { id: row.id, status: row.status, original: row.original ?? {},
    proposed: row.proposed ?? {}, filledFields: row.filled_fields ?? [],
    error: row.error ?? null, completedAt: row.completed_at ?? null } :
    { status: "not_checked", original: {}, proposed: {}, filledFields: [], error: null, completedAt: null };
}
async function ownedContact(tenantId: number, id: number) {
  const result = await pool.query(`SELECT id,email,${fields.join(",")} FROM contacts
    WHERE tenant_id=$1 AND id=$2 AND is_anonymous=FALSE`, [tenantId, id]);
  return result.rows[0] as (Values & { id:number; email:string|null }) | undefined;
}

router.get("/contacts/:id/verification", async (req, res, next) => {
  try {
    const id = safeId(req.params.id);
    const tenantId = (req.user as {tenantId:number}).tenantId;
    if (!id || !await ownedContact(tenantId,id)) { res.status(404).json({error:"Contact not found"}); return; }
    const r = await pool.query(`SELECT * FROM contact_verifications WHERE tenant_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1`, [tenantId,id]);
    res.json(view(r.rows[0]));
  } catch (error) { next(error); }
});

router.post("/contacts/:id/verification", async (req, res, next) => {
  const id = safeId(req.params.id);
  if (!id) { res.status(400).json({error:"Invalid contact"}); return; }
  const tenantId = (req.user as {tenantId:number}).tenantId;
  try {
    const contact = await ownedContact(tenantId,id);
    if (!contact) { res.status(404).json({error:"Contact not found"}); return; }
    if (!normalizedEmail(contact.email)) { res.status(400).json({error:"An existing business email is required for identity-safe verification."}); return; }
    const duplicate = await pool.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id<>$2 AND LOWER(BTRIM(email))=$3 LIMIT 1`,
      [tenantId,id,normalizedEmail(contact.email)]);
    if (duplicate.rowCount) { res.status(409).json({error:"This email belongs to more than one contact. Resolve the identity before verifying."}); return; }
    const provider = await apolloCommitteeConfig(tenantId);
    if (!provider.configured) { res.status(409).json({error:"Contact verification is not configured in Settings > Integrations."}); return; }
    // Serialize lookup claims across app instances, not only inside this process.
    const cx = await pool.connect();
    let verificationId: number;
    try {
      await cx.query("BEGIN");
      await cx.query("SELECT pg_advisory_xact_lock($1,$2)", [tenantId,id]);
      const active = await cx.query(`SELECT id FROM contact_verifications WHERE tenant_id=$1 AND contact_id=$2
        AND status='processing' AND created_at>NOW()-interval '5 minutes' LIMIT 1`, [tenantId,id]);
      if (active.rowCount) { await cx.query("ROLLBACK"); res.status(409).json({error:"Verification is already running. Refresh before retrying."}); return; }
      // Atomic reservation shared by all contacts and all server instances.
      // No refunds: a reserved request may have reached the provider even if we crash.
      const budget = await cx.query(`UPDATE contact_verification_usage SET attempts=attempts+1
        WHERE tenant_id=$1 AND attempts<request_limit RETURNING attempts`, [tenantId]);
      if (!budget.rowCount) {
        await cx.query("ROLLBACK");
        res.status(429).json({error:"Verification request ceiling reached or not configured. Ask an admin to set a higher all-time ceiling in Database > Verification usage."});
        return;
      }
      const claimed = await cx.query(`INSERT INTO contact_verifications(tenant_id,contact_id,original)
        VALUES($1,$2,$3::jsonb) RETURNING id`, [tenantId,id,JSON.stringify({email:contact.email,...Object.fromEntries(fields.map(f=>[f,contact[f]??null]))})]);
      verificationId = claimed.rows[0].id;
      await cx.query("COMMIT");
    } catch (error) { await cx.query("ROLLBACK"); throw error; }
    finally { cx.release(); }
    try {
      // One explicit lookup, no background retries or personal-email/direct-dial unlocks.
      const response = await fetch("https://api.apollo.io/api/v1/people/match", {
        method: "POST", headers: { "Content-Type":"application/json", "X-Api-Key":provider.apiKey!, accept:"application/json" },
        body: JSON.stringify({email:contact.email, reveal_personal_emails:false, reveal_phone_number:false}),
        signal: AbortSignal.timeout(25000),
      });
      // Every received HTTP response counts, including 4xx/5xx and invalid JSON.
      // This is transport accounting, never a claim about provider billing.
      await pool.query(`UPDATE contact_verification_usage SET responses=responses+1 WHERE tenant_id=$1`, [tenantId]);
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}; the lookup may have used credits. No automatic retry was made.`);
      const payload = await response.json() as {person?: Record<string,any>};
      const person = payload.person;
      if (!person || normalizedEmail(person.email) !== normalizedEmail(contact.email)) {
        throw new Error("Provider did not return an exact email match. No contact details were changed.");
      }
      const proposed: Record<string,string> = {};
      const values: Record<Field,string> = {
        first_name:clean(person.first_name),last_name:clean(person.last_name),phone:"",
        title:clean(person.title),designation:clean(person.title),linkedin_url:clean(person.linkedin_url),
        city:clean(person.city),state:clean(person.state),country:clean(person.country),
      };
      const current = await ownedContact(tenantId,id);
      if (!current || normalizedEmail(current.email)!==normalizedEmail(contact.email)) throw new Error("Contact identity changed while verifying. No changes were saved.");
      const filled: string[] = [];
      const update = await pool.connect();
      try {
        await update.query("BEGIN");
        const latest=await update.query(`SELECT id FROM contact_verifications
          WHERE tenant_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1 FOR UPDATE`,[tenantId,id]);
        if (latest.rows[0]?.id!==verificationId) throw new Error("A newer verification was started. The earlier result was discarded.");
        const locked = await update.query(`SELECT email,${fields.join(",")} FROM contacts WHERE tenant_id=$1 AND id=$2 AND is_anonymous=FALSE FOR UPDATE`,[tenantId,id]);
        const now = locked.rows[0] as Values & {email:string|null}|undefined;
        if (!now || normalizedEmail(now.email)!==normalizedEmail(contact.email)) throw new Error("Contact identity changed while verifying. No changes were saved.");
        for (const field of fields) {
          const value = values[field];
          if (!value || value.toLowerCase()===(clean(now[field]).toLowerCase())) continue;
          if (clean(now[field])) proposed[field]=value;
          else {
            await update.query(`UPDATE contacts SET ${field}=$1,updated_at=NOW()
              WHERE tenant_id=$2 AND id=$3 AND NULLIF(BTRIM(${field}),'') IS NULL`,[value,tenantId,id]);
            filled.push(field);
          }
        }
        const saved = await update.query(`UPDATE contact_verifications SET status=$1, proposed=$2::jsonb,
          original=$3::jsonb,filled_fields=$4::jsonb, completed_at=NOW() WHERE id=$5 AND tenant_id=$6 RETURNING *`,
          [Object.keys(proposed).length?"review":"verified", JSON.stringify(proposed),
            JSON.stringify({email:now.email,...Object.fromEntries(fields.map(f=>[f,now[f]??null]))}),JSON.stringify(filled),verificationId,tenantId]);
        await update.query("COMMIT");
        res.json(view(saved.rows[0]));
      } catch (error) { await update.query("ROLLBACK"); throw error; }
      finally { update.release(); }
    } catch (error) {
      await pool.query(`UPDATE contact_verifications SET status='failed',error=$1,completed_at=NOW()
        WHERE tenant_id=$2 AND id=$3`, [error instanceof Error ? error.message : "Verification failed",tenantId,verificationId]);
      res.status(502).json({error:error instanceof Error ? error.message : "Verification failed"});
    }
  } catch (error) { next(error); }
});

router.patch("/contacts/:id/verification/:verificationId", async (req, res, next) => {
  const id = safeId(req.params.id), verificationId = safeId(req.params.verificationId);
  const selected = req.body?.fields;
  if (!id || !verificationId || !Array.isArray(selected) || selected.length>fields.length
    || selected.some(f=>typeof f!=="string" || !fields.includes(f as Field)) || new Set(selected).size!==selected.length) {
    res.status(400).json({error:"Select valid fields for review"}); return;
  }
  const tenantId=(req.user as {tenantId:number}).tenantId;
  const cx=await pool.connect();
  try {
    await cx.query("BEGIN");
    const record=await cx.query(`SELECT * FROM contact_verifications WHERE tenant_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE`,
      [tenantId,id,verificationId]);
    const v=record.rows[0];
    if (!v || v.status!=="review") { await cx.query("ROLLBACK"); res.status(409).json({error:"No pending review for this contact"}); return; }
    const latest=await cx.query(`SELECT id FROM contact_verifications WHERE tenant_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1`,[tenantId,id]);
    if (latest.rows[0]?.id!==verificationId) { await cx.query("ROLLBACK"); res.status(409).json({error:"A newer verification exists. Reload before reviewing."}); return; }
    const current=await cx.query(`SELECT email,${fields.join(",")} FROM contacts WHERE tenant_id=$1 AND id=$2 AND is_anonymous=FALSE FOR UPDATE`,[tenantId,id]);
    if (!current.rowCount) { await cx.query("ROLLBACK"); res.status(404).json({error:"Contact not found"}); return; }
    if (normalizedEmail(current.rows[0].email)!==normalizedEmail(v.original.email)) {
      await cx.query("ROLLBACK"); res.status(409).json({error:"Contact identity changed since verification. Run a new verification."}); return;
    }
    for (const field of selected as Field[]) {
      if (!v.proposed[field] || (current.rows[0][field]??null)!==(v.original[field]??null)) {
        await cx.query("ROLLBACK"); res.status(409).json({error:"Contact details changed since verification. Run a new verification before replacing fields."}); return;
      }
    }
    for (const field of selected as Field[]) await cx.query(`UPDATE contacts SET ${field}=$1,updated_at=NOW() WHERE tenant_id=$2 AND id=$3`,
      [v.proposed[field],tenantId,id]);
    const saved=await cx.query(`UPDATE contact_verifications SET status='verified',completed_at=NOW() WHERE id=$1 RETURNING *`,[verificationId]);
    await cx.query("COMMIT");
    res.json(view(saved.rows[0]));
  } catch (error) { await cx.query("ROLLBACK"); next(error); }
  finally { cx.release(); }
});
export default router;
