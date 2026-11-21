import { Router, type IRouter, type ErrorRequestHandler } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db, usersTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/requireAuth";
import { accessInput, permissionInput, changeMember, safeMember } from "../lib/teamAccess";
import { createTeamMemberBatch } from "../lib/bulkTeamMembers";
import { temporaryPasswordHours, temporaryPasswordDeadline } from "../lib/temporaryPasswords";
import { dispatchWelcomeEmails, previewWelcomeEmails, WelcomeEmailError } from "../services/welcomeEmails";

const router: IRouter = Router();
router.use(requireAuth);
router.use(["/users", "/team-access"], requireRole("admin"));

const welcomeInput = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(50)
    .refine(ids => new Set(ids).size === ids.length, "Choose each user only once"),
}).strict();

router.post("/users/welcome-email/preview", async (req, res, next): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const input = welcomeInput.safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Choose 1–50 unique users." }); return; }
  try { res.json(await previewWelcomeEmails((req.user as any).tenantId, input.data.userIds)); }
  catch (err) { next(err); }
});

router.post("/users/welcome-email/send", async (req, res, next): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const input = welcomeInput.extend({
    confirmed: z.literal(true),
    expectedRecipients: z.array(z.object({ id: z.number().int().positive(), email: z.string().email() }).strict()).min(1).max(50),
  }).safeParse(req.body);
  if (!input.success) { res.status(400).json({ error: "Review and explicitly confirm the recipients." }); return; }
  try { res.status(202).json(await dispatchWelcomeEmails((req.user as any).tenantId, input.data.userIds, input.data.expectedRecipients)); }
  catch (err) { next(err); }
});

router.get("/team-access", async (req, res, next) => {
  try {
    res.json(await db.select(safeMember).from(usersTable).where(eq(usersTable.tenantId, (req.user as any).tenantId)));
  } catch (err) { next(err); }
});
router.patch("/users/:id/access", async (req, res, next): Promise<void> => {
  const parsed = accessInput.safeParse(req.body);
  const id = Number(req.params.id);
  if (!parsed.success || !Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Choose a valid role and section permissions" }); return; }
  try { res.json(await changeMember(req.user as any, id, parsed.data)); } catch (err) { next(err); }
});

router.get("/users", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        role: usersTable.role,
        sectionPermissions: usersTable.sectionPermissions,
        clientIds: usersTable.clientIds,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.tenantId, user.tenantId));
    res.json(rows);
  } catch (err) { next(err); }
});

router.patch("/users/:id/role", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({ role: z.enum(["admin", "manager", "editor", "viewer"]) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid role" }); return; }
  try {
    const user = req.user as any;
    const [target] = await db.select().from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, user.tenantId)));
    if (!target) { res.status(404).json({ error: "User not found" }); return; }
    res.json(await changeMember(user, id, { role: parsed.data.role, sectionPermissions: target.sectionPermissions, clientIds: target.clientIds }));
  } catch (err) { next(err); }
});

router.patch("/users/:id/deactivate", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (user.id === id) { res.status(400).json({ error: "Cannot deactivate yourself" }); return; }
    res.json(await changeMember(user, id, { role: "viewer", sectionPermissions: {}, clientIds: [] }));
  } catch (err) { next(err); }
});

router.patch("/users/:id/profile", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const user = req.user as any;
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
    const [row] = await db
      .update(usersTable)
      .set(parsed.data)
      .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, user.tenantId)))
      .returning(safeMember);
    if (!row) { res.status(404).json({ error: "User not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/users/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (user.id === id) { res.status(400).json({ error: "Cannot delete yourself" }); return; }
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, user.tenantId)));
    if (!existing) { res.status(404).json({ error: "User not found" }); return; }
    res.json(await changeMember(user, id, "delete"));
  } catch (err) { next(err); }
});

// ── PATCH /users/:id/password — workspace administrators only ──
router.patch("/users/:id/password", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const actor = req.user as any;
  if (actor.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const parsed = z.object({ password: z.string().min(8).max(72), temporaryPasswordHours }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Use a password of 8–72 characters and a temporary lifetime of 1–168 whole hours." }); return; }
  try {
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const row = await db.transaction(async tx => {
      const [updated] = await tx.update(usersTable)
        .set({ passwordHash: hash, mustChangePassword: true, sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          temporaryPasswordExpiresAt: temporaryPasswordDeadline(parsed.data.temporaryPasswordHours) })
        .where(and(eq(usersTable.id, id), eq(usersTable.tenantId, actor.tenantId)))
        .returning({ id: usersTable.id, email: usersTable.email, temporaryPasswordExpiresAt: usersTable.temporaryPasswordExpiresAt });
      if (updated) await tx.execute(sql`UPDATE password_reset_tokens SET used_at=now() WHERE email=${updated.email} AND used_at IS NULL`);
      return updated;
    });
    if (!row) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ ok: true, temporaryPasswordExpiresAt: row.temporaryPasswordExpiresAt });
  } catch (err) { next(err); }
});

