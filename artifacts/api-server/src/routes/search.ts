import { Router, type IRouter } from "express";
import { eq, ilike, or, and } from "drizzle-orm";
import {
  db, contactsTable, companiesTable, playsTable, journeysTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { canAccess } from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/search", async (req, res, next): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  if (!q || q.length < 2) {
    res.json({ contacts: [], companies: [], plays: [], journeys: [] });
    return;
  }
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const pat = `%${q}%`;

    const [contacts, companies, plays, journeys] = await Promise.all([
      db
        .select({
          id: contactsTable.id,
          firstName: contactsTable.firstName,
          lastName: contactsTable.lastName,
          email: contactsTable.email,
          leadScore: contactsTable.leadScore,
        })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.tenantId, tid),
            or(
              ilike(contactsTable.firstName, pat),
              ilike(contactsTable.lastName, pat),
              ilike(contactsTable.email, pat),
            ),
          ),
        )
        .limit(5),

      db
        .select({
          id: companiesTable.id,
          name: companiesTable.name,
          domain: companiesTable.domain,
          industry: companiesTable.industry,
        })
        .from(companiesTable)
        .where(
          and(
            eq(companiesTable.tenantId, tid),
            ilike(companiesTable.name, pat),
          ),
        )
        .limit(5),

      db
        .select({
          id: playsTable.id,
          name: playsTable.name,
          status: playsTable.status,
        })
        .from(playsTable)
        .where(
          and(
            eq(playsTable.tenantId, tid),
            ilike(playsTable.name, pat),
          ),
        )
        .limit(5),

      db
        .select({
          id: journeysTable.id,
          name: journeysTable.name,
          status: journeysTable.status,
          slug: journeysTable.slug,
        })
        .from(journeysTable)
        .where(
          and(
            eq(journeysTable.tenantId, tid),
            ilike(journeysTable.name, pat),
          ),
        )
        .limit(5),
    ]);

    res.json({
      contacts: canAccess(user, "contacts") ? contacts : [],
      companies: canAccess(user, "companies") ? companies : [],
      plays: canAccess(user, "plays") ? plays : [],
      journeys: canAccess(user, "journeys") ? journeys : [],
    });
  } catch (err) { next(err); }
});

export default router;
