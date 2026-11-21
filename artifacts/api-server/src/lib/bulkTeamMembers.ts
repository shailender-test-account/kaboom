import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { AddTeamMembersBulkBody } from "@workspace/api-zod";
import { permissionInput, safeMember } from "./teamAccess";
import { temporaryPasswordDeadline } from "./temporaryPasswords";

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export async function createTeamMemberBatch(actor: { id: number; tenantId: number }, body: unknown) {
  const parsed = AddTeamMembersBulkBody.safeParse(body);
  if (!parsed.success) fail(400, "Provide 1–50 users with first name, last name and a valid email, plus shared access settings.");
  const input = parsed.data;
  const permissions = permissionInput.safeParse(input.sectionPermissions);
  if (!permissions.success || permissions.data === null) fail(400, "Choose explicit section permissions for the batch.");
  const users = input.users.map((row, index) => {
    const firstName = row.firstName.trim(), lastName = row.lastName.trim(), email = row.email.trim().toLowerCase();
    if (!firstName || !lastName || firstName.length > 120 || lastName.length > 120 || email.length > 254) {
      fail(400, `Row ${index + 1}: provide names up to 120 characters and an email up to 254 characters.`);
    }
    return { firstName, lastName, email };
  });
  if (new Set(users.map(row => row.email)).size !== users.length) fail(400, "Duplicate emails in this batch. Each user must have a unique email.");
  const ids = input.clientIds === null ? null : [...new Set(input.clientIds)];
  if (ids && ids.length !== input.clientIds?.length) fail(400, "Duplicate client assignment.");
  const emails = sql.join(users.map(row => sql`${row.email}`), sql`,`);
  // Fail cheaply before hashing. Recheck inside the transaction for concurrent requests.
  const existing = await db.execute(sql`SELECT 1 FROM users WHERE lower(email) IN (${emails}) LIMIT 1`);
  if (existing.rows.length) fail(409, "One or more emails are already registered. No users were created; remove those rows and try again.");
  const prepared: Array<(typeof users)[number] & { tempPassword: string; passwordHash: string }> = [];
  for (const user of users) {
    // A letter prefix keeps the password literal when opened in spreadsheet
    // software, rather than triggering CSV formula escaping for a leading "-".
    const tempPassword = "U" + crypto.randomBytes(18).toString("base64url") + "A1!";
    prepared.push({ ...user, tempPassword, passwordHash: await bcrypt.hash(tempPassword, 12) });
  }
  return db.transaction(async tx => {
    const [currentActor] = await tx.select({ role: usersTable.role }).from(usersTable)
      .where(and(eq(usersTable.id, actor.id), eq(usersTable.tenantId, actor.tenantId))).for("update");
    if (currentActor?.role !== "admin") fail(403, "Administrator access required.");
    if (ids?.length) {
      const clients = await tx.execute(sql`SELECT id FROM clients WHERE tenant_id=${actor.tenantId}
        AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) FOR SHARE`);
      if (clients.rows.length !== ids.length) fail(400, "Choose clients from this workspace.");
    }
    const conflicts = await tx.execute(sql`SELECT 1 FROM users WHERE lower(email) IN (${emails}) LIMIT 1`);
    if (conflicts.rows.length) fail(409, "One or more emails are already registered. No users were created; remove those rows and try again.");
    const temporaryPasswordExpiresAt = temporaryPasswordDeadline(input.temporaryPasswordHours);
    const created = await tx.insert(usersTable).values(prepared.map(({ tempPassword: _password, ...user }) => ({
      ...user, tenantId: actor.tenantId, role: input.role,
      mustChangePassword: true,
      temporaryPasswordExpiresAt,
      sectionPermissions: permissions.data, clientIds: ids,
    }))).returning(safeMember);
    const passwords = new Map(prepared.map(user => [user.email, user.tempPassword]));
    return created.map(user => ({ user, tempPassword: passwords.get(user.email)! }));
  });
}
