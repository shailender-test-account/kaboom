import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatReportDate, formatReportTime, REPORT_TIME_ZONE_LABEL } from "./reportTime";

// ── Brand tokens ──────────────────────────────────────────────────────────────
const INDIGO    = [99,  102, 241] as [number,number,number];
const CYAN      = [8,   145, 178] as [number,number,number];
const ZINC      = [24,  24,  27]  as [number,number,number];
const WHITE     = [255, 255, 255] as [number,number,number];
const GRAY_50   = [248, 250, 252] as [number,number,number];
const GRAY_100  = [241, 245, 249] as [number,number,number];
const GRAY_600  = [71,  85,  105] as [number,number,number];
const EMERALD   = [16,  185, 129] as [number,number,number];
const AMBER     = [245, 158, 11]  as [number,number,number];
const ROSE      = [244, 63,  94]  as [number,number,number];

const STAGE_LABELS: Record<string,string> = {
  "pre-aware":"Pre-Aware","aware":"Aware","pre-engage":"Pre-Engage",
  "engage":"Engage","advance-engage":"Adv. Engage","action":"Action",
};
const stageFmt = (s: string) => STAGE_LABELS[s] ?? (s ? s.replace(/-/g," ").replace(/\b\w/g, c=>c.toUpperCase()) : "—");

