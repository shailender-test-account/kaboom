import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Maximize2, Minimize2, Play, Pause, Upload, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { useHpBiDashboard, useHpBiFilterOptions, hpBiQuery } from "./api";
import type { HpBiFilters, HpBiSortField } from "./types";
import { GOV_EDU, HP_DIMENSIONS, RADS, SEGMENT_VIEWS, currentFiscalYear, download, fyLabel } from "./format";
import { ErrorBox, Panel, Skel } from "./ui";
import OverviewView from "./OverviewView";
import AccountsTable from "./AccountsTable";
import AccountFilters from "./AccountFilters";
import type { ContactMetric } from "./ContactActivity";
import ParentComparison from "./ParentComparison";
import ParentMonthHeatmap from "./ParentMonthHeatmap";
import ScoringTab from "./ScoringTab";
import Collapsible from "./Collapsible";
import MetricSummaryDialog, { type MetricKey } from "./MetricSummaryDialog";
import { readLayout, writeLayout, type AccountLayout } from "./structured";
import RosterMappingPanel from "./RosterMappingPanel";
import WarmRoutingPanel from "./WarmRoutingPanel";
import { useAuth } from "@/hooks/useAuth";
const AccountDetail = lazy(() => import("./AccountDetail"));
const ImportPanel = lazy(() => import("./ImportPanel"));
const AccountDataManager = lazy(() => import("./AccountDataManager"));
import EvidenceDialog, { type EvidenceQuery } from "./EvidenceDialog";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Public+Sans:wght@400;500;600&display=swap');
.hpbi{font-family:'Public Sans',sans-serif;color:#10243B;max-width:100%;min-width:0}
@keyframes hpbi-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes hpbi-fade{from{opacity:0}to{opacity:1}}
@keyframes hpbi-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes hpbi-pulse{50%{opacity:.5}}
.hpbi-rise{animation:hpbi-rise .45s cubic-bezier(.2,.7,.2,1) both}
.hpbi-fade{animation:hpbi-fade .35s ease both}
.hpbi-grow{animation:hpbi-grow .7s cubic-bezier(.2,.7,.2,1) both}
.hpbi-pulse{animation:hpbi-pulse 1.4s ease infinite}
@keyframes hpbi-present-cue{0%,100%{background-color:#0096D6;box-shadow:inset 0 0 0 0 transparent}50%{background-color:#0876ab;box-shadow:inset 0 0 0 2px #98e4ff}}
.hpbi-present-cue{animation:hpbi-present-cue 2s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.hpbi *{animation:none!important;transition:none!important}}
.hpbi-present{font-size:112%}
`;
type Tab = "bi" | "scoring" | "parent" | "heatmap" | "data" | "roster" | "routing";
const pill = (on: boolean) => `px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${on ? "bg-[#0096D6] text-white" : "text-[#d6e6f3] hover:bg-white/10"}`;
const filterControl = "h-9 w-full min-w-0 rounded-md border border-[#c5d3df] bg-white px-2.5 py-0 text-xs font-normal text-[#10243B] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[#0096D6]/40 disabled:bg-[#f4f7fa] disabled:text-[#8a9aab] disabled:shadow-none";
const filterLabel = "flex min-w-0 flex-col gap-1.5 text-[10.5px] font-semibold text-[#5d7388]";

export default function HpBiDashboard({ clientId }: { clientId: number }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("bi");
  const [year, setYear] = useState(currentFiscalYear);
  const [segment, setSegment] = useState<string>("Overall");
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [basis, setBasis] = useState<"" | "PS" | "Print">("");
  const [rad, setRad] = useState("");
  const [salesPerson, setSalesPerson] = useState("");
  const [opportunity, setOpportunity] = useState<NonNullable<HpBiFilters["opportunity"]> | "">("");
  const filterOptions = useHpBiFilterOptions(clientId);
  useEffect(() => { setSalesPerson(""); setOpportunity(""); setPage(1); }, [clientId]);
  const [newOnly, setNewOnly] = useState(false);
  const [abmOnly, setAbmOnly] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [sortBy, setSortBy] = useState<HpBiSortField | undefined>();
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [qualification,setQualification]=useState<"Hot"|"Warm"|"Cold"|undefined>();
  const [gtmSource, setGtmSource] = useState<HpBiFilters["gtmSource"]>();
  const [monitoring, setMonitoring] = useState<HpBiFilters["monitoring"]>();
  const [sortCurrency, setSortCurrency] = useState("INR");
  const [parentKey, setParentKey] = useState<string | null>(null);
  const [contactMetric, setContactMetric] = useState<ContactMetric>("touchpoints");
  const [dimension, setDimension] = useState("");
  const [dimText, setDimText] = useState("");
  const [dimValue, setDimValue] = useState("");
  const [evidence, setEvidence] = useState<EvidenceQuery | null>(null);
  const [summary, setSummary] = useState<MetricKey | null>(null);
  const [evidenceFrom, setEvidenceFrom] = useState<MetricKey | null>(null);
  const [accountsFrom, setAccountsFrom] = useState<MetricKey | null>(null);
  const [scoringFrom, setScoringFrom] = useState<MetricKey | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [auto, setAuto] = useState(false);
  const [layout, setLayoutState] = useState<AccountLayout>(() => readLayout(clientId));
  // A full-page plan link must not lose the legal-account card on browser Back.
  // Keep this context on the source history entry, not in a persistent user cache.
  useEffect(() => {
    const saved = window.history.state?.hpCommitteeReturn as { clientId: number; filters: HpBiFilters; parentKey: string; tab: Tab; metric: ContactMetric } | undefined;
    if (!saved || saved.clientId !== clientId) return;
    const f = saved.filters;
    setYear(f.year ?? currentFiscalYear()); setSegment(f.segment || "Overall"); setIncompleteOnly(!!f.incompleteOnly);
    setBasis(f.basis === "PS" || f.basis === "Print" ? f.basis : ""); setRad(f.rad || ""); setSalesPerson(f.salesPerson || "");
    setOpportunity(f.opportunity || ""); setNewOnly(!!f.newOnly); setAbmOnly(!!f.abmOnly);
    setSearch(f.search || ""); setSearchText(f.search || ""); setPage(f.page || 1); setPageSize(f.pageSize || 5);
    setSortBy(f.sortBy); setSortDir(f.sortDir || "desc"); setSortCurrency(f.sortCurrency || "INR");
    setQualification(f.qualification); setGtmSource(f.gtmSource); setMonitoring(f.monitoring); setDimension(f.dimension || ""); setDimValue(f.dimensionValue || ""); setDimText(f.dimensionValue || "");
    setParentKey(saved.parentKey); setTab(saved.tab); setContactMetric(saved.metric);
  }, [clientId]);
  useEffect(() => { setLayoutState(readLayout(clientId)); }, [clientId]);
  const setLayout = (l: AccountLayout) => { writeLayout(clientId, l); setLayoutState(l); };
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (search === searchText.trim() && dimValue === dimText.trim()) return;
    const t = setTimeout(() => { setSearch(searchText.trim()); setDimValue(dimText.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchText, dimText, search, dimValue]);
  useEffect(() => { const f = () => { const on = document.fullscreenElement === root.current; setFull(on); if (!on) setAuto(false); }; document.addEventListener("fullscreenchange", f); return () => document.removeEventListener("fullscreenchange", f); }, []);
  const exitFull = useCallback(async () => { if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ignore */ } } }, []);
  const toggleFull = useCallback(() => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.(); }, []);
  const filters: HpBiFilters = useMemo(() => ({ clientId, year, segment: segment === "Overall" ? undefined : segment, basis: basis || undefined, rad: rad || undefined,
    salesPerson: salesPerson || undefined, opportunity: opportunity || undefined,
    search: search || undefined, newOnly, abmOnly, incompleteOnly, page, pageSize, sortBy, sortDir, sortCurrency,qualification,gtmSource,monitoring,
    dimension: dimension && dimValue ? dimension : undefined, dimensionValue: dimension && dimValue ? dimValue : undefined }), [clientId, year, segment, basis, rad, salesPerson, opportunity, search, newOnly, abmOnly, incompleteOnly, page, pageSize, dimension, dimValue, sortBy, sortDir, sortCurrency,qualification,gtmSource,monitoring]);
  const q = useHpBiDashboard(filters, !importOpen && tab !== "heatmap" && tab !== "data" && tab !== "roster" && tab !== "routing", !full);
  const data = q.data;
  const displayedAccountPage = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    const changed = displayedAccountPage.current !== undefined && displayedAccountPage.current !== data.page;
    displayedAccountPage.current = data.page;
    if (!changed || tab !== "bi") return;
    // A new page can have much shorter rows. Do not retain a deep fullscreen
    // scroll offset that leaves only the middle of an otherwise empty cell visible.
    const frame = requestAnimationFrame(() => {
      root.current?.querySelector("[data-testid=panel-accounts]")?.scrollIntoView?.({ block: "start", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [data?.page, tab]);
  const views: string[] = [...SEGMENT_VIEWS, GOV_EDU];
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { setSegment(s => views[(views.indexOf(s) + 1) % views.length]); setPage(1); }, 20000);
    return () => clearInterval(t);
  }, [auto]);

  const openEvidence = async (e: EvidenceQuery, from: MetricKey | null = null) => { await exitFull(); setSummary(null); setAccountsFrom(null); setScoringFrom(null); setEvidenceFrom(from); setEvidence(e); };
  const openSummary = async (k: MetricKey) => { await exitFull(); setEvidence(null); setEvidenceFrom(null); setAccountsFrom(null); setScoringFrom(null); setSummary(k); };
  const closeEvidence = () => { setEvidence(null); setEvidenceFrom(null); };
  const evidenceBack = () => { const f = evidenceFrom; closeEvidence(); if (f) setSummary(f); };
  const toAccounts = (k: MetricKey) => { setSummary(null); setTab("bi"); setAccountsFrom(k); setTimeout(() => root.current?.querySelector("[data-testid=panel-accounts]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
  const toScoring = (k: MetricKey) => { setSummary(null); setScoringFrom(k); setTab("scoring"); };
  const reset = (fn: () => void) => { fn(); setPage(1); };
  const years = Array.from({ length: Math.max(1, new Date().getFullYear() - 2000 + 3) }, (_, i) => 2000 + i);
  const chip = (on: boolean) => `inline-flex h-9 items-center justify-center whitespace-nowrap px-2.5 text-xs rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0096D6]/40 ${on ? "bg-[#0B2A4A] text-white border-[#0B2A4A]" : "bg-white text-[#41586e] border-[#c5d3df] hover:bg-[#eaf6fc]"}`;

  return (
    <div ref={root} onClickCapture={e => {
      if (!(e.target instanceof Element) || !e.target.closest("a[data-committee-plan-link]") || !parentKey) return;
      const url = new URL(window.location.href);
      url.searchParams.set("clientId", String(clientId));
      window.history.replaceState({ ...window.history.state, hpCommitteeReturn: { clientId, filters, parentKey, tab, metric: contactMetric } }, "", url);
    }} className={`hpbi relative bg-[#eef3f7] ${full ? "hpbi-present overflow-y-auto h-screen" : "rounded-xl overflow-hidden"}`} data-testid="hp-bi-dashboard">
      <style>{CSS}</style>
      <header className="bg-[#0B2A4A] text-white px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div><h2 className="text-lg leading-none font-semibold" style={{ fontFamily: "'Barlow Semi Condensed',sans-serif" }}>Commercial Marketing BI</h2>
            <p className="text-[11px] text-[#9db6cc] mt-0.5" data-testid="text-fy">{fyLabel(year)} / HP India</p></div>
        </div>
        <nav className="flex flex-wrap md:flex-nowrap gap-1 rounded-lg bg-white/5 p-1 max-w-full overflow-x-auto shrink-0" aria-label="BI views">
          <button data-testid="tab-bi" className={pill(tab === "bi")} onClick={() => { setScoringFrom(null); setTab("bi"); }}>Dashboard</button>
          <button data-testid="tab-scoring" className={pill(tab === "scoring")} onClick={() => { setScoringFrom(null); setTab("scoring"); }}>Scoring Logic</button>
          <button data-testid="tab-parent-comparison" className={pill(tab === "parent")} onClick={() => { setScoringFrom(null); setTab("parent"); }}>Parent Comparison</button>
          <button data-testid="tab-heatmap" className={pill(tab === "heatmap")} onClick={() => { setScoringFrom(null); setTab("heatmap"); }}>Heatmap</button>
          <button data-testid="tab-data-manager" className={pill(tab === "data")} onClick={() => { setScoringFrom(null); setTab("data"); }}>Data Manager</button>
          <button data-testid="tab-roster" className={pill(tab === "roster")} onClick={() => { setScoringFrom(null); setTab("roster"); }}>Roster &amp; GTM mapping</button>
          {user?.role === "admin" && <button data-testid="tab-warm-routing" className={pill(tab === "routing")} onClick={() => setTab("routing")}>Warm routing</button>}
        </nav>
        <div className="ml-auto flex items-center gap-2 max-w-full overflow-x-auto">
          <div role="group" aria-label="Account layout" className="flex rounded-md bg-white/5 p-0.5 shrink-0" data-testid="layout-selector">
            {(["structured", "original"] as const).map(l => <button key={l} type="button" aria-pressed={layout === l} data-testid={`layout-${l}`} onClick={() => setLayout(l)} className={`px-2 py-1 text-xs rounded ${layout === l ? "bg-[#0096D6] text-white" : "text-[#d6e6f3] hover:bg-white/10"}`}>{l === "structured" ? "Structured layout" : "Original layout"}</button>)}
          </div>
          <select data-testid="select-year" value={year} onChange={e => reset(() => setYear(Number(e.target.value)))} className="rounded bg-white/10 text-xs px-2 py-1.5 border border-white/15">
            {years.map(y => <option key={y} value={y} className="text-black">{fyLabel(y)}</option>)}</select>
          <button data-testid="button-import" onClick={async () => { await exitFull(); setImportOpen(true); }} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20"><Upload className="w-3.5 h-3.5" />Import{data && data.quality.unresolvedMatches > 0 ? ` (${data.quality.unresolvedMatches})` : ""}</button>
          <button data-testid="button-export" onClick={() => download(`/api/analytics/hp-bi/export?${hpBiQuery({ ...filters, page: undefined, pageSize: undefined })}`)} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20"><Download className="w-3.5 h-3.5" />Export CSV</button>
          <Link href={`/ai-answer?clientId=${clientId}`} data-testid="button-hp-ai-answer" className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20"><Sparkles className="w-3.5 h-3.5" />AI Answer</Link>
          {full && <button data-testid="button-autoplay" onClick={() => setAuto(a => !a)} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20">{auto ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}{auto ? "Stop cycling" : "Cycle segments"}</button>}
          <button data-testid="button-fullscreen" title={full ? "Exit full screen" : "View dashboard in full screen"} onClick={toggleFull} className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-[#0096D6] hover:bg-[#0583b9] ${full ? "" : "hpbi-present-cue"}`}>{full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}{full ? "Exit" : "Present"}</button>
        </div>
      </header>

      {(tab === "bi" || tab === "heatmap") && (
        <div className="@container mx-5 mt-3 rounded-lg border border-[#d5e0ea] bg-[#f7fafc] p-3 space-y-3" data-testid="filter-bar">
          <AccountFilters search={searchText} qualification={qualification} gtmSource={gtmSource}
            monitoring={monitoring} onMonitoring={value => reset(() => setMonitoring(value))}
            onSearch={setSearchText}
            onQualification={value => reset(() => setQualification(value))}
            onSource={value => reset(() => setGtmSource(value))}
            onClear={() => reset(() => { setSearchText(""); setSearch(""); setQualification(undefined); setGtmSource(undefined); setMonitoring(undefined); })} />
          <div className="grid grid-cols-1 @min-[420px]:grid-cols-2 @min-[760px]:grid-cols-4 gap-3 items-end" data-testid="filter-fields">
          <label className={filterLabel}>HP Salesperson
            <select aria-label="HP Salesperson" data-testid="filter-hp-salesperson" value={salesPerson}
              disabled={filterOptions.isLoading || filterOptions.isError}
              onChange={e => reset(() => setSalesPerson(e.target.value))}
              className={filterControl}>
              <option value="">{filterOptions.isLoading ? "Loading salespeople…" : "All HP salespeople"}</option>
              {(filterOptions.data?.salesPeople ?? []).map(email => <option key={email} value={email}>{email}</option>)}
            </select>
          </label>
          <label className={filterLabel}>Opportunity
            <select aria-label="Opportunity" data-testid="filter-hp-opportunity" value={opportunity}
              onChange={e => reset(() => setOpportunity(e.target.value as typeof opportunity))}
              title="Matches supplied buyer/whitespace categories, recorded category activity, or source-backed Hot/Warm intent."
              className={filterControl}>
              <option value="">All opportunities</option>
              <option value="Business Services">Business Services</option><option value="Business Collaboration">Collaboration</option>
              <option value="IT Hardware">IT Hardware</option><option value="Security">Security</option>
            </select>
          </label>
          <label className={filterLabel}>Dimension
            <select data-testid="select-dimension" aria-label="Dimension" className={filterControl} value={dimension} onChange={e => reset(() => setDimension(e.target.value))}><option value="">Any dimension</option>{Object.entries(HP_DIMENSIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <label className={filterLabel}>Dimension value
            <input data-testid="input-dimension-value" aria-label="Dimension value" disabled={!dimension} value={dimText} onChange={e => setDimText(e.target.value)} placeholder={dimension ? "Enter a value" : "Select a dimension first"} className={filterControl} />
          </label>
          </div>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-t border-[#e0e8ef] pt-3" data-testid="filter-groups">
            <div className={filterLabel}>
              <span id="hp-segment-label">Segment</span>
              <div className="flex flex-wrap gap-1" role="tablist" aria-labelledby="hp-segment-label">{views.map(s => <button key={s} role="tab" aria-selected={segment === s} data-testid={`filter-segment-${s}`} className={chip(segment === s)} onClick={() => reset(() => setSegment(s))}>{s}</button>)}</div>
            </div>
            <div className={filterLabel}>
              <span id="hp-portfolio-label">Portfolio</span>
              <div className="flex flex-wrap gap-1" role="group" aria-labelledby="hp-portfolio-label">
                {(["PS", "Print"] as const).map(b => <button key={b} aria-pressed={basis === b} data-testid={`filter-basis-${b}`} className={chip(basis === b)} onClick={() => reset(() => setBasis(basis === b ? "" : b))}>{b}</button>)}
              </div>
            </div>
            <div className={filterLabel}>
              <span id="hp-rad-label">RAD</span>
              <div className="flex flex-wrap gap-1" role="group" aria-labelledby="hp-rad-label">
                {RADS.map(r => <button key={r} aria-pressed={rad === r} data-testid={`filter-rad-${r}`} className={chip(rad === r)} onClick={() => reset(() => setRad(rad === r ? "" : r))}>{r}</button>)}
              </div>
            </div>
            <div className={`${filterLabel} @min-[1120px]:ml-auto`}>
              <span id="hp-scope-label">Account scope</span>
              <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 text-xs font-normal text-[#41586e]" role="group" aria-labelledby="hp-scope-label">
                <label className="flex min-h-9 items-center gap-2 whitespace-nowrap cursor-pointer"><input className="h-3.5 w-3.5 accent-[#0096D6]" data-testid="check-new-only" type="checkbox" checked={newOnly} onChange={e => reset(() => setNewOnly(e.target.checked))} />New only</label>
                <label className="flex min-h-9 items-center gap-2 whitespace-nowrap cursor-pointer"><input className="h-3.5 w-3.5 accent-[#0096D6]" data-testid="check-abm-only" type="checkbox" checked={abmOnly} onChange={e => reset(() => setAbmOnly(e.target.checked))} />ABM designated only</label>
              </div>
            </div>
          </div>
          {filterOptions.isError && <p role="alert" className="text-xs text-red-700">Salespeople unavailable. <button className="underline" onClick={() => filterOptions.refetch()}>Retry</button></p>}
          {opportunity && <p className="text-[11px] leading-relaxed text-[#5d7388]">Opportunity matches supplied buyer/whitespace categories, recorded category activity, or source-backed Hot/Warm intent. Totals include all activity for the matching accounts; category interest alone is not a confirmed deal.</p>}
        </div>
      )}

      <main className="p-5 space-y-3">
        {tab !== "parent" && tab !== "heatmap" && tab !== "data" && tab !== "roster" && tab !== "routing" && q.isLoading && <div className="grid grid-cols-4 gap-3" data-testid="status-loading">{Array.from({ length: 8 }).map((_, i) => <Skel key={i} className="h-20" />)}<Skel className="h-60 col-span-3" /><Skel className="h-60" /></div>}
        {tab !== "parent" && tab !== "heatmap" && tab !== "data" && tab !== "roster" && tab !== "routing" && q.isError && <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />}
        {tab === "parent" && <ParentComparison filters={filters} onBack={() => setTab("bi")} />}
        {tab === "roster" && <RosterMappingPanel key={clientId} clientId={clientId} onOpenAccount={async k => { await exitFull(); setContactMetric("touchpoints"); setParentKey(k); }} />}
        {tab === "routing" && user?.role === "admin" && <WarmRoutingPanel key={clientId} clientId={clientId} onOpenAccount={async k => { await exitFull(); setContactMetric("touchpoints"); setParentKey(k); }} />}
        {tab === "data" && <Suspense fallback={<Skel className="h-40" />}><AccountDataManager clientId={clientId} /></Suspense>}
        {tab === "heatmap" && <ParentMonthHeatmap filters={filters} />}
        {data && tab === "scoring" && <>
          {scoringFrom && <button type="button" data-testid="button-scoring-back" className="text-xs font-semibold text-[#05628f] hover:underline" onClick={() => { const f = scoringFrom; setScoringFrom(null); setTab("bi"); setSummary(f); }}>&larr; Back to summary</button>}
          <ScoringTab data={data} /></>}
        {data && tab === "bi" && (
          <>
            <Collapsible testId="roster-coverage" title={data.quality.rosterImported ? "Imported account roster" : "Existing CRM baseline — no account workbook imported"} summary={`${data.summary.accounts.toLocaleString("en-IN")} legal accounts in current filters; the roster does not create leads`}>
              <div>
              <p className="mt-1">
                {data.quality.rosterLegalAccounts?.toLocaleString("en-IN") ?? "—"} legal accounts / {data.quality.rosterParentGroups?.toLocaleString("en-IN") ?? "—"} parent groups in this HP client.
                {" "}Current filters: {data.summary.accounts.toLocaleString("en-IN")} legal accounts / {data.summary.parentAccounts.toLocaleString("en-IN")} parent groups.
                {" "}Accounts without contacts or activity remain included; the roster does not create leads.
              </p>
              <p className="mt-2">One HP account register: roster imports, CRM and inbound accounts share their existing account IDs, contacts, scores and product evidence. Missing context does not exclude an account.</p>
              <label className="mt-2 inline-flex items-center gap-2 cursor-pointer">
                <input data-testid="filter-needs-completion" type="checkbox" checked={incompleteOnly} onChange={e => reset(() => setIncompleteOnly(e.target.checked))} />
                Needs completion ({data.quality.incompleteAccounts?.toLocaleString("en-IN") ?? "—"} accounts in current filters)
              </label>
              {data.quality.rosterImported === false && <div className="mt-2">
                <p>The supplied Excel roster is not loaded in this environment. These counts do not represent the full Excel account universe.</p>
                <button data-testid="button-import-roster" className="mt-2 rounded bg-[#0B2A4A] px-3 py-1.5 text-white" onClick={async () => { await exitFull(); setImportOpen(true); }}>Preview account-context workbook</button>
              </div>}
            </div>
            </Collapsible>
            <OverviewView data={data} onMetric={openSummary} pageHint={segment === "Overall" ? "Overall view." : `${segment} view.`} onEvidence={e => void openEvidence(e)} />
            {accountsFrom && <button type="button" data-testid="button-accounts-back" className="text-xs font-semibold text-[#05628f] hover:underline" onClick={() => { const f = accountsFrom; setAccountsFrom(null); setSummary(f); root.current?.scrollIntoView({ block: "start" }); }}>&larr; Back to summary</button>}
            <Panel id="panel-accounts" className="scroll-mt-28" title="Parent accounts" note="Select a row for parent detail, monthly records, contacts and editable context."
              right={<div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-[#41586e]">Accounts per page
                  <select aria-label="Accounts per page" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                    className="rounded border border-[#c5d3df] bg-white px-2 py-1">
                    {[5, 10, 25].map(size => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
                <span className="text-xs tabular-nums text-[#41586e]" data-testid="text-total-accounts">{data.total.toLocaleString("en-IN")} parent groups / {(data.matchingLegalAccounts??data.summary.accounts).toLocaleString("en-IN")} legal accounts</span>
              </div>}>
              <AccountsTable data={data} fetching={q.isFetching} sortBy={sortBy} sortDir={sortDir} sortCurrency={sortCurrency}
                qualification={qualification}
                onQualification={value=>reset(()=>setQualification(value))}
                onSort={(field, direction) => { setSortBy(field); setSortDir(direction); setPage(1); }}
                onSortCurrency={currency => { setSortCurrency(currency); setPage(1); }}
                onOpen={async (k) => { await exitFull(); setContactMetric("touchpoints"); setParentKey(k); }}
                onMetric={async (k, metric) => { await exitFull(); setContactMetric(metric); setParentKey(k); }} onPage={setPage} />
            </Panel>
          </>
        )}
      </main>
      {data && <MetricSummaryDialog metric={summary} data={data} onBack={() => setSummary(null)} onEvidence={(e, f) => void openEvidence(e, f)} onAccounts={toAccounts} onScoring={toScoring} />}
      <EvidenceDialog filters={filters} query={evidence} onClose={closeEvidence} onBack={evidenceBack} backLabel={evidenceFrom ? "Back to summary" : "Back to dashboard"} />
      {parentKey && <Suspense fallback={<div role="status" className="p-4">Loading account details…</div>}><AccountDetail layout={layout} filters={filters} parentKey={parentKey} initialMetric={contactMetric} onClose={() => {
        setParentKey(null);
        const { hpCommitteeReturn: _returnContext, ...state } = window.history.state ?? {};
        window.history.replaceState(state, "");
      }} /></Suspense>}
      {importOpen && <Suspense fallback={<div role="status" className="p-4">Loading import tools…</div>}><ImportPanel open={importOpen} onClose={() => setImportOpen(false)} clientId={clientId} unresolved={data?.quality.unresolvedMatches ?? 0} /></Suspense>}
    </div>
  );
}
