import type { HpBiRecord } from "./types";

/** Only combine server-linked projections present in this filtered selection. */
export function combineSourceRecords(records: HpBiRecord[]): HpBiRecord[] {
  const byId = new Map(records.map(r => [r.id, r]));
  return records.filter(r => !r.qualificationRecordId || !byId.has(r.qualificationRecordId))
    .map(r => r.responseRecordId && byId.has(r.responseRecordId)
      ? { ...r, relatedRecords: [byId.get(r.responseRecordId)!] } : r);
}
