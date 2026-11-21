import { useState, useMemo } from "react";
import { useIntentInboundRoutingRules, useSaveIntentInboundRoutingRule, useDeleteIntentInboundRoutingRule, useRetryIntentInboundRoutingRule, useConsolidateNoCategoryRoutes, IntentInboundRoutingRule, IntentInboundRoutingRuleInput, IntentInboundRoutingRulesResponse } from "@/hooks/use-intent";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, ArrowRight, X, AlertTriangle, AlertCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { InboundResponseDialog } from "./InboundResponseDialog";

export function findNoCategoryRoute(rules:IntentInboundRoutingRule[],clientId:number,classification:"hot"|"warm"|"cold") {
  if(classification!=="warm")return undefined;
  const matches=rules.filter(rule=>rule.clientId===clientId
    &&rule.matchType==="category"&&rule.categoryName==="No Category");
  const applies=(rule:IntentInboundRoutingRule)=>rule.classification==="all"
    ||rule.classification==="warm";
  const byPriority=(a:IntentInboundRoutingRule,b:IntentInboundRoutingRule)=>a.priority-b.priority||a.id-b.id;
  return matches.filter(rule=>rule.enabled&&applies(rule)).sort(byPriority)[0]
    ??matches.filter(applies).sort(byPriority)[0];
}

