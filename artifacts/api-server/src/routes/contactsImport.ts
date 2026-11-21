import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { sql, inArray, eq, and, isNotNull } from "drizzle-orm";
import { db, pool, contactsTable } from "@workspace/db";
import { isHpClient, resolveHpAccount, ensureHpProfile } from "../lib/hpBiImport";
import { requireAuth } from "../middlewares/requireAuth";
import {
  parseCsvBufferWithMappings, previewCsvBuffer,
  type CsvRow, type ColumnMappings, type SpreadsheetType,
} from "../lib/csvImport";

interface AuthenticatedUser {
  tenantId: number;
  id: number;
}

const router: IRouter = Router();

const ACCEPTED_EXTENSIONS = [".csv", ".xls", ".xlsx"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    const ok = ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext));
    if (ok) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv, .xls, or .xlsx files are accepted"));
    }
  },
});

function detectFileType(originalname: string): SpreadsheetType {
  const lower = originalname.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".xls")) return "xls";
  return "csv";
}

function multerMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const multerErr = err as { code?: string; message?: string };
      if (multerErr.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ errors: ["File exceeds the 15 MB size limit."] });
        return;
      }
      res.status(400).json({ errors: [multerErr.message ?? "File upload error."] });
      return;
    }
    next();
  });
}

function parseMappings(raw: unknown): ColumnMappings {
  if (!raw || typeof raw !== "string") return {};
  try { return JSON.parse(raw) as ColumnMappings; } catch { return {}; }
}

