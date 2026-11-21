import { loadHpBiFacts, type BusinessRecord, type HpFilters } from "./hpBiMetrics";
import { hpLeadStatus, normalizeRad, text } from "./hpBiImport";

export type Portfolio = "PS" | "Print" | "Unassigned";
export type Breakdown = "total" | "segment" | "portfolio" | "segment_portfolio" | "rad";
export type Metric = "touchpoints" | "engagedContacts" | "leads" | "hot" | "warm" | "opportunities" | "closedWon" | "closedLost" | "opportunityValue" | "prospectiveValue" | "bookedValue";
export interface PivotInput {
  salesPerson?: string; opportunity?: string;
  clientId: number; currentStart: string; currentEnd: string; previousStart: string; previousEnd: string;
  parents?: string[]; segments?: string[]; portfolios?: Portfolio[]; rads?: string[];
  breakdown: Breakdown; basis: "PS" | "Print"; page: number; pageSize: number;
  sortBy: "touchpoints" | "leads" | "hot" | "opportunities"; sortOrder: "asc" | "desc";
  search?: string; newOnly?: boolean; abmOnly?: boolean; incompleteOnly?: boolean; dimension?: string; dimensionValue?: string;
  focusParent?: string; focusColumn?: string; focusPeriod?: "current" | "previous"; focusMetric?: Metric; evidencePage: number;
}
export interface Metrics {
  touchpoints: number; engagedContacts: number; leads: number; hot: number; warm: number;
  opportunities: number; closedWon: number; closedLost: number;
  opportunityValue: Record<string, number>; prospectiveValue: Record<string, number>; bookedValue: Record<string, number>;
}
type Facts = Awaited<ReturnType<typeof loadHpBiFacts>>;
const touchKinds = new Set(["attendance", "invitation", "digital", "content", "other", "interest"]);
const empty = (): Metrics => ({ touchpoints: 0, engagedContacts: 0, leads: 0, hot: 0, warm: 0,
  opportunities: 0, closedWon: 0, closedLost: 0, opportunityValue: {}, prospectiveValue: {}, bookedValue: {} });

/** Only explicit product/category terms classify activity. Conflicting signals remain unassigned. */
export function portfolioFor(record: Pick<BusinessRecord, "product" | "category">): Portfolio {
  const value = `${record.product ?? ""} ${record.category ?? ""}`.toLowerCase();
  const print = /\b(print|printing|printer|printers|laserjet|officejet|pagewide|designjet|mfp|photocopier)\b/.test(value);
  const ps = /\b(ps|personal systems|personal computing|pc|pcs|laptop|laptops|notebook|notebooks|desktop|desktops|workstation|workstations|elitebook|probook|zbook|thin client)\b/.test(value);
  return print === ps ? "Unassigned" : print ? "Print" : "PS";
}
export function businessRange(start: string, end: string) {
  return { start: `${start}T00:00:00+05:30`, end: new Date(Date.parse(`${end}T00:00:00+05:30`) + 86_400_000).toISOString() };
}
function segment(p: any): string { return text(p.gtm) || "Unclassified"; }
function rad(p: any, input: PivotInput): string { return normalizeRad(input.basis === "Print" ? p.prt_rad : p.ps_rad); }
function tam(v: unknown): number | null {
  const value = text(v).replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function summarize(records: BusinessRecord[]): Metrics {
  const result = empty(), people = new Set<number>();
  for (const r of records) {
    if (touchKinds.has(r.kind)) {
      result.touchpoints++;
      if (r.contactId !== null) people.add(r.contactId);
    }
    if (r.kind === "lead") {
      result.leads++;
      const status = hpLeadStatus(r.product, r.horizonMonths);
      if (status !== "cold") result[status]++;
    }
    if (r.kind === "opportunity") result.opportunities++;
    if (r.kind === "closed_won") result.closedWon++;
    if (r.kind === "closed_lost") result.closedLost++;
    const money = r.kind === "opportunity" ? result.opportunityValue : r.kind === "closed_won" ? result.bookedValue
      : ["lead", "prospective"].includes(r.kind) ? result.prospectiveValue : null;
    if (money && r.currency && r.orderValue !== null && Number.isFinite(r.orderValue))
      money[r.currency] = (money[r.currency] ?? 0) + r.orderValue;
  }
  result.engagedContacts = people.size;
  return result;
}
function sourceForMetric(record: BusinessRecord, metric: Metric): boolean {
  if (metric === "touchpoints") return touchKinds.has(record.kind);
  if (metric === "engagedContacts") return touchKinds.has(record.kind) && record.contactId !== null;
  if (metric === "hot" || metric === "warm") return record.kind === "lead" && hpLeadStatus(record.product, record.horizonMonths) === metric;
  const kinds: Record<string, string[]> = { leads: ["lead"], opportunities: ["opportunity"], closedWon: ["closed_won"],
    closedLost: ["closed_lost"], opportunityValue: ["opportunity"], prospectiveValue: ["lead", "prospective"], bookedValue: ["closed_won"] };
  return kinds[metric].includes(record.kind) && (!metric.endsWith("Value") || record.orderValue !== null && !!record.currency);
}
function columnKey(input: PivotInput, profile: any, record: BusinessRecord) {
  const portfolio = portfolioFor(record);
  if (input.breakdown === "segment") return segment(profile);
  if (input.breakdown === "portfolio") return portfolio;
  if (input.breakdown === "segment_portfolio") return JSON.stringify([segment(profile), portfolio]);
  if (input.breakdown === "rad") return rad(profile, input);
  return "total";
}
function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const items = map.get(key);
  if (items) items.push(value); else map.set(key, [value]);
}

