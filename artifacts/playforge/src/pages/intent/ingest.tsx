import { useState, useRef } from "react";
import { useIntentGoogleSheetRead, useIntentImportsPreview, useIntentImportsCommit, useIntentImports, useIntentScopeOptions } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileText, CheckCircle, AlertCircle, ArrowRight, Loader2, FileSpreadsheet, Layers, History, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link, useLocation } from "wouter";
import { formatReportDate } from "@/lib/reportTime";
import * as XLSX from "xlsx";
import Papa from "papaparse";

type ImportKind = "account_list" | "baseline" | "firmographic" | "event_feedback" | "event_questionnaire" | "lead_form" | "product_buy_intent" | "consulting";

const kinDLabels: Record<string, string> = {
  account_list: "Accounts & contacts",
  baseline: "Baseline Scores",
  firmographic: "Firmographic Data",
  event_feedback: "Event Feedback",
  event_questionnaire: "Event questionnaires",
  lead_form: "Lead-form responses",
  product_buy_intent: "Product Buy Intent",
  consulting: "Consulting Insights",
};

const KINDS: { value: ImportKind; label: string; desc: string; icon: any }[] = [
  { value: "account_list", label: "Accounts & contacts", desc: "Seed accounts, domains, industries, regions and buying roles.", icon: FileSpreadsheet },
  { value: "lead_form", label: "Lead-form responses", desc: "Map declared challenges, timing, interest and consented details.", icon: Layers },
  { value: "event_questionnaire", label: "Event questionnaires", desc: "Add priorities, pain points, evaluation stage and demo requests.", icon: FileText },
];

const canonicalFields = new Set([
  "account_name", "domain", "industry", "size", "contact_name", "first_name", "last_name",
  "email", "phone", "title", "signal_type", "source", "external_id", "summary", "strength",
  "captured_at", "vertical", "function", "baseline_score", "kaboom_tag", "product_interest",
  "knowledge_interest", "product_service_interest", "purchase_timeframe", "follow_up_date", "follow_up_time", "business_challenge",
  "challenges", "rating", "event_rating", "session_rating", "comments", "form_name", "campaign", "lead_source",
  "response_text", "qualification", "budget", "decision_role",
]);

const headerAliases: Record<string, string> = {
  account: "account_name",
  company: "account_name",
  company_name: "account_name",
  accountname: "account_name",
  companyname: "account_name",
  website: "domain",
  company_domain: "domain",
  contact_email: "email",
  email_address: "email",
  mobile: "phone",
  mob_no: "phone",
  name: "contact_name",
  tag: "kaboom_tag",
  phone_number: "phone",
  designation: "title",
  job_title: "title",
  event_date: "captured_at",
  date: "captured_at",
  score: "baseline_score",
  intent_score: "baseline_score",
  notes: "summary",
  feedback: "summary",
  feedback_notes: "summary",
  product: "product_interest",
  product_interest: "product_interest",
  product_service_interest: "product_interest",
  service_interest: "product_interest",
  interested_product: "product_interest",
  topics_for_future: "knowledge_interest",
  future_topics: "knowledge_interest",
  topics_you_want_us_to_cover_in_future: "knowledge_interest",
  purchase_timeframe: "purchase_timeframe",
  buying_timeframe: "purchase_timeframe",
  purchase_timeline: "purchase_timeframe",
  when_do_you_plan_to_purchase: "purchase_timeframe",
  follow_up_date: "follow_up_date",
  preferred_follow_up_date: "follow_up_date",
  follow_up_time: "follow_up_time",
  preferred_follow_up_time: "follow_up_time",
  business_challenge: "business_challenge",
  business_challenges: "business_challenge",
  challenge: "business_challenge",
  challenges: "business_challenge",
  event_rating: "event_rating",
  overall_event_rating: "event_rating",
  session_rating: "session_rating",
  comments: "comments",
  comment: "comments",
  additional_comments: "comments",
  form: "form_name",
  form_title: "form_name",
  questionnaire: "form_name",
  questionnaire_name: "form_name",
  campaign_name: "campaign",
  source_name: "lead_source",
  response: "response_text",
  answer: "response_text",
  lead_status: "qualification",
  qualification_status: "qualification",
  lead_qualification: "qualification",
  qualified: "qualification",
  budget_range: "budget",
  available_budget: "budget",
  approved_budget: "budget",
  estimated_budget: "budget",
  role_in_decision: "decision_role",
  role_in_decision_making: "decision_role",
  decision_making_role: "decision_role",
  decision_maker: "decision_role",
  buying_role: "decision_role",
  rating: "rating",
  score_rating: "rating",
  id: "external_id",
};

