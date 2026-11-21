import { useState, useMemo, useRef, useEffect } from "react";
import RespondentRouteForm, { type RespondentSequence } from "@/components/intent/RespondentRouteForm";
import MultipleDriveFolders from "@/components/intent/MultipleDriveFolders";
import { Link, useLocation, useSearch } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import {
  useIntentInboundSources,
  useCreateIntentInboundSource,
  useUpdateIntentInboundSource,
  useSyncIntentInboundFolder,
  useIntentInboundAccounts,
  useIntentInboundRoutingRules,
  useRouteInboundRespondent,
  useIntentInboundSourcePreview,
  useIntentScopeOptions,
  useIntentInboundDashboard,
  useInboundCategoryRules,
  useSaveInboundCategoryRules,
  IntentInboundAccount,
  IntentInboundMappingTarget,
  IntentInboundSource
} from "@/hooks/use-intent";
import { IntentInboundRouting, findNoCategoryRoute } from "@/components/intent/IntentInboundRouting";
import { InboundResponseDialog } from "@/components/intent/InboundResponseDialog";
import { InboundMetricsDrilldown, type InboundMetric } from "@/components/intent/InboundMetricsDrilldown";
import { AddInboundAccountDialog } from "@/components/intent/AddInboundAccountDialog";
import { TrackedContactLink } from "@/components/intent/TrackedContactLink";
import { AnonymousSessionReview } from "@/components/intent/AnonymousSessionReview";
import { AccountIntelligenceOverview, MonitoredAccountsSection, PriorityAccountsSection, useMonitoredAccounts } from "./account-intelligence-overview";
import { downloadInboundAccountsCsv } from "./export-inbound-accounts";
import { useRemoveManualInboundAccount } from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import DemoEngagementHistory from "@/components/demo-engagement/DemoEngagementHistory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Inbox,
  Search,
  Settings,
  RefreshCw,
  FolderSync,
  AlertCircle,
  Building2,
  Calendar,
  MessageSquare,
  User,
  ShoppingBag,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  FileText,
  CheckCircle2,
  Clock,
  ArrowRight,
  Star,
  ListChecks,
  PhoneCall,
  Plus,
  Pencil,
  Trash2,
  Download
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/contexts/AuthContext";
import "./inbound-accounts.css";

const INBOUND_THEME = {
  primary: "text-sky-600",
  bg: "bg-sky-50",
  border: "border-sky-100",
  hover: "hover:bg-sky-100",
  active: "active:bg-sky-200",
  focus: "focus:ring-sky-500",
  gradient: "from-sky-600 to-blue-500",
  shadow: "shadow-sky-500/20",
  hot: {
    bg: "bg-rose-50",
    text: "text-rose-700",
    border: "border-rose-200",
    icon: "text-rose-500"
  },
  warm: {
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    icon: "text-amber-500"
  }
};

function CohortSummaryCard({ icon, title, desc, count, onClick }: { icon: string, title: string, desc: string, count: number, onClick:()=>void }) {
  return (
    <button type="button" onClick={onClick} className="inbound-cohort-card w-full text-left bg-white rounded-xl border border-slate-200/60 shadow-sm p-4 flex items-center justify-between hover:border-sky-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 transition-all">
      <div className="flex items-center gap-4">
        <div className="cohort-letter w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center font-black text-sm border border-sky-100 shadow-sm shrink-0">
          {icon}
        </div>
        <div>
          <div className="font-bold text-slate-900 text-sm">{title}</div>
          <div className="text-xs font-medium text-slate-500 mt-0.5">{desc}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 pl-4">
        <span className="text-2xl font-black text-slate-900 tracking-tight">{count}</span>
        <ChevronRight className="w-4 h-4 text-slate-300" />
      </div>
    </button>
  );
}

function CategoryMatchingEditor() {
  const {user}=useAuthContext();
  const {data,isLoading,isError}=useInboundCategoryRules();
  const save=useSaveInboundCategoryRules();
  const {toast}=useToast();
  const [draft,setDraft]=useState<Record<string,string>|null>(null);
  const [fallback,setFallback]=useState<boolean|null>(null);
  const categories=data?.categories??[];
  const values=draft??Object.fromEntries(categories.map(category=>[
    category,data?.rules.find(rule=>rule.categoryName===category)?.terms.join("\n")??"",
  ]));
  const dirty=draft!==null||fallback!==null;
  const submit=()=>{
    const rules=categories.map(category=>({
      categoryName:category,
      terms:values[category].split(/\r?\n/).map(term=>term.trim()).filter(Boolean),
    }));
    save.mutate({rules,useBuiltin:fallback??data?.useBuiltin??true},{
      onSuccess:()=>{setDraft(null);setFallback(null);toast({title:"Category matching rules saved",description:"Existing and future answers now use these terms. Past enrollments are unchanged."});},
      onError:error=>toast({title:"Could not save matching rules",description:error.message,variant:"destructive"}),
    });
  };
  return <div className="mt-5 border-t border-slate-100 pt-5">
    <h3 className="text-sm font-bold text-slate-900">Reusable answer matching</h3>
    <p className="mt-1 text-xs text-slate-500">Add one phrase per line. Matching uses whole words or phrases, regardless of capitalization. These rules take priority over built-in product matches; individual response corrections take priority over both. Routing of already enrolled respondents is not changed.</p>
    {isLoading&&<p className="mt-3 text-sm text-slate-500">Loading matching rules…</p>}
    {isError&&<p role="alert" className="mt-3 text-sm text-rose-700">Matching rules could not be loaded.</p>}
    {!!data&&<div className="mt-4 grid gap-4 md:grid-cols-2">
      {categories.map(category=><div key={category}>
        <Label htmlFor={`terms-${category}`} className="text-xs font-semibold">{category}</Label>
        <Textarea id={`terms-${category}`} className="mt-1 min-h-24 text-sm" placeholder="One matching phrase per line"
          value={values[category]??""} disabled={user?.role!=="admin"||save.isPending}
          onChange={event=>setDraft({...values,[category]:event.target.value})}/>
      </div>)}
    </div>}
    {!!data&&<label className="mt-4 flex items-center gap-3 text-xs text-slate-700">
      <Switch checked={fallback??data.useBuiltin} disabled={user?.role!=="admin"||save.isPending}
        onCheckedChange={checked=>setFallback(checked)}/>
      Use built-in product matches when no saved phrase matches
    </label>}
    {user?.role==="admin"&&!!data&&<div className="mt-4 flex items-center gap-3">
      <Button size="sm" onClick={submit} disabled={!dirty||save.isPending}>{save.isPending?"Saving…":"Save matching rules"}</Button>
      {dirty&&<Button size="sm" variant="outline" disabled={save.isPending} onClick={()=>{setDraft(null);setFallback(null);}}>Discard changes</Button>}
    </div>}
  </div>;
}

