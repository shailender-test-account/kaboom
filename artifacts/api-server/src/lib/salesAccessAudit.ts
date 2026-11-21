import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

export type AuditKind = "owners" | "visibility";
type Value = number[] | "owned" | "all";

export async function recordSalesAccess(db: PoolClient, entry: {
  tenantId: number; actorId: number; targetId: number; kind: AuditKind;
  before: Value; after: Value; requestedAt: Date; rejected?: boolean;
}) {
  const outcome = entry.rejected ? "rejected"
    : JSON.stringify(entry.before) === JSON.stringify(entry.after) ? "unchanged" : "changed";
  await db.query(`INSERT INTO sales_access_audit
    (tenant_id,actor_id,target_id,kind,before_value,after_value,requested_at,outcome,recorded_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,clock_timestamp())`,
  [entry.tenantId, entry.actorId, entry.targetId, entry.kind,
    JSON.stringify(entry.before), JSON.stringify(entry.after), entry.requestedAt, outcome]);
}

/** Match HP inbound creation: ownership lock first, then Team's admin-removal lock. */
export async function beginSalesAccessChange(db: PoolClient, actor: { id: number; tenantId: number }) {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock($1,914357)", [actor.tenantId]);
  await db.query("SELECT pg_advisory_xact_lock($1,914358)", [actor.tenantId]);
  const current = (await db.query("SELECT role FROM users WHERE tenant_id=$1 AND id=$2", [actor.tenantId, actor.id])).rows[0];
  return current?.role === "admin";
}

export async function salesAccessHistory(tenantId: number, targetId: number, kind: AuditKind, beforeId?: number) {
  const rows = (await pool.query(`SELECT id,actor_id,target_id,kind,before_value,after_value,requested_at,recorded_at,outcome
    FROM sales_access_audit WHERE tenant_id=$1 AND target_id=$2 AND kind=$3
    AND ($4::int IS NULL OR id<$4) ORDER BY id DESC LIMIT 26`, [tenantId, targetId, kind, beforeId ?? null])).rows;
  const page = rows.slice(0, 25);
  const items = await displaySalesAudit(tenantId, page);
  // Preserve target display even for an empty per-target history.
  const target = kind === "visibility" ? (await pool.query(
    "SELECT coalesce(nullif(trim(concat_ws(' ',first_name,last_name)),''),'User #' || id) AS name FROM users WHERE tenant_id=$1 AND id=$2",
    [tenantId, targetId])).rows[0]?.name || (items[0]?.target ?? `Deleted user #${targetId}`)
    : (await pool.query("SELECT name FROM companies WHERE tenant_id=$1 AND id=$2",
      [tenantId, targetId])).rows[0]?.name ?? `Deleted account #${targetId}`;
  return { target, items, nextBeforeId: rows.length > 25 ? page[24].id : null };
}

/** Calendar days are UTC recorded dates; never normalize an impossible day. */
export function salesAuditDateRange(dateFrom: string, dateTo: string) {
  const day = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < "0001-01-01") return NaN;
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? ms : NaN;
  };
  const from = day(dateFrom), to = day(dateTo), length = (to - from) / 86400000 + 1;
  return length >= 1 && length <= 366
    ? { from: new Date(from), until: new Date(to + 86400000) } : null;
}

export async function tenantSalesAccessHistory(tenantId: number, filters: {
  from: Date; until: Date; actorId?: number; kind?: AuditKind; beforeId?: number;
}) {
  // Omit unused predicates so PostgreSQL can use tenant/actor paging indexes.
  const values: (number | string | Date)[] = [tenantId, filters.from, filters.until];
  const where = ["tenant_id=$1", "recorded_at >= $2", "recorded_at < $3"];
  for (const [column, value] of [
    ["actor_id", filters.actorId], ["kind", filters.kind], ["id", filters.beforeId],
  ] as const) {
    if (value !== undefined) {
      values.push(value);
      where.push(`${column}${column === "id" ? "<" : "="}$${values.length}`);
    }
  }
  const rows = (await pool.query(`SELECT id,actor_id,target_id,kind,before_value,after_value,requested_at,recorded_at,outcome
    FROM sales_access_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 26`, values)).rows;
  const page = rows.slice(0, 25);
  return { items: await displaySalesAudit(tenantId, page), nextBeforeId: rows.length > 25 ? page[24].id : null };
}

type AuditRow = {
  id: number; actor_id: number; target_id: number; kind: AuditKind;
  before_value: Value; after_value: Value; requested_at: Date; recorded_at: Date; outcome: string;
};

/** Resolve only this page's live identities; never persist names or emails in the audit. */
async function displaySalesAudit(tenantId: number, page: AuditRow[]) {
  if (!page.length) return [];
  const ids = new Set<number>(page.map(r => r.actor_id));
  for (const row of page) if (row.kind === "visibility") ids.add(row.target_id);
  for (const row of page) for (const value of [row.before_value, row.after_value])
    if (Array.isArray(value)) for (const userId of value) ids.add(userId);
  const users = (await pool.query(`SELECT id,trim(concat_ws(' ',first_name,last_name)) AS name
    FROM users WHERE tenant_id=$1 AND id=ANY($2::int[])`, [tenantId, [...ids]])).rows;
  const names = new Map<number, string>(users.map(u => [u.id, u.name || `User #${u.id}`]));
  const name = (userId: number) => names.get(userId) ?? `Deleted user #${userId}`;
  const display = (value: Value) => Array.isArray(value) ? value.map(name)
    : [value === "all" ? "All accounts" : "Own accounts"];
  const accounts = (await pool.query("SELECT id,name FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[])",
    [tenantId, [...new Set(page.filter(r => r.kind === "owners").map(r => r.target_id))]])).rows;
  const accountNames = new Map<number, string>(accounts.map(a => [a.id, a.name]));
  return page.map(r => ({
    id: r.id, actorId: r.actor_id, targetId: r.target_id, kind: r.kind,
    target: r.kind === "visibility" ? name(r.target_id)
      : accountNames.get(r.target_id) ?? `Deleted account #${r.target_id}`,
    actor: name(r.actor_id), before: display(r.before_value), after: display(r.after_value),
    requestedAt: r.requested_at.toISOString(), recordedAt: r.recorded_at.toISOString(), outcome: r.outcome,
  }));
}
