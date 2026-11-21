export const ownershipFields = [
  ["eam_email", "EAM"], ["pam_email", "PAM"], ["rm_email", "RM"],
  ["isr_email", "ISR"], ["zm_email", "ZM"], ["poly_am_email", "Poly AM"],
  ["poly_mgr_email", "Poly manager"],
] as const;

type Account = { company_id: number; name: string; hp_id?: string | null } & Record<string, unknown>;
export function hpSalesAssignments(members: Account[]) {
  const people = new Map<string, { role: string; email: string; accounts: { id: number; name: string; hpId: string | null }[] }>();
  for (const member of members) for (const [field, role] of ownershipFields) {
    const value = member[field];
    if (typeof value !== "string") continue;
    const email = value.trim();
    if (!email || /^(?:-|n\/?a|none|null|unassigned|not assigned)$/i.test(email)) continue;
    const key = `${role}:${email.toLowerCase()}`;
    if (!people.has(key)) people.set(key, { role, email, accounts: [] });
    const person = people.get(key)!;
    const id = Number(member.company_id);
    if (!person.accounts.some(a => a.id === id))
      person.accounts.push({ id, name: member.name, hpId: member.hp_id ?? null });
  }
  return [...people.values()];
}