router.post(
  "/contacts/import/preview",
  requireAuth,
  multerMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user as AuthenticatedUser;

      if (!req.file) {
        res.status(400).json({ headerErrors: [], headers: [], unknownHeaders: [], previewRows: [], totalDataRows: 0, validRowCount: 0, existingCount: 0, newCount: 0 });
        return;
      }

      const mappings = parseMappings((req.body as Record<string, unknown>).columnMappings);
      const fileType = detectFileType(req.file.originalname);
      const result = previewCsvBuffer(req.file.buffer, mappings, fileType);

      if (result.headerErrors.length > 0) {
        res.json({ ...result, existingCount: 0, newCount: 0 });
        return;
      }

      const { rows: parsedRows } = parseCsvBufferWithMappings(req.file.buffer, mappings, fileType);
      const emailSet = new Set<string>();
      for (const row of parsedRows) {
        const norm = row.email ? row.email.trim().toLowerCase() : null;
        if (norm) emailSet.add(norm);
      }

      let existingCount = 0;
      if (emailSet.size > 0) {
        const emailList = Array.from(emailSet);
        const existing = await db
          .select({ email: contactsTable.email })
          .from(contactsTable)
          .where(
            and(
              eq(contactsTable.tenantId, user.tenantId),
              isNotNull(contactsTable.email),
              inArray(sql`LOWER(BTRIM(${contactsTable.email}))`, emailList),
            ),
          );
        existingCount = existing.length;
      }

      const newCount = Math.max(0, result.validRowCount - existingCount);
      res.json({ ...result, existingCount, newCount });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/contacts/import",
  requireAuth,
  multerMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user as AuthenticatedUser;

      if (!req.file) {
        res.status(400).json({ errors: ["No file uploaded."] });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const clientIdRaw = body.clientId;
      const clientId = clientIdRaw ? Number(clientIdRaw) : null;
      const databaseId = body.databaseId ? Number(body.databaseId) : null;
      const segmentId = body.segmentId ? Number(body.segmentId) : null;
      const newDatabaseName = typeof body.newDatabaseName === "string" ? body.newDatabaseName.trim() : "";
      if ([clientId, databaseId, segmentId].some(id => id !== null && (!Number.isSafeInteger(id) || id <= 0))
        || (databaseId !== null && newDatabaseName) || newDatabaseName.length > 120) {
        res.status(400).json({ errors: ["Choose valid client, database and segment options; a new database name cannot accompany an existing one."] });
        return;
      }
      if (clientId !== null) {
        const clientCheck = await db.execute(sql`SELECT 1 FROM clients WHERE id = ${clientId} AND tenant_id = ${user.tenantId} LIMIT 1`);
        if (!clientCheck.rows.length) { res.status(400).json({ errors: ["Selected client is invalid."] }); return; }
      }
      if (databaseId !== null) {
        const exists = await db.execute(sql`SELECT 1 FROM contact_databases WHERE id=${databaseId} AND tenant_id=${user.tenantId}`);
        if (!exists.rows.length) { res.status(404).json({ errors: ["Database not found."] }); return; }
      }
      if (segmentId !== null) {
        const exists = await db.execute(sql`SELECT 1 FROM segments WHERE id=${segmentId} AND tenant_id=${user.tenantId} AND segment_type='static'`);
        if (!exists.rows.length) { res.status(400).json({ errors: ["Select an existing fixed-list segment. Rule-based segments cannot be manually populated."] }); return; }
      }

      const mappings = parseMappings(body.columnMappings);
      const fileType = detectFileType(req.file.originalname);
      const { rows, errors, validationSkippedCount } = parseCsvBufferWithMappings(req.file.buffer, mappings, fileType);

      if (errors.length > 0 && rows.length === 0) {
        res.status(422).json({ errors });
        return;
      }
      if (rows.length === 0) {
        res.json({ imported: 0, skipped: 0 });
        return;
      }

      const identifierRaw = body.identifier;
      const batchIdentifier = typeof identifierRaw === "string" ? identifierRaw.trim() || null : null;

      const normalisedRows: CsvRow[] = rows.map((row: CsvRow) => ({
        ...row,
        email: row.email ? row.email.trim().toLowerCase() || null : null,
        identifier: row.identifier?.trim() || batchIdentifier,
      }));

      const rowsWithIdentifier = normalisedRows.filter((row: CsvRow) => !!row.email || !!row.phone);
      const missingBothSkipped = normalisedRows.length - rowsWithIdentifier.length;

      const seenEmails = new Set<string>();
      const seenPhones = new Set<string>();
      const uniqueRows = rowsWithIdentifier.filter((row: CsvRow) => {
        if (row.email) {
          if (seenEmails.has(row.email)) return false;
          seenEmails.add(row.email);
          return true;
        }
        const ph = row.phone!;
        if (seenPhones.has(ph)) return false;
        seenPhones.add(ph);
        return true;
      });

      const skippedInUpload = rowsWithIdentifier.length - uniqueRows.length + missingBothSkipped;

      // Reject ambiguous/cross-client identities before creating HP profiles
      // or company rows; the earlier contact lookup must not be the first
      // opportunity to detect a conflict after those side effects.
      if (clientId !== null && uniqueRows.length) {
        const emails = uniqueRows.map(r => r.email).filter((v): v is string => !!v);
        const phones = uniqueRows.filter(r => !r.email && r.phone).map(r => r.phone!);
        const conflicts = await db.execute(sql`SELECT 1 FROM contacts WHERE tenant_id=${user.tenantId}
          AND client_id IS DISTINCT FROM ${clientId}
          AND (${emails.length ? sql`LOWER(BTRIM(email)) IN (${sql.join(emails.map(v=>sql`${v}`),sql`,`)})` : sql`FALSE`}
            OR ${phones.length ? sql`phone IN (${sql.join(phones.map(v=>sql`${v}`),sql`,`)})` : sql`FALSE`})
          LIMIT 1`);
        if (conflicts.rows.length) {
          res.status(409).json({ errors: ["An imported email or phone belongs to another client. Review contact ownership before uploading; no records were changed."] });
          return;
        }
      }

      // ── 1. Batch company resolution (one SELECT + one INSERT per missing name) ──
      // Company names are few per import (typically < 50) so a short loop is fine.
      const companyMap = new Map<string, number>();
      const distinctCompanyNames = [
        ...new Set(
          uniqueRows
            .map((r: CsvRow) => r.companyName?.trim())
            .filter((n): n is string => !!n),
        ),
      ];

      if (clientId !== null && distinctCompanyNames.length > 0 && await isHpClient(user.tenantId, clientId)) {
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          for (const name of distinctCompanyNames) {
            const match = await resolveHpAccount(connection, user.tenantId, clientId, null, name, true);
            if (!match.id) {
              await connection.query("ROLLBACK");
              res.status(409).json({ error: `${name}: ${match.reason}. Review the HP identity before importing contacts.` });
              return;
            }
            await ensureHpProfile(connection, user.tenantId, clientId, match.id, name, match.created, "contact import");
            companyMap.set(name.toLowerCase(), match.id);
          }
          await connection.query("COMMIT");
        } catch (error) { await connection.query("ROLLBACK"); throw error; }
        finally { connection.release(); }
      } else if (clientId !== null && distinctCompanyNames.length > 0) {
        // Batch-fetch all known companies in one query
        const lcNames = distinctCompanyNames.map(n => n.toLowerCase());
        const existingCompanies = await db.execute(sql`
          SELECT id, LOWER(name) AS lname
          FROM companies
          WHERE tenant_id = ${user.tenantId}
            AND client_id = ${clientId}
            AND LOWER(name) IN (${sql.join(lcNames.map(n => sql`${n}`), sql`, `)})
        `);
        for (const row of existingCompanies.rows as Array<{ id: number; lname: string }>) {
          companyMap.set(row.lname, row.id);
        }

        // Insert only the ones not found
        const missing = distinctCompanyNames.filter(n => !companyMap.has(n.toLowerCase()));
        for (const companyName of missing) {
          const lc = companyName.toLowerCase();
          const created = await db.execute(sql`
            INSERT INTO companies (tenant_id, client_id, name)
            VALUES (${user.tenantId}, ${clientId}, ${companyName})
            ON CONFLICT DO NOTHING
            RETURNING id
          `);
          if ((created.rows as Array<{ id: number }>).length > 0) {
            companyMap.set(lc, (created.rows as Array<{ id: number }>)[0].id);
          } else {
            const retry = await db.execute(sql`
              SELECT id FROM companies
              WHERE tenant_id = ${user.tenantId} AND LOWER(name) = ${lc}
                AND client_id = ${clientId}
              LIMIT 1
            `);
            if ((retry.rows as Array<{ id: number }>).length > 0) {
              companyMap.set(lc, (retry.rows as Array<{ id: number }>)[0].id);
            }
          }
        }
      }

      // ── 2. Batch contact lookup (two queries: email-keyed + phone-keyed) ──────
      // email → existing contact id
      const emailToId = new Map<string, number>();
      const existingClients = new Map<number, number | null>();
      const emailRows = uniqueRows.filter(r => !!r.email);
      if (emailRows.length > 0) {
        const emailList = emailRows.map(r => r.email!.toLowerCase());
        const found = await db.execute(sql`
          SELECT id, client_id, LOWER(BTRIM(email)) AS norm_email
          FROM contacts
          WHERE tenant_id = ${user.tenantId}
            AND LOWER(BTRIM(email)) IN (${sql.join(emailList.map(e => sql`${e}`), sql`, `)})
        `);
        for (const row of found.rows as Array<{ id: number; client_id: number | null; norm_email: string }>) {
          if (emailToId.has(row.norm_email)) { res.status(409).json({ errors: ["Email belongs to multiple contacts. Resolve the duplicate before importing."] }); return; }
          emailToId.set(row.norm_email, row.id);
          existingClients.set(row.id, row.client_id);
        }
      }

      // phone → existing contact id (only for phone-only rows not matched by email)
      const phoneToId = new Map<string, number>();
      const phoneOnlyRows = uniqueRows.filter(r => !r.email && !!r.phone);
      if (phoneOnlyRows.length > 0) {
        const phoneList = phoneOnlyRows.map(r => r.phone!);
        const found = await db.execute(sql`
          SELECT id, client_id, phone
          FROM contacts
          WHERE tenant_id = ${user.tenantId}
            AND phone IN (${sql.join(phoneList.map(p => sql`${p}`), sql`, `)})
        `);
        for (const row of found.rows as Array<{ id: number; client_id: number | null; phone: string }>) {
          if (phoneToId.has(row.phone)) { res.status(409).json({ errors: ["Phone belongs to multiple contacts. Resolve the duplicate before importing."] }); return; }
          phoneToId.set(row.phone, row.id);
          existingClients.set(row.id, row.client_id);
        }
      }

      // ── 3. Split rows into updates vs inserts ───────────────────────────────
      type RowWithMeta = { row: CsvRow; existingId: number | null; companyId: number | null };
      const toUpdate: RowWithMeta[] = [];
      const toInsert: RowWithMeta[] = [];
      const linkedOnlyIds: number[] = [];

      for (const row of uniqueRows) {
        const companyId = row.companyName?.trim()
          ? (companyMap.get(row.companyName.trim().toLowerCase()) ?? null)
          : null;

        let existingId: number | null = null;
        if (row.email) {
          existingId = emailToId.get(row.email.toLowerCase()) ?? null;
        } else if (row.phone) {
          existingId = phoneToId.get(row.phone) ?? null;
        }

        if (existingId !== null) {
          if (clientId !== null && existingClients.get(existingId) !== clientId) {
            res.status(409).json({ errors: ["An imported email or phone already belongs to another client's contact. Resolve ownership before importing; no contacts were changed."] });
            return;
          }
          // A shared collection can reference an existing CRM contact, but an
          // upload must never move or overwrite a contact belonging to another client.
          if (existingClients.get(existingId) === clientId) toUpdate.push({ row, existingId, companyId });
          else linkedOnlyIds.push(existingId);
        } else {
          toInsert.push({ row, existingId: null, companyId });
        }
      }

      // ── 4. Batch execute inside a single transaction ────────────────────────
      let inserted = 0;
      let updated = 0;

      await db.transaction(async (tx) => {
        let selectedDatabaseId = databaseId;
        let backingSegmentId: number;
        if (selectedDatabaseId !== null) {
          const rows = await tx.execute(sql`SELECT segment_id FROM contact_databases WHERE tenant_id=${user.tenantId} AND id=${selectedDatabaseId} FOR UPDATE`);
          if (!rows.rows.length) throw Object.assign(new Error("Database was removed during import"), { status: 409 });
          backingSegmentId = Number(rows.rows[0].segment_id);
        } else {
          const name = newDatabaseName || req.file!.originalname.replace(/\.(csv|xlsx|xls)$/i, "").trim().slice(0, 120) || "Imported contacts";
          const seg = await tx.execute(sql`INSERT INTO segments(tenant_id,name,segment_type,static_contact_ids)
            VALUES(${user.tenantId},${name},'static',ARRAY[]::integer[]) RETURNING id`);
          backingSegmentId = Number(seg.rows[0].id);
          const created = await tx.execute(sql`INSERT INTO contact_databases(tenant_id,name,segment_id)
            VALUES(${user.tenantId},${name},${backingSegmentId}) RETURNING id`);
          selectedDatabaseId = Number(created.rows[0].id);
        }
        const dataset = await tx.execute(sql`INSERT INTO contact_datasets(tenant_id,database_id,segment_id,client_id,name,added_at)
          VALUES(${user.tenantId},${selectedDatabaseId},${segmentId},${clientId},${req.file!.originalname.slice(0, 255)},NOW()) RETURNING id`);
        const datasetId = Number(dataset.rows[0].id);
        const memberIds = new Set<number>(linkedOnlyIds);
        toUpdate.forEach(({ existingId }) => memberIds.add(existingId!));
        // 4a. Batch UPDATE via a VALUES CTE (one round-trip for all updates)
        if (toUpdate.length > 0) {
          // Build per-row UPDATE queries and run them in parallel inside the tx.
          // Postgres doesn't natively support "UPDATE multiple rows with different values"
          // without complex UNNEST typing, so we batch as concurrent promises instead —
          // still one network round-trip per row but pipelined, not serialized.
          // For very large imports (>500 updates) consider switching to UNNEST.
          const BATCH_SIZE = 100;
          for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
            const batch = toUpdate.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(({ row, existingId, companyId }) => {
              const hasExtraData = Object.keys(row.extraData).length > 0;
              const extraDataVal = hasExtraData ? JSON.stringify(row.extraData) : null;
              return tx.execute(sql`
                UPDATE contacts SET
                  first_name           = COALESCE(${row.firstName},            first_name),
                  last_name            = COALESCE(${row.lastName},             last_name),
                  phone                = COALESCE(${row.phone},                phone),
                  title                = COALESCE(${row.title},                title),
                  company_name         = COALESCE(${row.companyName},          company_name),
                  company_id           = COALESCE(${companyId},                company_id),
                  designation          = COALESCE(${row.designation},          designation),
                  "function"           = COALESCE(${row.function},             "function"),
                  employee_size        = COALESCE(${row.employeeSize},         employee_size),
                  company_revenue      = COALESCE(${row.companyRevenue},       company_revenue),
                  linkedin_url         = COALESCE(${row.linkedinUrl},          linkedin_url),
                  company_linkedin_url = COALESCE(${row.companyLinkedinUrl},   company_linkedin_url),
                  city                 = COALESCE(${row.city},                 city),
                  pin                  = COALESCE(${row.pin},                  pin),
                  state                = COALESCE(${row.state},                state),
                  country              = COALESCE(${row.country},              country),
                  identifier           = COALESCE(${row.identifier},           identifier),
                  extra_data           = CASE
                    WHEN ${extraDataVal}::jsonb IS NOT NULL AND extra_data IS NOT NULL
                      THEN extra_data || ${extraDataVal}::jsonb
                    ELSE COALESCE(${extraDataVal}::jsonb, extra_data)
                  END,
                  updated_at           = NOW()
                WHERE id = ${existingId} AND tenant_id = ${user.tenantId}
              `);
            }));
            updated += batch.length;
          }
        }

        // 4b. Batch INSERT — build multi-row VALUES in one query
        if (toInsert.length > 0) {
          const BATCH_SIZE = 500;
          for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
            const batch = toInsert.slice(i, i + BATCH_SIZE);
            const valuesSql = sql.join(
              batch.map(({ row, companyId }) => {
                const hasExtraData = Object.keys(row.extraData).length > 0;
                const extraDataVal = hasExtraData ? JSON.stringify(row.extraData) : null;
                return sql`(
                  ${user.tenantId},
                  ${clientId},
                  ${row.firstName},
                  ${row.lastName},
                  ${row.email},
                  ${row.phone},
                  ${row.title},
                  ${row.companyName},
                  ${companyId},
                  ${row.designation},
                  ${row.function},
                  ${row.employeeSize},
                  ${row.companyRevenue},
                  ${row.linkedinUrl},
                  ${row.companyLinkedinUrl},
                  ${row.city},
                  ${row.pin},
                  ${row.state},
                  ${row.country},
                  ${row.identifier},
                  'import',
                  'active',
                  'pre-aware',
                  ARRAY[]::text[],
                  0,
                  ${extraDataVal}
                )`;
              }),
              sql`, `
            );
            const insertedRows = await tx.execute(sql`
              INSERT INTO contacts (
                tenant_id, client_id, first_name, last_name, email, phone, title,
                company_name, company_id, designation, "function", employee_size,
                company_revenue, linkedin_url, company_linkedin_url,
                city, pin, state, country, identifier,
                source, status, stage, tags, lead_score,
                extra_data
              ) VALUES ${valuesSql} RETURNING id
            `);
            insertedRows.rows.forEach(row => memberIds.add(Number(row.id)));
            inserted += batch.length;
          }
        }
        if (memberIds.size) {
          const ids = [...memberIds];
          await tx.execute(sql`INSERT INTO contact_dataset_members(dataset_id,contact_id)
            SELECT ${datasetId},id FROM contacts WHERE tenant_id=${user.tenantId}
            AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})
            ON CONFLICT(dataset_id,contact_id) DO NOTHING`);
          await tx.execute(sql`UPDATE segments SET static_contact_ids=(
            SELECT array_agg(DISTINCT x) FROM unnest(COALESCE(static_contact_ids, ARRAY[]::integer[]) || ARRAY[${sql.join(ids.map(id => sql`${id}`),sql`,`)}]::integer[]) x
          ),updated_at=NOW() WHERE tenant_id=${user.tenantId} AND id IN (${sql.join([...new Set([backingSegmentId,segmentId].filter((v):v is number=>v!==null))].map(id=>sql`${id}`),sql`,`)})`);
          await tx.execute(sql`UPDATE segments SET last_computed_count=cardinality(static_contact_ids),last_computed_at=NOW()
            WHERE tenant_id=${user.tenantId} AND id IN (${sql.join([...new Set([backingSegmentId,segmentId].filter((v):v is number=>v!==null))].map(id=>sql`${id}`),sql`,`)})`);
        }
      });

      const totalSkipped = validationSkippedCount + skippedInUpload;
      res.json({ imported: inserted, updated, skipped: totalSkipped });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ errors: ["A database with this name already exists. Select it from the existing databases list instead."] });
        return;
      }
      next(err);
    }
  }
);

export default router;
