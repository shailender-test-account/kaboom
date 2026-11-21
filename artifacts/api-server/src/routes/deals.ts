import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, pool, dealsTable, dealAuditTable, clientsTable, companiesTable, contactsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { CreateDealBody, UpdateDealBody, GetDealParams, UpdateDealParams, DeleteDealParams,
  ListDealsQueryParams, GetDealLinkOptionsQueryParams } from "@workspace/api-zod";
import { dealChanges, dealJson } from "../lib/dealFacts";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth);
// Orval coerces OpenAPI date strings into JS Date, which would lose the original
// calendar input (including invalid days rolled into the next month).
const calendarFields = {
  actualOpportunityDate: z.string().nullable().optional(),
  actualOutcomeDate: z.string().nullable().optional(),
};
const createBody = CreateDealBody.extend(calendarFields).strict();
const updateBody = UpdateDealBody.extend(calendarFields).strict();
const fail = (err: any, res: any, next: any) => err.status ? res.status(err.status).json({ error: err.message }) : next(err);
const missing = (message: string, status = 404) => { throw Object.assign(new Error(message), { status }); };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function ownership(tx: Tx, tenantId: number, clientId: number, companyId: number | null, contactId: number | null) {
  const [client] = await tx.select({ id: clientsTable.id }).from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.tenantId, tenantId)));
  if (!client) missing("Client not found in your tenant.");
  if (companyId !== null) {
    const [company] = await tx.select({ id: companiesTable.id }).from(companiesTable)
      .where(and(eq(companiesTable.id, companyId), eq(companiesTable.tenantId, tenantId), eq(companiesTable.clientId, clientId)));
    if (!company) missing("Account does not belong to this client.", 422);
  }
  if (contactId !== null) {
    const [contact] = await tx.select().from(contactsTable).where(and(eq(contactsTable.id, contactId), eq(contactsTable.tenantId, tenantId)));
    if (!companyId || !contact || contact.clientId !== clientId || contact.companyId !== companyId || contact.isAnonymous)
      missing("Select an identified contact owned by the selected client and account.", 422);
  }
}
async function lock(tx: Tx, tenantId: number) {
  // Same boundary as CRM permanent deletion and inbound identity writers.
  const { sql } = await import("drizzle-orm");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}::int,914357)`);
}
async function audit(tx: Tx, tenantId: number, actorId: number, action: string, before: any, after: any) {
  const deal = after ?? before;
  await tx.insert(dealAuditTable).values({ tenantId, clientId: deal.clientId, dealId: deal.id, actorId, action, before, after });
}

router.get("/deals", async (req, res, next): Promise<void> => {
  const qp = ListDealsQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }
  try {
    const user = req.user as any;
    const deals = await db.select().from(dealsTable).where(and(eq(dealsTable.tenantId, user.tenantId),
      qp.data.clientId ? eq(dealsTable.clientId, qp.data.clientId) : undefined,
      qp.data.contactId ? eq(dealsTable.contactId, qp.data.contactId) : undefined,
      qp.data.stage ? eq(dealsTable.stage, qp.data.stage) : undefined));
    res.json(deals.map(dealJson));
  } catch (err) { next(err); }
});
router.get("/deals/link-options", async (req, res, next): Promise<void> => {
  const qp = GetDealLinkOptionsQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }
  try {
    const { clientId, search = "", companyId, contactId } = qp.data, tenantId = (req.user as any).tenantId;
    if (!(await pool.query("SELECT 1 FROM clients WHERE id=$1 AND tenant_id=$2", [clientId, tenantId])).rowCount)
      missing("Client not found in your tenant.");
    // A bounded search, plus the selected account so editing isn't limited to the first page.
    const accounts = (await pool.query(`SELECT id,name FROM companies WHERE tenant_id=$1 AND client_id=$2 AND
      (name ILIKE '%'||$3||'%' OR id=$4) ORDER BY (id=$4) DESC NULLS LAST,name,id LIMIT 50`,
    [tenantId, clientId, search, companyId ?? null])).rows;
    const contacts = companyId ? (await pool.query(`SELECT id,
      COALESCE(NULLIF(btrim(concat_ws(' ',first_name,last_name)),''),email,'Unnamed contact') || COALESCE(' · '||email,'') name
      FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3 AND NOT is_anonymous
      AND (concat_ws(' ',first_name,last_name,email) ILIKE '%'||$4||'%' OR id=$5)
      ORDER BY (id=$5) DESC NULLS LAST,id LIMIT 50`,
    [tenantId, clientId, companyId, search, contactId ?? null])).rows : [];
    res.json({ accounts, contacts });
  } catch (err) { fail(err, res, next); }
});
router.post("/deals", async (req, res, next): Promise<void> => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any, changes = dealChanges(parsed.data);
    const deal = await db.transaction(async tx => {
      await lock(tx, user.tenantId);
      await ownership(tx, user.tenantId, parsed.data.clientId, parsed.data.companyId ?? null, parsed.data.contactId ?? null);
      const [created] = await tx.insert(dealsTable).values({ ...changes, tenantId: user.tenantId } as any).returning();
      await audit(tx, user.tenantId, user.id, "created", null, dealJson(created));
      return created;
    });
    res.status(201).json(dealJson(deal));
  } catch (err) { fail(err, res, next); }
});
router.get("/deals/:id/contacts", async (req, res, next): Promise<void> => {
  try {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const tenantId = Number((req.user as any).tenantId);
    if (!(await pool.query("SELECT 1 FROM deals WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rowCount) {
      res.status(404).json({ error: "Opportunity not found" }); return;
    }
    const linked = await pool.query(`SELECT DISTINCT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.title,
      COALESCE(d.contact_id=c.id,false) AS "isPrimary" FROM deals d JOIN contacts c
      ON c.tenant_id=d.tenant_id AND c.client_id=d.client_id AND c.company_id=d.company_id AND NOT c.is_anonymous
      LEFT JOIN deal_contacts dc ON dc.deal_id=d.id AND dc.contact_id=c.id AND dc.tenant_id=d.tenant_id
        AND dc.client_id=d.client_id AND dc.company_id=d.company_id
      WHERE d.tenant_id=$1 AND d.id=$2 AND (d.contact_id=c.id OR dc.id IS NOT NULL) ORDER BY c.id`, [tenantId, id]);
    res.json(linked.rows);
  } catch (err) { fail(err, res, next); }
});
router.get("/deals/:id/history", async (req, res, next): Promise<void> => {
  const params = GetDealParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const tenantId = (req.user as any).tenantId, dealId = params.data.id;
    const history = await db.select().from(dealAuditTable).where(and(eq(dealAuditTable.dealId, dealId), eq(dealAuditTable.tenantId, tenantId)));
    if (!history.length && !(await db.select({ id: dealsTable.id }).from(dealsTable)
      .where(and(eq(dealsTable.id, dealId), eq(dealsTable.tenantId, tenantId)))).length) missing("Deal not found");
    res.json(history.sort((a, b) => b.id - a.id));
  } catch (err) { fail(err, res, next); }
});
router.get("/deals/:id", async (req, res, next): Promise<void> => {
  const params = GetDealParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const [deal] = await db.select().from(dealsTable).where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.tenantId, (req.user as any).tenantId)));
    if (!deal) { res.status(404).json({ error: "Deal not found" }); return; }
    res.json(dealJson(deal));
  } catch (err) { next(err); }
});
router.patch("/deals/:id", async (req, res, next): Promise<void> => {
  const params = UpdateDealParams.safeParse(req.params), parsed = updateBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid deal ID or changes." }); return; }
  try {
    const user = req.user as any;
    const deal = await db.transaction(async tx => {
      await lock(tx, user.tenantId);
      const [existing] = await tx.select().from(dealsTable)
        .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.tenantId, user.tenantId))).for("update");
      if (!existing) missing("Deal not found");
      const changes = dealChanges(parsed.data, existing);
      if ("companyId" in parsed.data || "contactId" in parsed.data)
        await ownership(tx, user.tenantId, existing.clientId,
          "companyId" in changes ? changes.companyId : existing.companyId,
          "contactId" in changes ? changes.contactId : existing.contactId);
      const [updated] = await tx.update(dealsTable).set(changes).where(eq(dealsTable.id, existing.id)).returning();
      await audit(tx, user.tenantId, user.id, "updated", dealJson(existing), dealJson(updated));
      return updated;
    });
    res.json(dealJson(deal));
  } catch (err) { fail(err, res, next); }
});
router.delete("/deals/:id", async (req, res, next): Promise<void> => {
  const params = DeleteDealParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    await db.transaction(async tx => {
      await lock(tx, user.tenantId);
      const [existing] = await tx.select().from(dealsTable)
        .where(and(eq(dealsTable.id, params.data.id), eq(dealsTable.tenantId, user.tenantId))).for("update");
      if (!existing) missing("Deal not found");
      await audit(tx, user.tenantId, user.id, "deleted", dealJson(existing), null);
      await tx.delete(dealsTable).where(eq(dealsTable.id, existing.id));
    });
    res.sendStatus(204);
  } catch (err) { fail(err, res, next); }
});
export default router;
