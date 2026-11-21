type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";

export function describeMatch(match: RecordValue) {
  const payload = object(match.payload);
  const values = object(payload.values);
  const fields = object(payload.fields);
  const roster = payload.roster === true;
  const contactReview = /email.*(conflict|ambiguous|unmatched)|contact identity|contact.*conflicting/i.test(text(match.reason));
  return {
    roster, contactReview,
    title: text(roster ? values.name : fields.companyName || values.accountName || values.account_name || payload.accountName) || "Identity review",
    details: (roster ? [
      ["HP ID", text(values.hp_id)], ["Parent", text(values.top_name)],
      ["Source", text(payload.fileName)],
    ] : [
      ["Person", text(fields.name || values.name)],
      ["Email", text(fields.email || values.email)],
      ["Source", text(payload.fileName)],
    ]).filter(([, value]) => value),
  };
}

export function queueCount(rows: unknown, fallback: number) {
  if (!Array.isArray(rows)) return String(fallback);
  // The endpoint returns at most 100 rows, not an exact total beyond that.
  return rows.length < 100 ? String(rows.length) : "100+";
}
