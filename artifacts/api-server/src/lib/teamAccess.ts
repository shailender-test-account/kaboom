import { and, eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { SECTIONS } from "@workspace/api-zod";
import { z } from "zod";

const levels = z.enum(["none", "view", "manage"]);
export const permissionInput = z.object(Object.fromEntries(SECTIONS.map(([key]) => [key, levels.optional()]))).strict()
  .transform(value => Object.fromEntries(Object.entries(value).filter((entry): entry is [string, "none" | "view" | "manage"] => entry[1] !== undefined)))
  .nullable();
export const accessInput = z.object({
  role: z.enum(["admin", "manager", "editor", "viewer"]),
  sectionPermissions: permissionInput,
  clientIds: z.array(z.number().int().positive()).max(100).nullable().optional(),
}).strict();
export const safeMember = {
  mustChangePassword: usersTable.mustChangePassword,
  temporaryPasswordExpiresAt: usersTable.temporaryPasswordExpiresAt,
  id: usersTable.id, email: usersTable.email, firstName: usersTable.firstName,
  lastName: usersTable.lastName, role: usersTable.role,
  sectionPermissions: usersTable.sectionPermissions, clientIds: usersTable.clientIds, createdAt: usersTable.createdAt,
};
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export async function changeMember(actor: { id: number; tenantId: number }, id: number,
  input: z.infer<typeof accessInput> | "delete") {
  return db.transaction(async tx => {
    // Serialize all admin removal paths, including simultaneous self-demotions.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${actor.tenantId}, 914358)`);
    const [currentActor] = await tx.select().from(usersTable).where(and(eq(usersTable.id, actor.id), eq(usersTable.tenantId, actor.tenantId)));
    if (currentActor?.role !== "admin") fail(403, "Administrator access required");
    const [target] = await tx.select().from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, actor.tenantId))).for("update");
    if (!target) fail(404, "User not found");
    if (input === "delete" && id === actor.id) fail(400, "Cannot delete yourself");
    if (target.role === "admin" && (input === "delete" || input.role !== "admin")) {
      const admins = await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.tenantId, actor.tenantId), eq(usersTable.role, "admin")));
      if (admins.length <= 1) fail(409, "Add or promote another administrator before changing the last administrator");
    }
    if (input === "delete") {
      await tx.delete(usersTable).where(eq(usersTable.id, id));
      return { ok: true };
    }
    if (input.role !== "admin" && input.clientIds !== undefined) {
      const ids = [...new Set(input.clientIds ?? [])];
      if (ids.length !== (input.clientIds ?? []).length) fail(400, "Duplicate client assignment");
      if (ids.length) {
        const matches = await tx.execute(sql`SELECT id FROM clients WHERE tenant_id=${actor.tenantId}
          AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`);
        if (matches.rows.length !== ids.length) fail(400, "Choose clients from this workspace");
      }
    }
    const [updated] = await tx.update(usersTable).set({
      ...input, clientIds: input.role === "admin" ? null : input.clientIds === undefined ? target.clientIds : input.clientIds,
    }).where(eq(usersTable.id, id)).returning(safeMember);
    return updated;
  });
}