/** Pure aggregation: all filters intersect, source facts already obey the canonical reporting pipeline. */
export function aggregateParentPivot(input: PivotInput, current: Facts, previous: Facts) {
  const optionsMap = new Map<string, { key: string; name: string; accounts: number }>();
  current.selected.forEach(p => {
    const key = text(p.parent_key), option = optionsMap.get(key);
    if (option) option.accounts++; else optionsMap.set(key, { key, name: text(p.parent_name) || p.name, accounts: 1 });
  });
  const options = { parents: [...optionsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    segments: [...new Set(current.selected.map(segment))].sort() };
  const profiles = current.selected.filter(p => (!input.parents?.length || input.parents.includes(p.parent_key))
    && (!input.segments?.length || input.segments.includes(segment(p)))
    && (!input.rads?.length || input.rads.includes(rad(p, input))));
  const byAccount = new Map(profiles.map(p => [Number(p.company_id), p]));
  const ids = new Set(byAccount.keys()), grouped = new Map<string, any[]>();
  profiles.forEach(p => append(grouped, p.parent_key, p));
  const raw = { current: current.records.filter(r => ids.has(r.accountId)), previous: previous.records.filter(r => ids.has(r.accountId)) };
  const selectedRecords = {
    current: raw.current.filter(r => !input.portfolios?.length || input.portfolios.includes(portfolioFor(r))),
    previous: raw.previous.filter(r => !input.portfolios?.length || input.portfolios.includes(portfolioFor(r))),
  };
  const segments = input.segments?.length ? input.segments : [...new Set(profiles.map(segment))].sort();
  const portfolios = input.portfolios?.length ? input.portfolios : ["PS", "Print", "Unassigned"] as Portfolio[];
  const names = input.breakdown === "segment" ? segments : input.breakdown === "portfolio" ? portfolios
    : input.breakdown === "segment_portfolio" ? segments.flatMap(s => portfolios.map(p => JSON.stringify([s, p])))
    : input.breakdown === "rad" ? input.rads?.length ? input.rads : ["Retention", "Acquisition", "Development", "Unknown"] : ["total"];
  const columns = names.map(key => ({ key, label: input.breakdown === "segment_portfolio" ? JSON.parse(key).join(" · ") : key === "total" ? "All selected activity" : key }));
  const buckets = { current: new Map<string, BusinessRecord[]>(), previous: new Map<string, BusinessRecord[]>() };
  for (const period of ["current", "previous"] as const) for (const r of selectedRecords[period]) {
    const p = byAccount.get(r.accountId)!;
    append(buckets[period], JSON.stringify([p.parent_key, columnKey(input, p, r)]), r);
  }
  const rows = [...grouped].map(([parentKey, members]) => {
    const cells = Object.fromEntries(columns.map(c => [c.key, {
      current: summarize(buckets.current.get(JSON.stringify([parentKey, c.key])) ?? []),
      previous: summarize(buckets.previous.get(JSON.stringify([parentKey, c.key])) ?? []),
    }]));
    const psValues = members.map(p => tam(p.ps_tam_k)), printValues = members.map(p => tam(p.prt_tam_k));
    const radCounts = (field: string) => members.reduce((acc, p) => { const key = normalizeRad(p[field]); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    return { parentKey, parentName: text(members[0].parent_name) || members[0].name, accounts: members.length,
      segments: [...new Set(members.map(segment))],
      planning: { psTamK: psValues.some(v => v !== null) ? psValues.reduce<number>((n, v) => n + (v ?? 0), 0) : null,
        printTamK: printValues.some(v => v !== null) ? printValues.reduce<number>((n, v) => n + (v ?? 0), 0) : null,
        missingPsTam: psValues.filter(v => v === null).length, missingPrintTam: printValues.filter(v => v === null).length,
        psRad: radCounts("ps_rad"), printRad: radCounts("prt_rad") }, cells };
  });
  rows.sort((a, b) => {
    const value = (row: typeof a) => Object.values(row.cells).reduce((n, cell) => n + cell.current[input.sortBy], 0);
    return (value(a) - value(b)) * (input.sortOrder === "asc" ? 1 : -1) || a.parentName.localeCompare(b.parentName);
  });
  const totals = { current: summarize(selectedRecords.current), previous: summarize(selectedRecords.previous) };
  const result = { periods: { current: { start: input.currentStart, end: input.currentEnd }, previous: { start: input.previousStart, end: input.previousEnd } },
    options, columns, rows: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
    totals, population: { parents: grouped.size, accounts: profiles.length, contacts: current.contacts.filter(c => ids.has(Number(c.company_id))).length },
    total: rows.length, page: input.page, pageSize: input.pageSize,
    unassigned: { currentRecords: raw.current.filter(r => portfolioFor(r) === "Unassigned").length, previousRecords: raw.previous.filter(r => portfolioFor(r) === "Unassigned").length },
    notes: ["Dates are inclusive India business days. Filters intersect; choices within a dimension are combined.",
      "Planning is the current supplied roster snapshot, not historical TAM or pipeline. PS/Print TAM is USD thousands ($K); missing values are not zero.",
      "Activity is attributed only by explicit PS/Print product or category terms. Missing and conflicting terms remain Unassigned; account RAD does not assign activity.",
      "Distinct engaged contacts and roster counts are not additive across columns. Overall totals deduplicate people.",
      "Opportunity, prospective and booked values stay separate, per currency. No currency conversion is applied."],
    evidence: undefined as { parentKey: string; columnKey: string; period: string; total: number; page: number; pageSize: number; records: (BusinessRecord & { accountName: string })[] } | undefined };
  if (input.focusParent) {
    const period = input.focusPeriod ?? "current", key = input.focusColumn ?? "total";
    const rr = (buckets[period].get(JSON.stringify([input.focusParent, key])) ?? [])
      .filter(r => sourceForMetric(r, input.focusMetric ?? "touchpoints"))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    result.evidence = { parentKey: input.focusParent, columnKey: key, period, total: rr.length,
      page: input.evidencePage, pageSize: 50, records: rr.slice((input.evidencePage - 1) * 50, input.evidencePage * 50)
        .map(r => ({ ...r, accountName: byAccount.get(r.accountId)?.name ?? "Unknown" })) };
  }
  return { result, allRows: rows };
}
export async function loadParentPivot(tenantId: number, input: PivotInput) {
  const base: HpFilters = { clientId: input.clientId, year: Number(input.currentStart.slice(0, 4)), page: 1, pageSize: 50,
    search: input.search, newOnly: input.newOnly, abmOnly: input.abmOnly, incompleteOnly: input.incompleteOnly,
    dimension: input.dimension, dimensionValue: input.dimensionValue, salesPerson: input.salesPerson, opportunity: input.opportunity };
  const [current, previous] = await Promise.all([
    loadHpBiFacts(tenantId, { ...base, ...businessRange(input.currentStart, input.currentEnd) }),
    loadHpBiFacts(tenantId, { ...base, ...businessRange(input.previousStart, input.previousEnd) }),
  ]);
  return aggregateParentPivot(input, current, previous);
}

export function pivotCsv(data: ReturnType<typeof aggregateParentPivot>) {
  const fields = ["Parent", "Parent key", "Segments", "Current legal accounts", "PS TAM ($K)", "Print TAM ($K)", "Missing PS TAM", "Missing Print TAM", "PS RAD", "Print RAD",
    "Bucket", "Period", "From", "Through", "Touchpoints", "Engaged contacts", "Leads", "Hot", "Warm", "Opportunities", "Closed won", "Closed lost", "Opportunity value by currency", "Prospective value by currency", "Booked value by currency"];
  const cell = (v: unknown) => {
    let s = typeof v === "object" && v !== null ? JSON.stringify(v) : v == null ? "" : String(v);
    if (/^\s*[=+@-]|^[\t\r\n]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [fields.map(cell).join(",")];
  for (const row of data.allRows) for (const column of data.result.columns) for (const period of ["current", "previous"] as const) {
    const m = row.cells[column.key][period], range = data.result.periods[period], p = row.planning;
    lines.push([row.parentName, row.parentKey, row.segments.join(" / "), row.accounts, p.psTamK, p.printTamK, p.missingPsTam, p.missingPrintTam, p.psRad, p.printRad,
      column.label, period, range.start, range.end, m.touchpoints, m.engagedContacts, m.leads, m.hot, m.warm, m.opportunities, m.closedWon, m.closedLost, m.opportunityValue, m.prospectiveValue, m.bookedValue].map(cell).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}
