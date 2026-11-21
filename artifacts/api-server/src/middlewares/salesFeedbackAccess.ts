import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { loadSalesAccess, maySeeSalesAccount, type SalesAccess } from "../lib/salesAccountAccess";

export async function salesFeedbackAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const access = await loadSalesAccess(req.user as any);
    (req as Request & { salesAccess: SalesAccess }).salesAccess = access;
    if (access.visibility === "all") { next(); return; }
    const path = req.originalUrl.split("?")[0].replace(/^\/api(?=\/)/, "");
    if (/^\/sales-feedback\/sources(?:\/|$)/.test(path)) {
      res.status(403).json({ error: "All-account Sales access is required to manage shared feedback sources." }); return;
    }
    const accountId = req.body?.accountId ?? req.query.accountId;
    const contactId = req.body?.contactId ?? req.query.contactId;
    if ([accountId, contactId].some(value => value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0))) {
      res.status(400).json({ error: "Use a valid account or contact ID." }); return;
    }
    if (accountId !== undefined && !await maySeeSalesAccount(access, Number(accountId))) {
      res.status(404).json({ error: "Account not found." }); return;
    }
    if (contactId !== undefined) {
      const contact = (await pool.query("SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2",
        [access.user.tenantId, Number(contactId)])).rows[0];
      if (!contact?.company_id || !await maySeeSalesAccount(access, Number(contact.company_id))) {
        res.status(404).json({ error: "Contact not found." }); return;
      }
    }
    next();
  } catch (error) { next(error); }
}
export function requestSalesAccess(req: Request): SalesAccess {
  const access = (req as Request & { salesAccess?: SalesAccess }).salesAccess;
  if (!access) throw new Error("Sales access boundary missing");
  return access;
}
