import { sql, SQL } from "drizzle-orm";
import { db } from "@workspace/db";

export type LogicOperator = "AND" | "OR";

export interface FilterCriterion {
  field: string;
  operator: string;
  value: unknown;
}

function joinSQL(parts: SQL[], op: LogicOperator): SQL {
  return parts.reduce((acc, part) => op === "OR" ? sql`${acc} OR ${part}` : sql`${acc} AND ${part}`);
}

/** Returns true if v is a non-empty, non-whitespace string */
function hasStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Returns a finite number, or null if v is not finite */
function toNum(v: unknown): number | null {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Builds a properly parameterised SQL IN(...) expression for a string list.
 * Drizzle ORM expands JS arrays as individual params ($1, $2, ...) — NOT a pg
 * array literal — so `ANY(${arr}::text[])` produces invalid SQL.
 * Using IN(${sql.join(...)}) works correctly.
 */
function sqlInText(items: string[]): SQL {
  return sql.join(items.map(s => sql`${s}`), sql`, `);
}

/** Same for numeric (int) lists. */
function sqlInInt(items: number[]): SQL {
  return sql.join(items.map(n => sql`${n}`), sql`, `);
}

/**
 * Builds ARRAY[...] for PostgreSQL array operators (&& / @>).
 * Cannot use IN for these — must use a proper pg array.
 */
function sqlTextArray(items: string[]): SQL {
  return sql`ARRAY[${sql.join(items.map(s => sql`${s}`), sql`, `)}]::text[]`;
}

/**
 * Converts an array of filter criteria into a parameterized Drizzle SQL expression.
 * All user-supplied values are bound parameters — never interpolated into the SQL string.
 * Table alias `c` = contacts, `co` = companies (LEFT JOIN required by caller when company filters used).
 * The function is async to allow `member_of_segment` to look up referenced segment criteria.
 * depth controls recursion depth for member_of_segment (max 2 levels).
 */
export async function buildContactsWhereClause(
  tid: number,
  criteria: FilterCriterion[],
  logicOperator: LogicOperator = "AND",
  depth = 0,
): Promise<SQL> {
  const tenantFilter = sql`c.tenant_id = ${tid}`;
  const parts: SQL[] = [];

  for (const crit of criteria ?? []) {
    const { field, operator, value } = crit;
    if (!field || !operator) continue;

    switch (field) {
      // ── Score ──────────────────────────────────────────────────────────────
      case "lead_score": {
        const n = toNum(value);
        if (n === null) break;
        if (operator === "gt")      parts.push(sql`c.lead_score > ${n}`);
        else if (operator === "lt") parts.push(sql`c.lead_score < ${n}`);
        else if (operator === "eq") parts.push(sql`c.lead_score = ${n}`);
        else if (operator === "between" && Array.isArray(value)) {
          const lo = toNum(value[0]);
          const hi = toNum(value[1]);
          if (lo !== null && hi !== null) parts.push(sql`c.lead_score BETWEEN ${lo} AND ${hi}`);
        }
        break;
      }

      case "score_tier": {
        const tiers = Array.isArray(value) ? value : [value];
        const tierParts: SQL[] = [];
        for (const tier of tiers) {
          if (tier === "Cold")          tierParts.push(sql`c.lead_score BETWEEN 0 AND 24`);
          else if (tier === "Warm")     tierParts.push(sql`c.lead_score BETWEEN 25 AND 49`);
          else if (tier === "Hot")      tierParts.push(sql`c.lead_score BETWEEN 50 AND 74`);
          else if (tier === "Very Hot") tierParts.push(sql`c.lead_score BETWEEN 75 AND 119`);
          else if (tier === "Champion") tierParts.push(sql`c.lead_score >= 120`);
        }
        if (tierParts.length > 0) {
          const combined = joinSQL(tierParts, "OR");
          parts.push(operator === "is_not" ? sql`NOT (${combined})` : sql`(${combined})`);
        }
        break;
      }

      case "score_change_nd": {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const v = value as Record<string, unknown>;
          const delta = toNum(v.delta ?? v.threshold ?? 0) ?? 0;
          const days = Math.max(1, toNum(v.days ?? v.n ?? 30) ?? 30);
          const subq = sql`(SELECT COALESCE(SUM(ae.score_delta), 0)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.created_at > NOW() - make_interval(days => ${days}))`;
          if (operator === "gt")      parts.push(sql`${subq} > ${delta}`);
          else if (operator === "lt") parts.push(sql`${subq} < ${delta}`);
          else if (operator === "eq") parts.push(sql`${subq} = ${delta}`);
        }
        break;
      }

      case "score_change_30d": {
        const threshold = toNum(value);
        if (threshold === null) break;
        const subq = sql`(SELECT COALESCE(SUM(ae.score_delta), 0)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.created_at > NOW() - INTERVAL '30 days')`;
        if (operator === "gt")      parts.push(sql`${subq} > ${threshold}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${threshold}`);
        else if (operator === "eq") parts.push(sql`${subq} = ${threshold}`);
        break;
      }

      // ── Profile ────────────────────────────────────────────────────────────
      case "stage": {
        if (!Array.isArray(value) || value.length === 0) break;
        const stages = value.map(String);
        // Use IN(...) — ANY(${array}::text[]) sends individual params which PostgreSQL
        // interprets as a record, not an array literal, causing "malformed array literal"
        if (operator === "is")
          parts.push(sql`c.stage IN (${sqlInText(stages)})`);
        else if (operator === "is_not")
          parts.push(sql`c.stage NOT IN (${sqlInText(stages)})`);
        break;
      }

      case "title": {
        if (!hasStr(value)) break;
        const v = String(value);
        if (operator === "contains")
          parts.push(sql`LOWER(COALESCE(c.title,'')) LIKE LOWER(${'%' + v + '%'})`);
        else if (operator === "is")
          parts.push(sql`LOWER(COALESCE(c.title,'')) = LOWER(${v})`);
        else if (operator === "starts_with")
          parts.push(sql`LOWER(COALESCE(c.title,'')) LIKE LOWER(${v + '%'})`);
        break;
      }

      case "company_name": {
        if (!hasStr(value)) break;
        const v = String(value);
        if (operator === "contains") {
          // Check both the direct company_name column AND the companies FK
          parts.push(sql`(
            LOWER(COALESCE(c.company_name, '')) LIKE LOWER(${'%' + v + '%'})
            OR EXISTS (
              SELECT 1 FROM companies co2
              WHERE co2.id = c.company_id
                AND LOWER(co2.name) LIKE LOWER(${'%' + v + '%'})
            )
          )`);
        }
        break;
      }

      case "industry": {
        if (!hasStr(value)) break;
        const v = String(value);
        if (operator === "contains")
          parts.push(sql`EXISTS (SELECT 1 FROM companies co2 WHERE co2.id = c.company_id AND LOWER(COALESCE(co2.industry,'')) LIKE LOWER(${'%' + v + '%'}))`);
        else if (operator === "is")
          parts.push(sql`EXISTS (SELECT 1 FROM companies co2 WHERE co2.id = c.company_id AND LOWER(COALESCE(co2.industry,'')) = LOWER(${v}))`);
        break;
      }

      case "tags": {
        // Tags are a PostgreSQL TEXT[] column — must use ARRAY[...] constructor, not IN
        if (Array.isArray(value) && value.length > 0) {
          const tags = value.map(String);
          if (operator === "contains_any")      parts.push(sql`c.tags && ${sqlTextArray(tags)}`);
          else if (operator === "contains_all") parts.push(sql`c.tags @> ${sqlTextArray(tags)}`);
          else if (operator === "contains")     parts.push(sql`c.tags @> ${sqlTextArray(tags)}`);
        } else if (hasStr(value) && operator === "contains") {
          parts.push(sql`c.tags @> ${sqlTextArray([String(value)])}`);
        }
        break;
      }

      case "source": {
        if (!Array.isArray(value) || value.length === 0) break;
        const sources = value.map(String);
        if (operator === "is")          parts.push(sql`c.source IN (${sqlInText(sources)})`);
        else if (operator === "is_not") parts.push(sql`c.source NOT IN (${sqlInText(sources)})`);
        break;
      }

      case "identifier": {
        if (operator === "contains") {
          const vals = (Array.isArray(value) ? value : [value])
            .map(String)
            .map(v => v.trim())
            .filter(v => v.length > 0);
          if (vals.length === 0) break;
          const containsParts = vals.map(v => sql`LOWER(COALESCE(c.identifier,'')) LIKE LOWER(${'%' + v + '%'})`);
          parts.push(joinSQL(containsParts, "OR"));
        } else if (operator === "is" || operator === "is_not") {
          const vals = (Array.isArray(value) ? value : [value]).map(String).filter(v => v.trim() !== "");
          if (vals.length === 0) break;
          if (operator === "is")          parts.push(sql`c.identifier IN (${sqlInText(vals)})`);
          else if (operator === "is_not") parts.push(sql`(c.identifier IS NULL OR c.identifier NOT IN (${sqlInText(vals)}))`);
        }
        break;
      }

      case "client_id": {
        if (!Array.isArray(value) || value.length === 0) break;
        const clientIds = value.map(Number).filter(n => isFinite(n));
        if (clientIds.length === 0) break;
        if (operator === "is")          parts.push(sql`c.client_id IN (${sqlInInt(clientIds)})`);
        else if (operator === "is_not") parts.push(sql`c.client_id NOT IN (${sqlInInt(clientIds)})`);
        break;
      }

      // ── Date filters ───────────────────────────────────────────────────────
      case "created_at": {
        if (operator === "last_n_days") {
          const n = toNum(value);
          if (n === null || n <= 0) break;
          parts.push(sql`c.created_at > NOW() - make_interval(days => ${n})`);
        } else if (operator === "before" || operator === "after") {
          if (!hasStr(value)) break;
          const dateVal = String(value).trim();
          if (operator === "before") parts.push(sql`c.created_at < ${dateVal}::timestamptz`);
          else                       parts.push(sql`c.created_at > ${dateVal}::timestamptz`);
        }
        break;
      }

      case "last_activity_at": {
        if (operator === "last_n_days") {
          const n = toNum(value);
          if (n === null || n <= 0) break;
          parts.push(sql`c.last_activity > NOW() - make_interval(days => ${n})`);
        } else if (operator === "not_in_n_days") {
          const n = toNum(value);
          if (n === null || n <= 0) break;
          parts.push(sql`(c.last_activity IS NULL OR c.last_activity < NOW() - make_interval(days => ${n}))`);
        } else if (operator === "before" || operator === "after") {
          if (!hasStr(value)) break;
          const dateVal = String(value).trim();
          if (operator === "before") parts.push(sql`c.last_activity < ${dateVal}::timestamptz`);
          else                       parts.push(sql`c.last_activity > ${dateVal}::timestamptz`);
        }
        break;
      }

      // ── Engagement ─────────────────────────────────────────────────────────
      case "email_opens": {
        const n = toNum(value);
        if (n === null) break;
        const subq = sql`(SELECT COUNT(*)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_open')`;
        if (operator === "gt")      parts.push(sql`${subq} > ${n}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${n}`);
        else if (operator === "eq") parts.push(sql`${subq} = ${n}`);
        break;
      }

      case "email_clicks": {
        const n = toNum(value);
        if (n === null) break;
        const subq = sql`(SELECT COUNT(*)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_click')`;
        if (operator === "gt")      parts.push(sql`${subq} > ${n}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${n}`);
        else if (operator === "eq") parts.push(sql`${subq} = ${n}`);
        break;
      }

      case "email_open_rate": {
        const pct = toNum(value);
        if (pct === null) break;
        const openSubq = sql`(SELECT COUNT(*)::float FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_open')`;
        const sentSubq = sql`NULLIF((SELECT COUNT(*)::float FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_sent'), 0)`;
        if (operator === "gt")      parts.push(sql`${openSubq} / ${sentSubq} * 100 > ${pct}`);
        else if (operator === "lt") parts.push(sql`${openSubq} / ${sentSubq} * 100 < ${pct}`);
        break;
      }

      case "email_click_rate": {
        const pct = toNum(value);
        if (pct === null) break;
        const clickSubq = sql`(SELECT COUNT(*)::float FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_click')`;
        const openSubq2 = sql`NULLIF((SELECT COUNT(*)::float FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_open'), 0)`;
        if (operator === "gt")      parts.push(sql`${clickSubq} / ${openSubq2} * 100 > ${pct}`);
        else if (operator === "lt") parts.push(sql`${clickSubq} / ${openSubq2} * 100 < ${pct}`);
        break;
      }

      case "emails_received": {
        const n = toNum(value);
        if (n === null) break;
        const subq = sql`(SELECT COUNT(*)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'email_sent')`;
        if (operator === "gt")      parts.push(sql`${subq} > ${n}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${n}`);
        break;
      }

      case "pages_viewed": {
        const n = toNum(value);
        if (n === null) break;
        const subq = sql`(SELECT COUNT(*)::int FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'page_view')`;
        if (operator === "gt")      parts.push(sql`${subq} > ${n}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${n}`);
        else if (operator === "eq") parts.push(sql`${subq} = ${n}`);
        break;
      }

      case "visited_journey":
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'page_view')`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'page_view')`);
        break;

      case "submitted_form":
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM form_submissions fs WHERE fs.contact_id = c.id)`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM form_submissions fs WHERE fs.contact_id = c.id)`);
        break;

      case "downloaded_asset":
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM asset_downloads ad WHERE ad.tenant_id = c.tenant_id AND ad.visitor_token IN (SELECT token FROM visitor_tokens WHERE contact_id = c.id))`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM asset_downloads ad WHERE ad.tenant_id = c.tenant_id AND ad.visitor_token IN (SELECT token FROM visitor_tokens WHERE contact_id = c.id))`);
        break;

      // ── Journey & Sequences ────────────────────────────────────────────────
      case "in_journey":
        if (operator === "yes")
          parts.push(sql`c.id IN (SELECT jc2.contact_id FROM journey_contacts jc2 JOIN journeys j2 ON j2.id = jc2.journey_id WHERE j2.tenant_id = ${tid})`);
        else if (operator === "no")
          parts.push(sql`c.id NOT IN (SELECT jc2.contact_id FROM journey_contacts jc2 JOIN journeys j2 ON j2.id = jc2.journey_id WHERE j2.tenant_id = ${tid})`);
        break;

      case "journey_count": {
        const n = toNum(value);
        if (n === null) break;
        const subq = sql`(SELECT COUNT(DISTINCT jc2.journey_id)::int FROM journey_contacts jc2 JOIN journeys j2 ON j2.id = jc2.journey_id WHERE jc2.contact_id = c.id AND j2.tenant_id = ${tid})`;
        if (operator === "gt")      parts.push(sql`${subq} > ${n}`);
        else if (operator === "lt") parts.push(sql`${subq} < ${n}`);
        else if (operator === "eq") parts.push(sql`${subq} = ${n}`);
        break;
      }

      case "enrolled_sequence":
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM sequence_enrollments se WHERE se.contact_id = c.id)`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM sequence_enrollments se WHERE se.contact_id = c.id)`);
        break;

      case "sequence_status": {
        const statuses = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
        if (statuses.length === 0) break;
        if (operator === "is")
          parts.push(sql`c.id IN (SELECT contact_id FROM sequence_enrollments WHERE status IN (${sqlInText(statuses)}))`);
        else if (operator === "is_not")
          parts.push(sql`c.id NOT IN (SELECT contact_id FROM sequence_enrollments WHERE status IN (${sqlInText(statuses)}))`);
        break;
      }

      case "score_trend":
        if (operator === "rising")
          parts.push(sql`EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type IN ('email_open','email_click','form_submit','asset_download','page_view','video_view') AND ae.created_at > NOW() - INTERVAL '30 days')`);
        else if (operator === "falling")
          parts.push(sql`EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type IN ('email_bounced','inactivity') AND ae.created_at > NOW() - INTERVAL '30 days')`);
        else if (operator === "flat")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.created_at > NOW() - INTERVAL '30 days')`);
        break;

      // ── Segment membership — evaluates actual segment criteria ─────────────
      case "member_of_segment": {
        const segId = toNum(value);
        if (segId === null || segId <= 0 || depth >= 2) break;

        const refRows = (await db.execute(sql`
          SELECT segment_type, filter_criteria, static_contact_ids, logic_operator
          FROM segments WHERE id = ${segId} AND tenant_id = ${tid}
        `)).rows as Array<{
          segment_type: string;
          filter_criteria: FilterCriterion[] | null;
          static_contact_ids: number[] | null;
          logic_operator: string;
        }>;
        if (!refRows.length) break;

        const ref = refRows[0];
        let memberExpr: SQL;

        if (ref.segment_type === "static") {
          const ids = (ref.static_contact_ids ?? [])
            .map(id => parseInt(String(id), 10))
            .filter(n => !isNaN(n));
          memberExpr = ids.length > 0
            ? sql`c.id IN (${sqlInInt(ids)})`
            : sql`FALSE`;
        } else {
          const refOp: LogicOperator = ref.logic_operator === "OR" ? "OR" : "AND";
          const refCriteria: FilterCriterion[] = ref.filter_criteria ?? [];
          if (refCriteria.length === 0) {
            memberExpr = sql`TRUE`;
          } else {
            const subExpr = await buildContactsWhereClause(tid, refCriteria, refOp, depth + 1);
            memberExpr = subExpr;
          }
        }

        if (operator === "yes")     parts.push(memberExpr);
        else if (operator === "no") parts.push(sql`NOT (${memberExpr})`);
        break;
      }

      case "visited_journey_id": {
        const jid = toNum(value);
        if (jid === null || jid <= 0) break;
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'page_view' AND ae.journey_id = ${jid})`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM activity_events ae WHERE ae.contact_id = c.id AND ae.event_type = 'page_view' AND ae.journey_id = ${jid})`);
        break;
      }

      case "submitted_form_id": {
        const fid = toNum(value);
        if (fid === null || fid <= 0) break;
        if (operator === "yes")
          parts.push(sql`EXISTS (SELECT 1 FROM form_submissions fs WHERE fs.contact_id = c.id AND fs.form_id = ${fid})`);
        else if (operator === "no")
          parts.push(sql`NOT EXISTS (SELECT 1 FROM form_submissions fs WHERE fs.contact_id = c.id AND fs.form_id = ${fid})`);
        break;
      }
    }
  }

  if (parts.length === 0) return tenantFilter;
  const combined = joinSQL(parts, logicOperator);
  return sql`${tenantFilter} AND (${combined})`;
}
