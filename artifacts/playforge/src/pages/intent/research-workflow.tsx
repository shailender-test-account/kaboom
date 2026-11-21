import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Activity, DatabaseZap, Loader2, SearchCheck, Upload, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ContactDiscoveryCandidate,
  useApproveContactDiscovery,
  useContactDiscovery,
  useIntentResearchSummary,
  useResumeIntentResearch,
  useRunMultiIntentResearch,
} from "@/hooks/use-intent";

function neutralProviderText(value: string): string {
  return value
    .replace(/\bPerplexity\b/gi, "web search")
    .replace(/\bApollo\b/gi, "contact discovery provider");
}

const REQUIRED_EVENTS = [
  {key:"funding",label:"Funding"}, {key:"layoffs",label:"Layoffs"}, {key:"hiring",label:"Hiring by function"},
  {key:"branch_opening",label:"Branch openings"}, {key:"merger_acquisition",label:"Mergers & acquisitions"},
  {key:"cxo_appointment",label:"CXO appointments"}, {key:"partnership",label:"Partnerships"},
  {key:"quarterly_financial",label:"Quarterly financial outcomes"}, {key:"technology_integration",label:"Technology integrations"},
  {key:"capital_investment",label:"Capital investments"},
];

const RESEARCH_COUNTRIES = [
  "Global", "Australia", "Brazil", "Canada", "China", "France", "Germany", "India", "Indonesia", "Ireland",
  "Italy", "Japan", "Mexico", "Netherlands", "Singapore", "South Africa", "South Korea", "Spain",
  "Switzerland", "United Arab Emirates", "United Kingdom", "United States",
];

const RESEARCH_PROVIDERS = [
  { key: "perplexity", label: "Perplexity / Web Search", description: "Default for business, finance, hiring and tender news" },
  { key: "tavily", label: "Tavily News", description: "Recent news articles" },
  { key: "explorium", label: "Explorium Business Signals", description: "Structured company events" },
  { key: "newsapi", label: "NewsAPI.org", description: "Additional news coverage" },
] as const;
type ResearchProvider = typeof RESEARCH_PROVIDERS[number]["key"];

