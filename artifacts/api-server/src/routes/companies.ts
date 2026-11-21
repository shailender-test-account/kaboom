import { Router, type IRouter } from "express";
import { and, eq, ilike, sql } from "drizzle-orm";
import { db, pool, companiesTable, contactsTable, dealsTable } from "@workspace/db";
import { isHpClient, resolveHpAccount, ensureHpProfile } from "../lib/hpBiImport";
import { requireAuth } from "../middlewares/requireAuth";
import { deleteCompanyAndHistory } from "../lib/deleteCrmEntity";
import {
  CreateCompanyBody,
  UpdateCompanyBody,
  GetCompanyParams,
  UpdateCompanyParams,
  DeleteCompanyParams,
  ListCompaniesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/companies", async (req, res, next): Promise<void> => {
  const qp = ListCompaniesQueryParams.safeParse(req.query);
  try {
    const user = req.user as any;
    const companies = await db
      .select()
      .from(companiesTable)
      .where(
        and(
          eq(companiesTable.tenantId, user.tenantId),
          qp.success && qp.data.clientId ? eq(companiesTable.clientId, qp.data.clientId) : undefined,
          qp.success && qp.data.search ? ilike(companiesTable.name, `%${qp.data.search}%`) : undefined,
        ),
      );

    const result = await Promise.all(
      companies.map(async (c) => {
        const [cCount] = await db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(eq(contactsTable.companyId, c.id));
        const [dCount] = await db.select({ count: sql<number>`count(*)::int` }).from(dealsTable).where(eq(dealsTable.companyId, c.id));
        return { ...c, contactsCount: cCount?.count ?? 0, dealsCount: dCount?.count ?? 0 };
      }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/companies", async (req, res, next): Promise<void> => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    if (parsed.data.clientId && await isHpClient(user.tenantId, parsed.data.clientId)) {
      const connection = await pool.connect();
      let accountId: number | null = null;
      let created = false;
      try {
        await connection.query("BEGIN");
        const match = await resolveHpAccount(connection, user.tenantId, parsed.data.clientId, null, parsed.data.name.trim(), true);
        if (!match.id) {
          await connection.query("ROLLBACK");
          res.status(409).json({ error: `${match.reason}. Review the existing HP identities instead of creating a duplicate.` });
          return;
        }
        accountId = match.id; created = match.created;
        await connection.query(`UPDATE companies SET domain=COALESCE(domain,$4),industry=COALESCE(industry,$5),
          size=COALESCE(size,$6),website=COALESCE(website,$7),updated_at=NOW()
          WHERE tenant_id=$1 AND client_id=$2 AND id=$3`,
        [user.tenantId, parsed.data.clientId, accountId, parsed.data.domain || null, parsed.data.industry || null,
          parsed.data.size || null, parsed.data.website || null]);
        await ensureHpProfile(connection, user.tenantId, parsed.data.clientId, accountId, parsed.data.name.trim(), created, "CRM company");
        await connection.query("COMMIT");
      } catch (error) { await connection.query("ROLLBACK"); throw error; }
      finally { connection.release(); }
      const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, accountId!));
      const [cCount] = await db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(eq(contactsTable.companyId, accountId!));
      const [dCount] = await db.select({ count: sql<number>`count(*)::int` }).from(dealsTable).where(eq(dealsTable.companyId, accountId!));
      res.status(created ? 201 : 200).json({ ...company, contactsCount: cCount.count, dealsCount: dCount.count });
      return;
    }
    const [company] = await db.insert(companiesTable).values({ ...parsed.data, tenantId: user.tenantId }).returning();
    res.status(201).json({ ...company, contactsCount: 0, dealsCount: 0 });
  } catch (err) { next(err); }
});

router.get("/companies/:id", async (req, res, next): Promise<void> => {
  const params = GetCompanyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, params.data.id));
    if (!company || company.tenantId !== user.tenantId) { res.status(404).json({ error: "Company not found" }); return; }
    const [cCount] = await db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(eq(contactsTable.companyId, company.id));
    const [dCount] = await db.select({ count: sql<number>`count(*)::int` }).from(dealsTable).where(eq(dealsTable.companyId, company.id));
    res.json({ ...company, contactsCount: cCount?.count ?? 0, dealsCount: dCount?.count ?? 0 });
  } catch (err) { next(err); }
});