router.post("/users/:id/reissue-temporary-password", async (req, res, next): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const id = Number(req.params.id);
  const parsed = z.object({ temporaryPasswordHours }).strict().safeParse(req.body);
  if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
    res.status(400).json({ error: "Choose a valid user and a lifetime of 1–168 hours." }); return;
  }
  try {
    const actor = req.user as any;
    if (id === actor.id) { res.status(400).json({ error: "Use your own Change password action instead." }); return; }
    const tempPassword = "U" + crypto.randomBytes(18).toString("base64url") + "A1!";
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const user = await db.transaction(async tx => {
      const [currentActor] = await tx.select({ role: usersTable.role }).from(usersTable)
        .where(and(eq(usersTable.id, actor.id), eq(usersTable.tenantId, actor.tenantId))).for("update");
      if (currentActor?.role !== "admin") throw Object.assign(new Error("Administrator access required."), { status: 403 });
      const [updated] = await tx.update(usersTable).set({
        passwordHash, temporaryPasswordExpiresAt: temporaryPasswordDeadline(parsed.data.temporaryPasswordHours),
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      }).where(and(eq(usersTable.id, id), eq(usersTable.tenantId, actor.tenantId), eq(usersTable.mustChangePassword, true)))
        .returning(safeMember);
      if (!updated) throw Object.assign(new Error("User not found or no longer has a temporary password. Refresh the team list."), { status: 409 });
      // Replacement credentials must not be superseded by older bearer links.
      // The user update holds the row lock, matching other password writers.
      await tx.execute(sql`UPDATE password_reset_tokens SET used_at=now() WHERE email=${updated.email} AND used_at IS NULL`);
      return updated;
    });
    res.json({ user, tempPassword });
  } catch (err) { next(err); }
});

router.post("/users/bulk", async (req, res, next): Promise<void> => {
  res.set("Cache-Control", "no-store");
  try {
    res.status(201).json(await createTeamMemberBatch(req.user as any, req.body));
  } catch (err) { next(err); }
});

router.post("/users/invite", async (req, res, next): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const parsed = z.object({
    temporaryPasswordHours,
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    role: z.enum(["admin", "manager", "editor", "viewer"]).default("editor"),
    sectionPermissions: permissionInput.optional(),
    clientIds: z.array(z.number().int().positive()).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const user = req.user as any;
    const ids = [...new Set(parsed.data.clientIds ?? [])];
    if (ids.length !== (parsed.data.clientIds ?? []).length) { res.status(400).json({ error: "Duplicate client assignment" }); return; }
    if (parsed.data.role !== "admin" && ids.length) {
      const rows = await db.execute(sql`SELECT id FROM clients WHERE tenant_id=${user.tenantId}
        AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`);
      if (rows.rows.length !== ids.length) { res.status(400).json({ error: "Choose clients from this workspace" }); return; }
    }
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, parsed.data.email));
    if (existing.length > 0) { res.status(409).json({ error: "Email already registered" }); return; }
    const tempPassword = crypto.randomBytes(18).toString("base64url") + "A1!";
    const hash = await bcrypt.hash(tempPassword, 12);
    const [newUser] = await db
      .insert(usersTable)
      .values({ tenantId: user.tenantId, email: parsed.data.email, firstName: parsed.data.firstName, lastName: parsed.data.lastName, role: parsed.data.role, sectionPermissions: parsed.data.sectionPermissions ?? null, clientIds: parsed.data.role === "admin" ? null : ids, passwordHash: hash, mustChangePassword: true, temporaryPasswordExpiresAt: temporaryPasswordDeadline(parsed.data.temporaryPasswordHours) })
      .returning(safeMember);
    res.status(201).json({ user: newUser, tempPassword });
  } catch (err) { next(err); }
});

const teamErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof WelcomeEmailError) {
    res.status(err.status).json({ error: err.message }); return;
  }
  if ((err?.code ?? err?.cause?.code) === "23505") {
    res.status(409).json({ error: "This email is already registered. Choose another email." }); return;
  }
  next(err);
};
router.use(teamErrors);
export default router;
