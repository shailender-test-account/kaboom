/**
 * Explicit, development-only operation. Default is read-only validation.
 * Usage: tsx scripts/import-approved-gcc.ts TENANT CLIENT WORKBOOK APPROVALS_JSON REPORT_JSON [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { readHpWorkbook } from "../src/lib/hpWorkbookReader.mjs";
import { importApprovedGccProfiling, type GccApproval } from "../src/lib/hpGccProfiling";
const [tenant, client, file, approvalFile, reportFile, mode] = process.argv.slice(2);
if (!tenant || !client || !file || !approvalFile || !reportFile || !/^\d+$/.test(tenant + client)) throw new Error("Provide tenant, client, workbook, approved mappings and output report.");
if (process.env.NODE_ENV === "production") throw new Error("This reviewed operation must not run against production.");
try {
  const bytes = fs.readFileSync(file);
  const parsed = readHpWorkbook(bytes, "accounts");
  const gcc = parsed.rows.filter((r: any) => r.sheet === "GCC");
  if (!gcc.length) throw new Error("The workbook has no populated GCC sheet.");
  const fields = ["Company Name", "Name", "Job Title", "Email id", "Email id 2", "Phone No", "Phone No 2", "City"];
  if (fields.some(f => !Object.hasOwn(gcc[0].values, f))) throw new Error("GCC columns changed; review before importing.");
  const keys = ["companyName", "name", "title", "email", "email2", "phone", "phone2", "city"];
  const rows = gcc.map((r: any) => ({ sourceRow: r.row,
    values: Object.fromEntries(fields.map((f, i) => [keys[i], String(r.values[f] ?? "").trim()])) as any }));
  const approvals: GccApproval[] = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  const report = await importApprovedGccProfiling(Number(tenant), Number(client), {
    fileName: path.basename(file), fileHash: createHash("sha256").update(bytes).digest("hex"), rows,
  }, approvals, mode === "--apply");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ applied: report.applied, rows: report.results.length,
    created: report.results.filter(r => r.outcome === "created").length,
    enriched: report.results.filter(r => r.outcome === "enriched").length,
    held: report.results.filter(r => r.outcome === "held").length, accounts: report.accounts }));
} finally { await pool.end(); }