// ── Company Analytics Drill-Down ──────────────────────────────────────────────
router.get("/companies/:id/analytics", async (req, res, next): Promise<void> => {
  const params = GetCompanyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, params.data.id));
    if (!company || company.tenantId !== user.tenantId) { res.status(404).json({ error: "Company not found" }); return; }

    const q = req.query;
    const journeyIdFilter = q.journeyId ? parseInt(String(q.journeyId)) : null;
    const playIdFilter = q.playId ? parseInt(String(q.playId)) : null;

    const journeyClause = journeyIdFilter
      ? sql` AND c.id IN (
          SELECT DISTINCT contact_id FROM journey_contacts WHERE journey_id = ${journeyIdFilter}
          UNION
          SELECT DISTINCT contact_id FROM activity_events WHERE journey_id = ${journeyIdFilter} AND contact_id IS NOT NULL
        )`
      : sql``;

    const playClause = playIdFilter
      ? sql` AND c.id IN (
          SELECT contact_id FROM play_contacts WHERE play_id = ${playIdFilter} AND tenant_id = ${user.tenantId}
        )`
      : sql``;

    const actJourneyClause = journeyIdFilter
      ? sql` AND ae.journey_id = ${journeyIdFilter}`
      : sql``;

    const actPlayClause = playIdFilter
      ? sql` AND ae.contact_id IN (SELECT contact_id FROM play_contacts WHERE play_id = ${playIdFilter} AND tenant_id = ${user.tenantId})`
      : sql``;

    const rr = (res: any): any[] => res.rows as any[];

    const [contacts, activities, stageDist, firstEngRes, pvRes, ffRes, eoRes] = await Promise.all([
      db.execute(sql`
        SELECT c.id, c.first_name, c.last_name, c.email, c.title, c.lead_score, c.stage, c.last_activity, c.created_at,
               count(ae.id)::int as activity_count,
               min(ae.created_at) as first_engagement
        FROM contacts c
        LEFT JOIN activity_events ae ON ae.contact_id = c.id
        WHERE c.company_id = ${params.data.id}
        ${journeyClause}${playClause}
        GROUP BY c.id ORDER BY c.lead_score DESC
      `),
      db.execute(sql`
        SELECT ae.id, ae.contact_id, ae.contact_name, ae.event_type, ae.description, ae.stage, ae.score_delta, ae.page_name, ae.source, ae.created_at
        FROM activity_events ae
        WHERE ae.company_id = ${params.data.id}
        ${actJourneyClause}${actPlayClause}
        ORDER BY ae.created_at DESC
        LIMIT 60
      `),
      db.execute(sql`SELECT stage, count(*)::int as count FROM contacts c WHERE c.company_id=${params.data.id}${journeyClause}${playClause} GROUP BY stage`),
      db.execute(sql`SELECT min(ae.created_at) as first_engagement FROM activity_events ae JOIN contacts c ON c.id=ae.contact_id WHERE c.company_id=${params.data.id}${actJourneyClause}${actPlayClause}`),
      db.execute(sql`SELECT count(*)::int as total FROM activity_events ae JOIN contacts c ON c.id=ae.contact_id WHERE c.company_id=${params.data.id} AND ae.event_type='page_view'${actJourneyClause}${actPlayClause}`),
      db.execute(sql`SELECT count(*)::int as total FROM activity_events ae JOIN contacts c ON c.id=ae.contact_id WHERE c.company_id=${params.data.id} AND ae.event_type='form_submit'${actJourneyClause}${actPlayClause}`),
      db.execute(sql`SELECT count(*)::int as total FROM activity_events ae JOIN contacts c ON c.id=ae.contact_id WHERE c.company_id=${params.data.id} AND ae.event_type='email_open'${actJourneyClause}${actPlayClause}`),
    ]);

    const contactRows = rr(contacts);
    const activityRows = rr(activities);
    const stageDistRows = rr(stageDist);
    const [firstEngRow] = rr(firstEngRes);
    const [pvRow] = rr(pvRes);
    const [ffRow] = rr(ffRes);
    const [eoRow] = rr(eoRes);

    // Per-journey score for each contact when a journey filter is active
    let journeyScoreMap = new Map<number, number>();
    if (journeyIdFilter && contactRows.length > 0) {
      const ids = contactRows.map((c: any) => c.id);
      const jsr = await db.execute(sql`
        SELECT contact_id, COALESCE(SUM(score_delta), 0)::int AS journey_score
        FROM activity_events
        WHERE journey_id = ${journeyIdFilter}
          AND contact_id IN (${sql.join(ids.map((id: number) => sql`${id}`), sql`, `)})
        GROUP BY contact_id
      `);
      journeyScoreMap = new Map(
        (jsr.rows as { contact_id: number; journey_score: number }[]).map(r => [r.contact_id, r.journey_score])
      );
    }

    const contactsWithJourneyScore = contactRows.map((c: any) => ({
      ...c,
      journey_score: journeyIdFilter ? (journeyScoreMap.get(c.id) ?? 0) : null,
    }));

    res.json({
      company,
      contacts: contactsWithJourneyScore,
      activities: activityRows,
      stageDist: stageDistRows,
      firstEngagement: firstEngRow?.first_engagement ?? null,
      activeJourneyId: journeyIdFilter,
      kpi: {
        totalContacts: contactRows.length,
        pageViews: pvRow?.total ?? 0,
        formFills: ffRow?.total ?? 0,
        emailOpens: eoRow?.total ?? 0,
      },
    });
  } catch (err) { next(err); }
});

router.patch("/companies/:id", async (req, res, next): Promise<void> => {
  const params = UpdateCompanyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateCompanyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Company not found" }); return; }
    const [company] = await db.update(companiesTable).set(parsed.data).where(eq(companiesTable.id, params.data.id)).returning();
    res.json({ ...company, contactsCount: 0, dealsCount: 0 });
  } catch (err) { next(err); }
});

router.delete("/companies/:id", async (req, res, next): Promise<void> => {
  const params = DeleteCompanyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    if(user.role!=="admin"){res.status(403).json({error:"Admins only"});return;}
    const deleted=await deleteCompanyAndHistory(user.tenantId,params.data.id);
    if(!deleted){res.status(404).json({error:"Company not found"});return;}
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