const today = () => formatReportDate(new Date());
const fmtDate = formatReportDate;
const fmtDuration = (secs: number|null|undefined) => {
  if (!secs) return "0:00";
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2,"0")}`;
};
const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

// ── PDF helpers ───────────────────────────────────────────────────────────────
function makePdf(title: string, subtitle = "") {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  // Header bar
  doc.setFillColor(...INDIGO);
  doc.rect(0, 0, 297, 18, "F");

  // KABOOM wordmark
  doc.setTextColor(...WHITE);
  doc.setFontSize(11);
  doc.setFont("helvetica","bold");
  doc.text("KABOOM", 10, 12);

  // Title
  doc.setFontSize(13);
  doc.text(title, 148, 12, { align: "center" });

  // Date right
  doc.setFontSize(8);
  doc.setFont("helvetica","normal");
  doc.text(`Generated: ${today()} ${REPORT_TIME_ZONE_LABEL}`, 287, 12, { align: "right" });

  // Subtitle
  if (subtitle) {
    doc.setTextColor(...GRAY_600);
    doc.setFontSize(8);
    doc.text(subtitle, 148, 22, { align: "center" });
  }

  return doc;
}

function addKpiRow(doc: jsPDF, y: number, kpis: { label: string; value: string; color?: [number,number,number] }[]) {
  const startX = 10;
  const boxW = (277 - (kpis.length - 1) * 3) / kpis.length;
  kpis.forEach((kpi, i) => {
    const x = startX + i * (boxW + 3);
    doc.setFillColor(...GRAY_100);
    doc.roundedRect(x, y, boxW, 16, 2, 2, "F");
    doc.setTextColor(...GRAY_600);
    doc.setFontSize(7);
    doc.setFont("helvetica","normal");
    doc.text(kpi.label, x + boxW / 2, y + 5.5, { align: "center" });
    doc.setTextColor(...(kpi.color ?? ZINC));
    doc.setFontSize(12);
    doc.setFont("helvetica","bold");
    doc.text(kpi.value, x + boxW / 2, y + 13, { align: "center" });
  });
}

function sectionHeading(doc: jsPDF, y: number, text: string, color: [number,number,number] = CYAN) {
  doc.setFillColor(...color);
  doc.rect(10, y, 277, 7, "F");
  doc.setTextColor(...WHITE);
  doc.setFontSize(8);
  doc.setFont("helvetica","bold");
  doc.text(text, 13, y + 5);
}

function pdfTable(
  doc: jsPDF,
  startY: number,
  head: string[],
  body: (string|number)[][],
  opts: { headColor?: [number,number,number]; fontSize?: number } = {}
) {
  autoTable(doc, {
    startY,
    head: [head],
    body: body as string[][],
    styles: { fontSize: opts.fontSize ?? 7.5, cellPadding: 2.5, lineColor: [226,232,240], lineWidth: 0.2 },
    headStyles: { fillColor: opts.headColor ?? INDIGO, textColor: WHITE, fontStyle: "bold", fontSize: 7.5 },
    alternateRowStyles: { fillColor: GRAY_50 },
    margin: { left: 10, right: 10 },
    tableWidth: 277,
    theme: "grid",
  });
}

function addPageNumbers(doc: jsPDF) {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setTextColor(...GRAY_600);
    doc.setFontSize(7);
    doc.setFont("helvetica","normal");
    doc.text(`Page ${i} of ${total}`, 148, 205, { align: "center" });
    doc.setFillColor(...INDIGO);
    doc.rect(0, 207, 297, 3, "F");
  }
}

// ── Excel helpers ─────────────────────────────────────────────────────────────
type XlRow = (string|number|null)[];

function xlSheet(headers: string[], rows: XlRow[], colWidths?: number[]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Style header row (xlsx community edition doesn't support full cell styles,
  // but we set column widths and freeze the first row)
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  if (colWidths) ws["!cols"] = colWidths.map(w => ({ wch: w }));
  else ws["!cols"] = headers.map(h => ({ wch: Math.max(h.length + 4, 12) }));

  return ws;
}

function xlWorkbook(sheets: { name: string; ws: XLSX.WorkSheet }[], filename: string) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, ws }) => XLSX.utils.book_append_sheet(wb, ws, name));
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  triggerDownload(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

function xlMeta(filters: Record<string,string> = {}) {
  const applied = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(", ");
  const rows: XlRow[] = [
    ["Report Generated", today()],
    ["Report Time Zone", REPORT_TIME_ZONE_LABEL],
    ["Filters Applied",  applied || "None"],
    ["Platform",         "KABOOM ABM Analytics"],
  ];
  return xlSheet(["Key","Value"], rows, [20, 60]);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAFFIC
// ─────────────────────────────────────────────────────────────────────────────
export function exportTrafficExcel(traffic: any) {
  const kpiWs = xlSheet(
    ["Metric","Value"],
    [
      ["Total Visits",    traffic?.kpi?.visits        ?? 0],
      ["Unique Visitors", traffic?.kpi?.uniqueVisits  ?? 0],
      ["Form Fills",      traffic?.kpi?.formFills      ?? 0],
      ["Downloads",       traffic?.kpi?.downloads      ?? 0],
    ],
    [30, 20],
  );

  const trendWs = xlSheet(
    ["Date","Visits","Unique Visits"],
    (traffic?.trend ?? []).map((r: any) => [r.date, r.visits ?? 0, r.unique_visits ?? 0]),
    [16, 12, 14],
  );

  const tableWs = xlSheet(
    ["#","First Name","Last Name","Email","Company","Source","IP Address","Visit Date","Duration (sec)"],
    (traffic?.table ?? []).map((r: any, i: number) => [
      i+1, r.first_name ?? "", r.last_name ?? "", r.email ?? "",
      r.company_name ?? "", r.source ?? "Direct", r.ip_address ?? "",
      fmtDate(r.created_at), r.duration_seconds ?? "",
    ]),
    [5, 18, 18, 32, 26, 12, 18, 24, 14],
  );

  xlWorkbook([
    { name: "Summary",      ws: kpiWs },
    { name: "Daily Trend",  ws: trendWs },
    { name: "Visitor Log",  ws: tableWs },
    { name: "Meta",         ws: xlMeta() },
  ], `KABOOM — Traffic Report — ${today()}.xlsx`);
}

export function exportTrafficPdf(traffic: any) {
  const doc = makePdf("Traffic Analytics Report", "Visits, unique visitors, form fills & downloads");
  let y = 26;

  addKpiRow(doc, y, [
    { label: "Total Visits",    value: String(traffic?.kpi?.visits       ?? 0), color: INDIGO },
    { label: "Unique Visitors", value: String(traffic?.kpi?.uniqueVisits ?? 0), color: CYAN },
    { label: "Form Fills",      value: String(traffic?.kpi?.formFills    ?? 0), color: EMERALD },
    { label: "Downloads",       value: String(traffic?.kpi?.downloads    ?? 0), color: AMBER },
  ]);
  y += 22;

  sectionHeading(doc, y, "Daily Visits (Last 30 Days)");
  y += 10;
  pdfTable(doc, y, ["Date","Visits","Unique Visits"],
    (traffic?.trend ?? []).map((r: any) => [r.date, r.visits ?? 0, r.unique_visits ?? 0]),
  );

  doc.addPage();
  sectionHeading(doc, 10, "Visitor Activity Log");
  pdfTable(doc, 20,
    ["#","First Name","Last Name","Email","Company","Source","Visit Date","Duration"],
    (traffic?.table ?? []).map((r: any, i: number) => [
      i+1, r.first_name ?? "—", r.last_name ?? "—", r.email ?? "—",
      r.company_name ?? "—", r.source ?? "Direct",
      fmtDate(r.created_at), r.duration_seconds ? `${r.duration_seconds}s` : "—",
    ]),
    { fontSize: 7 },
  );

  addPageNumbers(doc);
  doc.save(`KABOOM — Traffic Report — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE AFFINITY
