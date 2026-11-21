import type { Request } from "express";
import { sql, type SQL } from "drizzle-orm";
export const authorizedClients = Symbol("authorized request clients");

/** null is unrestricted; [] is explicitly no client access. Never conflate them. */
export function permittedClientIds(req: Request): number[] | null {
  const user = req.user as any;
  return user?.role === "admin" || !Array.isArray(user?.clientIds) ? null : user.clientIds;
}

export function clientScopeSql(column: SQL, ids: number[] | null): SQL {
  if (ids === null) return sql`true`;
  if (!ids.length) return sql`false`;
  return sql`${column} IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`;
}
