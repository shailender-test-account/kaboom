type SourceRecord = { id: string; externalEventId?: string | null; accountId: number; contactId: number | null;
  occurredAt: string; kind: string };

/** Link only the two projections of the exact same owned submission, never names or similar answers. */
export function linkQuestionnaireRecords<T extends SourceRecord>(records: T[]): (T & {
  responseRecordId?: string; qualificationRecordId?: string;
})[] {
  const key = (r: T, id: string) => `${r.accountId}:${r.contactId}:${r.occurredAt}:${id}`;
  const reference=(r:T)=>(r.externalEventId??r.id).replace(/^form_submission:(\d+)$/,"form:$1:response");
  const responses = new Map(records.filter(r => ["other", "interest"].includes(r.kind)
    && /^(inbound|form):\d+:response$/.test(reference(r)))
    .map(r => [key(r, reference(r)), r]));
  const responseFor = new Map<string, string>(), leadFor = new Map<string, string>();
  for (const r of records) {
    const ref = reference(r);
    if (r.kind !== "lead" || !/^(inbound|form):\d+$/.test(ref)) continue;
    const response = responses.get(key(r, `${ref}:response`));
    if (response) { responseFor.set(r.id, response.id); leadFor.set(response.id, r.id); }
  }
  return records.map(r => ({ ...r, ...(responseFor.has(r.id) ? { responseRecordId: responseFor.get(r.id) } : {}),
    ...(leadFor.has(r.id) ? { qualificationRecordId: leadFor.get(r.id) } : {}) }));
}

/** Presentation only; metric arithmetic continues to use all canonical records. */
export function groupQuestionnaireRecords<T extends SourceRecord & { responseRecordId?: string; qualificationRecordId?: string }>(
  records: T[],
): (T & { relatedRecords?: T[] })[] {
  const byId = new Map(records.map(r => [r.id, r]));
  return records.filter(r => !r.qualificationRecordId || !byId.has(r.qualificationRecordId))
    .map(r => r.responseRecordId && byId.has(r.responseRecordId)
      ? { ...r, relatedRecords: [byId.get(r.responseRecordId)!] } : r);
}