// ─────────────────────────────────────────────────────────────────────────────
export function exportStageExcel(stageDist: any, content: any) {
  const distWs = xlSheet(
    ["Stage","Contact Count","% Share"],
    (stageDist?.data ?? []).map((d: any) => [stageFmt(d.stage), d.count, `${d.pct}%`]),
    [22, 16, 12],
  );

  const affinityRows: XlRow[] = [];
  (content?.byStage ?? []).forEach((b: any) => {
    affinityRows.push([stageFmt(b.stage), b.page_name, b.views]);
  });
  const affinityWs = xlSheet(["Stage","Page Name","Views"], affinityRows, [22, 50, 12]);

  xlWorkbook([
    { name: "Stage Distribution", ws: distWs },
    { name: "Content Affinity",   ws: affinityWs },
    { name: "Meta",               ws: xlMeta() },
  ], `KABOOM — Stage Affinity Report — ${today()}.xlsx`);
}

export function exportStagePdf(stageDist: any, content: any) {
  const doc = makePdf("Content Affinity by Stage", "Contact distribution and page engagement per stage");
  const total = stageDist?.total ?? 0;
  let y = 26;

  addKpiRow(doc, y, [
    { label: "Total Contacts", value: String(total), color: INDIGO },
    ...(stageDist?.data ?? []).slice(0,5).map((d: any) => ({
      label: stageFmt(d.stage), value: `${d.count} (${d.pct}%)`,
    })),
  ]);
  y += 22;

  sectionHeading(doc, y, "Stage Distribution");
  y += 10;
  pdfTable(doc, y, ["Stage","Contact Count","% Share"],
    (stageDist?.data ?? []).map((d: any) => [stageFmt(d.stage), d.count, `${d.pct}%`]),
  );

  const curY = (doc as any).lastAutoTable?.finalY ?? y + 40;
  sectionHeading(doc, curY + 8, "Content Affinity by Stage");
  pdfTable(doc, curY + 18, ["Stage","Page Name","Views"],
    (content?.byStage ?? []).map((b: any) => [stageFmt(b.stage), b.page_name, b.views]),
  );

  addPageNumbers(doc);
  doc.save(`KABOOM — Stage Affinity — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT POPULARITY
// ─────────────────────────────────────────────────────────────────────────────
export function exportContentExcel(content: any) {
  const ws = xlSheet(
    ["Rank","Page Name","Total Views","Unique Visitors"],
    (content?.byPage ?? []).map((p: any, i: number) => [i+1, p.page_name, p.views, p.unique_visitors]),
    [8, 55, 14, 16],
  );
  xlWorkbook([{ name: "Content Popularity", ws }, { name: "Meta", ws: xlMeta() }],
    `KABOOM — Content Popularity — ${today()}.xlsx`);
}

export function exportContentPdf(content: any) {
  const doc = makePdf("Content Popularity Report", "Page views and unique visitors ranked by engagement");
  sectionHeading(doc, 26, "Page Engagement Ranking");
  pdfTable(doc, 36, ["Rank","Page Name","Total Views","Unique Visitors"],
    (content?.byPage ?? []).map((p: any, i: number) => [i+1, p.page_name, p.views, p.unique_visitors]),
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — Content Popularity — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE OF TRAFFIC
// ─────────────────────────────────────────────────────────────────────────────
export function exportSourceExcel(trafficSrc: any) {
  const ws = xlSheet(
    ["Source","Visit Count","% Share"],
    (trafficSrc?.data ?? []).map((d: any) => [d.source, d.count, `${d.pct}%`]),
    [22, 14, 12],
  );
  xlWorkbook([{ name: "Traffic Sources", ws }, { name: "Meta", ws: xlMeta() }],
    `KABOOM — Traffic Sources — ${today()}.xlsx`);
}

export function exportSourcePdf(trafficSrc: any) {
  const doc = makePdf("Source of Traffic Report", "Where your journey visitors are coming from");
  addKpiRow(doc, 26, [
    { label: "Total Page Views", value: String(trafficSrc?.total ?? 0), color: INDIGO },
    ...(trafficSrc?.data ?? []).map((d: any) => ({ label: d.source, value: `${d.count} (${d.pct}%)` })),
  ]);
  sectionHeading(doc, 48, "Traffic Source Breakdown");
  pdfTable(doc, 58, ["Source","Visits","% Share"],
    (trafficSrc?.data ?? []).map((d: any) => [d.source, d.count, `${d.pct}%`]),
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — Traffic Sources — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// USERS BY STAGE
// ─────────────────────────────────────────────────────────────────────────────
export function exportUsersExcel(usersByStage: any[]) {
  const ws = xlSheet(
    ["Stage","Contact Count"],
    usersByStage.map((r: any) => [stageFmt(r.stage), r.count]),
    [25, 16],
  );
  xlWorkbook([{ name: "Users by Stage", ws }, { name: "Meta", ws: xlMeta() }],
    `KABOOM — Users & Journeys — ${today()}.xlsx`);
}

export function exportUsersPdf(usersByStage: any[]) {
  const doc = makePdf("Users & Journeys Report", "Contact distribution across buyer journey stages");
  const total = usersByStage.reduce((s: number, r: any) => s + (r.count ?? 0), 0);
  addKpiRow(doc, 26, [{ label: "Total Contacts", value: String(total), color: INDIGO }]);
  sectionHeading(doc, 48, "Contacts by Stage");
  pdfTable(doc, 58, ["Stage","Contact Count"],
    usersByStage.map((r: any) => [stageFmt(r.stage), r.count]),
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — Users & Journeys — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL DEPTH
// ─────────────────────────────────────────────────────────────────────────────
export function exportScrollDepthExcel(scrollDepth: any) {
  const totals = scrollDepth?.totals ?? {};
  const summaryWs = xlSheet(
    ["Depth Milestone","Unique Visitors Reached"],
    [
      ["25% scroll",  totals.d25  ?? 0],
      ["50% scroll",  totals.d50  ?? 0],
      ["75% scroll",  totals.d75  ?? 0],
      ["100% scroll", totals.d100 ?? 0],
    ],
    [22, 24],
  );

  const byJourneyWs = xlSheet(
    ["Journey","25%","50%","75%","100%","Total Visitors"],
    (scrollDepth?.byJourney ?? []).map((r: any) => [r.name, r.d25, r.d50, r.d75, r.d100, r.total]),
    [45, 10, 10, 10, 10, 16],
  );

  xlWorkbook([
    { name: "Overall Totals", ws: summaryWs },
    { name: "By Journey",     ws: byJourneyWs },
    { name: "Meta",           ws: xlMeta() },
  ], `KABOOM — Scroll Depth — ${today()}.xlsx`);
}

export function exportScrollDepthPdf(scrollDepth: any) {
  const doc = makePdf("Scroll Depth Report", "How deep visitors scroll in your journeys");
  const totals = scrollDepth?.totals ?? {};
  addKpiRow(doc, 26, [
    { label: "Reached 25%",  value: String(totals.d25  ?? 0), color: INDIGO  },
    { label: "Reached 50%",  value: String(totals.d50  ?? 0), color: CYAN    },
    { label: "Reached 75%",  value: String(totals.d75  ?? 0), color: EMERALD },
    { label: "Reached 100%", value: String(totals.d100 ?? 0), color: AMBER   },
  ]);
  sectionHeading(doc, 48, "Scroll Depth by Journey");
  pdfTable(doc, 58, ["Journey","25%","50%","75%","100%","Total"],
    (scrollDepth?.byJourney ?? []).map((r: any) => [r.name, r.d25, r.d50, r.d75, r.d100, r.total]),
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — Scroll Depth — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ABM DATA
// ─────────────────────────────────────────────────────────────────────────────
export function exportAbmExcel(rows: any[]) {
  const ws = xlSheet(
    ["Page Name","Event","First Name","Last Name","Email","Company","Designation","Score Delta","Total Score","Stage","Journey","Duration","User Type","Tags","Visit Date","Visit Time"],
    rows.map((r: any) => [
      r.page_name ?? "", r.event_type ?? "",
      r.first_name ?? "", r.last_name ?? "", r.email ?? "",
      r.company_name ?? "", r.designation ?? "",
      r.score ?? 0, r.total_score ?? 0,
      stageFmt(r.user_stage ?? ""), r.journey_name ?? "",
      fmtDuration(r.duration_seconds), r.user_type ?? "anonymous",
      (r.contact_tags ?? []).join("; "),
      fmtDate(r.visit_date), r.visit_date ? formatReportTime(r.visit_date) : "",
    ]),
    [28,16,16,16,32,24,20,12,12,16,28,12,12,24,14,10],
  );
  xlWorkbook([{ name: "ABM Visitor Log", ws }, { name: "Meta", ws: xlMeta() }],
    `KABOOM — ABM Data — ${today()}.xlsx`);
}

export function exportAbmPdf(rows: any[]) {
  const doc = makePdf("ABM Visitor Activity Log", "Full event-level visitor data across all journeys");
  const known = rows.filter((r: any) => r.user_type === "known").length;
  const anon  = rows.length - known;
  addKpiRow(doc, 26, [
    { label: "Total Events", value: String(rows.length), color: INDIGO   },
    { label: "Known Visitors", value: String(known),     color: EMERALD  },
    { label: "Anonymous",    value: String(anon),         color: GRAY_600 },
  ]);
  sectionHeading(doc, 48, "Activity Log");
  pdfTable(doc, 58,
    ["Page","Event","Name","Email","Company","Score","Total","Stage","Journey","Date"],
    rows.map((r: any) => [
      (r.page_name ?? "—").slice(0,30),
      r.event_type ?? "—",
      [r.first_name, r.last_name].filter(Boolean).join(" ") || "—",
      r.email ?? "—",
      r.company_name ?? "—",
      r.score ?? 0,
      r.total_score ?? 0,
      stageFmt(r.user_stage ?? ""),
      (r.journey_name ?? "—").slice(0,24),
      fmtDate(r.visit_date),
    ]),
    { fontSize: 6.5 },
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — ABM Data — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS GTM OS
// ─────────────────────────────────────────────────────────────────────────────
type AccountDirectoryRow = {
  name: string; clientName: string | null; gtmStatus: { status: string } | null;
  journeyName: string | null; keyContactName: string | null;
  contactCount: number; activityScore: number; intentScore: number | null;
  journeyCount: number; eventCount: number; lastActivity: string | null;
};

export function exportAccountsExcel(rows: AccountDirectoryRow[], filters: Record<string, string>) {
  const ws = xlSheet(
    ["Account", "Client", "Status", "Journey (most recent)", "Key contact", "Contacts", "Activity score", "Intent score", "Journeys", "Events", "Last activity"],
    rows.map(r => [r.name, r.clientName ?? "", r.gtmStatus?.status ?? "Not categorized",
      r.journeyName ?? "", r.keyContactName ?? "", r.contactCount, r.activityScore,
      r.intentScore, r.journeyCount, r.eventCount,
      r.lastActivity ? `${fmtDate(r.lastActivity)} ${formatReportTime(r.lastActivity)}` : ""]),
    [32, 26, 18, 30, 26, 12, 16, 15, 12, 12, 24],
  );
  xlWorkbook([{ name: "Accounts", ws }, { name: "Meta", ws: xlMeta(filters) }],
    `KABOOM — Accounts — ${today()}.xlsx`);
}

export function exportAccountsPdf(rows: AccountDirectoryRow[], filters: Record<string, string>) {
  const doc = makePdf("Accounts", `${rows.length} matching accounts · ${Object.entries(filters).filter(([, v]) => v).map(([k,v]) => `${k}: ${v}`).join(", ") || "All accounts"}`);
  sectionHeading(doc, 30, "Account directory");
  pdfTable(doc, 40,
    ["Account", "Client", "Status", "Journey (most recent)", "Key contact", "Contacts", "Activity", "Intent", "Events"],
    rows.map(r => [r.name, r.clientName ?? "—", r.gtmStatus?.status ?? "Not categorized",
      r.journeyName ?? "—", r.keyContactName ?? "—", r.contactCount,
      r.activityScore, r.intentScore ?? "—", r.eventCount]),
    { fontSize: 6.5 });
  addPageNumbers(doc);
  doc.save(`KABOOM — Accounts — ${today()}.pdf`);
}

export function exportAccountIntelExcel(data: any[]) {
  const sourceLabel = (sources: string[] | undefined) => sources?.length
    ? sources.map(s => ({ lead_form: "Lead form", event_feedback: "Event feedback", monitored: "Monitored account", manual: "Manually added" }[s] ?? s)).join("; ")
    : "Not recorded";
  const ws = xlSheet(
    ["Account Name","Acquisition Source","Associated Journey","Contact Score","Score Prev Month","GTM OS Status","Journey Stage","Days in Stage","Contacts Tracked","Total Events","Sessions","Avg Session (sec)"],
    data.map((r: any) => [
      r.name, sourceLabel(r.acquisition_sources), r.journeyName ?? "Not recorded",
      parseFloat(r.avg_score)||0, parseFloat(r.prev_month_score)||0,
      r.gtmStatus?.status ?? "Not categorized", stageFmt(r.dominant_stage ?? ""),
      r.days_in_stage ?? 0, r.contact_count ?? 0,
      r.total_events ?? 0, r.sessions ?? 0,
      parseFloat(r.avg_session_secs)||0,
    ]),
    [32,27,28,16,17,18,18,14,16,13,11,15],
  );
  xlWorkbook([{ name: "Autonomous GTM OS", ws }, { name: "Meta", ws: xlMeta() }],
    `KABOOM — Autonomous GTM OS — ${today()}.xlsx`);
}

export function exportAccountIntelPdf(data: any[]) {
  const doc = makePdf("Autonomous GTM OS Report", "Recorded account qualification, acquisition and associated journey");
  const hot  = data.filter((r: any) => r.gtmStatus?.status === "hot").length;
  const warm = data.filter((r: any) => r.gtmStatus?.status === "warm").length;
  const cold = data.filter((r: any) => r.gtmStatus?.status === "cold").length;
  addKpiRow(doc, 26, [
    { label: "Total Accounts", value: String(data.length), color: INDIGO   },
    { label: "Hot", value: String(hot),         color: ROSE     },
    { label: "Warm",           value: String(warm),        color: AMBER    },
    { label: "Cold",           value: String(cold),        color: GRAY_600 },
    { label: "Not Categorized", value: String(data.length - hot - warm - cold), color: GRAY_600 },
  ]);
  sectionHeading(doc, 48, "Account Portfolio Overview");
  pdfTable(doc, 58,
    ["#","Account","Source","Journey","Score","Prev Score","GTM OS","Stage","Days","Contacts","Events","Sessions"],
    data.map((r: any, i: number) => [
      i+1, r.name,
      r.acquisition_sources?.length ? r.acquisition_sources.join(", ").replaceAll("_", " ") : "Not recorded",
      r.journeyName ?? "—",
      (parseFloat(r.avg_score)||0).toFixed(1),
      (parseFloat(r.prev_month_score)||0).toFixed(1),
      r.gtmStatus?.status ?? "Not categorized", stageFmt(r.dominant_stage ?? ""),
      r.days_in_stage ?? 0, r.contact_count ?? 0,
      r.total_events ?? 0, r.sessions ?? 0,
    ]),
    { headColor: CYAN, fontSize: 6.5 },
  );
  addPageNumbers(doc);
  doc.save(`KABOOM — Autonomous GTM OS — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOURNEY VELOCITY
// ─────────────────────────────────────────────────────────────────────────────
export function exportVelocityExcel(data: { stageTransitions: any[]; conversionRates: any[] }) {
  const transWs = xlSheet(
    ["Account","Industry","From Stage","To Stage","Entry Date","Exit Date","Days in Stage","Velocity vs Avg"],
    (data.stageTransitions ?? []).map((r: any) => [
      r.account, r.industry ?? "—",
      stageFmt(r.fromStage), stageFmt(r.toStage),
      fmtDate(r.entryDate), r.exitDate ? fmtDate(r.exitDate) : "In Progress",
      r.daysInStage ?? 0, r.velocityVsAvg,
    ]),
    [28,20,18,18,14,14,14,16],
  );

  const convWs = xlSheet(
    ["Stage Transition","Accounts Entered","Accounts Exited","Conversion Rate","Avg Days","Industry Leader","Fastest Account"],
    (data.conversionRates ?? []).map((r: any) => [
      `${stageFmt(r.fromStage)} → ${stageFmt(r.toStage)}`,
      r.entered, r.exited, `${r.conversionRate}%`, `${r.avgDays}d`,
      r.industryLeader ?? "—", r.fastestAccount ?? "—",
    ]),
    [32,16,16,15,12,20,24],
  );

  xlWorkbook([
    { name: "Stage Transitions",  ws: transWs },
    { name: "Conversion Rates",   ws: convWs  },
    { name: "Meta",               ws: xlMeta() },
  ], `KABOOM — Journey Velocity — ${today()}.xlsx`);
}

export function exportVelocityPdf(data: { stageTransitions: any[]; conversionRates: any[] }) {
  const doc = makePdf("Journey Velocity Report", "Stage movement speed and conversion rates across accounts");
  const avgDays = data.conversionRates.length
    ? Math.round(data.conversionRates.reduce((s, r) => s + (r.avgDays ?? 0), 0) / data.conversionRates.length)
    : 0;
  addKpiRow(doc, 26, [
    { label: "Stage Transitions", value: String(data.stageTransitions.length),  color: INDIGO },
    { label: "Conversion Paths",  value: String(data.conversionRates.length),   color: CYAN   },
    { label: "Avg Days / Stage",  value: `${avgDays}d`,                         color: AMBER  },
  ]);

  sectionHeading(doc, 48, "Account Stage Transitions");
  pdfTable(doc, 58,
    ["Account","From","To","Entry Date","Exit Date","Days","Velocity"],
    (data.stageTransitions ?? []).map((r: any) => [
      r.account, stageFmt(r.fromStage), stageFmt(r.toStage),
      fmtDate(r.entryDate), r.exitDate ? fmtDate(r.exitDate) : "In progress",
      r.daysInStage ?? 0, r.velocityVsAvg,
    ]),
    { fontSize: 7 },
  );

  doc.addPage();
  sectionHeading(doc, 10, "Stage Conversion Rates", CYAN);
  pdfTable(doc, 20,
    ["Stage Transition","Entered","Exited","Conv. Rate","Avg Days","Leader Industry","Fastest Account"],
    (data.conversionRates ?? []).map((r: any) => [
      `${stageFmt(r.fromStage)} → ${stageFmt(r.toStage)}`,
      r.entered, r.exited, `${r.conversionRate}%`, `${r.avgDays}d`,
      r.industryLeader ?? "—", r.fastestAccount ?? "—",
    ]),
    { headColor: CYAN },
  );

  addPageNumbers(doc);
  doc.save(`KABOOM — Journey Velocity — ${today()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────
// ── Calls helpers ─────────────────────────────────────────────────────────────
function parseTranscript(tx: any): string {
  if (!tx) return "";
  if (typeof tx === "string") {
    try {
      const p = JSON.parse(tx);
      if (Array.isArray(p)) return p.map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
      return (p as any)?.text ?? tx;
    } catch { return tx; }
  }
  if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
  return (tx as any)?.text ?? "";
}

function fmtSecs(s: number | null | undefined): string {
  if (!s) return "—";
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function exportCallsExcel(calls: any[]) {
  const callWs = xlSheet(
    ["Contact", "Email", "Phone", "Company", "Campaign", "Outcome", "Duration", "Called At", "Transcript"],
    calls.map((r: any) => [
      `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—",
      r.email ?? "—",
      r.phone ?? "—",
      r.company_name ?? "—",
      r.campaign_name ?? "—",
      r.outcome ? r.outcome.replace(/_/g, " ") : "—",
      fmtSecs(r.duration_seconds),
      fmtDate(r.started_at),
      parseTranscript(r.transcript) || (r.ai_summary ?? "—"),
    ]),
    [26, 28, 16, 26, 26, 16, 10, 18, 80],
  );

  const aiWs = xlSheet(
    ["Contact", "Email", "Phone", "Company", "Campaign", "Interest Score", "Sentiment", "Next Action", "Action Timing", "Owning Team", "Follow-up Message", "AI Summary"],
    calls.map((r: any) => [
      `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—",
      r.email ?? "—",
      r.phone ?? "—",
      r.company_name ?? "—",
      r.campaign_name ?? "—",
      r.interest_score ?? "—",
      r.sentiment ?? "—",
      r.recommended_action ?? r.ai_next_steps ?? "—",
      r.action_timing ?? "—",
      r.owning_team ?? "—",
      r.follow_up_message ?? "—",
      r.llm_call_summary ?? r.ai_summary ?? "—",
    ]),
    [26, 30, 18, 26, 26, 14, 14, 36, 18, 16, 50, 50],
  );

  xlWorkbook([
    { name: "Call Log",    ws: callWs },
    { name: "AI Analysis", ws: aiWs   },
    { name: "Meta",        ws: xlMeta() },
  ], `KABOOM — Call Campaigns Export — ${today()}.xlsx`);
}

export function exportCallsPdf(calls: any[]) {
  const total      = calls.length;
  const connected  = calls.filter(r => (r.duration_seconds ?? 0) > 5).length;
  const interested = calls.filter(r => r.outcome === "interested").length;
  const analysed   = calls.filter(r => r.interest_score != null).length;
  const avgScore   = analysed > 0
    ? Math.round(calls.filter(r => r.interest_score != null).reduce((s, r) => s + Number(r.interest_score), 0) / analysed * 10) / 10
    : 0;

  const doc = makePdf("Call Campaigns Export", "Full call log with AI analysis — transcript and next action suggestions");

  addKpiRow(doc, 26, [
    { label: "Total Calls",    value: String(total),                                              color: INDIGO   },
    { label: "Connected",      value: String(connected),                                           color: EMERALD  },
    { label: "Interested",     value: String(interested),                                          color: EMERALD  },
    { label: "Connect Rate",   value: total > 0 ? `${Math.round((connected / total) * 100)}%` : "—", color: CYAN  },
    { label: "AI Analysed",    value: String(analysed),                                            color: AMBER    },
    { label: "Avg Interest",   value: analysed > 0 ? `${avgScore}/10` : "—",                      color: AMBER    },
  ]);

  sectionHeading(doc, 48, "Call Log with Transcripts");
  pdfTable(doc, 58,
    ["Contact", "Company", "Campaign", "Outcome", "Duration", "Called At", "Transcript / Summary"],
    calls.map((r: any) => {
      const tx = parseTranscript(r.transcript) || r.ai_summary || "—";
      return [
        `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—",
        r.company_name ?? "—",
        r.campaign_name ?? "—",
        r.outcome ? r.outcome.replace(/_/g, " ") : "—",
        fmtSecs(r.duration_seconds),
        fmtDate(r.started_at),
        tx.length > 180 ? tx.slice(0, 180) + "…" : tx,
      ];
    }),
    { fontSize: 6.5 },
  );

  doc.addPage();
  sectionHeading(doc, 10, "AI Analysis — Next Actions & Follow-up", CYAN);
  pdfTable(doc, 20,
    ["Contact", "Company", "Score", "Sentiment", "Next Action", "Timing", "Team", "Follow-up Message"],
    calls
      .filter(r => r.recommended_action || r.ai_next_steps || r.follow_up_message)
      .map((r: any) => {
        const msg = r.follow_up_message ?? "";
        return [
          `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—",
          r.company_name ?? "—",
          r.interest_score != null ? `${r.interest_score}/10` : "—",
          r.sentiment ?? "—",
          r.recommended_action ?? r.ai_next_steps ?? "—",
          r.action_timing ?? "—",
          r.owning_team ?? "—",
          msg.length > 120 ? msg.slice(0, 120) + "…" : (msg || "—"),
        ];
      }),
    { fontSize: 6.5 },
  );

  addPageNumbers(doc);
  doc.save(`KABOOM — Call Campaigns Export — ${today()}.pdf`);
}

export function exportScoreIntelExcel(data: { distribution: any[]; risers: any[]; trend: any[]; byAccount: any[] }) {
  const distWs = xlSheet(
    ["Score Bucket","Contact Count"],
    (data.distribution ?? []).map((r: any) => [r.bucket, r.count]),
    [22, 16],
  );

  const risersWs = xlSheet(
    ["Name","Email","Company","Current Score","Score Gain (30d)","Prev Score","Stage"],
    (data.risers ?? []).map((r: any) => [
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      r.email ?? "", r.company_name ?? "", r.leadScore ?? 0,
      r.score_gain_30d ?? 0, r.prev_score ?? 0, stageFmt(r.stage ?? ""),
    ]),
    [26,32,24,14,16,12,18],
  );

  const trendWs = xlSheet(
    ["Date","Total Score Delta","Active Contacts"],
    (data.trend ?? []).map((r: any) => [r.date, r.total_delta ?? 0, r.active_contacts ?? 0]),
    [16, 18, 16],
  );

  const accountWs = xlSheet(
    ["Company","Industry","Contacts","Avg Score","Total Score Delta"],
    (data.byAccount ?? []).map((r: any) => [
      r.company_name ?? "—", r.industry ?? "—",
      r.contact_count ?? 0, parseFloat(r.avg_score)||0, r.total_delta ?? 0,
    ]),
    [32,20,12,12,16],
  );

  xlWorkbook([
    { name: "Score Distribution", ws: distWs    },
    { name: "Top Risers (30d)",   ws: risersWs  },
    { name: "Score Trend",        ws: trendWs   },
    { name: "By Account",         ws: accountWs },
    { name: "Meta",               ws: xlMeta()  },
  ], `KABOOM — Score Intelligence — ${today()}.xlsx`);
}

export function exportScoreIntelPdf(data: { distribution: any[]; risers: any[]; trend: any[]; byAccount: any[] }) {
  const doc = makePdf("Score Intelligence Report", "Lead score distribution, top risers and scoring trends");
  const total    = (data.distribution ?? []).reduce((s: number, r: any) => s + (r.count ?? 0), 0);
  const hot      = (data.distribution ?? []).find((r: any) => r.bucket?.includes("Hot"))?.count ?? 0;
  const veryHot  = (data.distribution ?? []).find((r: any) => r.bucket?.includes("Very"))?.count ?? 0;
  const topRiser = data.risers?.[0];

  addKpiRow(doc, 26, [
    { label: "Total Contacts",  value: String(total),              color: INDIGO   },
    { label: "Hot (50+)",       value: String(hot),                color: ROSE     },
    { label: "Very Hot (75+)",  value: String(veryHot),            color: ROSE     },
    { label: "Top Riser",       value: topRiser ? `${topRiser.firstName} +${topRiser.score_gain_30d}` : "—", color: EMERALD },
  ]);

  sectionHeading(doc, 48, "Score Bucket Distribution");
  pdfTable(doc, 58, ["Score Bucket","Contact Count"],
    (data.distribution ?? []).map((r: any) => [r.bucket, r.count]),
  );

  const y1 = (doc as any).lastAutoTable?.finalY ?? 90;
  sectionHeading(doc, y1 + 8, "Top Risers — Last 30 Days");
  pdfTable(doc, y1 + 18,
    ["Name","Email","Company","Current Score","Gain (30d)","Stage"],
    (data.risers ?? []).map((r: any) => [
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      r.email ?? "—", r.company_name ?? "—",
      r.leadScore ?? 0, `+${r.score_gain_30d ?? 0}`, stageFmt(r.stage ?? ""),
    ]),
    { fontSize: 7 },
  );

  doc.addPage();
  sectionHeading(doc, 10, "Daily Score Trend (Last 30 Days)", CYAN);
  pdfTable(doc, 20, ["Date","Total Score Delta","Active Contacts"],
    (data.trend ?? []).map((r: any) => [r.date, r.total_delta ?? 0, r.active_contacts ?? 0]),
  );

  const y2 = (doc as any).lastAutoTable?.finalY ?? 80;
  sectionHeading(doc, y2 + 8, "Score by Account", CYAN);
  pdfTable(doc, y2 + 18,
    ["Company","Industry","Contacts","Avg Score","Score Delta"],
    (data.byAccount ?? []).map((r: any) => [
      r.company_name ?? "—", r.industry ?? "—",
      r.contact_count ?? 0, parseFloat(r.avg_score)||0, r.total_delta ?? 0,
    ]),
  );

  addPageNumbers(doc);
  doc.save(`KABOOM — Score Intelligence — ${today()}.pdf`);
}
