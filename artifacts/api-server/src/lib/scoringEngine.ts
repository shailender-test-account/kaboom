import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  buildContactsWhereClause,
  type FilterCriterion,
  type LogicOperator,
} from "../utils/segmentFilter";

interface ScoringContext {
  tenantId: number;
  contactId: number;
  newScore: number;
  oldScore?: number;
  tagsAdded?: string[];
  tagsRemoved?: string[];
  newIntentState?: string;
  oldIntentState?: string;
}

/**
 * After a contact score or tag change, evaluate all active routing rules
 * for the tenant and enroll the contact in matching journeys/sequences.
 */
export async function evaluateRoutingRules(ctx: ScoringContext): Promise<void> {
  const {
    tenantId, contactId, newScore, oldScore,
    tagsAdded = [], tagsRemoved = [],
    newIntentState, oldIntentState,
  } = ctx;

  // Load all active rules for this tenant
  const rules = (await db.execute(sql`
    SELECT * FROM journey_routing_rules
    WHERE tenant_id = ${tenantId} AND is_active = true
    ORDER BY id
  `)).rows as Array<{
    id: number;
    name: string;
    condition_type: string;
    condition_value: Record<string, any>;
    journey_id: number;
    enroll_sequence_id: number | null;
    apply_to: string;
    apply_client_id: number | null;
    apply_segment_id: number | null;
    if_already_in_journey: string;
    reenroll_after_completion: boolean;
  }>;

  for (const rule of rules) {
    const cv = rule.condition_value as Record<string, any>;
    const reenrollAfterCompletion = rule.reenroll_after_completion ?? false;
    let matched = false;

    switch (rule.condition_type) {
      case "score_above":
        matched = newScore >= Number(cv.threshold ?? 0) &&
          (oldScore === undefined || oldScore < Number(cv.threshold ?? 0));
        break;
      case "score_below":
        matched = newScore < Number(cv.threshold ?? 0) &&
          (oldScore === undefined || oldScore >= Number(cv.threshold ?? 0));
        break;
      case "score_range":
        matched = newScore >= Number(cv.min ?? 0) && newScore <= Number(cv.max ?? 999);
        break;
      case "tag_added":
        matched = tagsAdded.includes(String(cv.tag ?? ""));
        break;
      case "tag_removed":
        matched = tagsRemoved.includes(String(cv.tag ?? ""));
        break;
      case "intent_state_is":
        // Fire only on transition: new state matches and old state was different
        matched = !!newIntentState &&
          newIntentState === String(cv.state ?? "") &&
          oldIntentState !== newIntentState;
        break;
    }

    if (!matched) continue;

    // Check apply_to scope — if scoped to client/segment, verify contact belongs
    if (rule.apply_to === "client" && rule.apply_client_id) {
      const contact = (await db.execute(sql`
        SELECT client_id FROM contacts WHERE id = ${contactId}
      `)).rows[0] as { client_id: number } | undefined;
      if (!contact || contact.client_id !== rule.apply_client_id) continue;
    }
    if (rule.apply_to === "segment" && rule.apply_segment_id) {
      // Verify contact is actually a member of the named segment (not via journey linkage)
      const segRow = (await db.execute(sql`
        SELECT segment_type, filter_criteria, static_contact_ids, logic_operator
        FROM segments WHERE id = ${rule.apply_segment_id} AND tenant_id = ${tenantId}
      `)).rows[0] as {
        segment_type: string;
        filter_criteria: unknown;
        static_contact_ids: unknown;
        logic_operator: string;
      } | undefined;
      if (!segRow) continue;

      if (segRow.segment_type === "static") {
        const ids = Array.isArray(segRow.static_contact_ids)
          ? (segRow.static_contact_ids as unknown[]).map(Number)
          : [];
        if (!ids.includes(contactId)) continue;
      } else {
        const criteria: FilterCriterion[] = Array.isArray(segRow.filter_criteria)
          ? (segRow.filter_criteria as FilterCriterion[]) : [];
        const logicOp: LogicOperator = segRow.logic_operator === "OR" ? "OR" : "AND";
        const whereExpr = await buildContactsWhereClause(tenantId, criteria, logicOp);
        const inSeg = (await db.execute(sql`
          SELECT 1 FROM contacts c
          LEFT JOIN companies co ON co.id = c.company_id
          WHERE c.id = ${contactId} AND ${whereExpr}
        `)).rows[0];
        if (!inSeg) continue;
      }
    }

    // Defensive tenant ownership check: verify journey still belongs to this tenant
    // (guards against stale/corrupted rule data after a rule was tampered with)
    if (rule.journey_id) {
      const journeyOwned = (await db.execute(sql`
        SELECT 1 FROM journeys WHERE id = ${rule.journey_id} AND tenant_id = ${tenantId} LIMIT 1
      `)).rows[0];
      if (!journeyOwned) continue;
    }
    if (rule.enroll_sequence_id) {
      const seqOwned = (await db.execute(sql`
        SELECT 1 FROM email_sequences WHERE id = ${rule.enroll_sequence_id} AND tenant_id = ${tenantId} LIMIT 1
      `)).rows[0];
      if (!seqOwned) continue;
    }

    // Check if already in journey
    const alreadyIn = (await db.execute(sql`
      SELECT 1 FROM journey_contacts
      WHERE journey_id = ${rule.journey_id} AND contact_id = ${contactId}
    `)).rows[0];

    if (alreadyIn && rule.if_already_in_journey === "skip") continue;

    // Add to journey — re_add resets added_at and added_via so the contact is treated as freshly enrolled
    if (alreadyIn && rule.if_already_in_journey === "re_add") {
      await db.execute(sql`
        UPDATE journey_contacts
        SET added_via = 'routing_rule', added_at = NOW()
        WHERE journey_id = ${rule.journey_id} AND contact_id = ${contactId}
      `);
    } else {
      await db.execute(sql`
        INSERT INTO journey_contacts (journey_id, contact_id, added_via)
        VALUES (${rule.journey_id}, ${contactId}, 'routing_rule')
        ON CONFLICT (journey_id, contact_id) DO NOTHING
      `);
    }

    // Log auto_journey_assigned activity event
    const ruleLabel = rule.name ? `"${rule.name}"` : `#${rule.id}`;
    await db.execute(sql`
      INSERT INTO activity_events
        (tenant_id, contact_id, event_type, description, journey_id, created_at)
      VALUES (
        ${tenantId}, ${contactId}, 'auto_journey_assigned',
        ${`Auto-assigned to journey via routing rule ${ruleLabel}`},
        ${rule.journey_id}, NOW()
      )
    `).catch(() => {}); // non-critical

    // Fire notification
    await db.execute(sql`
      INSERT INTO notifications (tenant_id, type, title, body, contact_id, read)
      VALUES (${tenantId}, 'routing_rule_fired',
        'Contact routed to journey',
        ${`Contact (id=${contactId}) matched routing rule and was added to journey (id=${rule.journey_id})`},
        ${contactId}, false)
    `).catch(() => {}); // non-critical

    // Enroll contact directly in the sequence (do NOT create a synthetic completed run)
    if (rule.enroll_sequence_id) {
      // DNC check: skip sequence enrollment if the contact has opted out
      const dncRow = (await db.execute(sql`
        SELECT dnc FROM contacts WHERE id = ${contactId} AND tenant_id = ${tenantId} LIMIT 1
      `)).rows[0] as { dnc: boolean } | undefined;

      if (dncRow?.dnc) {
        // Log a skipped activity event so admins can see why no enrollment occurred
        await db.execute(sql`
          INSERT INTO activity_events
            (tenant_id, contact_id, event_type, description, sequence_id, created_at)
          VALUES (
            ${tenantId}, ${contactId}, 'sequence_enrollment_skipped',
            ${'Sequence enrollment skipped — contact is on the DNC list'},
            ${rule.enroll_sequence_id}, NOW()
          )
        `).catch(() => {}); // non-critical
      } else {
        // Completed enrollment guard: skip re-enrollment if the contact already
        // finished this sequence, unless the rule explicitly allows it.
        const completedEnrollment = (await db.execute(sql`
          SELECT 1 FROM sequence_enrollments
          WHERE sequence_id = ${rule.enroll_sequence_id}
            AND contact_id  = ${contactId}
            AND status      = 'completed'
          LIMIT 1
        `)).rows[0];

        if (completedEnrollment && !reenrollAfterCompletion) {
          // Contact already completed this sequence — skip silently and log
          await db.execute(sql`
            INSERT INTO activity_events
              (tenant_id, contact_id, event_type, description, sequence_id, created_at)
            VALUES (
              ${tenantId}, ${contactId}, 'sequence_enrollment_skipped',
              ${'Sequence enrollment skipped — contact already completed this sequence'},
              ${rule.enroll_sequence_id}, NOW()
            )
          `).catch(() => {}); // non-critical
        } else {
          await db.execute(sql`
            INSERT INTO sequence_enrollments (sequence_id, contact_id, status, enrolled_at)
            VALUES (${rule.enroll_sequence_id}, ${contactId}, 'active', NOW())
            ON CONFLICT (sequence_id, contact_id) WHERE status = 'active' DO NOTHING
          `).catch(() => {});

          // Log sequence enrollment activity event
          await db.execute(sql`
            INSERT INTO activity_events
              (tenant_id, contact_id, event_type, description, sequence_id, created_at)
            VALUES (
              ${tenantId}, ${contactId}, 'sequence_enrolled',
              ${'Auto-enrolled via routing rule'}, ${rule.enroll_sequence_id}, NOW()
            )
          `).catch(() => {}); // non-critical
        }
      }
    }
  }
}