const buyIntentFields = [
  { key: "knowledge_interest", label: "Knowledge intent · future topics" },
  { key: "product_interest", label: "Product / service interest" },
  { key: "budget", label: "Budget" },
  { key: "purchase_timeframe", label: "Purchase timeframe" },
  { key: "decision_role", label: "Decision role" },
  { key: "qualification", label: "Qualification" },
  { key: "follow_up_date", label: "Follow-up date" },
  { key: "follow_up_time", label: "Follow-up time" },
  { key: "business_challenge", label: "Business challenge" },
  { key: "event_rating", label: "Event rating" },
  { key: "session_rating", label: "Session rating" },
  { key: "comments", label: "Comments" },
];

function inferCanonicalField(header: string): string {
  const normalized = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (canonicalFields.has(normalized)) return normalized;
  if (headerAliases[normalized]) return headerAliases[normalized];
  if (normalized.includes("interested_to_know_more") && normalized.includes("hp_services")) return "product_interest";
  if (normalized.includes("topics") && normalized.includes("cover") && normalized.includes("future")) return "knowledge_interest";
  if (normalized.includes("interested") && normalized.includes("following") && (normalized.includes("services") || normalized.includes("solutions"))) return "product_interest";
  if (normalized.includes("estimated_timeframe") && normalized.includes("purchase")) return "purchase_timeframe";
  if (normalized.includes("budget")) return "budget";
  if ((normalized.includes("role") || normalized.includes("involvement")) && normalized.includes("decision")) return "decision_role";
  if (normalized.includes("qualified") || normalized.includes("qualification")) return "qualification";
  if (normalized.includes("suitable_date") && normalized.includes("connect")) return "follow_up_date";
  if (normalized === "suitable_time" || normalized.includes("suitable_time")) return "follow_up_time";
  if (normalized.includes("challenge") || normalized.includes("pain_point") || normalized.includes("problem_to_solve")) return "business_challenge";
  if (normalized.includes("overall_experience") && normalized.includes("gathering")) return "event_rating";
  if (normalized.includes("rating") || normalized.includes("rate_the_session") || normalized.includes("rate_the_quality") || normalized.includes("solution_demo")) return "session_rating";
  if (normalized.includes("any_other_feedback") || normalized.includes("suggestions_on_other_activities")) return "comments";
  return "ignore";
}

function normalizedValue(row: any, canonical: string): unknown {
  const camel = canonical.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = row.normalized?.[camel] ?? row.normalized?.[canonical] ?? row.normalized?.mappedPayload?.[canonical] ?? "";
  if ((canonical === "captured_at" || canonical === "follow_up_date") && typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return formatReportDate(value);
    }
  }
  return value;
}

function matchLabel(match: any): string {
  if (match?.conflict) return "Identity conflict";
  if (match?.contactId) return `Contact #${match.contactId}${match.accountId ? ` · Account #${match.accountId}` : ""}`;
  if (match?.accountId) return `Account #${match.accountId}`;
  if (match?.willCreateAccount && match?.willCreateContact) return "Will add account + contact";
  if (match?.willCreateAccount) return "Will add account";
  if (match?.willCreateContact) return "Will add contact";
  return "Unmatched";
}