export function IntentResearchWorkflow({ clientId, audienceId, categoryIds, subcategoryIds, productId, accountIds, accountNames=[] }: { clientId?: number; audienceId?: number; categoryIds?: number[]; subcategoryIds?: number[]; productId?: number; accountIds?: number[]; accountNames?: string[] }) {
  const [seniority, setSeniority] = useState("director");
  const [functionName, setFunctionName] = useState("all");
  const [location, setLocation] = useState("");
  const [researchProviders, setResearchProviders] = useState<ResearchProvider[]>(["perplexity"]);
  const [researchCountry, setResearchCountry] = useState("");
  const [selectedEventTypes, setSelectedEventTypes] = useState<string[]>(REQUIRED_EVENTS.map(event => event.key));
  const [candidates, setCandidates] = useState<ContactDiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [discoveryRunId, setDiscoveryRunId] = useState<number | undefined>();
  const research = useIntentResearchSummary({ clientId, audienceId, accountIds: accountIds?.length ? accountIds.join(",") : undefined });
  const discover = useContactDiscovery();
  const approve = useApproveContactDiscovery();
  const runResearch = useRunMultiIntentResearch();
  const resumeResearch = useResumeIntentResearch();
  const taxonomy = research.data?.eventTaxonomy?.length ? research.data.eventTaxonomy : REQUIRED_EVENTS;
  useEffect(() => {
    const available = research.data?.availableProviders;
    if (!available?.length) return;
    setResearchProviders(current => {
      const valid = current.filter(provider => available.includes(provider));
      return valid.length ? valid : [available[0]];
    });
  }, [research.data?.availableProviders]);
  const providerUnavailable = research.isError || research.data?.providerConfigured === false || researchProviders.length === 0;
  const review = research.data?.reviewCounts || {};
  const latestRun = research.data?.latestRun;
  const progress = latestRun?.summary;
  const researchActive = (research.data?.activeRunCount ?? 0) > 0;

  const selectionText = useMemo(() => selected.length === 1 ? "1 candidate selected" : `${selected.length} candidates selected`, [selected.length]);
  const runDiscovery = () => discover.mutate({
    clientId, audienceId, accountIds,
    seniorities: seniority === "all" ? [] : [seniority],
    functions: functionName === "all" ? [] : [functionName],
    locations: location.trim() ? [location.trim()] : [],
  }, {
    onSuccess: result => {
      const found = result.candidates || [];
      setCandidates(found);
      setSelected(found.map(candidate => candidate.id));
      setDiscoveryRunId(result.runId);
    }
  });

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6" data-testid="intent-research-workflow">
      <Card className="shadow-xs border" data-testid="contact-discovery-panel">
        <CardHeader className="border-b bg-muted/20">
          <CardTitle className="text-base flex items-center gap-2"><UsersRound className="w-4 h-4 text-indigo-600" /> Contact discovery</CardTitle>
          <CardDescription>Find people for the selected audience, then approve only the contacts you want added.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          <div className={cn("rounded-md border p-3", accountIds?.length ? "border-indigo-200 bg-indigo-50" : "border-amber-200 bg-amber-50")}>
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">2. Research scope</p>
            <p className="mt-1 text-sm font-semibold">{accountIds?.length ? `${accountIds.length} selected account${accountIds.length===1?"":"s"}` : "No accounts selected"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{accountNames.length ? accountNames.join(", ") : "Select accounts in the research picker above. Public research will not run against an implicit or unknown account scope."}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Seniority</Label>
              <Select value={seniority} onValueChange={setSeniority}>
                <SelectTrigger data-testid="select-discovery-seniority"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">Any level</SelectItem><SelectItem value="manager">Manager</SelectItem><SelectItem value="director">Director</SelectItem><SelectItem value="vp">VP</SelectItem><SelectItem value="cxo">CXO</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Function</Label>
              <Select value={functionName} onValueChange={setFunctionName}>
                <SelectTrigger data-testid="select-discovery-function"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">Any function</SelectItem><SelectItem value="marketing">Marketing</SelectItem><SelectItem value="sales">Sales</SelectItem><SelectItem value="technology">Technology</SelectItem><SelectItem value="operations">Operations</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="discovery-location">Location</Label>
              <Input id="discovery-location" data-testid="input-discovery-location" value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Mumbai" />
            </div>
          </div>
          <Button data-testid="button-run-contact-discovery" className="bg-indigo-600 hover:bg-indigo-700" onClick={runDiscovery} disabled={discover.isPending || !accountIds?.length}>
            {discover.isPending ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <SearchCheck className="mr-2 w-4 h-4" />} Run discovery
          </Button>
          <div data-testid="status-contact-discovery-source" className="text-sm text-slate-700 bg-slate-50 border rounded p-3">
            Discovery checks existing database contacts first. An external contact provider is used only when no matching database contacts are found.
            {research.data?.contactProviderConfigured === false && <span className="ml-1 text-amber-700">External contact discovery is not connected. <Link href="/settings" className="font-semibold underline">Open integrations</Link></span>}
          </div>
          {discover.isSuccess && <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-3" data-testid="status-contact-discovery-result">
            {neutralProviderText(discover.data.message || `Found ${discover.data.candidates.length} contact${discover.data.candidates.length === 1 ? "" : "s"} from ${discover.data.providerUsed === "database" ? "the database" : "an external provider"}.`)}
          </div>}
          {(discover.isError || (discover.data?.providerConfigured === false && candidates.length === 0)) && <p data-testid="status-contact-discovery-provider-unavailable" className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">Contact enrichment is unavailable: {neutralProviderText(discover.data?.message || discover.error?.message || "A contact discovery provider is not configured.")}</p>}
          {candidates.length > 0 && <div className="border rounded-lg overflow-hidden" data-testid="contact-discovery-candidates">
            <div className="max-h-56 overflow-auto divide-y">
              {candidates.map(candidate => <label key={candidate.id} className="flex gap-3 p-3 hover:bg-slate-50 cursor-pointer">
                <input data-testid={`checkbox-discovery-candidate-${candidate.id}`} type="checkbox" checked={selected.includes(candidate.id)} onChange={e => setSelected(e.target.checked ? [...selected, candidate.id] : selected.filter(id => id !== candidate.id))} />
                <span className="flex-1 min-w-0"><span className="block text-sm font-semibold">{candidate.name}</span><span className="block text-xs text-muted-foreground">{candidate.title || "Title unavailable"} · {candidate.companyName || "Account"} {candidate.location ? `· ${candidate.location}` : ""}</span></span>
                 <span className="text-right text-[11px]"><span className="block font-semibold text-emerald-700">{candidate.confidence ?? 0}% confidence</span><span className="text-muted-foreground">{neutralProviderText(candidate.source || "Provider")}</span></span>
              </label>)}
            </div>
            <div className="p-3 border-t bg-muted/20 flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{selectionText}</span><Button data-testid="button-approve-discovered-contacts" size="sm" onClick={() => discoveryRunId && approve.mutate({ runId: discoveryRunId, candidateIds: selected })} disabled={!selected.length || !discoveryRunId || approve.isPending}>{approve.isPending && <Loader2 className="mr-2 w-3 h-3 animate-spin" />}Approve contacts</Button></div>
          </div>}
          {!discover.isPending && candidates.length === 0 && <p className="text-xs text-muted-foreground">Choose criteria and run discovery. Provider candidates remain reviewable before they enter contacts.</p>}
        </CardContent>
      </Card>

      <Card className="shadow-xs border" data-testid="public-signal-research-panel">
        <CardHeader className="border-b bg-muted/20"><CardTitle className="text-base flex items-center gap-2"><Activity className="w-4 h-4 text-emerald-600" /> Public-signal research</CardTitle><CardDescription>Verifiable company events are collected separately from uploaded and Kaboom evidence.</CardDescription></CardHeader>
        <CardContent className="p-4 space-y-4">
          <div className="space-y-2" data-testid="event-taxonomy">
            <div className="flex items-center justify-between gap-3">
              <Label>Intent signals to research</Label>
              <div className="flex gap-2 text-xs"><button type="button" className="font-semibold text-indigo-600 hover:underline" onClick={() => setSelectedEventTypes(taxonomy.map(event => event.key))}>Select all</button><button type="button" className="font-semibold text-slate-500 hover:underline" onClick={() => setSelectedEventTypes([])}>Clear</button></div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {taxonomy.map(event => {
                const selected=selectedEventTypes.includes(event.key);
                return <button type="button" aria-pressed={selected} key={event.key} onClick={() => setSelectedEventTypes(current => selected ? current.filter(key => key!==event.key) : [...current,event.key])} className={cn("text-[11px] px-2 py-1 rounded-full border transition-colors",selected?"border-indigo-300 bg-indigo-50 text-indigo-700 font-semibold":"bg-white text-slate-500 hover:bg-slate-50")}>{event.label}</button>;
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">{selectedEventTypes.length} of {taxonomy.length} signal types selected. Only these topics will be researched.</p>
          </div>
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2"><Label>Research sources</Label><span className="text-[11px] text-muted-foreground">{researchProviders.length} selected</span></div>
                <div className="grid gap-2" data-testid="research-source-options">
                  {RESEARCH_PROVIDERS.map(provider => {
                    const available = research.data?.availableProviders?.includes(provider.key) ?? false;
                    const selected = researchProviders.includes(provider.key);
                    return <button
                      key={provider.key}
                      type="button"
                      data-testid={`button-research-source-${provider.key}`}
                      aria-pressed={selected}
                      disabled={!available}
                      onClick={() => setResearchProviders(current => selected ? current.filter(item => item !== provider.key) : [...current, provider.key])}
                      className={cn("flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors", selected ? "border-indigo-300 bg-indigo-50" : "bg-white hover:bg-slate-50", !available && "cursor-not-allowed opacity-45")}
                    >
                      <span className={cn("flex h-4 w-4 items-center justify-center rounded border text-[10px] font-black", selected ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300")}>{selected ? "✓" : ""}</span>
                      <span><span className="block text-xs font-semibold">{provider.label}</span><span className="block text-[10px] text-muted-foreground">{available ? provider.description : "Not connected"}</span></span>
                    </button>;
                  })}
                </div>
              </div>
             <div className="space-y-1.5"><Label>Research country</Label><Select value={researchCountry} onValueChange={setResearchCountry}><SelectTrigger data-testid="select-public-research-country"><SelectValue placeholder="Select a country" /></SelectTrigger><SelectContent>{RESEARCH_COUNTRIES.map(country => <SelectItem key={country} value={country}>{country}</SelectItem>)}</SelectContent></Select><p className="text-[11px] text-muted-foreground">Choose the market whose news, hiring, launches, and financial reporting should be prioritized.</p></div>
           </div>
           <div className="space-y-1"><p className="text-[11px] text-muted-foreground">Research runs dedicated searches for latest news, hiring, product launches, and financial reports for every selected brand over the last 3 months. New source URLs are retained while exact repeats are deduplicated.</p><p className="text-[11px] text-muted-foreground">Analysis: {research.data?.analysisConfigured ? research.data.analysisProvider === "openai" ? "OpenAI configured" : "Replit OpenAI configured" : "unavailable"}</p></div>
          {providerUnavailable ? <div data-testid="status-research-provider-unavailable" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">The selected provider is not connected. You can still review uploaded evidence and Kaboom activity. <Link href="/settings" className="ml-1 font-semibold underline">Open integrations</Link></div> :
            <div><div className="grid grid-cols-3 gap-3 text-center"><div><p className="text-xl font-black">{review.pending ?? 0}</p><p className="text-[10px] uppercase text-muted-foreground">Evidence awaiting review</p></div><div><p className="text-xl font-black">{review.approved ?? 0}</p><p className="text-[10px] uppercase text-muted-foreground">Approved signals</p></div><div><p className="text-xl font-black">{review.rejected ?? 0}</p><p className="text-[10px] uppercase text-muted-foreground">Rejected</p></div></div><p className="mt-2 text-[11px] text-center text-muted-foreground">Counts are limited to the currently selected accounts. Pending evidence does not affect intent scores or Hot/Warm status.</p></div>}
          <div className="rounded-md border p-3 space-y-3 text-xs text-muted-foreground" data-testid="status-research-run">
              <div><span className="font-semibold text-foreground">Latest source run: </span>{latestRun ? `${latestRun.status} via ${neutralProviderText(latestRun.provider || "provider")}${latestRun.summary?.request?.country ? ` · ${latestRun.summary.request.country}` : ""}` : "No research run has been started for this scope."}{researchActive ? ` · ${research.data?.activeRunCount} source run${research.data?.activeRunCount===1?"":"s"} active` : ""}</div>
            {latestRun && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded bg-muted/40 p-2"><p className="text-base font-black text-foreground">{progress?.accountsCompleted ?? 0}</p><p>Completed</p></div>
              <div className="rounded bg-muted/40 p-2"><p className="text-base font-black text-foreground">{progress?.accountsRemaining ?? 0}</p><p>Remaining</p></div>
              <div className="rounded bg-muted/40 p-2"><p className="text-base font-black text-red-700">{progress?.accountsFailed ?? 0}</p><p>Failed</p></div>
              <div className="rounded bg-muted/40 p-2"><p className="text-base font-black text-indigo-700">{progress?.accountsInterpreted ?? 0}</p><p>Interpreted</p></div>
            </div>}
            {latestRun && <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>Confirmed requests: <strong className="text-foreground">{progress?.requests ?? 0}</strong></span>
              <span>Request attempts: <strong className="text-foreground">{progress?.requestAttempts ?? progress?.requests ?? 0}</strong></span>
              <span>Billable cost units: <strong className="text-foreground">{progress?.cost?.confirmedBillableRequests ?? progress?.requests ?? 0}–{progress?.cost?.maximumBillableRequests ?? progress?.requestAttempts ?? progress?.requests ?? 0}</strong></span>
              <span>Fetched: <strong className="text-foreground">{progress?.recordsFetched ?? 0}</strong></span>
              <span>Evidence added: <strong className="text-foreground">{progress?.inserted ?? 0}</strong></span>
            </div>}
            {(latestRun?.status === "failed" || latestRun?.status === "partial") && <Button data-testid="button-resume-public-research" size="sm" variant="outline" onClick={() => resumeResearch.mutate(Number(latestRun.id))} disabled={resumeResearch.isPending}>{resumeResearch.isPending && <Loader2 className="mr-2 w-3 h-3 animate-spin" />}Resume failed accounts</Button>}
          </div>
            <Button data-testid="button-run-public-research" className="bg-indigo-600 hover:bg-indigo-700" onClick={() => runResearch.mutate({ providers: researchProviders, clientId, audienceId, accountIds, eventTypes:selectedEventTypes, country:researchCountry })} disabled={runResearch.isPending || researchActive || providerUnavailable || !accountIds?.length || !selectedEventTypes.length || !researchCountry}>{runResearch.isPending || researchActive ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <DatabaseZap className="mr-2 w-4 h-4" />}{researchActive?"Research running in the background":!researchProviders.length?"Select at least one source":!researchCountry?"Select a research country":!selectedEventTypes.length?"Select at least one signal type":accountIds?.length ? `Run ${researchProviders.length} source${researchProviders.length===1?"":"s"} for ${accountIds.length} account${accountIds.length===1?"":"s"}` : "Select accounts above to run research"}</Button>
           {runResearch.isError && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{neutralProviderText(runResearch.error.message)}</div>}
           {runResearch.isSuccess && <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">{runResearch.data.runs.length} research source run{runResearch.data.runs.length===1?"":"s"} started in the background. You can leave this page; progress and completed accounts are saved.{runResearch.data.failures.length ? <span className="block mt-1 text-amber-800">{runResearch.data.failures.map(failure => `${neutralProviderText(failure.provider)}: ${neutralProviderText(failure.message)}`).join(" · ")}</span> : null}</div>}
          {resumeResearch.isError && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{resumeResearch.error.message}</div>}
        </CardContent>
      </Card>

      <Card className="xl:col-span-2 shadow-xs border border-indigo-100 bg-indigo-50/30" data-testid="intent-response-import-card">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div><p className="text-sm font-semibold">Add questionnaire and lead-form evidence</p><p className="text-xs text-muted-foreground mt-1">Upload CSV, XLS, or XLSX exports, map respondent and answer columns, and attach every response to the selected product’s intent view.</p></div>
          <Button asChild className="shrink-0 bg-indigo-600 hover:bg-indigo-700"><Link href="/intent/ingest"><Upload className="mr-2 h-4 w-4" />Upload responses</Link></Button>
        </CardContent>
      </Card>
    </div>
  );
}