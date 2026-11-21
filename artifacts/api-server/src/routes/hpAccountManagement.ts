import type { IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireRole } from "../middlewares/requireAuth";
import contactsRouter from "./contacts";
import journeyRouter from "./journeyAssignments";
import sequenceRouter from "./email-sequences";
import { canAccess } from "@workspace/api-zod";
import { contactRoutingMemberships, linkContactOpportunity } from "../lib/contactRoutingMemberships";
import { hpContactMayNurture, WARM_ONLY_ROUTING_MESSAGE } from "../lib/hpNurturePolicy";

const ids = z.object({ accountId: z.coerce.number().int().positive(), contactId: z.coerce.number().int().positive() });
const edits = z.object({
  firstName: z.string().trim().min(1).max(200).optional(), lastName: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().max(320).optional(), phone: z.string().trim().max(100).nullable().optional(),
  title: z.string().trim().max(300).nullable().optional(), city: z.string().trim().max(200).nullable().optional(),
  country: z.string().trim().max(200).nullable().optional(), dnc: z.boolean().optional(),
});
const bodySchema = ids.extend({
  clientId: z.number().int().positive(), action: z.enum(["update-contact", "add-journey", "remove-journey", "enroll-sequence", "cancel-sequence", "link-opportunity"]),
  values: edits.optional(), journeyId: z.number().int().positive().optional(),
  sequenceId: z.number().int().positive().optional(), enrollmentId: z.number().int().positive().optional(),
  dealId: z.number().int().positive().optional(),
  product: z.string().trim().min(1).max(500).optional(),
});
async function contact(tenantId: number, clientId: number, accountId: number, contactId: number) {
  const r = await pool.query(`SELECT c.id,c.first_name AS "firstName",c.last_name AS "lastName",c.email,c.phone,c.title,
    c.city,c.country,c.dnc,c.status,c.intent_score AS "intentScore" FROM contacts c JOIN companies a ON a.id=c.company_id
    AND a.tenant_id=c.tenant_id AND a.client_id=c.client_id
    WHERE c.tenant_id=$1 AND c.client_id=$2 AND a.id=$3 AND c.id=$4 AND NOT c.is_anonymous`,
  [tenantId, clientId, accountId, contactId]);
  if (!r.rows[0]) throw Object.assign(new Error("Contact is not linked to this HP account."), { status: 404 });
  return r.rows[0];
}
export async function hpRoutingOptions(tenantId: number, clientId: number) {
  const [journeys, sequences] = await Promise.all([
    pool.query("SELECT id,name,status,slug FROM journeys WHERE tenant_id=$1 AND client_id=$2 ORDER BY name,id", [tenantId, clientId]),
    pool.query(`SELECT s.id,s.name,s.status FROM email_sequences s
      WHERE s.tenant_id=$1 AND (s.client_id=$2 OR (s.client_id IS NULL AND
        EXISTS(SELECT 1 FROM abm_plays p WHERE p.id=s.play_id AND p.tenant_id=$1 AND p.client_id=$2))) AND (
        EXISTS(SELECT 1 FROM abm_plays p WHERE p.id=s.play_id AND p.tenant_id=$1 AND p.client_id=$2)
        OR EXISTS(SELECT 1 FROM intent_inbound_routing_rules r WHERE r.sequence_id=s.id AND r.tenant_id=$1 AND r.client_id=$2)
      ) ORDER BY s.name,s.id`, [tenantId, clientId]),
  ]);
  return { journeyOptions: journeys.rows, sequenceOptions: sequences.rows };
}