export default function IntentInboundAccountsPage() {
  const [location, setLocation] = useLocation();
  const {toast} = useToast();
  const searchParams = new URLSearchParams(window.location.search);
  const clientIdParam = searchParams.get("client") ? Number(searchParams.get("client")) : undefined;

  const [search, setSearch] = useState("");
  const [exportingAccounts, setExportingAccounts] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [classification, setClassification] = useState<"all"|"hot"|"warm"|"cold"|"manual">("all");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  // New controlled filters
  const [dateRange, setDateRange] = useState<number | undefined>(undefined);
  const [formType, setFormType] = useState<"all" | "lead_form" | "event_feedback" | "monitoring">("all");
  const [category, setCategory] = useState<string>("all");
  const [product, setProduct] = useState<string>("all");
  const [cohortTab, setCohortTab] = useState<"categorized"|"not-categorized">("categorized");
  const [cohortStatus, setCohortStatus] = useState<"all"|"hot"|"warm"|"cold">("all");
  const [cohortCategory, setCohortCategory] = useState("all");

  const [reviewAccountId, setReviewAccountId] = useState<number | null>(null);
  const [activeMetric, setActiveMetric] = useState<InboundMetric | null>(null);
  const [addAccountOpen,setAddAccountOpen]=useState(false);
  const [editAccount,setEditAccount]=useState<IntentInboundAccount|null>(null);
  const {user}=useAuthContext();

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: sourceData, isLoading: sourceLoading, isError: sourcesError, refetch: retrySources } = useIntentInboundSources();
  const sources = sourceData?.sources ?? [];
  const googleDriveConnected = sourceData?.googleDriveConnected ?? false;
  const [viewSourceId, setViewSourceId] = useState<number | undefined>(undefined);
  const [editSourceId, setEditSourceId] = useState<number | null>(null);
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const source = sources.find(item => item.id === viewSourceId) ?? null;
  const editSource = sources.find(item => item.id === editSourceId) ?? null;

  const dashboardFilters = {
    sourceId: viewSourceId,
    dateRange,
    formType: formType === "lead_form" || formType === "event_feedback" ? formType : undefined,
    category: category === "all" ? undefined : category,
    product: product === "all" ? undefined : product,
  };
  const monitoringOnly = formType === "monitoring";
  const { data: dashboardData, isLoading: dashboardLoading, isError: dashboardError, error: dashboardFailure, refetch: retryDashboard } = useIntentInboundDashboard(dashboardFilters, !monitoringOnly);
  const monitoredSummary = useMonitoredAccounts();
  // Cohort tabs have independent filters; account-list filters must not hide cohorts here.
  const {data: cohortData,isLoading: cohortsLoading,isError: cohortsError}=useIntentInboundDashboard({
    sourceId:viewSourceId,dateRange,formType:formType==="lead_form"||formType==="event_feedback"?formType:undefined,
  }, !monitoringOnly);

  const { data: accountsData, isLoading: accountsLoading, isError: accountsError, refetch: retryAccounts } = useIntentInboundAccounts({
    sourceId: viewSourceId,
    page,
    pageSize,
    search: debouncedSearch,
    classification: classification !== "all" ? classification : undefined,
    formType: formType === "lead_form" || formType === "event_feedback" ? formType : undefined,
    dateRange,
    category: category === "all" ? undefined : category,
    product: product === "all" ? undefined : product
  }, !monitoringOnly);

  const { data: routingOptions } = useIntentInboundRoutingRules(undefined,true);

  const dashboardSummary = dashboardData?.summary || { accounts: 0, hot: 0, warm: 0, cold: 0, contacts: 0 };
  const cohorts = cohortData?.cohorts || [];
  const noCategoryCount = new Set(cohorts.filter(cohort=>cohort.categoryName==="No Category")
    .flatMap(cohort=>cohort.accounts.map(account=>account.id))).size;
  const uncategorized=(name:string)=>name==="No Category"||name==="Needs categorization";
  const visibleCohorts=cohorts.filter(cohort=>
    (cohortTab==="not-categorized" ? uncategorized(cohort.categoryName) : !uncategorized(cohort.categoryName))
    &&(cohortStatus==="all"||cohort.classification===cohortStatus)
    &&(cohortTab==="not-categorized"||cohortCategory==="all"||cohort.categoryName===cohortCategory));
  const options = dashboardData?.options || { categories: [], products: [] };

  const accounts = accountsData?.accounts || [];
  const total = accountsData?.total || 0;
  const exportAccounts = async () => {
    setExportingAccounts(true);
    try {
      const count = await downloadInboundAccountsCsv({
        sourceId: viewSourceId,
        search: debouncedSearch,
        classification: classification === "all" ? undefined : classification,
        formType: formType === "lead_form" || formType === "event_feedback" ? formType : undefined,
        dateRange,
        category: category === "all" ? undefined : category,
        product: product === "all" ? undefined : product,
      });
      toast({title: "Accounts exported", description: `${count} matching account${count === 1 ? "" : "s"} downloaded as CSV.`});
    } catch (error) {
      toast({title: "Could not export accounts", description: error instanceof Error ? error.message : "Export failed", variant: "destructive"});
    } finally {
      setExportingAccounts(false);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  };

  const handleClassificationChange = (val: string) => {
    setClassification(val as "all"|"hot"|"warm"|"cold"|"manual");
    setPage(1);
  };
  const showSavedAccount=(name:string)=>{
    setSearch(name);setDebouncedSearch(name);setClassification("all");setFormType("all");
    setCategory("all");setProduct("all");setDateRange(undefined);setPage(1);
  };

  return (
    <div className="kaboom-inbound flex flex-col h-full min-h-[100dvh] overflow-hidden">
      <div className="inbound-scroll flex-1 overflow-auto px-4 py-7 sm:px-7 md:px-10 md:py-10">
        <div className="inbound-wrap mx-auto space-y-9 md:space-y-11">

          {/* Header */}
          <header className="inbound-header">
            <div>
              <div className="inbound-kicker">KABOOM / Inbound intelligence</div>
              <h1>Autonomous GTM OS<span className="text-[#c76a50]">.</span></h1>
              <p>One view for inbound responses, monitored accounts, and the decisions they support.</p>
            </div>
            <div className="inbound-header-actions">
              {user&&<Button className="shrink-0" onClick={()=>setAddAccountOpen(true)} data-testid="button-add-inbound-account"><Plus className="mr-2 h-4 w-4"/>Add account</Button>}
              <div className="inbound-sync-status" data-testid="status-drive-source">
                <div className={cn("w-1.5 h-1.5 rounded-full",source?.enabled&&source.lastSyncStatus==="completed"?"bg-sky-500":"bg-amber-500")}></div>
                {source ? `${source.name}: ${!source.enabled ? "Automatic sync paused" : source.lastSyncStatus === "failed" ? "Sync failed" : source.lastSyncedAt ? `synced ${formatDistanceToNow(new Date(source.lastSyncedAt),{addSuffix:true})}` : "not synced"}` : `${sources.length} Drive source${sources.length===1?"":"s"} configured`}
              </div>
              {user?.role==="admin" && <Button size="sm" variant="outline" onClick={()=>{setEditSourceId(null);setSourceSheetOpen(true);}} data-testid="button-add-drive-source"><Plus className="mr-2 h-4 w-4"/>Add Drive folder</Button>}
              {user?.role==="admin" && <SourceConfigSheet source={editSource} googleDriveConnected={googleDriveConnected} clientId={clientIdParam} open={sourceSheetOpen} onOpenChange={setSourceSheetOpen} onSaved={saved=>{setViewSourceId(saved.id);setEditSourceId(saved.id);setDateRange(undefined);setFormType("all");setCategory("all");setProduct("all");setPage(1);setActiveMetric(null);setReviewAccountId(null);}} />}
            </div>
          </header>
          {sourcesError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Could not load Drive folders. <button type="button" className="underline font-semibold" onClick={()=>retrySources()}>Retry</button></div>}
          {sourceLoading && <div className="h-20 animate-pulse rounded-xl bg-slate-100" aria-label="Loading Drive folders" />}
          {!sourceLoading && !sourcesError && <section className="rounded-xl border border-slate-200/70 bg-white p-4 sm:p-5 shadow-sm" aria-label="Drive folders">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3"><h2 className="text-sm font-bold text-slate-900">Drive folders</h2><span className="text-xs text-slate-500">Each folder has its own mappings and sync history.</span></div>
            {!sources.length ? <p className="text-sm text-slate-500">No Drive folders configured yet. Add one to bring lead forms or event feedback into this view.</p> : <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {sources.map(item=><div key={item.id} className={cn("rounded-lg border p-3 min-w-0",viewSourceId===item.id?"border-sky-300 bg-sky-50/60":"border-slate-200 bg-slate-50/40")} data-testid={`drive-source-${item.id}`}>
                <div className="flex justify-between gap-2"><div className="min-w-0"><div className="font-bold text-sm text-slate-900 truncate">{item.name}</div><div className="text-xs text-slate-500">{item.formType==="lead_form"?"Lead form":"Event feedback"}</div></div><span className={cn("text-[11px] font-semibold shrink-0",!item.enabled?"text-amber-700":item.lastSyncStatus==="failed"?"text-rose-700":"text-sky-700")}>{!item.enabled?"Paused":item.lastSyncStatus==="failed"?"Failed":item.lastSyncStatus==="completed"?"Synced":item.lastSyncStatus==="running"?"Syncing":"Not synced"}</span></div>
                <p className="text-xs text-slate-500 mt-2">{item.lastSyncedAt?`Last sync ${formatDistanceToNow(new Date(item.lastSyncedAt),{addSuffix:true})}`:"Never synced"}</p>
                {item.lastSyncSummary?.errors?.length ? <p role="alert" className="text-xs text-rose-700 mt-1 line-clamp-2">{item.lastSyncSummary.errors[0]}</p> : null}
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Button size="sm" variant={viewSourceId===item.id?"default":"outline"} onClick={()=>{setViewSourceId(item.id);setDateRange(undefined);setFormType("all");setCategory("all");setProduct("all");setPage(1);setActiveMetric(null);setReviewAccountId(null);}} data-testid={`button-view-source-${item.id}`}>View</Button>
                  {user?.role==="admin" && <Button size="sm" variant="outline" onClick={()=>{setEditSourceId(item.id);setSourceSheetOpen(true);}} data-testid={`button-edit-source-${item.id}`}><Settings className="h-3.5 w-3.5 mr-1"/>Edit</Button>}
                  {user?.role==="admin" && <SyncButton source={item} googleDriveConnected={googleDriveConnected} />}
                </div>
              </div>)}
            </div>}
          </section>}

          <AccountIntelligenceOverview />

          {/* Filters */}
          <section className="inbound-filters-panel" aria-label="View filters">
          <div className="inbound-section-label"><h2>Scope this view</h2><span>Choose the evidence you want to inspect</span></div>
           <div className={cn("inbound-filter-grid grid grid-cols-1 gap-3", monitoringOnly ? "sm:grid-cols-1" : "sm:grid-cols-2 lg:grid-cols-5")}>
             {!monitoringOnly && <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-3 hover:border-sky-200 transition-colors">
               <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block px-2">Drive folder</label>
               <Select value={viewSourceId===undefined?"all":String(viewSourceId)} onValueChange={v=>{setViewSourceId(v==="all"?undefined:Number(v));setFormType("all");setCategory("all");setProduct("all");setPage(1);setActiveMetric(null);setReviewAccountId(null);}}>
                 <SelectTrigger className="border-0 shadow-none p-0 h-auto font-bold text-slate-900 focus:ring-0 px-2 bg-transparent" data-testid="select-drive-source"><SelectValue placeholder="All Drive sources combined"/></SelectTrigger>
                 <SelectContent><SelectItem value="all">All Drive sources combined</SelectItem>{sources.map(item=><SelectItem key={item.id} value={String(item.id)}>{item.name}</SelectItem>)}</SelectContent>
               </Select>
             </div>}
            {!monitoringOnly && (
            <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-3 hover:border-sky-200 transition-colors">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block px-2">Date Range</label>
               <Select value={dateRange ? String(dateRange) : "all"} onValueChange={v => {setDateRange(v === "all" ? undefined : Number(v));setPage(1);}}>
                <SelectTrigger className="border-0 shadow-none p-0 h-auto font-bold text-slate-900 focus:ring-0 px-2 bg-transparent hover:bg-transparent">
                  <SelectValue placeholder="Select date range" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            )}
            <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-3 hover:border-sky-200 transition-colors">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block px-2">Response type</label>
               <Select value={formType} onValueChange={v=>{setFormType(v as typeof formType);if(v==="monitoring"){setViewSourceId(undefined);setCategory("all");setProduct("all");}setPage(1);setActiveMetric(null);}}>
                <SelectTrigger className="border-0 shadow-none p-0 h-auto font-bold text-slate-900 focus:ring-0 px-2 bg-transparent hover:bg-transparent">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                   <SelectItem value="lead_form" disabled={!!source && source.formType!=="lead_form"}>Lead form</SelectItem>
                   <SelectItem value="event_feedback" disabled={!!source && source.formType!=="event_feedback"}>Event feedback</SelectItem>
                  <SelectItem value="monitoring">Monitoring</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!monitoringOnly && (<>
            <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-3 hover:border-sky-200 transition-colors">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block px-2">Category</label>
               <Select value={category} onValueChange={v=>{setCategory(v);setProduct("all");setPage(1);}}>
                <SelectTrigger className="border-0 shadow-none p-0 h-auto font-bold text-slate-900 focus:ring-0 px-2 bg-transparent hover:bg-transparent">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {options?.categories?.map((c: string) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-3 hover:border-sky-200 transition-colors">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block px-2">Product</label>
               <Select value={product} onValueChange={v=>{setProduct(v);setPage(1);}}>
                <SelectTrigger className="border-0 shadow-none p-0 h-auto font-bold text-slate-900 focus:ring-0 px-2 bg-transparent hover:bg-transparent">
                  <SelectValue placeholder="All products" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  {options?.products?.filter((p: any) => category === "all" || p.categoryName === category).map((p: any) => (
                    <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            </>)}
          </div>
          </section>

           {monitoringOnly ? (
             <div className="space-y-4">
               <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-5">
                 <h2 className="font-bold text-slate-900">Monitoring accounts</h2>
                 <p className="mt-1 text-sm text-slate-600">Accounts reached by research, including those with no form response. Form categories, products and lead classifications do not apply to this list.</p>
                 <p className="mt-3 text-2xl font-black text-indigo-800">{monitoredSummary.isLoading || monitoredSummary.isError ? "—" : monitoredSummary.data?.total.toLocaleString() ?? "0"} <span className="text-sm font-medium">researched accounts</span></p>
               </div>
               <MonitoredAccountsSection />
             </div>
           ) : (<>
           {dashboardError&&<p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
             {dashboardFailure?.message.includes("intent_inbound_submissions_classification_check")
               ? "The account overview cannot load because the database does not permit Cold classifications. An administrator must update the production classification constraint."
               : "The account overview could not load."}{" "}
             <button type="button" className="font-semibold underline" onClick={() => retryDashboard()}>Retry</button>
           </p>}
            <div className="inbound-section-heading">
              <h2>Inbound source breakdown</h2>
              <p className="mt-1 text-xs text-slate-500">The filters above apply to these inbound metrics, cohorts and response details. Monitored accounts and qualified opportunities are independent of the form filters.</p>
           </div>
           <div data-testid="inbound-active-scope" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm">
             <div>
               <p className="font-semibold text-slate-900">Showing: {source?.name ?? "All Drive folders"} · {dateRange ? `Last ${dateRange} days` : "All time"}{formType==="lead_form" ? " · Lead forms" : formType==="event_feedback" ? " · Event feedback" : ""}</p>
               <p className="mt-1 text-xs text-slate-600">Hot / Warm / Cold tiles count accounts, not contacts. An account with both Hot and Warm respondents is counted as Hot.</p>
             </div>
             {(viewSourceId!==undefined || dateRange!==undefined || formType!=="all" || category!=="all" || product!=="all") &&
               <Button size="sm" variant="outline" onClick={()=>{setViewSourceId(undefined);setDateRange(undefined);setFormType("all");setCategory("all");setProduct("all");setClassification("all");setSearch("");setDebouncedSearch("");setPage(1);setActiveMetric(null);setReviewAccountId(null);}}>Show all folders &amp; dates</Button>}
           </div>
           {/* Metrics */}
             <div className="inbound-metric-grid">
             <button type="button" onClick={() => setActiveMetric("accounts")} disabled={dashboardLoading || dashboardError}
               aria-label="View all accounts" data-testid="metric-inbound-accounts"
               className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:hover:bg-white">
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Inbound accounts</div>
               <div className="text-4xl font-black text-slate-900 tracking-tight">{dashboardLoading||dashboardError?"—":dashboardSummary.accounts}</div>
               <div className="mt-2 text-xs font-medium text-sky-700">View accounts →</div>
             </button>
             <button type="button" onClick={() => setActiveMetric("hot")} disabled={dashboardLoading || dashboardError}
               aria-label="View hot accounts" data-testid="metric-inbound-hot"
               className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:hover:bg-white">
              <div className="absolute top-0 left-0 right-0 h-1 bg-rose-400"></div>
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Hot accounts</div>
               <div className="text-4xl font-black text-slate-900 tracking-tight">{dashboardLoading||dashboardError?"—":dashboardSummary.hot}</div>
               <div className="mt-2 text-xs font-medium text-sky-700">View hot accounts →</div>
             </button>
             <button type="button" onClick={() => setActiveMetric("warm")} disabled={dashboardLoading || dashboardError}
               aria-label="View warm accounts" data-testid="metric-inbound-warm"
               className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:hover:bg-white">
              <div className="absolute top-0 left-0 right-0 h-1 bg-amber-400"></div>
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Warm accounts</div>
               <div className="text-4xl font-black text-slate-900 tracking-tight">{dashboardLoading||dashboardError?"—":dashboardSummary.warm}</div>
               <div className="mt-2 text-xs font-medium text-sky-700">View warm accounts →</div>
             </button>
              <button type="button" onClick={() => setActiveMetric("cold")} disabled={dashboardLoading || dashboardError}
                aria-label="View cold accounts" data-testid="metric-inbound-cold"
                className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:hover:bg-white">
               <div className="absolute top-0 left-0 right-0 h-1 bg-slate-400"></div>
               <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Cold accounts</div>
                <div className="text-4xl font-black text-slate-900 tracking-tight">{dashboardLoading||dashboardError?"—":dashboardSummary.cold}</div>
                <div className="mt-2 text-xs font-medium text-sky-700">View cold accounts →</div>
              </button>
             <button type="button" onClick={() => setActiveMetric("contacts")} disabled={dashboardLoading || dashboardError}
               aria-label="View all contacts" data-testid="metric-inbound-contacts"
               className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 disabled:cursor-default disabled:hover:bg-white">
              <div className="absolute top-0 left-0 right-0 h-1 bg-sky-400"></div>
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Contacts</div>
               <div className="text-4xl font-black text-slate-900 tracking-tight">{dashboardLoading||dashboardError?"—":dashboardSummary.contacts}</div>
               <div className="mt-2 text-xs font-medium text-sky-700">View contacts →</div>
             </button>
              <a href="#monitored-accounts"
                aria-label="View accounts with research insights" data-testid="metric-monitored-accounts"
                className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-5 relative overflow-hidden text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
                <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-400"></div>
                <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Accounts with research insights</div>
                <div className="text-4xl font-black text-slate-900 tracking-tight">{monitoredSummary.isLoading || monitoredSummary.isError ? "—" : monitoredSummary.data?.total ?? 0}</div>
                <div className="mt-2 text-xs font-medium text-indigo-700">News + analysis + recommendations →</div>
              </a>
          </div>

          {/* Account Cohorts */}
           <div>
             <div className="inbound-section-heading mb-5">
               <h2>Account cohorts</h2>
                <p className="text-sm font-medium text-slate-500">Summary cards count each account once, at its highest status across responses. Category cohorts group responses by their own status, so an account can appear in both Hot and Warm. Routed, Pending, and Failed count responses, not accounts.</p>
            </div>
             <div className="inbound-cohort-grid">
              <CohortSummaryCard
                icon="H"
                title="Ready for outreach"
                 desc="Selected product · purchase within 3 months"
                count={dashboardSummary.hot}
                 onClick={()=>{setClassification("hot");document.getElementById("inbound-account-list")?.scrollIntoView({behavior:"smooth"});}}
              />
              <CohortSummaryCard
                icon="W"
                title="Actively evaluating"
                 desc="Selected product · over 3 through 6 months"
                count={dashboardSummary.warm}
                 onClick={()=>{setClassification("warm");document.getElementById("inbound-account-list")?.scrollIntoView({behavior:"smooth"});}}
              />
              <CohortSummaryCard
                icon="M"
                 title="No Category"
                 desc="Responses without a product or category"
                 count={noCategoryCount}
                 onClick={()=>{setCohortTab("not-categorized");setCohortStatus("all");setCategory("No Category");setProduct("all");setPage(1);document.getElementById("inbound-category-cohorts")?.scrollIntoView({behavior:"smooth"});}}
              />
              <CohortSummaryCard
                icon="A"
                title="All accounts"
                desc="Full account view for the selected filters"
                count={dashboardSummary.accounts}
                 onClick={()=>{setClassification("all");setPage(1);document.getElementById("inbound-account-list")?.scrollIntoView({behavior:"smooth"});}}
              />
            </div>
          </div>

          {/* Account Details */}
          <div id="inbound-account-list">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="inbound-section-heading">
                <h2>Account details</h2>
                <p className="text-xs text-slate-500">Hot accounts are ready for sales follow-up.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={exportAccounts}
                disabled={exportingAccounts || accountsLoading || accountsError || !total || search !== debouncedSearch}
                data-testid="button-export-inbound-accounts">
                <Download className="mr-2 h-4 w-4" />
                {exportingAccounts ? "Preparing CSV…" : `Export ${total ? `${total} ` : ""}matching accounts`}
              </Button>
            </div>
            <div className="inbound-account-controls flex flex-col sm:flex-row items-center gap-4 bg-white p-2 rounded-xl border border-slate-200/60 shadow-sm mb-4">
              <div className="relative flex-1 min-w-[250px] w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search accounts..."
                  value={search}
                  onChange={handleSearchChange}
                  className="pl-9 bg-transparent border-transparent shadow-none focus-visible:ring-0 focus-visible:bg-slate-50 transition-colors h-10 w-full font-medium"
                  data-testid="input-search-inbound"
                />
              </div>
              <div className="w-px h-6 bg-slate-200 hidden sm:block" />
              <Select value={classification} onValueChange={handleClassificationChange}>
                <SelectTrigger className="w-full sm:w-[180px] border-transparent shadow-none bg-transparent hover:bg-slate-50 focus:ring-0 h-10 font-bold text-slate-700" data-testid="select-classification">
                  <SelectValue placeholder="All classifications" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classifications</SelectItem>
                  <SelectItem value="hot">Hot Only</SelectItem>
                  <SelectItem value="warm">Warm Only</SelectItem>
                  <SelectItem value="cold">Cold Only</SelectItem>
                  <SelectItem value="manual">Manually added</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {accountsLoading ? (
              <AccountsSkeleton />
            ) : accountsError ? (
              <div role="alert" className="rounded-xl border border-rose-200 bg-white p-6 text-sm text-rose-700">
                The account list could not be loaded. <button className="font-semibold underline" onClick={() => retryAccounts()}>Retry</button>
              </div>
            ) : accounts.length === 0 ? (
              <EmptyState hasSearch={debouncedSearch !== "" || classification !== "all" || category!=="all" || product!=="all" || formType!=="all" || viewSourceId!==undefined} googleDriveConnected={googleDriveConnected} hasSource={sources.length>0} />
            ) : (
              <div className="flex flex-col gap-3">
                {(classification!=="all"||formType!=="all"||category!=="all"||product!=="all"||dateRange)&&
                  <p className="text-xs font-medium text-slate-500">Filters select matching accounts. Each account card shows {viewSourceId===undefined?"all responses and respondents, including answers outside the current filter":"responses and respondents for the selected Drive folder"}.</p>}
                {accounts.map(account => (
                  <AccountCard key={`${viewSourceId??"all"}-${account.account_id}`} account={account} sourceId={viewSourceId} onEdit={()=>setEditAccount(account)} onRemoved={()=>{
                    if(accounts.length===1&&page>1)setPage(page-1);
                  }}
                    journeys={routingOptions?.options.journeys.filter(journey=>journey.clientId===account.client_id)??[]}
                    sequences={routingOptions?.options.sequences.filter(sequence=>sequence.clientId==null||sequence.clientId===account.client_id)??[]} />
                ))}

                {/* Pagination */}
                {accountsData && accountsData.totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6 bg-white p-4 rounded-xl border border-slate-200/60 shadow-sm">
                    <span className="text-sm font-medium text-slate-500">
                      Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total} accounts
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="text-slate-600 font-bold"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.min(accountsData.totalPages, p + 1))}
                        disabled={page === accountsData.totalPages}
                        className="text-slate-600 font-bold"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Category Cohorts */}
           <div id="inbound-category-cohorts">
             <div className="inbound-section-heading mb-5">
               <h2>Category cohorts</h2>
               <p className="text-sm font-medium text-slate-500">Open an account to review its original responses and assign or correct a category.</p>
            </div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" aria-label="Category cohort status" className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
                {(["categorized","not-categorized"] as const).map(tab=><button key={tab} type="button" role="tab"
                  aria-selected={cohortTab===tab} onClick={()=>setCohortTab(tab)}
                  className={cn("rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600",
                    cohortTab===tab?"bg-sky-600 text-white":"text-slate-600 hover:bg-slate-50")}>
                  {tab==="categorized"?"Categorized":"Not Categorized"}
                </button>)}
              </div>
              <div className="flex flex-wrap gap-2">
                <Select value={cohortStatus} onValueChange={v=>setCohortStatus(v as "all"|"hot"|"warm"|"cold")}>
                  <SelectTrigger className="w-36 bg-white" aria-label="Filter cohorts by lead status"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="hot">Hot</SelectItem><SelectItem value="warm">Warm</SelectItem><SelectItem value="cold">Cold</SelectItem></SelectContent>
                </Select>
                {cohortTab==="categorized"&&<Select value={cohortCategory} onValueChange={setCohortCategory}>
                  <SelectTrigger className="w-48 bg-white" aria-label="Filter cohorts by category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {cohortData?.options.categories.filter(name=>!uncategorized(name)).map(name=><SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>}
              </div>
            </div>
            <div className="space-y-3">
               {cohortsLoading ? <div className="rounded-xl bg-white p-8 text-sm text-slate-500">Loading category cohorts…</div> : cohortsError ? (
                <div role="alert" className="rounded-xl bg-rose-50 p-8 text-sm text-rose-700">Could not load category cohorts.</div>
               ) : visibleCohorts.length === 0 ? (
                <div className="bg-white rounded-xl border border-slate-200/60 p-8 text-center text-sm font-medium text-slate-500 shadow-sm">
                  No {cohortTab==="categorized"?"categorized":"uncategorized"} cohorts found for these filters.
                </div>
              ) : visibleCohorts.map(cohort => (
                <details key={`${cohort.clientId}-${cohort.categoryName}-${cohort.classification}`} className="group bg-white rounded-xl border border-slate-200/60 shadow-sm overflow-hidden">
                  <summary className="p-4 cursor-pointer flex items-center justify-between hover:bg-slate-50 transition-colors list-none">
                    <div className="flex items-center gap-4">
                      <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 group-open:bg-sky-50 group-open:text-sky-600 transition-colors">
                        <ChevronRight className="w-4 h-4 group-open:rotate-90 transition-transform" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900">{cohort.categoryName}</span>
                          <Badge variant="outline" className={cohort.classification === 'hot' ? "bg-rose-50 text-rose-700 border-rose-200 font-bold" : cohort.classification==="warm" ? "bg-amber-50 text-amber-700 border-amber-200 font-bold" : "bg-slate-50 text-slate-600 border-slate-200 font-bold"}>
                            {cohort.classification}
                          </Badge>
                        </div>
                        <div className="text-xs font-medium text-slate-500 mt-1">
                          {cohort.accountCount} account{cohort.accountCount === 1 ? '' : 's'} · {cohort.contactCount} contact{cohort.contactCount === 1 ? '' : 's'}
                          {cohort.alsoHotCount>0&&<span className="ml-2 inline-flex rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 font-bold text-sky-700">{cohort.alsoHotCount} also Hot overall</span>}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs font-semibold flex gap-5 text-right mr-2">
                       <div className="flex flex-col">
                         <span className="text-slate-900 text-sm font-bold">{cohort.routed}</span>
                         <span className="text-slate-400">Routed responses</span>
                       </div>
                       <div className="flex flex-col">
                         <span className="text-amber-600 text-sm font-bold">{cohort.pending}</span>
                         <span className="text-slate-400">Pending responses</span>
                       </div>
                        <div className={cn("flex flex-col rounded-md px-2 py-1",cohort.failed>0?"border border-rose-200 bg-rose-50 text-rose-700":"text-slate-400")}>
                          <span className={cn("text-sm font-bold",cohort.failed>0?"text-rose-700":"text-slate-500")}>{cohort.failed}</span>
                          <span>Failed responses</span>
                       </div>
                    </div>
                  </summary>
                  <div className="p-4 border-t border-slate-100 bg-slate-50/50">
                    {cohort.categoryName==="No Category"&&user?.role==="admin"&&<Button size="sm" className="mb-4" onClick={()=>{
                      const details=document.getElementById("inbound-category-destinations") as HTMLDetailsElement|null;
                      if(details){
                        details.open=true;
                        document.getElementById(`no-category-route-${cohort.clientId}`)?.scrollIntoView({behavior:"smooth"});
                      }
                    }}>{routingOptions&&findNoCategoryRoute(routingOptions.rules,cohort.clientId,cohort.classification)
                      ?"View saved journey & sequence"
                      :cohort.pending>0?"Set journey & sequence for pending and future responses":"Set journey & sequence for future responses"}</Button>}
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">Accounts in this cohort</div>
                    <div className="flex flex-wrap gap-2">
                      {cohort.accounts.map(acc => (
                        <Button
                          key={acc.id}
                          variant="outline"
                          size="sm"
                          className={cn("shadow-sm h-auto min-h-8 text-xs",
                            acc.failed?"border-rose-300 bg-rose-50 text-rose-800 hover:border-rose-500 hover:bg-rose-100 hover:text-rose-900"
                            :acc.alsoHotOverall?"border-sky-300 bg-sky-50 text-sky-800 hover:border-sky-500 hover:bg-sky-100 hover:text-sky-900"
                            :"bg-white hover:border-sky-300 hover:text-sky-700 hover:bg-sky-50")}
                          onClick={() => setReviewAccountId(acc.id)}
                          title={[acc.failed?"Failed response":"",acc.alsoHotOverall?"Hot overall, Warm in this category":""].filter(Boolean).join(" · ")||undefined}
                        >
                          {acc.name}
                          {acc.failed&&<span className="ml-1.5 font-bold text-rose-700">Failed</span>}
                          {acc.alsoHotOverall&&<span className="ml-1.5 rounded-sm bg-sky-100 px-1 font-bold text-sky-800">Hot overall</span>}
                        </Button>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </div>

          {/* Cohort Rules */}
          <div className="inbound-rules-card bg-white rounded-xl border border-slate-200/60 shadow-sm p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                 <h2 className="text-lg font-bold text-slate-900 tracking-tight">Cohort rules</h2>
                 <p className="text-sm font-medium text-slate-500 mt-1">Product answers determine the category; purchase timelines determine Hot or Warm, while respondents without a selected product are Cold. Correct a category from an account’s original answers.</p>
              </div>
               <Button variant="outline" size="sm" className="font-bold text-slate-700 h-8" onClick={()=>document.getElementById("inbound-routing-rules")?.scrollIntoView({behavior:"smooth"})}>Edit routing rules</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/50">
                <div className="font-bold text-slate-900 text-sm mb-1.5">Hot cohort</div>
                 <div className="text-xs font-medium text-slate-500 leading-relaxed">Selected product/service and a purchase timeline of 3 months or less.</div>
              </div>
              <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/50">
                <div className="font-bold text-slate-900 text-sm mb-1.5">Warm cohort</div>
                 <div className="text-xs font-medium text-slate-500 leading-relaxed">Selected product/service and a purchase timeline over 3 and up to 6 months. Missing timelines or over 6 months are Cold.</div>
              </div>
              <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/50">
                 <div className="font-bold text-slate-900 text-sm mb-1.5">Category assignment</div>
                 <div className="text-xs font-medium text-slate-500 leading-relaxed">IT Hardware, Business Collaboration, Security, or Business Services; unknown answers need review.</div>
              </div>
            </div>
            <CategoryMatchingEditor />
          </div>

          {/* Actionable Routing Components */}
           <div id="inbound-routing-rules" className="pt-4 border-t border-slate-200">
             <IntentInboundRouting />
          </div>

           {formType === "event_feedback" && (
            <div className="pt-4 border-t border-slate-200">
               <EventFeedbackSummary summary={accountsData?.eventFeedbackSummary} loading={accountsLoading || sourceLoading} sourceName="Event feedback" />
            </div>
          )}

          <MonitoredAccountsSection />
          <PriorityAccountsSection />
           </>)}
        </div>
      </div>

       <InboundMetricsDrilldown metric={activeMetric} filters={dashboardFilters}
         onClose={() => setActiveMetric(null)}
         onOpenAccount={accountId => { setActiveMetric(null); setReviewAccountId(accountId); }} />
       <InboundResponseDialog accountId={reviewAccountId} sourceId={viewSourceId} onClose={() => setReviewAccountId(null)} />
       <AddInboundAccountDialog open={addAccountOpen} onClose={()=>setAddAccountOpen(false)}
         clientId={clientIdParam} onCreated={showSavedAccount} />
       <AddInboundAccountDialog open={editAccount!==null} account={editAccount} onClose={()=>setEditAccount(null)}
         onCreated={showSavedAccount} />
    </div>
  );
}

function EventFeedbackSummary({ summary, loading, sourceName }: {
  summary: import("@/hooks/use-intent").IntentEventFeedbackSummary | null | undefined;
  loading: boolean;
  sourceName: string;
}) {
  const ratingLabels = {
    overallExperience: "Overall experience",
    hpSessionRating: "HP session",
    workshopRating: "Discovery workshop",
    demoRating: "Productivity demo",
  } as const;
  if (loading) return <div className="h-64 animate-pulse rounded-xl border border-slate-200/60 bg-white" />;
  if (!summary) return null;
  return (
    <section className="inbound-feedback-card rounded-xl border border-slate-200/60 bg-white p-6 shadow-sm" data-testid="section-event-feedback-summary">
      <div className="mb-6 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-black tracking-tight text-slate-900">
            <Star className="h-5 w-5 text-sky-600" /> Event feedback summary
          </h2>
          <p className="mt-1 text-sm font-medium text-slate-500">Trends from {sourceName}, kept separate from lead-form responses.</p>
        </div>
        <Badge variant="outline" className="w-fit border-sky-200 bg-sky-50 text-sky-700 font-bold px-3 py-1 text-xs" data-testid="text-event-response-count">
          {summary.responseCount} response{summary.responseCount === 1 ? "" : "s"}
        </Badge>
      </div>
      <div className="grid gap-4 xl:grid-cols-4">
        {Object.entries(ratingLabels).map(([key, label]) => {
          const distribution = summary.ratings[key as keyof typeof summary.ratings];
          const total = distribution.reduce((count, item) => count + item.count, 0);
          return (
            <div key={key} className="rounded-xl border border-slate-100 bg-slate-50/50 p-4" data-testid={`rating-${key}`}>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
              <div className="mt-4 space-y-3">
                {distribution.length ? distribution.map(item => (
                  <div key={item.label}>
                    <div className="mb-1.5 flex justify-between text-xs font-bold text-slate-700"><span>{item.label}</span><span>{item.count}</span></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-sky-500" style={{ width: `${total ? (item.count / total) * 100 : 0}%` }} />
                    </div>
                  </div>
                )) : <p className="text-xs text-slate-400 font-medium">No ratings yet</p>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <RankedList title="Requested HP services" icon={<ListChecks className="h-4 w-4" />} items={summary.requestedServices} testId="requested-services" />
        <RankedList title="Future topics" icon={<MessageSquare className="h-4 w-4" />} items={summary.futureTopics} testId="future-topics" />
        <RankedList title="Recurring challenges" icon={<AlertCircle className="h-4 w-4" />} items={summary.challenges} testId="challenges" />
        <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-4" data-testid="list-follow-up-requests">
          <h3 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><PhoneCall className="h-4 w-4 text-slate-400" /> Follow-up requests</h3>
          <div className="mt-4 space-y-2">
            {summary.followUpRequests.length ? summary.followUpRequests.map((item, index) => (
              <div key={`${item.date}-${item.time}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-slate-700">{item.date || "Date not specified"}{item.time ? ` · ${item.time}` : ""}</span>
                <Badge variant="secondary" className="bg-white border border-slate-200 text-slate-600">{item.count}</Badge>
              </div>
            )) : <p className="text-xs text-slate-400 font-medium">No follow-up times requested</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function RankedList({ title, icon, items, testId }: { title:string; icon:React.ReactNode; items:Array<{label:string;count:number}>; testId:string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-4" data-testid={`list-${testId}`}>
      <h3 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><span className="text-slate-400">{icon}</span>{title}</h3>
      <ol className="mt-4 space-y-2">
        {items.length ? items.slice(0, 8).map((item, index) => (
          <li key={item.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-slate-700"><span className="mr-2 text-slate-400 font-bold text-xs">{index + 1}.</span>{item.label}</span>
            <Badge variant="secondary" className="bg-white border border-slate-200 text-slate-600">{item.count}</Badge>
          </li>
        )) : <li className="text-xs text-slate-400 font-medium">No responses yet</li>}
      </ol>
    </div>
  );
}

function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="bg-white p-5 rounded-xl border border-slate-200/60 shadow-sm flex flex-col gap-4 animate-pulse">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-slate-100" />
              <div className="space-y-2">
                <div className="w-48 h-5 bg-slate-100 rounded" />
                <div className="w-32 h-4 bg-slate-50 rounded" />
              </div>
            </div>
            <div className="w-24 h-6 bg-slate-100 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasSearch, googleDriveConnected, hasSource }: { hasSearch: boolean, googleDriveConnected: boolean, hasSource: boolean }) {
  if (hasSearch) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-slate-200/60 shadow-sm text-center min-h-[400px]">
        <div className="w-16 h-16 rounded-full bg-slate-50 flex items-center justify-center mb-4">
          <Search className="w-8 h-8 text-slate-400" />
        </div>
        <h3 className="text-lg font-bold text-slate-900 mb-2">No matching accounts</h3>
        <p className="text-sm font-medium text-slate-500 max-w-md">
          No inbound accounts match your current search and filter criteria. Try adjusting your filters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-slate-200/60 shadow-sm text-center min-h-[400px]">
      <div className="w-20 h-20 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center mb-6 shadow-sm rotate-3">
        <Inbox className="w-10 h-10 text-sky-600 -rotate-3" />
      </div>
      <h3 className="text-xl font-black text-slate-900 mb-3 tracking-tight">Your Inbound Command Center</h3>
      <p className="text-sm font-medium text-slate-500 max-w-md mb-8 leading-relaxed">
        Automatically process submitted questionnaires, event forms, and direct feedback into structured intent data.
        {!hasSource && " Or add an account manually without a Google Drive source."}
      </p>
      {!hasSource && (
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl max-w-md w-full text-left">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-widest mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-slate-400" /> Getting Started
          </h4>
          <ol className="text-sm font-medium text-slate-600 space-y-3 list-decimal pl-5 marker:text-slate-400 marker:font-bold">
            <li className="pl-1">Click <strong>Add Google Drive Folder</strong> above to paste your folder URL.</li>
            <li className="pl-1">Once Google Drive is connected by an admin, PlayForge will monitor the folder.</li>
            <li className="pl-1">New submissions will automatically generate account intent briefs.</li>
          </ol>
        </div>
      )}
    </div>
  );
}

function AccountCard({ account,sourceId,journeys,sequences,onEdit,onRemoved }: {
  account: IntentInboundAccount;
  sourceId?:number;
  journeys:{id:number;name:string;clientId:number}[];
  sequences:RespondentSequence[];
  onEdit:()=>void;onRemoved:()=>void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [responsesOpen,setResponsesOpen]=useState(false);
  const [selectedInterest,setSelectedInterest]=useState<{submissionId:number;selection:string}|null>(null);
  const route=useRouteInboundRespondent();
  const {toast}=useToast();
  const {user}=useAuthContext();
  const queryClient=useQueryClient();
  const remove=useRemoveManualInboundAccount();
  const [removeOpen,setRemoveOpen]=useState(false);
  const [deleteOpen,setDeleteOpen]=useState(false);
  const [deleteName,setDeleteName]=useState("");
  const deleteAccount=useMutation({
    mutationFn:async()=>{
      const response=await fetch(`/api/companies/${account.account_id}`,{method:"DELETE",credentials:"include"});
      if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error??"Account deletion failed");
    },
    onSuccess:()=>{
      setDeleteOpen(false);setDeleteName("");
      queryClient.invalidateQueries({queryKey:["intent"]});
      queryClient.invalidateQueries({queryKey:["companies"]});
      queryClient.invalidateQueries({queryKey:["contacts"]});
      toast({title:"Account and linked history deleted"});
      onRemoved();
    },
    onError:(error:Error)=>toast({title:"Could not delete account",description:error.message,variant:"destructive"}),
  });
  const confirmRemove=()=>{
    remove.mutate({accountId:account.account_id},{
      onSuccess:()=>{
        setRemoveOpen(false);
        queryClient.invalidateQueries({queryKey:["intent","inbound"]});
        queryClient.invalidateQueries({queryKey:["companies"]});
        toast({title:"Removed from Inbound Accounts",description:"The company remains in the CRM."});
        onRemoved();
      },
      onError:error=>{
        setRemoveOpen(false);
        queryClient.invalidateQueries({queryKey:["intent","inbound"]});
        toast({title:"Could not remove account",description:error.message,variant:"destructive"});
      },
    });
  };
  const isHot = account.classification === "hot";
  const isCold = account.classification === "cold";
  const interests=[...new Set(account.respondents.flatMap(person=>person.interests.map(interest=>interest.selection)))];

  return (
    <>
    <div className={cn(
      "inbound-account-card bg-white rounded-xl border shadow-sm transition-all duration-200 overflow-hidden group hover:border-sky-200",
      expanded ? "border-sky-200 shadow-md ring-1 ring-sky-500/10" : "border-slate-200/60"
    )}>
      {/* Card Header (Always visible) */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${account.name} account details`}
        className="p-5 cursor-pointer flex flex-col lg:flex-row lg:items-start justify-between gap-5 select-none"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setExpanded(value => !value); } }}
      >
        <div className="flex min-w-0 items-start gap-4">
          <div className={cn(
            "w-12 h-12 rounded-xl flex items-center justify-center shrink-0 border shadow-sm transition-colors",
            isHot ? "bg-rose-50 border-rose-100 text-rose-600 group-hover:bg-rose-100" : isCold ? "bg-slate-50 border-slate-200 text-slate-500 group-hover:bg-slate-100" : "bg-sky-50 border-sky-100 text-sky-600 group-hover:bg-sky-100"
          )}>
            <Building2 className="w-6 h-6" />
          </div>
          
          <div className="flex min-w-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h3 className="text-lg font-bold text-slate-900 tracking-tight group-hover:text-sky-700 transition-colors">
                {account.name}
              </h3>
              {account.domain && (
                <span className="text-xs font-bold text-slate-400 hidden sm:inline-block border border-slate-200 px-1.5 py-0.5 rounded-md">
                  {account.domain}
                </span>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-slate-500">
              <div className="flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-slate-400" />
                {account.response_count} response{account.response_count !== 1 ? 's' : ''}
              </div>
              <span>{account.respondents.length} respondent{account.respondents.length===1?"":"s"}</span>
              {account.identityConflictCount>0&&<button type="button" onClick={event=>{event.stopPropagation();setResponsesOpen(true);}}
                className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 font-bold text-amber-900 hover:bg-amber-100"
                data-testid={`review-identity-${account.account_id}`}>
                {account.identityConflictCount} email conflict{account.identityConflictCount===1?"":"s"} · review
              </button>}
              <Badge variant="outline" className="h-5 border-slate-200 bg-slate-50 px-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                {account.form_type === "manual" ? "Manually added" : account.form_type === "event_feedback" ? "Event feedback" : "Lead form"}
              </Badge>
              {account.manual_details&&<Badge variant="outline" className="h-5 border-sky-200 bg-sky-50 px-1.5 text-[9px] font-bold uppercase tracking-wider text-sky-700">Entered manually</Badge>}
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                {account.submitted_at ? formatDistanceToNow(new Date(account.submitted_at), { addSuffix: true }) : 'Recently'}
              </div>
              {interests.length>0 && (
                <button type="button" onClick={event=>{event.stopPropagation();setResponsesOpen(true);}} data-testid={`button-verify-affinity-${account.account_id}`} title="View original answers and verify this interest" className="flex items-center gap-1.5 text-sky-700 bg-sky-50 px-2 py-0.5 rounded-md border border-sky-100 max-w-[200px] truncate hover:bg-sky-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600 transition-colors">
                  <ShoppingBag className="w-3 h-3 shrink-0" />
                  <span className="truncate">{interests[0]}{interests.length>1?` +${interests.length-1} more`:""}</span>
                </button>
              )}
              {interests.length===0 && account.form_type!=="manual" && <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800 font-bold">No product selected · needs review</span>}
            </div>
            {account.classification_reason && (
              <p className="inbound-account-reason mt-4 max-w-2xl text-sm leading-relaxed">
                <span className="mr-2 font-bold">Why now</span>{account.classification_reason}
              </p>
            )}
            {(account.routes?.length || !isHot) && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid={`account-routes-${account.account_id}`}>
              <span className="mr-1 font-bold text-slate-500">{isHot?"Previous Warm journey":"Journey / Sequence"}</span>
              {(account.routes??[]).length ? account.routes.map((destination,index)=>(
                <span key={`${destination.status}-${destination.journeyId}-${destination.sequenceId}-${index}`}
                  title={isHot?"Historical journey from a Warm response. Not a current nurture route.":destination.status==="routed"&&destination.source==="rule"
                    ?"This shows the rule's current destination. Earlier enrollments may differ if the rule was edited."
                    :undefined}
                  className={cn("inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border px-2 py-1 font-semibold",
                    destination.status==="routed"?"border-emerald-200 bg-emerald-50 text-emerald-800"
                    :destination.status==="error"?"border-rose-200 bg-rose-50 text-rose-800"
                    :"border-sky-200 bg-sky-50 text-sky-800")}>
                  <span className="font-bold">{isHot?"History":destination.status==="routed"?"Routed":destination.status==="configured"?"Configured":destination.status==="error"?"Needs retry":"Previously routed"}</span>
                  <span>· {destination.journeyName??"Journey unavailable"}{(!isHot||destination.sequenceName)&&<> → {destination.sequenceName??"Sequence unavailable"}</>}</span>
                  {destination.responseCount>1&&<span>({destination.responseCount} responses)</span>}
                </span>
              )):<span className="font-medium text-slate-400">No route assigned</span>}
            </div>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4 self-end lg:self-start">
          <Badge className={cn(
            "px-2.5 py-1 text-[10px] uppercase tracking-widest font-black rounded-md shadow-none",
             isHot ? INBOUND_THEME.hot.bg + " " + INBOUND_THEME.hot.text + " " + INBOUND_THEME.hot.border
                   : account.classification==="warm" ? INBOUND_THEME.warm.bg + " " + INBOUND_THEME.warm.text + " " + INBOUND_THEME.warm.border
                   : isCold ? "bg-slate-100 text-slate-700 border-slate-300"
                   : "bg-slate-50 text-slate-600 border-slate-200"
          )} variant="outline">
            {account.classification??"No inbound intent"}
          </Badge>
          
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-slate-50 text-slate-400 group-hover:bg-sky-50 group-hover:text-sky-600 transition-colors">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      <div className={cn(
        "grid transition-all duration-300 ease-in-out bg-slate-50/50 border-t",
        expanded ? "grid-rows-[1fr] border-sky-100/50 opacity-100" : "grid-rows-[0fr] border-transparent opacity-0"
      )}>
        <div className="overflow-hidden">
          <div className="p-5 flex flex-col lg:flex-row gap-6">
            
            {/* Left Column: Details */}
            <div className="flex-1 space-y-6">
              <DemoEngagementHistory companyId={account.account_id} />
              {account.form_type!=="manual"&&<Button size="sm" variant="outline" className="font-bold text-slate-700 h-8 bg-white" onClick={()=>setResponsesOpen(true)} data-testid={`button-review-responses-${account.account_id}`}>
                 View responses · review identities &amp; interests
              </Button>}
              {(account.form_type==="manual"||account.manual_details?.editable)&&user&&<div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onEdit} data-testid={`button-edit-manual-inbound-${account.account_id}`}><Pencil className="mr-2 h-3.5 w-3.5"/>Edit account</Button>
                {!account.manual_details&&<Button size="sm" variant="outline" className="text-rose-700" onClick={()=>setRemoveOpen(true)} data-testid={`button-remove-manual-inbound-${account.account_id}`}><Trash2 className="mr-2 h-3.5 w-3.5"/>Remove from inbound</Button>}
              </div>}
              {user?.role==="admin" && account.manual_details?.editable && <>
                <TrackedContactLink accountId={account.account_id} />
                <AnonymousSessionReview accountId={account.account_id} />
              </>}
              {user?.role==="admin"&&<Button size="sm" variant="outline" className="border-rose-200 text-rose-700" onClick={()=>setDeleteOpen(true)} data-testid={`button-delete-inbound-account-${account.account_id}`}>
                <Trash2 className="mr-2 h-3.5 w-3.5"/>Delete account and history
              </Button>}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                  <Search className="w-3.5 h-3.5" /> Classification Rationale
                </h4>
                <p className="text-sm text-slate-700 leading-relaxed font-medium bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                  {account.classification_reason}
                </p>
              </div>

              {account.feedback && (
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5" /> Direct Feedback
                  </h4>
                  <div className="text-sm font-medium text-slate-600 leading-relaxed italic bg-white p-4 rounded-lg border border-slate-200/60 shadow-sm relative">
                    <span className="absolute top-2 left-2 text-slate-200 text-3xl font-serif leading-none">"</span>
                    <span className="relative z-10 pl-4 block">{account.feedback}</span>
                  </div>
                </div>
              )}

              {account.form_type === "event_feedback" && account.event_feedback && Object.keys(account.event_feedback).length > 0 && (
                <div>
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" /> Event response
                  </h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(account.event_feedback).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-slate-200/60 bg-white p-3 shadow-sm">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {key.replace(/([A-Z])/g, " $1").replace(/^./, character => character.toUpperCase())}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-slate-700">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Meta & Contact */}
            <div className="w-full lg:w-[420px] shrink-0 space-y-4">
              {account.manual_details&&<div className="bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm text-sm text-slate-700">
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Manually recorded source</h4>
                <span className="font-semibold">{account.manual_details.formType==="event_feedback"?"Event Feedback":"Lead form"}</span>
                {account.manual_details.eventName&&<span> · {account.manual_details.eventName}</span>}
                <span> · {account.manual_details.formType==="event_feedback"?account.manual_details.eventDate:account.manual_details.formFilledDate}</span>
                <div className="mt-1 text-xs">Product category: {account.manual_details.categoryName}</div>
                {account.manual_details.city&&<div className="mt-1 text-xs">Contact city: {account.manual_details.city}</div>}
              </div>}
              {account.purchase_timeframe_months !== null && account.purchase_timeframe_months !== undefined && (
                <div className="bg-white p-3 rounded-lg border border-slate-200/60 shadow-sm">
                  <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Timeline</h4>
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Clock className="w-4 h-4 text-sky-500" />
                    {account.purchase_timeframe_months === 0 ? "Immediate" : `Within ${account.purchase_timeframe_months} months`}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                  <User className="w-3 h-3" /> All respondents ({account.respondents.length})
                </h4>
                {account.respondents.map((person,index)=><div key={person.id??`unknown-${index}`} className="rounded-lg border border-slate-200/60 bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">{person.name}</span>
                    {person.id!==null&&<Link href={`/crm/contacts/${person.id}`} className="text-xs font-semibold text-sky-700 underline" onClick={event=>event.stopPropagation()}>Open contact</Link>}
                    {person.isPrimary&&<Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700 font-bold px-2 py-0.5 text-[10px]">Primary contact</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs font-medium text-slate-500">{person.title||"Designation not provided"}</p>
                  {person.email&&<a href={`mailto:${person.email}`} className="mt-1 block break-all text-xs font-medium text-sky-600 hover:underline">{person.email}</a>}
                  {person.interests.length===0?<div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-700 font-bold">Cold · missing product/horizon or beyond 6 months</Badge>
                    <span className="text-xs font-medium text-slate-500">The account status may reflect another respondent’s selected product.</span>
                  </div>:
                    <div className="mt-3 space-y-2">
                      {person.interests.map((interest,interestIndex)=>{
                        const active=selectedInterest?.submissionId===interest.submissionId&&selectedInterest.selection===interest.selection;
                        const assigned=interest.manualJourneyId!==null;
                        const historicalRoute=account.routes.find(destination=>
                          destination.status==="routed"&&destination.journeyId===interest.manualJourneyId);
                        const showRouting=!isHot||(interest.classification==="warm"&&assigned&&Boolean(historicalRoute));
                        return <div key={`${interest.submissionId}-${interest.selection}-${interestIndex}`} className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ShoppingBag className="h-3.5 w-3.5 text-sky-600"/>
                            <span className="text-xs font-bold text-slate-900">{interest.selection}</span>
                            {interest.category&&<span className="text-[10px] font-medium text-slate-500">· {interest.category}</span>}
                          </div>
                          {showRouting&&(assigned?<p className="mt-1 text-[11px] font-semibold text-emerald-700">{isHot
                            ?<>Previous Warm journey: {historicalRoute?.journeyName}{historicalRoute?.sequenceName&&<> → {historicalRoute.sequenceName}</>}</>
                            :<>Routed to {journeys.find(j=>j.id===interest.manualJourneyId)?.name??"journey"} → {sequences.find(s=>s.id===interest.manualSequenceId)?.name??"sequence"}</>}</p>
                            :interest.responseManuallyRouted?<p className="mt-1 text-[11px] font-medium text-slate-500">This response is already assigned to another interest.</p>
                            :<div className="mt-1">
                              {interest.routingStatus==="routed"&&<p className="text-[11px] font-semibold text-amber-700 mb-1">This response was previously routed by a cohort rule. A new route will not undo that enrollment.</p>}
                              {interest.routingError&&<p className="text-[11px] font-semibold text-rose-600 mb-1">{interest.routingError}</p>}
                              {!isHot&&interest.classification==="warm"&&user?.role==="admin"&&person.id!==null&&<Button size="sm" variant="link" className="h-7 p-0 text-xs font-bold text-sky-600" onClick={()=>{setSelectedInterest(active?null:{submissionId:interest.submissionId,selection:interest.selection});}}>Route this respondent</Button>}
                              {!isHot&&active&&<RespondentRouteForm key={`${interest.submissionId}-${interest.selection}`} journeys={journeys} sequences={sequences} busy={route.isPending} onSubmit={destination=>route.mutate({
                                  submissionId:interest.submissionId,selection:interest.selection,...destination,startSequence:false,
                                },{
                                  onSuccess:()=>{setSelectedInterest(null);toast({title:"Route saved — no emails sent",description:"This response’s journey and sequence were assigned without starting email delivery. Existing enrollments were not changed."});},
                                  onError:error=>toast({title:"Could not route respondent",description:error.message,variant:"destructive"}),
                                })} />}
                            </div>)}
                        </div>;
                      })}
                    </div>}
                </div>)}
              </div>

              <Button
                asChild
                variant="outline" 
                className="w-full justify-between group/btn text-xs font-bold text-slate-700 bg-white border-slate-200 hover:bg-sky-50 hover:text-sky-700 hover:border-sky-200 transition-colors shadow-sm"
              >
                <Link href={`/intent/accounts/${account.account_id}`} onClick={event => event.stopPropagation()}>
                  View full intent brief
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover/btn:text-sky-500 transition-colors group-hover/btn:translate-x-0.5" />
                </Link>
              </Button>
            </div>

          </div>
        </div>
      </div>
    </div>
    <InboundResponseDialog accountId={responsesOpen?account.account_id:null} sourceId={sourceId} onClose={()=>setResponsesOpen(false)}/>
    <AlertDialog open={deleteOpen} onOpenChange={open=>{if(!deleteAccount.isPending){setDeleteOpen(open);if(!open)setDeleteName("");}}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Permanently delete {account.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes the account, its contacts, imported responses, activities, scores, deals, and linked history. It cannot be undone. Source files or later imports can recreate records.</AlertDialogDescription>
        </AlertDialogHeader>
        <Label htmlFor={`confirm-account-${account.account_id}`}>Type the account name to confirm</Label>
        <Input id={`confirm-account-${account.account_id}`} value={deleteName} onChange={event=>setDeleteName(event.target.value)} autoComplete="off"/>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteAccount.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-rose-600 hover:bg-rose-700" disabled={deleteAccount.isPending||deleteName!==account.name}
            onClick={event=>{event.preventDefault();deleteAccount.mutate();}}>{deleteAccount.isPending?"Deleting…":"Delete account and history"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {account.name} from Inbound Accounts?</AlertDialogTitle>
          <AlertDialogDescription>This removes only its manual inbound membership. The company and its CRM data will remain. Accounts with form responses cannot be removed.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={remove.isPending} onClick={event=>{event.preventDefault();confirmRemove();}} data-testid="button-confirm-remove-manual-inbound">
            {remove.isPending?"Removing…":"Remove from inbound"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function SourceConfigSheet({ source, googleDriveConnected, clientId, open, onOpenChange, onSaved }: { source: IntentInboundSource | null, googleDriveConnected: boolean, clientId?: number, open:boolean, onOpenChange:(open:boolean)=>void, onSaved:(source:IntentInboundSource)=>void }) {
  const search = useSearch();
  useEffect(() => {
    if (new URLSearchParams(search).get("driveSettings") === "1") onOpenChange(true);
  }, [search]);
  const changeOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen && new URLSearchParams(window.location.search).has("driveSettings")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("driveSettings");
      window.history.replaceState(window.history.state, "", url);
    }
  };
  const { toast } = useToast();
  
  const [name, setName] = useState(source?.name || "");
  const [multipleFolders, setMultipleFolders] = useState(false);
  const [folderUrl, setFolderUrl] = useState(source?.folderUrl || "");
  const [formType, setFormType] = useState<"lead_form" | "event_feedback">(source?.formType || "lead_form");
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [selectedClientId, setSelectedClientId] = useState<number | undefined>(source?.clientId || clientId);
  const [fieldMappings, setFieldMappings] = useState<Record<string, IntentInboundMappingTarget>>(source?.fieldMappings || {});

  const { data: scopeOptions } = useIntentScopeOptions(undefined, open);
  const { data: preview, isLoading: previewLoading, isError: previewFailed, refetch: refreshPreview } = useIntentInboundSourcePreview(source?.id, open && !!source && googleDriveConnected);
  const clients = scopeOptions?.clients || [];

  const createMutation = useCreateIntentInboundSource();
  const updateMutation = useUpdateIntentInboundSource();
  const saving = createMutation.isPending || updateMutation.isPending;
  const [saveError,setSaveError] = useState("");
  const hasCompanyNameMapping = preview?.fields.some(field =>
    field.automaticTarget === "companyName" || fieldMappings[field.heading] === "companyName"
  ) || Object.values(fieldMappings).includes("companyName");

  // Reset form when source changes or sheet opens
  useEffect(() => {
    if (open) {
      setMultipleFolders(false);
      setName(source?.name || "");
      setFolderUrl(source?.folderUrl || "");
      setFormType(source?.formType || "lead_form");
      setEnabled(source?.enabled ?? true);
      setSelectedClientId(source?.clientId || clientId);
      setFieldMappings(source?.fieldMappings || {});
      setSaveError("");
    }
  }, [open, source?.id, clientId]);

  const handleSave = () => {
    if (!name || !folderUrl || !selectedClientId || !formType) {
      toast({ title: "Validation Error", description: "Name, Client, Folder URL, and response type are required.", variant: "destructive" });
      return;
    }

    const data = {
      name,
      clientId: selectedClientId,
      folderUrl,
      formType,
      enabled,
      fieldMappings
    };
    const callbacks = {
      onSuccess: (result:{source:IntentInboundSource}) => {
        onSaved(result.source);
        toast({ title: source ? "Folder updated" : "Folder added", description: `${result.source.name} is saved. Field mappings apply to future syncs.` });
        if (source) changeOpen(false);
      },
      onError: (err:Error) => {
        const message = /409|duplicate|locked|already exists|in use/i.test(err.message) ? `This folder identity is already in use or locked. Choose a different folder, or edit its existing source. ${err.message}` : err.message || "Failed to save source configuration";
        setSaveError(message);
        toast({ title: "Could not save Drive folder", description: message, variant: "destructive" });
      }
    };
    setSaveError("");
    if (source) updateMutation.mutate({id:source.id,data},callbacks);
    else createMutation.mutate(data,callbacks);
  };

  if (multipleFolders) return <Sheet open={open} onOpenChange={changeOpen}>
    <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
      <SheetHeader className="mb-5"><SheetTitle>Add multiple Google Drive folders</SheetTitle>
        <SheetDescription>Keep each folder's client and form provenance separate.</SheetDescription></SheetHeader>
      <MultipleDriveFolders clients={clients} clientId={selectedClientId}
        onSaved={saved => { setMultipleFolders(false); onSaved(saved); toast({ title: "Drive folders saved", description: "Each URL is now a separate source. Use Edit to configure its field mappings." }); }}
        onCancel={() => setMultipleFolders(false)} />
    </SheetContent>
  </Sheet>;

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetContent className="w-full sm:max-w-2xl border-l-slate-200 flex flex-col p-0">
        <div className="p-6 border-b border-slate-200 bg-slate-50/50">
          <SheetHeader>
            <SheetTitle className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <FolderSync className="w-5 h-5 text-sky-600" />
              {source ? `Edit ${source.name}` : "Add Google Drive Folder"}
            </SheetTitle>
            <SheetDescription className="text-sm font-medium text-slate-500 leading-relaxed">
               Choose a Google Drive folder and tell us whether it contains lead forms or event feedback.
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!googleDriveConnected && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 shadow-sm">
              <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="text-sm font-bold text-amber-800 tracking-tight">Google Drive Not Connected</span>
                <span className="text-xs font-medium text-amber-700 mt-1 leading-relaxed">
                  Your workspace admin has not connected Google Drive yet. You can configure this source folder now, and sync will automatically become available once the connection is established.
                </span>
              </div>
            </div>
          )}

          {saveError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" data-testid="error-save-source">{saveError}</div>}
          <Button type="button" variant="outline" disabled={saving} onClick={() => setMultipleFolders(true)}
            data-testid="button-add-multiple-drive-folders">Add multiple Drive URLs</Button>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Source Name</Label>
              <Input 
                value={name} data-testid="input-source-name"
                onChange={e => setName(e.target.value)} 
                placeholder="e.g. Website Demo Requests"
                className="h-10 font-medium focus-visible:ring-sky-500"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Target Client</Label>
              <Select value={selectedClientId ? String(selectedClientId) : ""} onValueChange={(v) => setSelectedClientId(Number(v))}>
                <SelectTrigger className="h-10 font-medium focus:ring-sky-500">
                  <SelectValue placeholder="Select client..." />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Google Drive Folder URL</Label>
              <Input data-testid="input-source-folder-url"
                value={folderUrl} 
                onChange={e => setFolderUrl(e.target.value)} 
                placeholder="https://drive.google.com/drive/folders/..."
                className="h-10 font-medium focus-visible:ring-sky-500"
              />
              <p className="text-[11px] font-medium text-slate-400 mt-1">Supported formats: DOCX, XLSX, XLS, CSV, Google Docs, and Google Sheets.</p>
            </div>

            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">What type of responses are in this folder?</Label>
              <Select value={formType} onValueChange={(value) => setFormType(value as "lead_form" | "event_feedback")}>
                <SelectTrigger className="h-10 font-medium focus:ring-sky-500" data-testid="select-inbound-form-type">
                  <SelectValue placeholder="Choose response type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead_form">Lead form</SelectItem>
                  <SelectItem value="event_feedback">Event feedback form</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] font-medium text-slate-400">
                This choice is stored with every fetched response and determines how it is interpreted in intent analysis.
              </p>
            </div>

            <div className="flex flex-row items-center justify-between rounded-xl border border-slate-200 p-4 bg-white shadow-sm mt-2">
              <div className="space-y-0.5">
                <Label className="text-sm font-bold text-slate-900">Enable automatic sync</Label>
                <p className="text-xs font-medium text-slate-500">Process new and changed files from this folder.</p>
              </div>
              <Switch 
                checked={enabled} 
                onCheckedChange={setEnabled}
                className="data-[state=checked]:bg-sky-600"
              />
            </div>
          </div>

          <div className="space-y-3 border-t border-slate-200 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Field mapping preview</h3>
                <p className="text-xs font-medium text-slate-500 mt-1">
                  Common headings map automatically. Assign client-specific headings before the next sync.
                </p>
              </div>
              {source && googleDriveConnected && (
                <Button variant="outline" size="sm" onClick={() => refreshPreview()} disabled={previewLoading} className="shrink-0 text-xs font-bold">
                  <RefreshCw className={cn("w-3.5 h-3.5 mr-2", previewLoading && "animate-spin")} />
                  Refresh
                </Button>
              )}
            </div>

            {!source ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs font-medium text-slate-500">
                Save the source folder first, then preview and map its columns here.
              </div>
            ) : !googleDriveConnected ? (
              <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-xs font-medium text-amber-700">
                Connect Google Drive to preview fields.
              </div>
            ) : previewLoading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs font-medium text-slate-500">
                Reading sample fields from the configured folder…
              </div>
            ) : previewFailed ? (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-700">
                The folder preview could not be loaded. Check access and try again.
              </div>
            ) : preview?.fields.length ? (
              <div className="space-y-3">
                {!hasCompanyNameMapping && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-bold text-amber-800">Company name mapping required</div>
                      <div className="text-xs font-medium text-amber-700 mt-1">
                        Map the heading that contains the company or account name. Sync is blocked because rows without a company name cannot be imported.
                      </div>
                    </div>
                  </div>
                )}
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {preview.fields.length} fields across {preview.scannedFiles} of {preview.files} supported file{preview.files === 1 ? "" : "s"}
                </div>
                <div className="divide-y divide-slate-100 max-h-[340px] overflow-y-auto">
                  {preview.fields.map(field => (
                    <div key={field.heading} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_220px] gap-3 sm:gap-4 p-4 items-center">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800 truncate">{field.heading}</div>
                        <div className="text-[11px] font-medium text-slate-500 truncate mt-0.5">
                          {field.samples.length ? field.samples.join(" · ") : "No sample value"}
                        </div>
                      </div>
                      {field.automaticTarget ? (
                        <div className="flex items-center justify-end gap-2">
                          <Badge variant="outline" className="bg-emerald-50 border-emerald-200 text-emerald-700 text-[10px] font-bold">Automatic</Badge>
                          <span className="text-xs font-semibold text-slate-700">{mappingLabel(field.automaticTarget)}</span>
                        </div>
                      ) : (
                        <Select
                          value={fieldMappings[field.heading] || "unmapped"}
                          onValueChange={(value) => setFieldMappings(current => {
                            const next = { ...current };
                            if (value === "unmapped") delete next[field.heading];
                            else next[field.heading] = value as IntentInboundMappingTarget;
                            return next;
                          })}
                        >
                          <SelectTrigger className="h-9 text-xs font-medium focus:ring-sky-500" data-testid={`mapping-${field.heading}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="unmapped">Leave unmapped</SelectItem>
                            {MAPPING_GROUPS.map(group => (
                              <div key={group.label}>
                                <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">{group.label}</div>
                                {group.targets.map(target => <SelectItem key={target} value={target}>{mappingLabel(target)}</SelectItem>)}
                              </div>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
                </div>
                {!!preview.errors.length && (
                  <div className="px-4 py-3 border-t border-amber-200 bg-amber-50 text-[11px] font-medium text-amber-700">
                    {preview.errors.length} file{preview.errors.length === 1 ? "" : "s"} could not be previewed.
                  </div>
                )}
              </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs font-medium text-slate-500">
                No supported fields were found in this folder.
              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-t border-slate-200 bg-slate-50/50 flex justify-end gap-3">
          <Button variant="outline" onClick={() => changeOpen(false)} className="h-10 font-bold text-slate-600">Cancel</Button>
          <Button 
            onClick={handleSave} 
            disabled={saving}
            className="h-10 bg-sky-600 hover:bg-sky-700 text-white font-bold"
          >
            {saving ? "Saving..." : source ? "Save Configuration & Mappings" : "Add folder"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const MAPPING_LABELS: Record<IntentInboundMappingTarget, string> = {
  companyName: "Company name", domain: "Company domain", firstName: "First name", lastName: "Last name",
  name: "Full name", email: "Email", phone: "Phone", title: "Job title", function: "Department / function",
  city: "City", country: "Country", linkedinUrl: "LinkedIn URL", interest: "Purchase interest",
  demo: "Demo request", timeframe: "Purchase timeframe", productInterest: "Product / solution",
  feedback: "Feedback", submittedAt: "Submitted date", formType: "Form type",
  overallExperience: "Overall experience", clubSuggestions: "Club suggestions",
  hpSessionRating: "HP session rating", workshopRating: "Workshop rating",
  demoRating: "HP demo rating", futureTopics: "Future topics",
  followUpDate: "Follow-up date", followUpTime: "Follow-up time", challenges: "Business challenges",
  hpId: "Stable HP account ID", orderValue: "Total Order Value (prospective)", currency: "Currency",
};
const mappingLabel = (target: IntentInboundMappingTarget) => MAPPING_LABELS[target];
const MAPPING_GROUPS: Array<{label:string;targets:IntentInboundMappingTarget[]}> = [
  { label: "Account & contact", targets: ["companyName","domain","firstName","lastName","name","email","phone","title","function","city","country","linkedinUrl"] },
  { label: "Intent", targets: ["interest","demo","timeframe","productInterest","hpId","orderValue","currency"] },
  { label: "Event feedback", targets: ["overallExperience","clubSuggestions","hpSessionRating","workshopRating","demoRating","futureTopics","followUpDate","followUpTime","challenges","feedback","submittedAt"] },
];

function SyncButton({ source, googleDriveConnected }: { source: IntentInboundSource | null, googleDriveConnected: boolean }) {
  const { toast } = useToast();
  const syncMutation = useSyncIntentInboundFolder();
  const { data: preview, isLoading: previewLoading } = useIntentInboundSourcePreview(source?.id, !!source && googleDriveConnected);

  const missingCompanyMapping = !!preview && !preview.hasCompanyNameMapping;
  const disabled = !source || !source.enabled || !googleDriveConnected || previewLoading || missingCompanyMapping || syncMutation.isPending;

  const handleSync = () => {
    if (!source) return;
    syncMutation.mutate(source.id, {
      onSuccess: (res) => {
        toast({
          title: `${source.name}: sync ${res.status}`,
          description: `Imported ${res.imported} records from ${res.files} file(s). Skipped: ${res.skipped}, Failed: ${res.failed}.`,
        });
      },
      onError: (err) => {
        toast({
          title: `${source.name}: sync failed`,
          description: err.message || "An error occurred during synchronization.",
          variant: "destructive"
        });
      }
    });
  };

  if (!source) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <Button 
            onClick={handleSync} 
            disabled={disabled}
            className={cn(
              "h-8 px-3 text-xs font-bold shadow-sm transition-all",
              disabled 
                ? "bg-slate-100 text-slate-400 cursor-not-allowed border-none"
                : "bg-sky-600 hover:bg-sky-700 text-white hover:shadow-sky-500/20"
            )}
            data-testid={`btn-sync-inbound-${source.id}`}
          >
            <RefreshCw className={cn("w-3.5 h-3.5 mr-2", syncMutation.isPending && "animate-spin")} />
            Sync Now
          </Button>
        </div>
      </TooltipTrigger>
      {disabled && (
        <TooltipContent className="bg-slate-900 text-slate-100 text-xs font-medium border-none shadow-xl">
          {!googleDriveConnected 
            ? "Google Drive is not connected." 
            : !source.enabled 
              ? "Source monitoring is disabled." 
               : missingCompanyMapping
                 ? "Map a source heading to Company name before syncing."
                 : previewLoading
                   ? "Checking source field mappings."
              : "Sync is currently unavailable."}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