export function IntentInboundRouting({sourceId}:{sourceId?:number}={}) {
  const { data, isLoading, isError, error } = useIntentInboundRoutingRules(sourceId);
  const { mutate: saveRule, isPending: isSaving } = useSaveIntentInboundRoutingRule();
  const { mutate: retryRule, isPending: isRetrying } = useRetryIntentInboundRoutingRule();
  const { mutate: deleteRule, isPending: isDeleting } = useDeleteIntentInboundRoutingRule();
  const { mutate: consolidateRoutes, isPending: isConsolidating } = useConsolidateNoCategoryRoutes();
  const { toast } = useToast();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<IntentInboundRoutingRule | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"warm"|"hot"|"cold"|"all">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [productCategoryFilter, setProductCategoryFilter] = useState("all");
  const [cohortSequences, setCohortSequences] = useState<Record<string,number>>({});
  const [cohortJourneys, setCohortJourneys] = useState<Record<string,number>>({});
  const [reviewAccountId,setReviewAccountId]=useState<number|null>(null);

  const [formData, setFormData] = useState<IntentInboundRoutingRuleInput>({
    name: "",
    clientId: 0,
    classification: "warm",
    matchType: "fallback",
    productId: null,
    productName: null,
    categoryId: null,
    categoryName: null,
    keywords: [],
    journeyId: null,
    sequenceId: 0,
    priority: 10,
    enabled: true
  });
  const [keywordsStr, setKeywordsStr] = useState("");

  const filteredJourneys = useMemo(() => {
    if (!data) return [];
    if (formData.clientId) {
      return data.options.journeys.filter(j => j.clientId === formData.clientId);
    }
    return data.options.journeys;
  }, [data, formData.clientId]);

  const filteredProducts = useMemo(() => {
    if (!data) return [];
    if (productCategoryFilter!=="all") {
      return data.options.products.filter(p => p.categoryName === productCategoryFilter);
    }
    return data.options.products;
  }, [data, productCategoryFilter]);

  const cohortCategories=useMemo(()=>[...new Set((data?.cohorts??[]).map(cohort=>cohort.categoryName))].sort(),[data]);
  const visibleCohorts=useMemo(()=>(data?.cohorts??[]).filter(cohort=>
    (statusFilter==="all"||cohort.classification===statusFilter)
    &&(categoryFilter==="all"||cohort.categoryName===categoryFilter)
  ),[data,statusFilter,categoryFilter]);
  const visibleRuleCohorts=useMemo(()=>(data?.ruleCohorts??[]).filter(cohort=>
    statusFilter==="all"||cohort.classification==="all"||cohort.classification===statusFilter
  ),[data,statusFilter]);
  const needsAttention=useMemo(()=>visibleRuleCohorts.filter(cohort=>{
    const rule=data?.rules.find(item=>item.id===cohort.ruleId);
    return cohort.failed>0||cohort.pending>0
      ||cohort.accountCount>0&&(!rule?.journeyId||!rule.enabled
        ||!data?.options.sequences.some(sequence=>sequence.id===rule.sequenceId));
  }).sort((a,b)=>b.failed-a.failed||b.pending-a.pending||b.accountCount-a.accountCount
    ||a.name.localeCompare(b.name)),[visibleRuleCohorts,data]);
  const needsAttentionIds=new Set(needsAttention.map(cohort=>cohort.ruleId));
  const otherConfigured=visibleRuleCohorts.filter(cohort=>!needsAttentionIds.has(cohort.ruleId));
  const categoryCohorts=(data?.categoryCohorts??[]).filter(cohort=>
    statusFilter==="all"||cohort.classification===statusFilter);
  const cohortKey=(cohort:{clientId:number;productAffinity:string;classification:"hot"|"warm"|"cold"})=>
    `${cohort.clientId}:${cohort.productAffinity}:${cohort.classification}`;

  const handleOpenNew = (cohort?: {clientId:number;productAffinity:string;classification:"hot"|"warm"|"cold"}) => {
    const normalizedAffinity=cohort?.productAffinity.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const matchedProduct=cohort&&data?.options.products.find(product=>
      product.name.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()===normalizedAffinity);
    setEditingRule(null);
    setProductCategoryFilter(matchedProduct?.categoryName??"all");
    setFormData({
      name: cohort ? `${cohort.productAffinity} · ${cohort.classification}` : "",
      clientId: cohort?.clientId ?? 0,
      classification: "warm",
      matchType: cohort ? "product" : "fallback",
      productId: null,
      productName: matchedProduct?.name ?? null,
      categoryId: null,
      categoryName: matchedProduct?.categoryName ?? null,
      keywords: cohort ? [cohort.productAffinity] : [],
      journeyId: null,
      sequenceId: 0,
      priority: 10,
      enabled: true
    });
    setKeywordsStr(cohort?.productAffinity ?? "");
    setEditorOpen(true);
  };

  const handleOpenEdit = (rule: IntentInboundRoutingRule) => {
    setEditingRule(rule);
    setProductCategoryFilter(rule.inboundProductName?rule.inboundCategoryName??"all":"all");
    setFormData({
      name: rule.name,
      clientId: rule.clientId,
      classification: "warm",
      matchType: rule.matchType,
      productId: rule.productId,
      productName: rule.inboundProductName??null,
      categoryId: rule.categoryId,
      categoryName: rule.inboundCategoryName??null,
      keywords: rule.keywords || [],
      journeyId: rule.journeyId,
      sequenceId: rule.sequenceId,
      priority: rule.priority,
      enabled: rule.enabled
    });
    setKeywordsStr(rule.keywords ? rule.keywords.join(", ") : "");
    setEditorOpen(true);
  };

  const handleConnectCohort=(cohort:IntentInboundRoutingRulesResponse["cohorts"][number])=>{
    if(cohort.productAffinity==="No product selected"||cohort.classification!=="warm")return;
    const key=cohortKey(cohort),sequenceId=cohortSequences[key],journeyId=cohortJourneys[key];
    if(!sequenceId||!journeyId){toast({title:"Choose a journey and sequence",variant:"destructive"});return;}
    const normalizedAffinity=cohort.productAffinity.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    const matchedProduct=data?.options.products.find(product=>
      product.name.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()===normalizedAffinity);
     const existing=data?.rules.find(rule=>rule.clientId===cohort.clientId
       &&rule.matchType==="product"
       &&rule.classification===cohort.classification
        &&(matchedProduct ? rule.inboundProductName===matchedProduct.name
          &&rule.inboundCategoryName===matchedProduct.categoryName : rule.productId===null
         &&rule.keywords.some(keyword=>cohort.keywords.includes(keyword))));
    const payload:IntentInboundRoutingRuleInput={
      name:`${cohort.productAffinity} · ${cohort.classification}`,
      clientId:cohort.clientId,classification:cohort.classification,matchType:"product",
       productId:null,productName:matchedProduct?.name??null,categoryId:null,
       categoryName:matchedProduct?.categoryName??null,keywords:cohort.keywords,
       journeyId,sequenceId,priority:existing?.priority??10,enabled:true,
    };
    saveRule({id:existing?.id,data:payload},{
       onSuccess:res=>toast({title:"Product routing rule saved",description:`${res.routing.routed} eligible responses connected; ${res.routing.failed} still need attention. Existing routes were not changed.`}),
      onError:err=>toast({title:"Failed to connect cohort",description:err.message,variant:"destructive"}),
    });
  };

  const handleSave = () => {
    if (!formData.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    if (!formData.clientId) { toast({ title: "Client scope required", variant: "destructive" }); return; }
    if (!formData.sequenceId) { toast({ title: "Sequence required", variant: "destructive" }); return; }
    if (formData.enabled && !formData.journeyId) { toast({ title: "Choose a journey before enabling this rule", variant: "destructive" }); return; }

    if (formData.matchType === "product" && !formData.productName && !formData.productId && !keywordsStr.trim()) { toast({ title: "Choose a product or keep the affinity keyword", variant: "destructive" }); return; }
    if (formData.matchType === "category" && !formData.categoryName && !formData.categoryId) { toast({ title: "Category required for category rule", variant: "destructive" }); return; }

    const payload = {
      ...formData,
      keywords: keywordsStr.split(",").map(k => k.trim()).filter(Boolean)
    };

    saveRule({ id: editingRule?.id, data: payload }, {
      onSuccess: (res) => {
        toast({
          title: "Rule saved",
           description: `Rule applied. ${res.routing.routed} responses routed by this rule; ${res.routing.failed} need attention.`
        });
        setEditorOpen(false);
      },
      onError: (err) => {
        toast({ title: "Failed to save rule", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleToggle = (rule: IntentInboundRoutingRule, enabled: boolean) => {
    saveRule({
      id: rule.id,
      data: {
        name: rule.name,
        clientId: rule.clientId,
        classification: "warm",
        matchType: rule.matchType,
        productId: rule.productId,
        productName: rule.inboundProductName??null,
        categoryId: rule.categoryId,
        categoryName: rule.inboundCategoryName??null,
        keywords: rule.keywords,
        journeyId: rule.journeyId,
        sequenceId: rule.sequenceId,
        priority: rule.priority,
        enabled
      }
    }, {
      onSuccess: (res) => {
        toast({
          title: `Rule ${enabled ? "enabled" : "disabled"}`,
           description: enabled ? `${res.routing.routed} responses routed by this rule.` : ""
        });
      },
      onError: (err) => {
        toast({ title: "Failed to toggle rule", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleDelete = () => {
    if (!deleteId) return;
    deleteRule(deleteId, {
      onSuccess: () => {
        toast({ title: "Rule deleted" });
        setDeleteId(null);
      },
      onError: (err) => {
        toast({ title: "Failed to delete rule", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm p-12 flex items-center justify-center mb-4">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="bg-rose-50/50 rounded-xl border border-rose-200 shadow-sm p-6 text-center text-rose-600 mb-4">
        <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="font-bold text-sm">Failed to load routing rules</p>
        <p className="text-xs font-medium mt-1">{error?.message}</p>
      </div>
    );
  }

  if (!data) return null;

  const openCategoryRule=(cohort:IntentInboundRoutingRulesResponse["categoryCohorts"][number])=>{
    if(!data.options.categories.includes(cohort.categoryName)||cohort.categoryName==="Needs categorization")return;
    const existing=cohort.categoryName==="No Category"
      ?findNoCategoryRoute(data.rules,cohort.clientId,cohort.classification)
      :data.rules.find(rule=>rule.clientId===cohort.clientId
      &&rule.matchType==="category"
      &&rule.classification===cohort.classification
      &&rule.categoryName===cohort.categoryName);
    if(existing){handleOpenEdit(existing);return;}
    setEditingRule(null);
    setKeywordsStr("");
    if(cohort.classification!=="warm")return;
    const routeClassification="warm" as const;
    setFormData({
      name:`${cohort.categoryName} · ${routeClassification}`,clientId:cohort.clientId,
      classification:routeClassification,
      matchType:"category",categoryId:null,categoryName:cohort.categoryName,productId:null,productName:null,
      keywords:[],journeyId:null,sequenceId:0,priority:10,enabled:true,
    });
    setEditorOpen(true);
  };

  const renderConfiguredCohort=(cohort:IntentInboundRoutingRulesResponse["ruleCohorts"][number])=>{
    const rule=data.rules.find(item=>item.id===cohort.ruleId);
    return <div key={`rule-${cohort.ruleId}`} className={`flex flex-col gap-3 border-l-4 p-4 lg:flex-row lg:items-start lg:justify-between bg-white ${cohort.failed>0?"border-l-rose-400":cohort.pending>0?"border-l-amber-400":"border-l-emerald-500"}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-slate-900">{cohort.name}</span>
          <Badge variant="outline" className="font-bold text-slate-600 bg-slate-50 border-slate-200">{cohort.classification}</Badge>
          <Badge variant="outline" className="font-bold text-slate-600 bg-slate-50 border-slate-200">{cohort.matchType}</Badge>
          {!cohort.enabled&&<Badge variant="outline" className="font-bold text-slate-400 bg-slate-100 border-slate-200">Disabled</Badge>}
        </div>
        <p className="mt-1 text-xs font-medium text-slate-600">{cohort.accountCount} matched account{cohort.accountCount===1?"":"s"} · {cohort.routed} routed, {cohort.pending} pending, {cohort.failed} failed response{cohort.failed===1?"":"s"}</p>
        <p className="mt-1 text-xs font-medium text-slate-500">
          {rule?.journeyName??"No journey linked"} → {rule?.sequenceName??"No active sequence"}
        </p>
        <details className="mt-2 text-xs font-bold text-sky-600">
          <summary className="cursor-pointer">View {cohort.accountCount} account{cohort.accountCount===1?"":"s"} &amp; routing details</summary>
          {cohort.accounts.length===0?<p className="mt-2 text-slate-500 font-medium">No imported responses match this rule for the selected source and status. Check its client, lead status, product or keywords.</p>:
            <div className="mt-2 max-h-48 space-y-2 overflow-auto">
              {cohort.accounts.map(account=><div key={account.id} className="rounded-lg border border-slate-200/60 bg-white p-3 shadow-sm">
                <Button size="sm" variant="link" className="h-auto p-0 text-xs font-bold text-sky-600 hover:text-sky-700" onClick={()=>setReviewAccountId(account.id)}>{account.name}</Button>
                <span className="ml-2 text-slate-500 font-medium">{account.responses} response{account.responses===1?"":"s"}</span>
                {account.failures.map(reason=><p key={reason} className="mt-1 text-rose-600 font-semibold">Not connected: {reason}</p>)}
              </div>)}
            </div>}
        </details>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant="outline" className="font-bold bg-white text-slate-700 hover:bg-slate-50 shadow-sm" onClick={()=>{if(rule)handleOpenEdit(rule);}}>Edit destination</Button>
        {cohort.failed>0&&cohort.enabled&&<Button size="sm" variant="outline" className="font-bold border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800 shadow-sm bg-white" disabled={isRetrying} onClick={()=>retryRule({id:cohort.ruleId,sourceId},{
          onSuccess:result=>toast({title:"Retry finished",description:`${result.routing.routed} responses connected; ${result.routing.failed} still need attention. Expand the cohort for reasons.`}),
          onError:err=>toast({title:"Retry failed",description:err.message,variant:"destructive"}),
        })}>{isRetrying?<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin"/>:null}Retry failed</Button>}
      </div>
    </div>;
  };

  return (
    <>
        {(!data.rules.length||!data.options.sequences.length)&&<div role="status" data-testid="routing-configuration-warning" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          <p className="font-bold">Automatic routing is not configured in this environment.</p>
          {!data.rules.length&&<p className="mt-1">No saved routing rules are available here. Rules in a different environment are not automatically copied.</p>}
          {!data.options.sequences.length&&<p className="mt-1">No active email sequences are available. Configure and activate a sequence before enabling email routing; a draft sequence will not send.</p>}
        </div>}
        <p className="mb-4 text-xs text-slate-600">Only currently Warm contacts may enter journeys and their nurture sequences, using their client’s saved rules. Hot contacts are for telecaller follow-up, never journey routing. Cold contacts are not routed. Historical activity remains visible.</p>
        <details id="inbound-category-destinations" className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden mb-4">
          <summary className="cursor-pointer p-4 text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors">
            Configure category destinations
          </summary>
          <div className="border-t border-slate-100 p-0">
              <div className="bg-slate-50/50 p-4 border-b border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">Product category cohorts</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">Automatically grouped from original product answers, whether or not a route exists. A selected product/service is required: Hot means purchase within 3 months; Warm means over 3 and up to 6 months. Over 6 months, no clear horizon, or no product/service is Cold. Existing routes are preserved.</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <Select value={statusFilter} onValueChange={value=>setStatusFilter(value as "warm"|"hot"|"cold"|"all")}>
                  <SelectTrigger className="h-9 w-36 bg-white font-medium text-slate-700"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="hot">Hot</SelectItem>
                    <SelectItem value="warm">Warm</SelectItem>
                    <SelectItem value="cold">Cold</SelectItem>
                  </SelectContent>
                </Select>
                <span className="max-w-52 text-xs font-medium text-slate-500">Correct a category from an account’s original answers above.</span>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {categoryCohorts.map(cohort=>{
                const known=data.options.categories.includes(cohort.categoryName)&&cohort.categoryName!=="Needs categorization";
                const savedNoCategoryRoute=cohort.categoryName==="No Category"
                  ?findNoCategoryRoute(data.rules,cohort.clientId,cohort.classification):undefined;
                return <div key={`${cohort.clientId}-${cohort.categoryName}-${cohort.classification}`}
                  id={cohort.categoryName==="No Category"?`no-category-route-${cohort.clientId}`:undefined}
                  className="flex flex-col justify-between gap-4 p-4 md:flex-row md:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm text-slate-900">{cohort.categoryName}</span>
                      <Badge variant="outline" className={cohort.classification==="hot"?"border-rose-200 bg-rose-50 text-rose-700 font-bold":cohort.classification==="warm"?"border-amber-200 bg-amber-50 text-amber-700 font-bold":"border-slate-300 bg-slate-100 text-slate-700 font-bold"}>{cohort.classification}</Badge>
                    </div>
                    <p className="mt-1 text-xs font-medium text-slate-600">{cohort.accountCount} account{cohort.accountCount===1?"":"s"} · {cohort.contactCount} contact{cohort.contactCount===1?"":"s"} · {cohort.routed} routed · {cohort.pending} pending · {cohort.failed} failed</p>
                     <p className="mt-1 text-xs font-medium text-slate-500">{cohort.categoryName==="No Category"
                       ?"No product or category was provided. Already-routed responses keep their original destinations."
                      :`Interests: ${cohort.products.join(", ")}`}</p>
                     {savedNoCategoryRoute&&<p className="mt-1 text-xs font-semibold text-slate-700">
                       Saved route for {cohort.classification} responses: {savedNoCategoryRoute.journeyName??"No journey linked"} → {savedNoCategoryRoute.sequenceName??"No active sequence"}{!savedNoCategoryRoute.enabled?" (disabled)":""}
                     </p>}
                    <details className="mt-2 text-xs font-bold text-sky-600">
                      <summary className="cursor-pointer">Review {cohort.accountCount} account{cohort.accountCount===1?"":"s"} and original answers</summary>
                      <div className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-auto">
                        {cohort.accounts.map(account=><Button key={account.id} size="sm" variant="outline" className="h-auto whitespace-normal text-left text-xs bg-white text-slate-700 hover:text-sky-700 hover:bg-sky-50 shadow-sm" onClick={()=>setReviewAccountId(account.id)}>{account.name}</Button>)}
                      </div>
                    </details>
                  </div>
                   {known&&cohort.classification==="warm"?<Button size="sm" variant="outline" className="shrink-0 font-bold bg-white text-slate-700 hover:bg-slate-50 shadow-sm" onClick={()=>openCategoryRule(cohort)}>{cohort.categoryName==="No Category"?(savedNoCategoryRoute?"Edit saved route":cohort.pending>0?"Set route for pending & future":"Set route for future responses"):"Configure route"}</Button>
                    :<span className="text-xs font-semibold text-amber-700">Review the answer and assign a category before routing</span>}
                </div>;
              })}
              {categoryCohorts.length===0&&<p className="p-6 text-sm font-medium text-slate-500 text-center">No product category interests found for this status. Check the Drive source mapping for product interest and purchase timeline.</p>}
            </div>
          </div>
        </details>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200/60 bg-white p-5 shadow-sm mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">Automatic journey and sequence routing</h2>
            <p className="mt-1 text-sm font-medium text-slate-500">{data.summary.routed} routed · {data.summary.pending} pending · {data.summary.failed} failed responses. Rules below control matching; already-routed responses keep their destination.</p>
            {data.summary.failed>0?<p className="mt-1 text-xs font-bold text-rose-600">Next: open a route needing action, check its failure reasons, then retry.</p>
              :data.summary.pending>0?<p className="mt-1 text-xs font-bold text-amber-600">Next: configure a category route or open unconfigured interests below to connect pending responses.</p>
              :<p className="mt-1 text-xs font-bold text-emerald-600">No routing failures or pending responses across inbound sources.</p>}
          </div>
          <Button size="sm" className="font-bold bg-sky-600 hover:bg-sky-700 text-white shadow-sm" onClick={()=>handleOpenNew()}>Add routing rule</Button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm mb-4 overflow-hidden" id="inbound-product-cohorts">
          <div className="border-b border-slate-100 bg-slate-50/50 p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Routing needs action</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  These cohorts come from the routing rules below. Failed or pending responses, and destinations needing attention, appear first.
                </p>
              </div>
            </div>
          </div>
          <div className="p-0">
            <div className="divide-y divide-slate-100">
              {needsAttention.map(renderConfiguredCohort)}
              {needsAttention.length===0&&<p className="p-6 text-sm font-medium text-slate-500 text-center">No configured cohorts need attention for this status. Failed or pending responses will appear here.</p>}
            </div>
          </div>
        </div>

        <details className="rounded-xl border border-slate-200/60 bg-white shadow-sm mb-4 overflow-hidden">
          <summary className="cursor-pointer p-4 text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors">Other configured routes ({otherConfigured.length})</summary>
          <div className="border-t border-slate-100 bg-slate-50/50 pb-4 p-4">
            <h3 className="text-sm font-bold text-slate-900">Other configured routes</h3>
            <p className="mt-1 text-xs font-medium text-slate-500">Also fed by the routing rules below. Includes completed, idle and newly saved cohorts with no matching responses yet.</p>
          </div>
          <div className="divide-y divide-slate-100 border-t border-slate-100 bg-white">
            {otherConfigured.map(renderConfiguredCohort)}
            {otherConfigured.length===0&&<p className="p-6 text-sm font-medium text-slate-500 text-center">No other configured cohorts match this status. Add or edit a rule below.</p>}
          </div>
        </details>

        <details className="rounded-xl border border-slate-200/60 bg-white shadow-sm mb-4 overflow-hidden">
          <summary className="cursor-pointer p-4 text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors">Product interests needing a specific route ({visibleCohorts.length})</summary>
          <div className="border-t border-slate-100">
            <div className="bg-slate-50/50 p-4 border-b border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Unconfigured product interests</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">From original answers, not a second routing rule list. Interests without a specific enabled product or category rule appear here. Create a rule for pending and future responses; existing routes are not replaced.</p>
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="h-9 w-full sm:w-52 bg-white font-medium text-slate-700"><SelectValue placeholder="All categories" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All product categories</SelectItem>
                  {cohortCategories.map(category=><SelectItem key={category} value={category}>{category}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="p-0 bg-white">
              {data.options.sequences.length === 0 && (
                <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                  No active sequences available. <Link href="/sequences" className="font-bold underline text-amber-700">Open Sequences</Link> to activate one before connecting contacts.
                </div>
              )}
              <div className="divide-y divide-slate-100">
                {visibleCohorts.map(cohort => {
                  const key=cohortKey(cohort);
                  return (
                  <div key={key} className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900">{cohort.productAffinity}</span>
                        <Badge variant="outline" className={cohort.classification==="hot"?"border-rose-200 bg-rose-50 text-rose-700 font-bold":"border-amber-200 bg-amber-50 text-amber-700 font-bold"}>
                          {cohort.classification}
                        </Badge>
                        <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600 font-bold">{cohort.categoryName}</Badge>
                      </div>
                      <p className="mt-1 text-xs font-medium text-slate-500">
                        {cohort.accountCount} account{cohort.accountCount===1?"":"s"} · {cohort.contactCount} contact{cohort.contactCount===1?"":"s"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-3 text-[11px] font-bold">
                         <span className="text-emerald-600">{cohort.routed} routed responses</span>
                         <span className="text-amber-600">{cohort.pending} pending responses</span>
                         <span className="text-rose-600">{cohort.failed} failed responses</span>
                      </div>
                      {cohort.routed>0&&<p className="mt-1 text-[11px] font-medium text-slate-500">Already-routed responses keep their original destination, including broader fallback routes.</p>}
                      <details className="mt-2 text-xs font-bold text-sky-600">
                        <summary className="cursor-pointer" data-testid={`button-view-cohort-accounts-${key}`}>View {cohort.accountCount} account{cohort.accountCount===1?"":"s"} &amp; verify answers</summary>
                        <div className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-auto">
                          {cohort.accounts.map(account=><Button key={account.id} size="sm" variant="outline" className="h-auto whitespace-normal text-left text-xs bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-700 shadow-sm" onClick={()=>setReviewAccountId(account.id)} data-testid={`button-review-cohort-account-${account.id}`}>{account.name}</Button>)}
                        </div>
                      </details>
                    </div>
                     {cohort.productAffinity!=="No product selected"&&cohort.classification==="warm" ? <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                       <Select value={cohortJourneys[key]?String(cohortJourneys[key]):""} onValueChange={value=>setCohortJourneys(current=>({...current,[key]:Number(value)}))}>
                         <SelectTrigger className="h-9 w-full sm:w-48 font-medium text-slate-700"><SelectValue placeholder="Choose journey" /></SelectTrigger>
                         <SelectContent>{data.options.journeys.filter(journey=>journey.clientId===cohort.clientId).map(journey=><SelectItem key={journey.id} value={String(journey.id)}>{journey.name}</SelectItem>)}</SelectContent>
                       </Select>
                      <Select value={cohortSequences[key]?String(cohortSequences[key]):""} onValueChange={value=>setCohortSequences(current=>({...current,[key]:Number(value)}))} disabled={data.options.sequences.length===0}>
                        <SelectTrigger className="h-9 w-full sm:w-56 font-medium text-slate-700"><SelectValue placeholder={data.options.sequences.length ? "Choose active sequence" : "No active sequences"} /></SelectTrigger>
                        <SelectContent>{data.options.sequences.map(sequence=><SelectItem key={sequence.id} value={String(sequence.id)}>{sequence.name}</SelectItem>)}</SelectContent>
                      </Select>
                       <Button size="sm" className="h-9 shrink-0 bg-emerald-600 hover:bg-emerald-700 text-xs font-bold text-white shadow-sm" disabled={!cohortJourneys[key]||!cohortSequences[key]||isSaving} onClick={()=>handleConnectCohort(cohort)}>
                        {isSaving?<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin"/>:<ArrowRight className="mr-1.5 h-3.5 w-3.5"/>}
                        Create routing rule
                      </Button>
                      <Button size="sm" variant="ghost" className="h-9 text-xs font-bold text-slate-600 hover:text-slate-900" onClick={()=>handleOpenNew(cohort)}>Advanced</Button>
                    </div> : <span className="text-xs font-bold text-amber-700">{cohort.classification==="hot"?"Hot: telecaller follow-up only; no journey":"Only Warm contacts may be routed"}</span>}
                  </div>
                )})}
                {visibleCohorts.length===0&&<div className="p-8 text-center text-sm font-medium text-slate-500">
                   No unconfigured affinities match these filters. Interests covered by a specific rule are listed in the configured cohorts above.
                </div>}
              </div>
            </div>
          </div>
        </details>

      <details className="rounded-xl border border-slate-200/60 bg-white shadow-sm mb-4 overflow-hidden">
        <summary className="cursor-pointer p-4 text-sm font-bold text-slate-800 hover:bg-slate-50 transition-colors">Edit routing rules ({data.rules.length})</summary>
        <div className="border-t border-slate-100">
          <div className="bg-slate-50/50 p-4 border-b border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Routing rule configuration</h3>
              <p className="mt-1 text-xs font-medium text-slate-500">
                These rules determine automatic journey and sequence connections. Product interests without a specific enabled rule remain visible above.
                <br />
                Rules are evaluated in order: Product &rarr; Category &rarr; Fallback.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <Button onClick={()=>handleOpenNew()} size="sm" className="h-8 text-xs font-bold bg-sky-600 hover:bg-sky-700 text-white shadow-sm">
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Rule
              </Button>
            </div>
          </div>
          {data.rules.filter(rule=>rule.matchType==="category"&&rule.categoryName==="No Category"
            &&rule.classification==="all"&&rule.enabled).map(canonical=>{
            const duplicates=data.rules.filter(rule=>rule.id!==canonical.id&&rule.clientId===canonical.clientId
              &&rule.matchType==="category"&&rule.categoryName==="No Category"
              &&rule.productId===null&&rule.categoryId===null&&!rule.inboundProductName
              &&rule.keywords.length===0&&rule.enabled===canonical.enabled
              &&rule.priority===canonical.priority&&rule.journeyId===canonical.journeyId
              &&rule.sequenceId===canonical.sequenceId);
            return duplicates.length>0?<div key={canonical.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
              <span>{data.options.clients.find(client=>client.id===canonical.clientId)?.name??"Client"} has {duplicates.length} overlapping No Category route{duplicates.length===1?"":"s"}. Consolidation keeps historical routing and checks unresolved responses before removing unused rules.</span>
              <Button size="sm" variant="outline" disabled={isConsolidating} onClick={()=>consolidateRoutes(canonical.clientId,{
                onSuccess:result=>toast({title:"Duplicate routes consolidated",description:`Removed ${result.removedIds.length} unused routes; ${result.retainedIds.length} history-linked routes were retained. Existing enrollments were not changed.`}),
                onError:err=>toast({title:"Could not consolidate routes",description:err.message,variant:"destructive"}),
              })}>Consolidate duplicate routes</Button>
            </div>:null;
          })}
          <div className="p-0 bg-white">
            {data.rules.length === 0 ? (
              <div className="p-8 text-center text-slate-500">
                <p className="text-sm font-medium">No routing rules configured.</p>
                <p className="text-xs font-medium mt-1">Inbound contacts will remain pending until a matching rule is configured.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {data.rules.map((rule) => (
                  <div key={rule.id} className="p-5 flex items-start gap-4 hover:bg-slate-50 transition-colors">
                    <div className="pt-1">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(c) => handleToggle(rule, c)}
                        className="data-[state=checked]:bg-sky-600"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-slate-900 text-sm">{rule.name}</span>
                        {rule.matchType === "product" && <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200 text-[9px] uppercase tracking-widest px-1.5 py-0 font-bold">Product</Badge>}
                        {rule.matchType === "category" && <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[9px] uppercase tracking-widest px-1.5 py-0 font-bold">Category</Badge>}
                        {rule.matchType === "fallback" && <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-200 text-[9px] uppercase tracking-widest px-1.5 py-0 font-bold">Fallback</Badge>}
                        <Badge variant="outline" className="text-[9px] uppercase tracking-widest px-1.5 py-0 font-bold text-slate-600">{rule.classification==="hot"?"Hot rule: blocked":"Warm only"}</Badge>
                        {!rule.enabled && <Badge variant="outline" className="bg-slate-100 text-slate-400 border-slate-200 text-[9px] uppercase tracking-widest px-1.5 py-0 font-bold">Disabled</Badge>}
                      </div>
                      <div className="text-xs text-slate-600 font-medium">
                        {rule.matchType === "product" && (
                           <span><span className="text-slate-400">When intent matches product </span>{rule.productName??"(keywords only)"}</span>
                        )}
                        {rule.matchType === "category" && (
                          <span><span className="text-slate-400">When intent matches category </span>{rule.categoryName}</span>
                        )}
                        {rule.matchType === "fallback" && (
                          <span className="text-slate-400">When no product or category rules match</span>
                        )}
                        {rule.keywords && rule.keywords.length > 0 && (
                          <span className="ml-1"><span className="text-slate-400">or keywords </span>{rule.keywords.join(", ")}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-2 text-[11px] font-bold text-slate-500">
                        <ArrowRight className="w-3 h-3 text-slate-400" />
                        {rule.journeyName && <><span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">{rule.journeyName}</span><span className="text-slate-400">&</span></>}
                        {!rule.journeyName&&<span className="text-amber-600">No journey linked ·</span>}
                        <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">{rule.sequenceName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => handleOpenEdit(rule)} className="h-8 text-xs font-bold text-slate-600 hover:text-slate-900 bg-white border border-slate-200 shadow-sm hover:bg-slate-50">Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(rule.id)} className="h-8 w-8 p-0 text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100"><X className="w-4 h-4" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="bg-slate-50 p-4 border-t border-slate-200 flex items-center justify-between text-xs font-medium text-slate-500">
              <span className="font-bold text-slate-700">System Status</span>
              <div className="flex gap-4 font-mono text-[11px]">
                <span><strong className="text-slate-900 text-xs">{data.summary.routed}</strong> Routed</span>
                <span><strong className="text-amber-600 text-xs">{data.summary.pending}</strong> Pending</span>
                <span><strong className="text-rose-600 text-xs">{data.summary.failed}</strong> Failed</span>
              </div>
            </div>
          </div>
        </div>
      </details>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl bg-white border-slate-200 shadow-xl rounded-xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-black text-slate-900">{editingRule ? "Edit Routing Rule" : "Create Routing Rule"}</DialogTitle>
            <DialogDescription className="font-medium text-slate-500">
              Map an inbound product-affinity cohort to an active sequence, with an optional journey.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Rule Name</Label>
                <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Enterprise Software Routing" className="h-10 font-medium focus-visible:ring-sky-500" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Client Scope</Label>
                <Select value={formData.clientId ? String(formData.clientId) : ""} onValueChange={v => setFormData({ ...formData, clientId: Number(v), journeyId: 0 })}>
                  <SelectTrigger className="h-10 font-medium focus:ring-sky-500"><SelectValue placeholder="Select client..." /></SelectTrigger>
                  <SelectContent>
                    {data.options.clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Lead status</Label>
              <Select value="warm" disabled>
                <SelectTrigger className="h-10 font-medium focus:ring-sky-500"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="warm">Warm only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="border border-slate-200/60 rounded-xl p-5 bg-slate-50/50 space-y-4 shadow-sm">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">When intent matches</Label>
                 <Select value={formData.matchType} onValueChange={v => setFormData({ ...formData, matchType: v as any, productId: null, productName:null,categoryId: null,categoryName:null })}>
                  <SelectTrigger className="h-10 font-medium bg-white focus:ring-sky-500"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="product">Specific Product</SelectItem>
                    <SelectItem value="category">Specific Category</SelectItem>
                    <SelectItem value="fallback">Broad Fallback (Catch-all)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formData.matchType === "product" && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Filter Products by Category</Label>
                     <Select value={productCategoryFilter} onValueChange={v => {setProductCategoryFilter(v);setFormData({ ...formData, categoryName:null, productId:null,productName:null });}}>
                      <SelectTrigger className="h-10 font-medium bg-white focus:ring-sky-500"><SelectValue placeholder="All Categories" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Categories</SelectItem>
                         {data.options.categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Product</Label>
                     <Select value={formData.productName ? `${formData.categoryName}:${formData.productName}` : ""} onValueChange={v => {
                       const choice=data.options.products.find(p=>`${p.categoryName}:${p.name}`===v);
                       if(choice)setFormData({...formData,productId:null,productName:choice.name,categoryId:null,categoryName:choice.categoryName});
                     }}>
                      <SelectTrigger className="h-10 font-medium bg-white focus:ring-sky-500"><SelectValue placeholder="Select Product..." /></SelectTrigger>
                      <SelectContent>
                         {filteredProducts.map(p => <SelectItem key={`${p.categoryName}:${p.name}`} value={`${p.categoryName}:${p.name}`}>{p.name}</SelectItem>)}
                        {filteredProducts.length === 0 && <SelectItem value="none" disabled>No products available</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
               {formData.matchType==="product"&&formData.productId&&!formData.productName&&
                 <p className="text-xs text-amber-700">This existing rule uses a legacy catalog product. Choose an inbound product to update it, or leave it unchanged.</p>}

              {formData.matchType === "category" && (
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Category</Label>
                   <Select value={formData.categoryName??""} onValueChange={v => setFormData({ ...formData, categoryId:null,categoryName:v })}>
                    <SelectTrigger className="h-10 font-medium bg-white focus:ring-sky-500"><SelectValue placeholder="Select Category..." /></SelectTrigger>
                    <SelectContent>
                       {data.options.categories.filter(c=>c!=="Needs categorization").map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
               {formData.matchType==="category"&&formData.categoryId&&!formData.categoryName&&
                 <p className="text-xs text-amber-700">This existing rule uses a legacy catalog category. Choose an inbound category to update it, or leave it unchanged.</p>}

              {formData.matchType !== "fallback" && <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Or contains keywords (comma separated, optional)</Label>
                <Input value={keywordsStr} onChange={e => setKeywordsStr(e.target.value)} placeholder="e.g. enterprise, compliance, sla" className="h-10 font-medium bg-white focus-visible:ring-sky-500" />
              </div>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-emerald-600">Optional Journey</Label>
                <Select value={formData.journeyId ? String(formData.journeyId) : "none"} onValueChange={v => setFormData({ ...formData, journeyId: v==="none"?null:Number(v) })}>
                  <SelectTrigger className="h-10 font-medium border-emerald-200 focus:ring-emerald-500 bg-emerald-50/30"><SelectValue placeholder="No journey" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No journey</SelectItem>
                    {filteredJourneys.map(j => <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>)}
                    {filteredJourneys.length === 0 && <SelectItem value="none" disabled>No journeys available</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase font-bold tracking-widest text-emerald-600">And Add to Sequence</Label>
                <Select value={formData.sequenceId ? String(formData.sequenceId) : ""} onValueChange={v => setFormData({ ...formData, sequenceId: Number(v) })}>
                  <SelectTrigger className="h-10 font-medium border-emerald-200 focus:ring-emerald-500 bg-emerald-50/30"><SelectValue placeholder="Select Sequence..." /></SelectTrigger>
                  <SelectContent>
                    {data.options.sequences.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                    {data.options.sequences.length === 0 && <SelectItem value="none" disabled>No active sequences</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="flex items-center gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200/60 shadow-sm">
              <Switch checked={formData.enabled} onCheckedChange={c => setFormData({ ...formData, enabled: c })} className="data-[state=checked]:bg-sky-600" />
              <div className="text-sm">
                <span className="font-bold text-slate-900 block">Enable Rule</span>
                <span className="text-xs font-medium text-slate-500">Saving an enabled rule will immediately route pending contacts.</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={isSaving} className="font-bold text-slate-700 h-10 shadow-sm">Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving} className="bg-sky-600 hover:bg-sky-700 text-white font-bold h-10 shadow-sm">
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="max-w-sm rounded-xl border-slate-200 shadow-xl bg-white">
          <DialogHeader>
            <DialogTitle className="text-rose-600 flex items-center gap-2 font-black">
              <AlertTriangle className="w-5 h-5" /> Delete Routing Rule
            </DialogTitle>
            <DialogDescription className="font-medium text-slate-600 mt-2">
              Are you sure you want to delete this routing rule? Future inbound contacts that would have matched this rule will fall back to other rules or remain pending.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={isDeleting} className="font-bold text-slate-700 shadow-sm">Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting} className="font-bold shadow-sm bg-rose-600 hover:bg-rose-700">
              {isDeleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Delete Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <InboundResponseDialog accountId={reviewAccountId} onClose={()=>setReviewAccountId(null)}/>
    </>
  );
}
