/** Exact owned identities only. Never infer a legal account from a domain or fuzzy name. */
export interface RosterIdentity { hp_id: string | null; name: string; aliases: string[]; parent_key: string }
export const rosterIdentityKey = (row: Pick<RosterIdentity, "hp_id" | "name">) =>
  row.hp_id || `name:${row.name.trim().toLowerCase()}`;
export interface ExistingRosterIdentity {
  crmId: number; name: string; hp_id?: string | null; aliases?: string[] | null;
  parent_key?: string | null; [key: string]: any;
}
export function matchHpRoster(incoming: RosterIdentity[], existing: ExistingRosterIdentity[], reviewed = new Map<string, number>()) {
  const norm = (s: string) => s.trim().toLowerCase();
  const byId = new Map<string, ExistingRosterIdentity>();
  const byCrmId = new Map<number, ExistingRosterIdentity>();
  const byName = new Map<string, Set<ExistingRosterIdentity>>();
  const sourceNames = new Map<string, Set<string>>();
  for (const row of existing) {
    byCrmId.set(row.crmId, row);
    if (row.hp_id) byId.set(row.hp_id, row);
    for (const name of new Set([row.name, ...(row.aliases ?? [])].map(norm))) {
      const bucket = byName.get(name) ?? new Set(); bucket.add(row); byName.set(name, bucket);
    }
  }
  for (const row of incoming) for (const name of new Set([row.name, ...row.aliases].map(norm))) {
    const bucket = sourceNames.get(name) ?? new Set(); bucket.add(rosterIdentityKey(row)); sourceNames.set(name, bucket);
  }
  const decisions = incoming.map(row => {
    const canonical = row.hp_id ? byId.get(row.hp_id) : undefined;
    if (canonical) return { row, existing: canonical, reason: null as string | null };
    const reviewedId = reviewed.get(rosterIdentityKey(row));
    const approved = reviewedId === undefined ? undefined : byCrmId.get(reviewedId);
    if (approved) {
      if (row.hp_id && approved.hp_id && approved.hp_id !== row.hp_id)
        return { row, existing: undefined, reason: "Reviewed target now has a different HP ID; identity review required" };
      return { row, existing: approved, reason: null as string | null };
    }
    const names = new Set([row.name, ...row.aliases].map(norm));
    if (!row.hp_id && [...names].some(n => (sourceNames.get(n)?.size ?? 0) > 1))
      return { row, existing: undefined, reason: "Missing HP ID overlaps another source identity; review before creating a duplicate" };
    const candidates = new Set([...names].flatMap(n => [...(byName.get(n) ?? [])]));
    if (candidates.size > 1 || candidates.size && [...names].some(n => (sourceNames.get(n)?.size ?? 0) > 1))
      return { row, existing: undefined, reason: "Ambiguous legal-account name; review the HP identity before importing" };
    const found = [...candidates][0];
    if (row.hp_id && found?.hp_id && found.hp_id !== row.hp_id)
      return { row, existing: undefined, reason: "Existing account has a different HP ID; identity review required" };
    return { row, existing: found, reason: null as string | null };
  });
  const claims = new Map<number, typeof decisions>();
  for (const d of decisions) if (d.existing) {
    const bucket = claims.get(d.existing.crmId) ?? []; bucket.push(d); claims.set(d.existing.crmId, bucket);
  }
  for (const bucket of claims.values()) if (bucket.length > 1) for (const d of bucket) {
    if (d.existing?.hp_id === d.row.hp_id) continue;
    d.reason = "Multiple HP IDs claim the same CRM account; identity review required"; d.existing = undefined;
  }
  return decisions;
}
