import { pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { is } from "drizzle-orm";
import { SQL } from "drizzle-orm/sql";
import {
  getTableConfig,
  PgColumn,
  PgDialect,
  PgTable,
} from "drizzle-orm/pg-core";
import { logger } from "./logger";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const dialect = new PgDialect();

/**
 * Render a Drizzle column default into a SQL DEFAULT clause fragment
 * (without the leading "DEFAULT" keyword). Returns null if the default
 * cannot be safely reconstructed.
 */
function renderColumnDefault(col: PgColumn): string | null {
  const def = (col as unknown as { default: unknown }).default;
  if (def === undefined) return null;

  if (is(def as object, SQL)) {
    try {
      const query = dialect.sqlToQuery((def as SQL).inlineParams());
      return query.sql;
    } catch {
      return null;
    }
  }

  if (def === null) return "NULL";
  if (typeof def === "string") return quoteLiteral(def);
  if (typeof def === "number" || typeof def === "bigint") return String(def);
  if (typeof def === "boolean") return def ? "true" : "false";
  if (def instanceof Date) {
    return `${quoteLiteral(def.toISOString())}::timestamptz`;
  }
  if (typeof def === "object") {
    try {
      return `${quoteLiteral(JSON.stringify(def))}::jsonb`;
    } catch {
      return null;
    }
  }
  return null;
}

interface BuildResult {
  ok: boolean;
  statements: string[];
  reason?: string;
}

function buildCreateTable(tableName: string, table: PgTable): BuildResult {
  const cfg = getTableConfig(table);
  const colDefs: string[] = [];
  const constraints: string[] = [];

  for (const col of cfg.columns) {
    const parts = [quoteIdent(col.name), col.getSQLType()];
    if (col.primary) parts.push("PRIMARY KEY");
    if (col.notNull && !col.primary) parts.push("NOT NULL");
    if ((col as unknown as { default: unknown }).default !== undefined) {
      const def = renderColumnDefault(col);
      if (def === null) {
        return {
          ok: false,
          statements: [],
          reason: `column "${col.name}" has an unrenderable default`,
        };
      }
      parts.push(`DEFAULT ${def}`);
    }
    if ((col as unknown as { isUnique: boolean }).isUnique) {
      parts.push("UNIQUE");
    }
    colDefs.push(parts.join(" "));
  }

  for (const pk of cfg.primaryKeys) {
    const cols = pk.columns.map((c) => quoteIdent(c.name)).join(", ");
    constraints.push(`PRIMARY KEY (${cols})`);
  }

  for (const uq of cfg.uniqueConstraints) {
    const cols = uq.columns.map((c) => quoteIdent(c.name)).join(", ");
    const name = uq.getName();
    constraints.push(
      name
        ? `CONSTRAINT ${quoteIdent(name)} UNIQUE (${cols})`
        : `UNIQUE (${cols})`,
    );
  }

  for (const chk of cfg.checks) {
    try {
      const query = dialect.sqlToQuery(chk.value.inlineParams());
      constraints.push(
        `CONSTRAINT ${quoteIdent(chk.name)} CHECK (${query.sql})`,
      );
    } catch {
      return {
        ok: false,
        statements: [],
        reason: `check constraint "${chk.name}" could not be rendered`,
      };
    }
  }

  const body = [...colDefs, ...constraints].join(",\n  ");
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (\n  ${body}\n)`,
  ];

  // Foreign keys added separately and conditionally — if the referenced
  // table doesn't exist yet (e.g. created later in the same run), we skip
  // them with a warning rather than fail the whole creation.
  for (const fk of cfg.foreignKeys) {
    try {
      const ref = fk.reference();
      const localCols = ref.columns.map((c) => quoteIdent(c.name)).join(", ");
      const refTable = getTableConfig(ref.foreignTable).name;
      const refCols = ref.foreignColumns
        .map((c) => quoteIdent(c.name))
        .join(", ");
      const name = fk.getName();
      let stmt = `ALTER TABLE ${quoteIdent(tableName)} ADD CONSTRAINT ${quoteIdent(name)} FOREIGN KEY (${localCols}) REFERENCES ${quoteIdent(refTable)} (${refCols})`;
      if (fk.onUpdate) stmt += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      if (fk.onDelete) stmt += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      statements.push(stmt);
    } catch {
      // Skip unrenderable FKs — they're additive and can be added later.
    }
  }

  for (const idx of cfg.indexes) {
    try {
      const cols = idx.config.columns
        .map((c) => {
          const name = (c as unknown as { name?: string }).name;
          return name ? quoteIdent(name) : null;
        })
        .filter((c): c is string => c !== null)
        .join(", ");
      if (!cols) continue;
      const idxName = idx.config.name;
      if (!idxName) continue;
      const unique = idx.config.unique ? "UNIQUE " : "";
      statements.push(
        `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(tableName)} (${cols})`,
      );
    } catch {
      // skip — non-essential
    }
  }

  return { ok: true, statements };
}

export async function checkSchemaDrift(): Promise<void> {
  // Default: auto-apply safe additive fixes in non-production environments.
  // Production must opt in explicitly with AUTO_APPLY_SCHEMA_DRIFT=true.
  // Either env can be forced with AUTO_APPLY_SCHEMA_DRIFT=true|false.
  const envFlag = process.env.AUTO_APPLY_SCHEMA_DRIFT;
  const autoApply =
    envFlag === "true"
      ? true
      : envFlag === "false"
        ? false
        : process.env.NODE_ENV !== "production";

  const tables: {
    tableName: string;
    columns: Set<string>;
    table: PgTable;
  }[] = [];

  for (const value of Object.values(schema)) {
    if (value && typeof value === "object" && value instanceof PgTable) {
      const cfg = getTableConfig(value as PgTable);
      tables.push({
        tableName: cfg.name,
        columns: new Set(cfg.columns.map((c) => c.name)),
        table: value as PgTable,
      });
    }
  }

  if (tables.length === 0) {
    logger.warn("Schema drift check: no Drizzle tables discovered, skipping");
    return;
  }

  const client = await pool.connect();
  try {
    const tableNames = tables.map((t) => t.tableName);
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [tableNames],
    );

    const actual = new Map<string, Set<string>>();
    for (const row of rows) {
      let set = actual.get(row.table_name);
      if (!set) {
        set = new Set();
        actual.set(row.table_name, set);
      }
      set.add(row.column_name);
    }

    let missingCount = 0;
    let missingTableCount = 0;
    let fixedColumnCount = 0;
    let createdTableCount = 0;
    let unfixableCount = 0;

    for (const { tableName, table } of tables) {
      const cfg = getTableConfig(table);
      let actualCols = actual.get(tableName);

      if (!actualCols) {
        missingTableCount++;

        if (autoApply) {
          const build = buildCreateTable(tableName, table);
          if (build.ok) {
            try {
              await client.query("BEGIN");
              for (const stmt of build.statements) {
                await client.query(stmt);
              }
              await client.query("COMMIT");
              createdTableCount++;
              actualCols = new Set(cfg.columns.map((c) => c.name));
              actual.set(tableName, actualCols);
              logger.info(
                { table: tableName, statements: build.statements.length },
                `Schema drift auto-fix: created missing table "${tableName}"`,
              );
              continue;
            } catch (err) {
              await client.query("ROLLBACK").catch(() => {});
              logger.error(
                { err, table: tableName, statements: build.statements },
                `Schema drift auto-fix failed to create table "${tableName}" — falling back to warning`,
              );
            }
          } else {
            logger.warn(
              { table: tableName, reason: build.reason },
              `Schema drift: cannot safely auto-create table "${tableName}" (${build.reason}). Run "pnpm --filter @workspace/db run push" to sync.`,
            );
          }
        }

        logger.warn(
          { table: tableName, autoApply },
          `Schema drift: table "${tableName}" is defined in code but missing from the database. ` +
            `Run "pnpm --filter @workspace/db run push" (dev) or re-publish (prod) to sync the schema.`,
        );
        continue;
      }

      for (const col of cfg.columns) {
        if (actualCols.has(col.name)) continue;
        missingCount++;

        // Only auto-add columns that are safely additive on a non-empty table:
        // strictly nullable, no NOT NULL (even with default — we don't try to
        // reconstruct default expressions because reflecting Drizzle defaults
        // back into SQL DDL is brittle and version-dependent).
        const isSafelyAdditive = !col.notNull;

        if (autoApply && isSafelyAdditive) {
          let sql: string | undefined;
          try {
            const sqlType = col.getSQLType();
            const defaultExpr = renderColumnDefault(col);
            const defaultClause = defaultExpr ? ` DEFAULT ${defaultExpr}` : "";
            sql = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS ${quoteIdent(col.name)} ${sqlType}${defaultClause}`;
            await client.query(sql);
            fixedColumnCount++;
            logger.info(
              { table: tableName, column: col.name, sql },
              `Schema drift auto-fix: added nullable column "${tableName}.${col.name}"`,
            );
            actualCols.add(col.name);
            continue;
          } catch (err) {
            logger.error(
              { err, table: tableName, column: col.name, sql },
              `Schema drift auto-fix failed for "${tableName}.${col.name}" — falling back to warning`,
            );
          }
        } else if (autoApply && !isSafelyAdditive) {
          unfixableCount++;
          logger.warn(
            { table: tableName, column: col.name },
            `Schema drift: column "${tableName}.${col.name}" is NOT NULL — auto-fix only adds nullable columns. ` +
              `Add it manually via "pnpm --filter @workspace/db run push" or a migration.`,
          );
          continue;
        }

        logger.warn(
          { table: tableName, column: col.name },
          `Schema drift: column "${tableName}.${col.name}" is defined in code but missing from the database. ` +
            `Run "pnpm --filter @workspace/db run push" (dev) or re-publish (prod) to sync the schema.`,
        );
      }
    }

    const remainingMissingTables = missingTableCount - createdTableCount;
    const remainingMissingColumns = missingCount - fixedColumnCount;

    // ── Idempotent partial unique index: dedup concurrent backfill/recompute
    // sequence_enrollment_skipped events at the DB level so ON CONFLICT DO NOTHING
    // works even when two calls race past the SELECT guard simultaneously.
    // IF NOT EXISTS makes this safe to run on every boot.
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ae_enrollment_skipped_dedup
        ON activity_events (
          tenant_id,
          contact_id,
          source,
          (metadata::jsonb->>'new_intent_state'),
          date_trunc('day', created_at AT TIME ZONE 'UTC')
        )
        WHERE event_type = 'sequence_enrollment_skipped'
      `);
    } catch (err) {
      logger.warn({ err }, "Schema drift check: could not ensure idx_ae_enrollment_skipped_dedup (non-fatal)");
    }

    if (
      missingCount === 0 &&
      missingTableCount === 0
    ) {
      logger.info(
        { tables: tables.length },
        "Schema drift check passed: all expected columns present",
      );
    } else if (
      autoApply &&
      remainingMissingTables === 0 &&
      remainingMissingColumns === 0
    ) {
      logger.info(
        {
          tables: tables.length,
          createdTables: createdTableCount,
          fixedColumns: fixedColumnCount,
        },
        "Schema drift check passed after auto-fix: all missing tables/columns created",
      );
    } else if (autoApply) {
      logger.warn(
        {
          missingColumns: missingCount,
          missingTables: missingTableCount,
          fixedColumns: fixedColumnCount,
          createdTables: createdTableCount,
          unfixable: unfixableCount,
        },
        "Schema drift check completed — auto-fix applied safe additive changes; remaining items need a real migration",
      );
    } else {
      logger.warn(
        { missingColumns: missingCount, missingTables: missingTableCount },
        "Schema drift check completed with warnings — set AUTO_APPLY_SCHEMA_DRIFT=true to auto-add nullable columns and missing tables at boot",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Schema drift check failed to run (non-fatal)");
  } finally {
    client.release();
  }
}
