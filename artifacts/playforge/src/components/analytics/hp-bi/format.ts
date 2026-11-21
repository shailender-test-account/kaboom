export const HP_BLUE = "#0096D6", HP_NAVY = "#0B2A4A", HP_INK = "#10243B", HP_AMBER = "#E8892B", HP_TEAL = "#1B9C85", HP_PLUM = "#8A4F9E", HP_MUTE = "#8CA0B3";
export const SEGMENT_VIEWS = ["Overall", "GCC", "MNC", "India Inc/PSU"] as const;
export const GOV_EDU = "Gov/Edu";
export const hasPeriodRecords = (p: { touchpoints: number; leads: number; opportunities: number; closedWon?: number; closedLost?: number; prospectiveValues?: Record<string, number>; bookedValues?: Record<string, number> }) =>
  Boolean(p.touchpoints || p.leads || p.opportunities || p.closedWon || p.closedLost
    || Object.keys(p.prospectiveValues ?? {}).length || Object.keys(p.bookedValues ?? {}).length);
export const HP_DIMENSIONS: Record<string, string> = {
  hp_id: "UNIQUE ID", deployment: "Deployment", gtm: "FY25 GTM", account_group: "GROUP",
  state_ut: "STATE/UT", zone: "ZONE", parent_sub: "PARENT/ SUB", top_id: "TOP_ID", top_name: "TOP_NAME",
  mid_id: "MID ID", mid_name: "MID_NAME", act_st: "ACT ST", st_name: "ST NAME",
  partial_st: "PARTIAL ST", partial_name: "PARTIAL_NAME", org_id: "ORG ID", opsi: "OPSI",
  legal_name: "SUBSIDIARY_LEGAL_NAME", city: "CITY", state: "STATE",
  relationship_link: "PARENT SUBSIDIARY RELATIONSHIP LINK", industry_vertical: "INDUSTRY VERTICAL",
  industry_segment: "INDUSTRY SEGMENT", hpi_segment: "HPI ACCT SEGMENT", e_cat: "E CAT",
  emp_size: "EMP SIZE", ps_tam_k: "PS TAM ($K)", prt_tam_k: "PRT TAM ($K)",
  ps_rad: "PS RAD", prt_rad: "PRT RAD", rtm_ps: "RTM - PS", ps_partners: 'PS PARTNERS (SEPRATED BY "/")',
  rtm_print: "RTM - PRINT", print_partners: 'PRINT PARTNERS (SEPRATED BY "/")',
  eam_email: "EAM email-ID", pam_email: "PAM email-ID", rm_email: "RM email-ID", isr_email: "ISR email-ID",
  zm_email: "ZM email-ID", poly_am_email: "Poly AM EMAIL-id", poly_mgr_email: "PolyMgr Email_ID",
};
export const RADS = ["Retention", "Acquisition", "Development"] as const;
export const nf = new Intl.NumberFormat("en-IN");
export const num = (n: number | null | undefined) => (n == null ? "Unavailable" : nf.format(n));
export function money(cur: string, v: number) {
  if (!/^[A-Z]{3}$/.test(cur)) return `${cur} ${new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }).format(v); } catch { return `${cur} ${nf.format(v)}`; }
}
export function moneyLines(values: Record<string, number> | undefined): string[] {
  const e = Object.entries(values ?? {});
  return e.map(([c, v]) => (/^[A-Z]{3}$/.test(c) ? money(c, v) : `${c} ${nf.format(v)}`));
}
export const moneyText = (v?: Record<string, number>) => { const l = moneyLines(v); return l.length ? l.join(" / ") : "None recorded"; };
export const dateText = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "None";
export function dateTimeText(s: string | null | undefined) {
  if (!s || !Number.isFinite(Date.parse(s))) return "Date unavailable";
  return `${new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" })} IST`;
}
export function fyLabel(y: number) { return `FY${y} (Nov ${y - 1} - Oct ${y})`; }
export function currentFiscalYear(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(p => p.type === "year")!.value);
  const month = Number(parts.find(p => p.type === "month")!.value);
  return month >= 11 ? year + 1 : year;
}
export function download(url: string) { const a = document.createElement("a"); a.href = url; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
export const READONLY_DIMENSIONS = ["hp_id", "top_id", "top_name", "mid_id", "mid_name", "act_st", "st_name", "partial_st", "partial_name", "legal_name"];
