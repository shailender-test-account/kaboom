import { GetContactResponse } from "@workspace/api-zod";
import type { z } from "zod";

type Alternative = NonNullable<z.infer<typeof GetContactResponse>["gccAlternatives"]>[number];
const supplied = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const sourceKey = (row: Record<string, unknown>) => JSON.stringify([row.fileHash, row.sourceRow]);

/** Project only read-only alternatives for the exact linked contact, never inferred identities. */
export function contactGccAlternatives(source: unknown, contactId: number): Alternative[] {
  if (!Array.isArray(source)) return [];
  const records = source.filter((r): r is Record<string, unknown> =>
    r !== null && typeof r === "object" && !Array.isArray(r));
  const deleted = new Set(records.filter(r => r.deleted).map(sourceKey));
  return records.flatMap(r => {
    if (r.deleted || deleted.has(sourceKey(r)) || r.contactId !== contactId ||
      !r.values || typeof r.values !== "object" || Array.isArray(r.values)) return [];
    const values = r.values as Record<string, unknown>;
    const alternateEmail = supplied(values.email2), alternatePhone = supplied(values.phone2);
    if (!alternateEmail && !alternatePhone) return [];
    const fileName = supplied(r.fileName), fileHash = supplied(r.fileHash), sheet = supplied(r.sheet);
    if (!fileName || !fileHash || !sheet || !Number.isInteger(r.sourceRow) || Number(r.sourceRow) < 1) return [];
    return [{ alternateEmail, alternatePhone, fileName, fileHash, sheet,
      sourceRow: Number(r.sourceRow), importedAt: supplied(r.importedAt) }];
  });
}
