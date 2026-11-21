import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { PreviewSalesOwnerBatchBody, PreviewSalesOwnerBatchResponse } from "@workspace/api-zod";
import { loadSalesAccess, type SalesActor } from "./salesAccountAccess";
import { enrichSalesOwners, isSalesUnassigned, loadSalesAccounts, salesAssignableUsers } from "./salesHotAccounts";

type Input = ReturnType<typeof PreviewSalesOwnerBatchBody.parse>;
type Row = ReturnType<typeof PreviewSalesOwnerBatchResponse.parse>["rows"][number];
// Process-local signing key: a restart expires pending reviews rather than allowing
// a stale or edited browser payload to authorize a write.
const reviewKey = randomBytes(32);
const REVIEW_MS = 10 * 60_000;
export class SalesBatchConflict extends Error {}
const conflict = () => new SalesBatchConflict("Selection or access changed. Nothing was saved. Reload unassigned accounts and review again.");
const snapshot = (rows: Row[]) => rows.map(({ assignableUsers: _, ...row }) => row);

function validateInput(input: unknown): Input {
  const value = PreviewSalesOwnerBatchBody.parse(input);
  if (new Set(value.assignments.map(a => a.accountId)).size !== value.assignments.length
    || value.assignments.some(a => new Set(a.userIds).size !== a.userIds.length)) throw conflict();
  return value;
}
async function rowsFor(actor: SalesActor, input: Input, db: Pick<PoolClient, "query"> = pool, lock = false): Promise<Row[]> {
  const ids = input.assignments.map(a => a.accountId);
  const accounts = await enrichSalesOwners(actor.tenantId,
    await loadSalesAccounts(await loadSalesAccess(actor), { accountIds: ids }), db);
  if (accounts.length !== ids.length || accounts.some(a => !isSalesUnassigned(a) || !a.evidence.length)) throw conflict();
  const choices = new Map<number, Awaited<ReturnType<typeof salesAssignableUsers>>>();
  for (const clientId of [...new Set(accounts.map(a => a.clientId))].sort((a, b) => a - b)) {
    choices.set(clientId, await salesAssignableUsers(actor.tenantId, clientId, db, lock));
  }
  return input.assignments.map(assignment => {
    const account = accounts.find(a => a.id === assignment.accountId)!;
    const assignableUsers = choices.get(account.clientId)!.map(({ id, name, email }) => ({ id, name, email }));
    const proposedUsers = assignment.userIds.map(id => assignableUsers.find(u => u.id === id));
    if (proposedUsers.some(u => !u)) throw conflict();
    return { accountId: account.id, accountName: account.name, clientId: account.clientId,
      clientName: account.clientName, assignableUsers, proposedUsers: proposedUsers as Row["proposedUsers"] };
  });
}
export async function previewSalesOwnerBatch(actor: SalesActor, raw: unknown) {
  const input = validateInput(raw);
  const rows = await rowsFor(actor, input);
  let reviewToken: string | null = null;
  if (input.assignments.every(a => a.userIds.length)) {
    const payload = Buffer.from(JSON.stringify({ actorId: actor.id, tenantId: actor.tenantId,
      expires: Date.now() + REVIEW_MS, input, rows: snapshot(rows) })).toString("base64url");
    reviewToken = `${payload}.${createHmac("sha256", reviewKey).update(payload).digest("base64url")}`;
  }
  return { rows, reviewToken };
}
export async function confirmSalesOwnerBatch(actor: SalesActor, token: string) {
  const [payload, signature, extra] = token.split(".");
  const expected = createHmac("sha256", reviewKey).update(payload ?? "").digest();
  const actual = Buffer.from(signature ?? "", "base64url");
  if (!payload || extra !== undefined || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw conflict();
  let review;
  try { review = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { throw conflict(); }
  if (review.actorId !== actor.id || review.tenantId !== actor.tenantId || review.expires <= Date.now()) throw conflict();
  const input = validateInput(review.input);
  if (input.assignments.some(a => !a.userIds.length)) throw conflict();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Same lock as the single-account writer; never replace another admin's assignments.
    await db.query("SELECT pg_advisory_xact_lock($1,914357)", [actor.tenantId]);
    const admin = await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND role='admin' FOR SHARE", [actor.tenantId, actor.id]);
    if (!admin.rowCount) throw conflict();
    const ids = input.assignments.map(a => a.accountId);
    const locked = await db.query(`SELECT id FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE`, [actor.tenantId, ids]);
    if (locked.rows.length !== ids.length) throw conflict();
    await db.query(`SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=ANY($2::int[]) FOR SHARE`, [actor.tenantId, ids]);
    const rows = await rowsFor(actor, input, db, true);
    if (JSON.stringify(snapshot(rows)) !== JSON.stringify(review.rows)) throw conflict();
    for (const row of rows) for (const user of row.proposedUsers) {
      await db.query(`INSERT INTO sales_account_owners(tenant_id,client_id,account_id,user_id) VALUES($1,$2,$3,$4)`,
        [actor.tenantId, row.clientId, row.accountId, user.id]);
    }
    await db.query("COMMIT");
    return { assignedAccounts: ids };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
