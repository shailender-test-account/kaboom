import { Router } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { readEngagementHistory } from "../lib/engagementHistory";
import { contactRoutingMemberships } from "../lib/contactRoutingMemberships";

const router = Router();
const input = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  contactId: z.coerce.number().int().positive().optional(),
  parentKey: z.string().min(1).max(200).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine(v => [v.companyId, v.contactId, v.parentKey].filter(v => v !== undefined).length === 1,
  "Choose exactly one account, contact or HP parent.").refine(v => !v.parentKey || !!v.clientId, "HP parent requires clientId.");
router.get("/engagement-history", requireAuth, async (req, res, next) => {
  try {
    const q = input.safeParse(req.query);
    if (!q.success) { res.status(400).json({ error: q.error.message }); return; }
    const tenantId = Number((req.user as any).tenantId), v = q.data;
    let clientId: number | null, companyIds: number[] | null;
    if (v.parentKey) {
      const r = await pool.query(`SELECT p.company_id,c.client_id FROM hp_account_profiles p JOIN companies c
        ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
        WHERE p.tenant_id=$1 AND p.client_id=$2 AND p.parent_key=$3`, [tenantId, v.clientId, v.parentKey]);
      if (!r.rows.length) { res.status(404).json({ error: "Account not found" }); return; }
      clientId = v.clientId!; companyIds = r.rows.map(r => Number(r.company_id));
    } else {
      const r = await pool.query(v.contactId
        ? "SELECT client_id,company_id FROM contacts WHERE tenant_id=$1 AND id=$2 AND NOT is_anonymous"
        : "SELECT client_id,id AS company_id FROM companies WHERE tenant_id=$1 AND id=$2",
      [tenantId, v.contactId ?? v.companyId]);
      if (!r.rows.length || (v.clientId && Number(r.rows[0].client_id) !== v.clientId)) {
        res.status(404).json({ error: "Record not found" }); return;
      }
      clientId = r.rows[0].client_id;
      companyIds = v.contactId ? null : [Number(r.rows[0].company_id)];
    }
    const history = await readEngagementHistory(tenantId, { clientId, companyIds, contactId: v.contactId }, v.page, v.pageSize);
    const memberships = await contactRoutingMemberships(tenantId, history.contacts.map(c => c.id));
    res.json({ ...history, clientId, contacts: history.contacts.map(c => ({
      ...c,
      journeys: memberships.journeys.filter(j => j.contactId === c.id),
      enrollments: memberships.enrollments.filter(e => e.contactId === c.id),
      opportunities: memberships.opportunities.filter(o => o.contactId === c.id),
    })) });
  } catch (err) { next(err); }
});
export default router;
