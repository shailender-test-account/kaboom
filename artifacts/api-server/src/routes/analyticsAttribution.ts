import { sql } from "drizzle-orm";

type SqlFragment = ReturnType<typeof sql>;
type ActivityAlias = "ae" | "ax" | "ae2";

/** Resolve the reviewed journey association for one event and contact. */
export function reviewedJourneyAccount(
  tenantId: SqlFragment,
  contactId: SqlFragment,
  journeyId: SqlFragment,
  occurredAt: SqlFragment,
): SqlFragment {
  return sql`(
    SELECT s.account_id FROM intent_inbound_submissions s
    JOIN companies linked_account ON linked_account.id=s.account_id AND linked_account.tenant_id=s.tenant_id
    JOIN journeys linked_journey ON linked_journey.id=${journeyId} AND linked_journey.tenant_id=s.tenant_id
      AND linked_journey.client_id=s.client_id
    WHERE s.tenant_id=${tenantId} AND s.source_id IS NULL
      AND s.raw_fields->>'manualProvenance'='manual'
      AND s.raw_fields->'trackedContact'->>'contactId'=${contactId}::text
      AND s.raw_fields->'trackedContact'->>'journeyId'=${journeyId}::text
      AND ${occurredAt}>=COALESCE(
        (s.raw_fields->'trackedContact'->>'effectiveFrom')::timestamptz,
        linked_account.inbound_manual_at,s.created_at)
    ORDER BY s.id DESC LIMIT 1
  )`;
}

/** Verified associations apply to the immutable, explicitly reviewed event IDs only. */
export function verifiedJourneyAccount(tenantId: SqlFragment, eventId: SqlFragment): SqlFragment {
  return sql`(SELECT v.account_id FROM verified_journey_sessions v
    WHERE v.tenant_id=${tenantId} AND v.revoked_at IS NULL
      AND ${eventId}=ANY(v.event_ids)
    ORDER BY v.id DESC LIMIT 1)`;
}

/** Activity-event counterpart of verifiedJourneyAccount. */
export function verifiedActivityAccount(tenantId: SqlFragment, eventId: SqlFragment): SqlFragment {
  return sql`(SELECT v.account_id FROM verified_journey_sessions v
    WHERE v.tenant_id=${tenantId} AND v.revoked_at IS NULL
      AND ${eventId}=ANY(v.activity_event_ids)
    ORDER BY v.id DESC LIMIT 1)`;
}

/**
 * Canonical read-time activity attribution. Explicit review/verification takes
 * precedence over event company and the current tenant-owned contact company.
 * Visitor tokens resolve only their tenant-matched contact; the token itself is
 * never treated as an account identity.
 */
export function activityCompanyIdExpression(alias: ActivityAlias): SqlFragment {
  const table = alias === "ae" ? sql`ae` : alias === "ax" ? sql`ax` : sql`ae2`;
  const tenantId = sql`${table}.tenant_id`;
  const contactId = sql`${table}.contact_id`;
  const companyId = sql`${table}.company_id`;
  const journeyId = sql`${table}.journey_id`;
  const occurredAt = sql`${table}.created_at`;
  const visitorToken = sql`${table}.visitor_token`;
  const eventId = sql`${table}.id`;
  const resolvedContactId = sql`COALESCE(${contactId}, (
    SELECT vt.contact_id FROM visitor_tokens vt
    WHERE vt.tenant_id=${tenantId} AND vt.token=${visitorToken}
  ))`;
  return sql`COALESCE(
    ${verifiedActivityAccount(tenantId, eventId)},
    ${reviewedJourneyAccount(tenantId, resolvedContactId, journeyId, occurredAt)},
    ${companyId},
    (SELECT c.company_id FROM contacts c
     WHERE c.id=${resolvedContactId} AND c.tenant_id=${tenantId})
  )`;
}
