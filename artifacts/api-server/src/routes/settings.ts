import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

router.patch("/settings/organization", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const parsed = z.object({ name: z.string().min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Name is required" }); return; }
    await db.execute(sql`UPDATE tenants SET name = ${parsed.data.name.trim()} WHERE id = ${user.tenantId}`);
    res.json({ ok: true, name: parsed.data.name.trim() });
  } catch (err) { next(err); }
});

router.post("/settings/tenants", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin") { res.status(403).json({ error: "Admins only" }); return; }
    const parsed = z.object({
      name: z.string().min(1).max(100),
      adminEmail: z.string().email(),
      adminPassword: z.string().min(8),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const { name, adminEmail, adminPassword } = parsed.data;
    const existingRows = await db.execute(sql`SELECT id FROM users WHERE email = ${adminEmail.toLowerCase()}`);
    if ((existingRows.rows as any[]).length > 0) {
      res.status(400).json({ error: "Email already in use" }); return;
    }
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now();
    const tenantRows = await db.execute(sql`
      INSERT INTO tenants (name, slug, plan) VALUES (${name.trim()}, ${slug}, 'professional') RETURNING id, name, plan
    `);
    const newTenant = (tenantRows.rows as { id: number; name: string; plan: string }[])[0];
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await db.execute(sql`
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
      VALUES (${newTenant.id}, ${adminEmail.toLowerCase()}, ${passwordHash}, 'Admin', '', 'admin')
    `);
    res.status(201).json({ ok: true, tenant: newTenant });
  } catch (err) { next(err); }
});

export default router;