export function registerHpAccountManagement(router: IRouter, scope: (req: any) => Promise<any>, fail: (req: any, res: any, err: any) => void) {
  router.get("/analytics/hp-bi/manage-account", async (req, res) => {
    try {
      const s = await scope(req), id = ids.parse(req.query);
      const person = await contact(s.tenantId, s.filters.clientId, id.accountId, id.contactId);
      const choices = await hpRoutingOptions(s.tenantId, s.filters.clientId);
      const memberships = await contactRoutingMemberships(s.tenantId, [id.contactId]);
      const opportunities = await pool.query(`SELECT id,title,stage FROM deals WHERE tenant_id=$1 AND client_id=$2
        AND company_id=$3 ORDER BY updated_at DESC,id DESC`, [s.tenantId, s.filters.clientId, id.accountId]);
      res.json({ contact: person, ...choices, ...memberships, opportunityOptions: opportunities.rows });
    } catch (err) { fail(req, res, err); }
  });
  router.post("/analytics/hp-bi/manage-account", requireRole("admin", "manager", "editor"), async (req, res) => {
    try {
      const b = bodySchema.parse(req.body);
      const section = b.action === "update-contact" ? "contacts"
        : b.action === "link-opportunity" ? "deals"
        : b.action.includes("sequence") ? "sequences" : "journeys";
      if (!canAccess(req.user as any, section, true))
        throw Object.assign(new Error(`Manage access to ${section} is required.`), { status: 403 });
      const s = await scope({ ...req, user: req.user, query: { clientId: b.clientId } });
      const person = await contact(s.tenantId, b.clientId, b.accountId, b.contactId);
      if (b.action === "add-journey" || b.action === "enroll-sequence") {
        if (!await hpContactMayNurture(s.tenantId,b.clientId,b.contactId))
          throw Object.assign(new Error(WARM_ONLY_ROUTING_MESSAGE), { status: 409 });
        const restricted = await pool.query(`SELECT 1 FROM intent_inbound_submissions s
          WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.contact_id=$3
          AND (s.account_id IS DISTINCT FROM $4 OR s.identity_review='keep'
            OR s.routing_error ILIKE '%email%another account%'
            OR ($5::text IS NOT NULL AND s.affinity_reviews->>$5='rejected')
            OR ($5::text IS NULL AND EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(s.affinity_reviews,'{}'::jsonb)) a WHERE a.value='rejected'))) LIMIT 1`,
        [s.tenantId,b.clientId,b.contactId,b.accountId,b.product ?? null]);
        if (restricted.rowCount) throw Object.assign(new Error("Resolve the contact identity or rejected product review before routing."), { status: 409 });
      }
      if (b.action === "add-journey" && (person.dnc || person.status !== "active"))
        throw Object.assign(new Error("Only active contacts outside the DNC list can be routed."), { status: 409 });
      if (b.action === "link-opportunity") {
        if (!b.dealId) throw Object.assign(new Error("Choose an opportunity."), { status: 400 });
        res.json(await linkContactOpportunity(s.tenantId, b.clientId, b.accountId, b.contactId, b.dealId, (req.user as any).id ?? null));
        return;
      }
      let target: IRouter, url: string, method = "POST", payload: unknown;
      if (b.action === "update-contact") {
        if (!b.values || !Object.keys(b.values).length) throw Object.assign(new Error("No contact changes supplied."), { status: 400 });
        target = contactsRouter; url = `/contacts/${b.contactId}`; method = "PATCH"; payload = b.values;
      } else if (b.action === "cancel-sequence") {
        if (!b.enrollmentId) throw Object.assign(new Error("Enrollment required."), { status: 400 });
        const cancelled = await pool.query(`UPDATE sequence_enrollments e SET status='cancelled'
          FROM email_sequences s,contacts c,companies a
          WHERE e.id=$1 AND e.contact_id=$2 AND s.id=e.sequence_id AND s.tenant_id=$3
            AND c.id=e.contact_id AND c.tenant_id=$3 AND c.client_id=$4 AND c.company_id=$5
            AND a.id=c.company_id AND a.tenant_id=$3 AND a.client_id=$4
            AND e.status IN ('active','paused') RETURNING e.id,e.status`,
        [b.enrollmentId, b.contactId, s.tenantId, b.clientId, b.accountId]);
        if (!cancelled.rowCount) throw Object.assign(new Error("Enrollment is no longer active, or does not belong to this contact."), { status: 409 });
        res.json(cancelled.rows[0]); return;
      } else {
        const choices = await hpRoutingOptions(s.tenantId, b.clientId);
        if (b.action === "enroll-sequence") {
          if (person.dnc || person.status !== "active")
            throw Object.assign(new Error("Only active contacts outside the DNC list can be enrolled."), { status: 409 });
          if (!choices.sequenceOptions.some(s => s.id === b.sequenceId && s.status === "active"))
            throw Object.assign(new Error("Choose an active sequence linked to HP through a play or routing rule."), { status: 400 });
          const previous = await pool.query("SELECT status FROM sequence_enrollments WHERE sequence_id=$1 AND contact_id=$2 ORDER BY id DESC LIMIT 1", [b.sequenceId,b.contactId]);
          if (previous.rows.length) {
            res.json({ enrolled:0,alreadyActive:previous.rows[0].status==="active" ? 1 : 0,existingStatus:previous.rows[0].status });
            return;
          }
          if (b.journeyId) {
            const steps = await pool.query("SELECT 1 FROM sequence_steps WHERE sequence_id=$1 LIMIT 1", [b.sequenceId]);
            if (!steps.rowCount) throw Object.assign(new Error("Publish sequence steps before bulk enrollment."), { status: 409 });
            if (!choices.journeyOptions.some(j => j.id === b.journeyId && j.status === "published"))
              throw Object.assign(new Error("Choose a published same-client journey."), { status: 400 });
            const membership = await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2", [b.journeyId,b.contactId]);
            if (!membership.rowCount) throw Object.assign(new Error("Add the contact to the selected journey before enrolling."), { status: 409 });
          }
          target = sequenceRouter; url = `/email-sequences/${b.sequenceId}/bulk-enroll`; payload = { contactIds: [b.contactId] };
        } else {
          if (!choices.journeyOptions.some(j => j.id === b.journeyId))
            throw Object.assign(new Error("Journey is outside the selected HP client."), { status: 400 });
          if (b.action === "add-journey" && !choices.journeyOptions.some(j => j.id === b.journeyId && j.status === "published"))
            throw Object.assign(new Error("Publish the journey before routing contacts."), { status: 409 });
          if (b.action === "remove-journey") {
            const manual = await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2 AND added_via='manual'", [b.journeyId, b.contactId]);
            if (!manual.rowCount) throw Object.assign(new Error("Inherited assignments must be managed from the journey or segment."), { status: 409 });
            method = "DELETE"; url = `/journeys/${b.journeyId}/contacts/${b.contactId}`; payload = {};
          } else { url = `/journeys/${b.journeyId}/contacts`; payload = { contactIds: [b.contactId] }; }
          target = journeyRouter;
        }
      }
      // Reuse the production mutation handlers, including DNC and enrollment guards.
      const originalUrl = req.url, originalMethod = req.method;
      req.url = url; req.method = method; req.body = payload;
      res.once("finish", () => { req.url = originalUrl; req.method = originalMethod; });
      target(req, res, err => {
        req.url = originalUrl; req.method = originalMethod;
        fail(req, res, err ?? Object.assign(new Error("Management action unavailable."), { status: 404 }));
      });
    } catch (err) { fail(req, res, err); }
  });
}
