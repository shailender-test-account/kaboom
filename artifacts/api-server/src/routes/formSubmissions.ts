import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

router.get("/form-submissions/export", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tenantId: number = user.tenantId;
    const formIdParam = req.query.formId as string | undefined;
    const formId = formIdParam ? parseInt(formIdParam, 10) : null;

    const rows = await db.execute(sql`
      SELECT
        fs.id,
        fs.submitted_at,
        fs.visitor_token,
        fs.action_type,
        fs.field_values,
        fs.form_id,
        jf.name        AS form_name,
        fs.journey_id,
        fs.page_id,
        c.email        AS contact_email,
        c.first_name   AS contact_first_name,
        c.last_name    AS contact_last_name,
        c.lead_score   AS contact_lead_score
      FROM form_submissions fs
      LEFT JOIN journey_forms jf ON jf.id = fs.form_id
      LEFT JOIN contacts c ON c.id = fs.contact_id
      WHERE fs.tenant_id = ${tenantId}
        AND (${formId}::int IS NULL OR fs.form_id = ${formId})
      ORDER BY fs.submitted_at DESC
    `);

    const submissions = rows.rows as any[];

    const allFieldKeys = new Set<string>();
    for (const row of submissions) {
      const fv = row.field_values ?? {};
      for (const k of Object.keys(fv)) {
        allFieldKeys.add(k);
      }
    }
    const fieldKeys = Array.from(allFieldKeys);

    const staticHeaders = [
      "submitted_at",
      "form_id",
      "form_name",
      "journey_id",
      "page_id",
      "visitor_token",
      "action_type",
      "contact_email",
      "contact_first_name",
      "contact_last_name",
      "contact_lead_score",
    ];

    const headerRow = [...staticHeaders, ...fieldKeys].join(",");

    const dataRows = submissions.map(row => {
      const fv = row.field_values ?? {};
      const staticCols = [
        row.submitted_at ? new Date(row.submitted_at).toISOString() : "",
        row.form_id,
        row.form_name,
        row.journey_id,
        row.page_id,
        row.visitor_token,
        row.action_type,
        row.contact_email,
        row.contact_first_name,
        row.contact_last_name,
        row.contact_lead_score,
      ];
      const fieldCols = fieldKeys.map(k => fv[k] ?? "");
      return buildCsvRow([...staticCols, ...fieldCols]);
    });

    const csv = [headerRow, ...dataRows].join("\r\n");

    const filename = formId ? `form-submissions-form-${formId}.csv` : "form-submissions-all.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

export default router;
