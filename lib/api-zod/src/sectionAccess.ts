// Shared by the API policy and navigation. A role is not a client-side security boundary.
export const SECTIONS = [
  ["dashboard", "Dashboard"], ["intent", "Intent Engine"],
  ["analytics", "Analytics"], ["monitoring", "Continuous Monitoring"],
  ["sales", "Sales Dashboard"],
  ["gtm", "Autonomous GTM OS"], ["committee", "Buying Committee"],
  ["ai", "AI Answer"], ["clients", "Clients"], ["plays", "Plays"],
  ["journeys", "Journeys"], ["templates", "Templates"], ["sequences", "Sequences"],
  ["database", "Database and segments"], ["contacts", "Contacts"],
  ["companies", "Companies"], ["deals", "Deals"], ["library", "Library"],
  ["calls", "Call Campaigns"], ["dnc", "DNC / Negative List"],
  ["contest", "Contests"], ["settings", "Settings and integrations"],
] as const;
export type SectionKey = typeof SECTIONS[number][0];
export type AccessLevel = "none" | "view" | "manage";
export type SectionPermissions = Partial<Record<SectionKey, AccessLevel>>;
export interface AccessUser { role: string; sectionPermissions?: SectionPermissions | null }

export function sectionLevel(user: AccessUser, section: SectionKey): AccessLevel {
  if (user.role === "admin") return "manage";
  if (user.sectionPermissions != null) return user.sectionPermissions[section] ?? "none";
  // Existing users retain role-based access until an administrator customizes it.
  return user.role === "viewer" ? "view" : "manage";
}
export function canAccess(user: AccessUser, section: SectionKey, write = false): boolean {
  const level = sectionLevel(user, section);
  return level === "manage" || (!write && level === "view");
}
export function hasManageGrant(user: AccessUser, section: SectionKey): boolean {
  return user.role === "admin" || (user.sectionPermissions != null && sectionLevel(user, section) === "manage");
}
export function hasSectionGrant(user: AccessUser, section: SectionKey, write = false): boolean {
  return user.role === "admin" || (user.sectionPermissions != null && canAccess(user, section, write));
}
export function pageSection(path: string): SectionKey | null {
  if (path === "/sales-dashboard" || path.startsWith("/sales-dashboard/")) return "sales";
  if (path === "/") return "dashboard";
  if (/^\/intent\/monitoring/.test(path)) return "monitoring";
  if (/^\/intent\/buying-committee/.test(path)) return "committee";
  if (/^\/intent\/inbound/.test(path)) return "gtm";
  if (/^\/intent\/sales-feedback/.test(path)) return "sales";
  if (path.startsWith("/intent")) return "intent";
  if (path.startsWith("/crm/contacts")) return "contacts";
  if (path.startsWith("/crm/companies")) return "companies";
  if (path.startsWith("/crm/deals")) return "deals";
  if (path.startsWith("/calls/dnc")) return "dnc";
  if (path.startsWith("/calls")) return "calls";
  if (/contest/.test(path)) return "contest";
  const prefix = path.split("/")[1];
  if (prefix === "ai-answer") return "ai";
  return SECTIONS.some(([key]) => key === prefix) ? prefix as SectionKey : null;
}