export default function IntentIngestPage() {
  const [, setLocation] = useLocation();
  const [kind, setKind] = useState<ImportKind>("account_list");
  const [file, setFile] = useState<File | null>(null);
  const [clientId, setClientId] = useState<string>("all");
  const [productId, setProductId] = useState<string>("all");
  const [audienceId, setAudienceId] = useState<string>("all");
  const [step, setStep] = useState<"upload" | "mapping" | "preview" | "done">("upload");
  const [previewData, setPreviewData] = useState<any>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [googleSheet, setGoogleSheet] = useState("");
  const [googleRange, setGoogleRange] = useState("");
  const [googleSourceName, setGoogleSourceName] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: scopeOptions } = useIntentScopeOptions();
  const { data: history, isLoading: historyLoading } = useIntentImports();
  const previewMutation = useIntentImportsPreview();
  const commitMutation = useIntentImportsCommit();
  const googleSheetMutation = useIntentGoogleSheetRead();
  const productRequired = kind === "product_buy_intent";
  const productInferred = kind === "event_questionnaire" || kind === "lead_form";

  const handleClientChange = (val: string) => {
    setClientId(val);
    const newClientNum = val === "all" ? undefined : Number(val);
    const audienceObj = scopeOptions?.audiences?.find((a: any) => a.id === Number(audienceId));
    if (audienceObj && audienceObj.clientId && audienceObj.clientId !== newClientNum) {
      setAudienceId("all");
    }
  };

  const requireProductForBuyIntent = () => {
    if (productRequired && productId === "all") {
      toast({ title: "Product required", description: "Choose the product this evidence applies to before continuing.", variant: "destructive" });
      return false;
    }
    return true;
  };

  const processRows = (rows: any[], headers: string[], sourceName?: string) => {
    if (rows.length > 5000) {
      toast({ title: "Source too large", description: "Maximum 5000 rows allowed.", variant: "destructive" });
      return;
    }
    const initialMappings: Record<string, string> = {};
    headers.forEach(header => {
      initialMappings[header] = inferCanonicalField(header);
    });
    setMappings(initialMappings);
    if(sourceName)setGoogleSourceName(sourceName);
    previewMutation.mutate({
      kind,
      clientId: clientId !== "all" ? Number(clientId) : undefined,
      productId: productId !== "all" ? Number(productId) : undefined,
      audienceId: audienceId !== "all" ? Number(audienceId) : undefined,
      rows,
      mapping: initialMappings,
    }, {
      onSuccess: data => {
        setPreviewData({ ...data, rawRows: rows });
        setStep("mapping");
      },
      onError: err => {
        toast({ title: "Preview failed", description: err.message, variant: "destructive" });
      },
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setIdempotencyKey(crypto.randomUUID());
      // Wait for product selection before uploading
    }
  };

  const handleCardClick = (selectedKind: ImportKind) => {
    setKind(selectedKind);
    fileRef.current?.click();
  };

  const handleGoogleSheet = () => {
    if(!googleSheet.trim()){
      toast({title:"Google Sheet required",description:"Paste a Google Sheets URL or spreadsheet ID.",variant:"destructive"});
      return;
    }
    if(!["event_questionnaire","lead_form"].includes(kind)){
      toast({title:"Choose a response type",description:"Google Sheets imports are available for questionnaires and lead forms.",variant:"destructive"});
      return;
    }
    setIdempotencyKey(crypto.randomUUID());
    setFile(null);
    googleSheetMutation.mutate({spreadsheet:googleSheet.trim(),range:googleRange.trim()||undefined},{
      onSuccess:data=>processRows(data.rows,data.headers,`${data.title} · ${data.range}`),
      onError:err=>toast({title:"Could not read Google Sheet",description:err.message,variant:"destructive"}),
    });
  };

  const handleUpload = () => {
    if (!file) {
      toast({ title: "No file", description: "Select a file to upload.", variant: "destructive" });
      return;
    }
    if (!requireProductForBuyIntent()) return;
    if (kind === "account_list" && clientId === "all") {
      toast({ title: "Client required", description: "Select a client for this account list.", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;

      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = new TextDecoder().decode(result as ArrayBuffer);
        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            processRows(results.data, results.meta.fields || []);
          }
        });
      } else {
        const workbook = XLSX.read(result, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

        if (json.length > 0) {
          const headers = Object.keys(json[0] as object);
          processRows(json, headers);
        } else {
          toast({ title: "Empty file", description: "No data found in spreadsheet.", variant: "destructive" });
        }
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleRePreview = () => {
    if (!requireProductForBuyIntent()) return;
    previewMutation.mutate({
      kind,
      clientId: clientId !== "all" ? Number(clientId) : undefined,
      productId: productId !== "all" ? Number(productId) : undefined,
      audienceId: audienceId !== "all" ? Number(audienceId) : undefined,
      rows: previewData.rawRows,
      mapping: mappings
    }, {
      onSuccess: (data) => {
        setPreviewData({ ...data, rawRows: previewData.rawRows });
        setStep("preview");
      }
    });
  };

  const handleCommit = () => {
    if (!requireProductForBuyIntent()) return;
    commitMutation.mutate({
      kind,
      clientId: clientId !== "all" ? Number(clientId) : undefined,
      productId: productId !== "all" ? Number(productId) : undefined,
      audienceId: audienceId !== "all" ? Number(audienceId) : undefined,
      rows: previewData.rawRows,
      mapping: mappings,
      idempotencyKey,
      fileName: file?.name || googleSourceName || undefined
    }, {
      onSuccess: () => {
        setStep("done");
      },
      onError: (err) => {
        toast({ title: "Import failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const reset = () => {
    setFile(null);
    setStep("upload");
    setPreviewData(null);
    setMappings({});
    setGoogleSourceName("");
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader
        title="First-party signal hub"
        breadcrumbs="FORMS, EVENTS AND CRM FILES"
      />

      <div className="p-6 max-w-[1200px] mx-auto w-full space-y-6">

        {/* Dark Hero Banner */}
        <div className="bg-[#0F2B20] text-stone-300 rounded-xl p-8 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#bef264]/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
          <div className="relative z-10">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#8BAA9D] mb-2">First-party evidence</p>
            <h2 className="text-xl font-bold text-white mb-2">Add what prospects told you directly</h2>
            <p className="text-xs font-medium text-[#8BAA9D]">
              Direct responses receive more weight than inferred interest—but only for the category and contact they support.
            </p>
          </div>
          <div className="relative z-10 shrink-0">
            <Button className="bg-[#bef264] hover:bg-[#a3e635] text-[#0F2B20] font-bold h-10 px-6" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" /> Upload new file
            </Button>
          </div>
        </div>

        {/* Hidden input for file selection */}
        <input data-testid="file-input" type="file" ref={fileRef} className="hidden" accept=".csv,.xls,.xlsx" onChange={handleFileChange} />

        {/* Upload State */}
        {step === "upload" && (
          <div className="space-y-6">
            {!file ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="md:col-span-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-6 shadow-sm">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-end">
                    <div className="flex-1">
                      <div className="mb-3 flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-emerald-200 bg-white text-emerald-700"><Link2 className="h-4 w-4" /></div>
                        <div>
                          <h3 className="text-[15px] font-bold text-stone-900">Import from Google Sheets</h3>
                          <p className="text-xs font-medium text-stone-500">Responses use the same mapping, preview, matching and explicit first-party scoring rules as uploaded files.</p>
                        </div>
                      </div>
                      <Label className="text-[10px] font-black uppercase tracking-widest text-stone-500">Spreadsheet URL or ID</Label>
                      <Input value={googleSheet} onChange={event=>setGoogleSheet(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" className="mt-1 bg-white" />
                    </div>
                    <div className="w-full lg:w-64">
                      <Label className="text-[10px] font-black uppercase tracking-widest text-stone-500">Response type</Label>
                      <Select value={kind} onValueChange={value=>setKind(value as ImportKind)}>
                        <SelectTrigger className="mt-1 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="event_questionnaire">Event questionnaire</SelectItem>
                          <SelectItem value="lead_form">Lead form</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-full lg:w-52">
                      <Label className="text-[10px] font-black uppercase tracking-widest text-stone-500">Range (optional)</Label>
                      <Input value={googleRange} onChange={event=>setGoogleRange(event.target.value)} placeholder="'Responses'!A1:Z" className="mt-1 bg-white" />
                    </div>
                    <Button onClick={handleGoogleSheet} disabled={googleSheetMutation.isPending} className="bg-emerald-700 font-bold hover:bg-emerald-800">
                      {googleSheetMutation.isPending?<Loader2 className="mr-2 h-4 w-4 animate-spin" />:<FileSpreadsheet className="mr-2 h-4 w-4" />}
                      Read responses
                    </Button>
                  </div>
                </div>
                {KINDS.map((k) => (
                  <div key={k.value} className="bg-white rounded-xl border border-stone-200 shadow-sm p-6 flex flex-col h-full">
                    <div className="w-8 h-8 rounded-md bg-stone-50 border border-stone-100 flex items-center justify-center mb-5 text-stone-400">
                      <k.icon className="w-4 h-4" />
                    </div>
                    <h3 className="font-bold text-[15px] text-stone-900 mb-2">{k.label}</h3>
                    <p className="text-xs font-medium text-stone-500 mb-6 flex-1">{k.desc}</p>
                    <Button variant="outline" className="w-full bg-white border-stone-200 font-bold text-xs" onClick={() => handleCardClick(k.value)}>
                      Choose file
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Card className="shadow-xs border-stone-200">
                <CardHeader className="bg-stone-50/50 border-b border-stone-100 pb-4">
                  <CardTitle className="text-sm">Configure Import: {file.name}</CardTitle>
                  <CardDescription className="text-xs">Select options before processing the file.</CardDescription>
                </CardHeader>
                <CardContent className="p-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-3">
                      <Label className="text-xs font-bold text-stone-900">Client (Optional)</Label>
                      <Select value={clientId} onValueChange={handleClientChange}>
                        <SelectTrigger className="bg-white text-xs h-9">
                          <SelectValue placeholder="Global (No Client)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Global (No Client)</SelectItem>
                          {(scopeOptions?.clients || []).map((c: any) => (
                            <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-3">
                      <Label className="text-xs font-bold text-stone-900">Audience (Optional)</Label>
                      <Select value={audienceId} onValueChange={setAudienceId}>
                        <SelectTrigger className="bg-white text-xs h-9">
                          <SelectValue placeholder="All Audiences" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Audiences</SelectItem>
                          {(scopeOptions?.audiences || [])
                            .filter((a: any) => clientId === "all" || !a.clientId || a.clientId === Number(clientId))
                            .map((a: any) => (
                            <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-3">
                      <Label className="text-xs font-bold text-stone-900">Product override {productRequired ? <span className="text-red-600">*</span> : ""}</Label>
                      <Select value={productId} onValueChange={setProductId}>
                        <SelectTrigger data-testid="select-import-product" className="bg-white text-xs h-9">
                          <SelectValue placeholder="All Products" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{productInferred ? "Infer from service-interest answer" : "All Products"}</SelectItem>
                          {(scopeOptions?.products || []).map((p: any) => (
                            <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(productRequired || productInferred) && (
                    <div className="mt-4 text-[11px] text-stone-500 font-medium">
                      {(scopeOptions?.products || []).length > 0
                        ? productInferred
                          ? "Product selection is optional. The app matches every service-interest answer to the active catalog. Future topics become knowledge intent; timeframe declares Hot/Warm/Cold; challenges feed opportunity interpretation."
                          : "Uploaded answers are approved on import and linked to the selected product."
                        : <span className="text-rose-600 font-bold">No products are configured. <Link href="/intent/settings" className="underline">Create a product</Link> first.</span>
                      }
                    </div>
                  )}
                </CardContent>
                <CardFooter className="p-4 border-t border-stone-100 bg-stone-50/50 flex justify-between">
                  <Button variant="outline" size="sm" onClick={reset} className="text-xs font-bold bg-white border-stone-200">Cancel</Button>
                  <Button data-testid="button-process-file" size="sm" onClick={handleUpload} disabled={previewMutation.isPending || (productRequired && productId === "all")} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs">
                    {previewMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
                    Process File <ArrowRight className="w-3.5 h-3.5 ml-2" />
                  </Button>
                </CardFooter>
              </Card>
            )}

            {/* Recent Imports - Only show when no file is selected to avoid clutter */}
            {!file && (
              <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-stone-100 flex items-center gap-2">
                  <History className="w-4 h-4 text-stone-500" />
                  <h3 className="font-bold text-sm text-stone-900">Recent imports</h3>
                </div>

                <div className="overflow-x-auto min-h-[150px]">
                  <table className="w-full text-left">
                    <tbody className="divide-y divide-stone-100">
                      {historyLoading ? (
                        <tr>
                          <td colSpan={4} className="p-12 text-center text-stone-400">
                            <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                          </td>
                        </tr>
                      ) : (history?.imports || []).length === 0 ? (
                        <tr>
                          <td colSpan={4} className="p-12 text-center text-stone-400 text-xs font-semibold">
                            No files imported yet.
                          </td>
                        </tr>
                      ) : (
                        (history?.imports || []).slice(0, 5).map((imp: any) => (
                          <tr key={imp.id} className="hover:bg-stone-50 transition-colors">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <FileSpreadsheet className="w-4 h-4 text-stone-400" />
                                <span className="text-[13px] font-bold text-stone-900">
                                  {imp.fileName || `Import #${imp.id}`}
                                </span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-xs font-medium text-stone-500">
                              {kinDLabels[imp.kind] || imp.kind.replace(/_/g, " ")}
                            </td>
                            <td className="px-6 py-4 text-xs font-medium text-stone-400 text-right tabular-nums">
                              {imp.totalRows || 0} rows
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-[10px] font-bold text-emerald-700 capitalize">
                                {imp.status === "completed" ? "Mapped" : imp.status}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mapping UI */}
        {step === "mapping" && previewData && (
          <Card className="shadow-sm border-stone-200">
            <CardHeader className="bg-stone-50/50 border-b border-stone-100 pb-4">
              <CardTitle className="text-sm text-stone-900">2. Map Columns</CardTitle>
              <CardDescription className="text-xs text-stone-500">Match your CSV headers to the canonical Intent Engine fields.</CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <div className="space-y-4">
                {previewData.headers?.map((header: string) => (
                  <div key={header} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 p-3 bg-stone-50 border border-stone-100 rounded-lg">
                    <div className="flex-1 font-semibold text-[13px] text-stone-900 truncate" title={header}>{header}</div>
                    <div className="hidden sm:flex w-8 justify-center"><ArrowRight className="w-4 h-4 text-stone-300" /></div>
                    <div className="flex-1">
                      <Select value={mappings[header]} onValueChange={(v) => setMappings({ ...mappings, [header]: v })}>
                        <SelectTrigger data-testid={`select-mapping-${header}`} className="bg-white text-xs h-9 border-stone-200">
                          <SelectValue placeholder="Ignore this column" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ignore">-- Ignore --</SelectItem>
                          {[
                            ...(previewData.mappingFields || []),
                            ...(productRequired ? buyIntentFields.filter(field => !(previewData.mappingFields || []).some((mapped: any) => mapped.key === field.key)) : []),
                          ].map((mf: any) => (
                            <SelectItem key={mf.key} value={mf.key}>{mf.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
            <CardFooter className="p-4 border-t border-stone-100 bg-stone-50/50 flex justify-between">
              <Button data-testid="button-back-upload" variant="outline" size="sm" onClick={() => setStep("upload")} className="text-xs font-bold bg-white border-stone-200">Back</Button>
              <Button data-testid="button-generate-preview" size="sm" onClick={handleRePreview} disabled={previewMutation.isPending || (productRequired && productId === "all")} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs">
                {previewMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
                Generate Preview <ArrowRight className="w-3.5 h-3.5 ml-2" />
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Preview UI */}
        {step === "preview" && previewData && (
          <Card className="shadow-sm border-stone-200">
            <CardHeader className="bg-stone-50/50 border-b border-stone-100 pb-4">
              <CardTitle className="text-sm text-stone-900">3. Validate Data</CardTitle>
              <CardDescription className="text-xs text-stone-500">
                {previewData.summary?.valid || 0} valid, {previewData.summary?.invalid || 0} invalid out of {previewData.summary?.total || 0} total rows.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-stone-50/80 text-[10px] uppercase font-bold tracking-widest text-stone-500 border-b border-stone-100">
                  <tr>
                    <th className="px-4 py-3">Row</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Match</th>
                    {productInferred && <th className="px-4 py-3">Inferred product fit</th>}
                    {Object.values(mappings).filter(v => v !== "ignore").map(m => (
                      <th key={m} className="px-4 py-3">{m.replace(/_/g, " ")}</th>
                    ))}
                    <th className="px-4 py-3">Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {(previewData.rows || []).slice(0, 10).map((row: any, i: number) => (
                    <tr key={i} className={row.status === "error" ? "bg-rose-50/50" : "hover:bg-stone-50"}>
                      <td className="px-4 py-3 text-xs text-stone-400">{row.rowNumber}</td>
                      <td className="px-4 py-3">
                        {row.status === "valid" ? (
                          <span className="flex items-center gap-1.5 text-emerald-600 text-xs font-bold"><CheckCircle className="w-3.5 h-3.5" /> Valid</span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-rose-600 text-xs font-bold"><AlertCircle className="w-3.5 h-3.5" /> Error</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs font-bold">
                        <span className={cn(
                          "px-2 py-0.5 rounded border",
                          row.match?.contactId || row.match?.accountId ? "text-emerald-700 bg-emerald-50 border-emerald-100" : "text-stone-500 bg-stone-100 border-stone-200",
                        )}>{matchLabel(row.match)}</span>
                      </td>
                      {productInferred && (
                        <td className="px-4 py-3 text-xs text-stone-600 min-w-[220px]">
                          {(row.inferredProducts || []).length
                            ? row.inferredProducts.slice(0, 3).map((product: any) => product.name).join(", ")
                            : "No catalog match — knowledge and challenge intent will still be retained"}
                        </td>
                      )}
                      {Object.values(mappings).filter(v => v !== "ignore").map(m => (
                        <td key={m} className="px-4 py-3 font-mono text-[11px] text-stone-600 max-w-[200px] truncate" title={String(normalizedValue(row, m) || "-")}>
                          {String(normalizedValue(row, m) || "-")}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-xs font-medium text-rose-600">
                        {(row.errors || []).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(previewData.rows || []).length > 10 && (
                <div className="p-3 text-center text-xs font-medium text-stone-500 bg-stone-50/50 border-t border-stone-100">
                  Showing 10 of {previewData.rows.length} rows
                </div>
              )}
            </CardContent>
            <CardFooter className="p-4 border-t border-stone-100 bg-stone-50/50 flex justify-between">
              <Button data-testid="button-back-mapping" variant="outline" size="sm" onClick={() => setStep("mapping")} className="text-xs font-bold bg-white border-stone-200">Back</Button>
              <Button data-testid="button-commit-import" size="sm" onClick={handleCommit} disabled={commitMutation.isPending || previewData.summary?.valid === 0 || (productRequired && productId === "all")} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs">
                {commitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5 mr-2" />}
                Commit Import
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Done State */}
        {step === "done" && (
          <Card className="shadow-sm border-stone-200 text-center py-12">
            <CardContent>
              <div className="w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-5 border border-emerald-100">
                <CheckCircle className="w-8 h-8 text-emerald-600" />
              </div>
              <h2 className="text-lg font-bold text-stone-900 mb-2">Import Successful</h2>
              <p className="text-xs font-medium text-stone-500 mb-6 max-w-md mx-auto leading-relaxed">
                Your {kinDLabels[kind]} data has been successfully ingested.
                {productInferred ? " Knowledge intent, inferred product intent, purchase urgency, and business challenges are now available." : productRequired ? " Product intent is available immediately." : " Score recalculation will run in the background."}
              </p>
              {commitMutation.data && (
                <div className="bg-stone-50 border border-stone-100 rounded-lg p-5 max-w-sm mx-auto mb-8 text-left space-y-3 text-[13px]">
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Inserted</span>
                    <span className="font-black text-emerald-700">{commitMutation.data.inserted || 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Skipped</span>
                    <span className="font-bold text-stone-900">{commitMutation.data.skipped || 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Unmatched</span>
                    <span className="font-bold text-amber-600">{commitMutation.data.unmatched || 0}</span>
                  </div>
                  {commitMutation.data.failed > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500 font-medium">Errors</span>
                      <span className="font-black text-rose-600">{commitMutation.data.failed}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-center gap-3">
                <Button data-testid="button-import-more" variant="outline" size="sm" onClick={reset} className="text-xs font-bold bg-white border-stone-200">Import More Data</Button>
                <Button data-testid="button-go-intent" size="sm" onClick={() => setLocation('/intent')} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs">Go to Intent Engine</Button>
              </div>
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}