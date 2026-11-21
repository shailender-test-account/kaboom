import type { IRouter } from "express";
import { z } from "zod";
import { hpDimensions } from "../lib/hpBiImport";
import { loadParentPivot, pivotCsv } from "../lib/hpParentPivot";
import { registerHpParentViews } from "./hpParentViews";

const day = z.string().regex(/^(20\d{2}|2100)-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Choose a valid calendar day.");
function choices<T extends z.ZodType>(item: T, maximum: number) {
  return z.preprocess(value => {
    if (value === undefined) return [];
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.array(item).max(maximum).transform(values => [...new Set(values)]));
}
export const pivotQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  currentStart: day, currentEnd: day, previousStart: day, previousEnd: day,
  parents: choices(z.string().min(1).max(200), 100),
  segments: choices(z.string().min(1).max(100), 20),
  portfolios: choices(z.enum(["PS", "Print", "Unassigned"]), 3),
  rads: choices(z.enum(["Retention", "Acquisition", "Development", "Unknown"]), 4),
  basis: z.enum(["PS", "Print"]).default("PS"),
  breakdown: z.enum(["total", "segment", "portfolio", "segment_portfolio", "rad"]).default("total"),
  sortBy: z.enum(["touchpoints", "leads", "hot", "opportunities"]).default("touchpoints"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  newOnly: z.enum(["true", "1"]).optional().transform(Boolean),
  abmOnly: z.enum(["true", "1"]).optional().transform(Boolean),
  incompleteOnly: z.enum(["true", "1"]).optional().transform(Boolean),
  dimension: z.enum(Object.keys(hpDimensions) as [string, ...string[]]).optional(),
  dimensionValue: z.string().max(200).optional(),
  salesPerson: z.string().trim().max(320).optional(),
  opportunity: z.enum(["Business Services", "Business Collaboration", "IT Hardware", "Security"]).optional(),
  focusParent: z.string().min(1).max(200).optional(), focusColumn: z.string().max(300).optional(),
  focusPeriod: z.enum(["current", "previous"]).optional(),
  focusMetric: z.enum(["touchpoints", "engagedContacts", "leads", "hot", "warm", "opportunities", "closedWon", "closedLost", "opportunityValue", "prospectiveValue", "bookedValue"]).optional(),
  evidencePage: z.coerce.number().int().min(1).max(10000).default(1),
  format: z.enum(["json", "csv"]).default("json"),
}).superRefine((value, context) => {
  for (const [start, end] of [["currentStart", "currentEnd"], ["previousStart", "previousEnd"]] as const) {
    const length = (Date.parse(`${value[end]}T00:00:00Z`) - Date.parse(`${value[start]}T00:00:00Z`)) / 86_400_000;
    if (length < 0) context.addIssue({ code: "custom", path: [end], message: "End date must be on or after start date." });
    if (length >= 1096) context.addIssue({ code: "custom", path: [end], message: "Each comparison period must be no longer than three years." });
  }
});

export function registerHpParentPivot(router: IRouter, scope: (req: any) => Promise<{ tenantId: number; filters: { clientId: number } }>, fail: (req: any, res: any, error: any) => void) {
  registerHpParentViews(router, scope, fail);
  router.get("/analytics/hp-bi/pivot", async (req, res) => {
    try {
      const input = pivotQuerySchema.parse(req.query);
      const { tenantId } = await scope(req);
      const data = await loadParentPivot(tenantId, input);
      if (input.format === "csv") {
        res.setHeader("Content-Disposition", 'attachment; filename="hp-parent-comparison.csv"');
        res.type("text/csv").send(pivotCsv(data));
      } else res.json(data.result);
    } catch (error) { fail(req, res, error); }
  });
}
