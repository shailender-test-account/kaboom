interface EvidenceRecord {
  kind: string; status: string | null; contactId: number | null;
  orderValue: number | null; currency: string | null;
}
const touchKinds = new Set(["invitation", "attendance", "digital", "content", "other", "interest"]);

/** Use the same event units as the dashboard, not current CRM contact scores. */
export function hpEvidenceKindMatches(record: EvidenceRecord, kind?: string) {
  if (!kind) return true;
  if (kind === "engaged_contacts") return touchKinds.has(record.kind) && !!record.contactId;
  if (kind === "hot" || kind === "warm") return record.kind === "lead" && record.status === kind;
  return record.kind === kind ||
    record.status === kind && !["closed_won", "closed_lost", "opportunity", "prospective", "lead"].includes(kind) ||
    kind === "other" && ["other", "interest"].includes(record.kind) ||
    kind === "touchpoint" && touchKinds.has(record.kind) ||
    kind === "prospective_value" && ["lead", "prospective"].includes(record.kind) && record.orderValue !== null && !!record.currency;
}
