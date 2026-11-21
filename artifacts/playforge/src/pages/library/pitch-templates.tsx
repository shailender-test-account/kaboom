import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Layers, Plus, Pencil, Trash2, Loader2, Phone,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });
const json = (path: string, method: string, body: unknown) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const PRODUCT_KEYS = [
  { key: "aiso",     label: "AI Search Optimization" },
  { key: "linkedin", label: "LinkedIn Executive Presence" },
  { key: "custom",   label: "Other / Custom" },
];

const LANG_MODES = [
  { value: "auto",        label: "Auto (bilingual)" },
  { value: "englishOnly", label: "English only" },
  { value: "hindiOnly",   label: "Hindi only" },
];

const EMPTY_FORM = {
  name: "",
  productKey: "aiso",
  productName: "",
  campaignFirstMessage: "",
  campaignFirstMessageHindi: "",
  languageMode: "auto",
  notAPitchDisclaimer: "",
  notAPitchDisclaimerHindi: "",
  hookContext: "",
  hookContextHindi: "",
  needDiscoveryQuestion: "",
  needDiscoveryQuestionHindi: "",
  bridgeStatement: "",
  bridgeStatementHindi: "",
  offerName: "",
  offerNameHindi: "",
  offerDuration: "15–20 minutes",
  offerWhatTheyGet: "",
  offerFreeStatement: "",
  valueBullets: "",
  cta: "",
};

type FormState = typeof EMPTY_FORM;

function productLabel(key: string) {
  return PRODUCT_KEYS.find(p => p.key === key)?.label ?? key;
}

function productBadgeClass(key: string) {
  if (key === "aiso")     return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (key === "linkedin") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-gray-50 text-gray-600 border-gray-200";
}

function rowFromTemplate(t: any): FormState {
  return {
    name:                       t.name ?? "",
    productKey:                 t.product_key ?? "aiso",
    productName:                t.product_name ?? "",
    campaignFirstMessage:       t.campaign_first_message ?? "",
    campaignFirstMessageHindi:  t.campaign_first_message_hindi ?? "",
    languageMode:               t.language_mode ?? "auto",
    notAPitchDisclaimer:        t.not_a_pitch_disclaimer ?? "",
    notAPitchDisclaimerHindi:   t.not_a_pitch_disclaimer_hindi ?? "",
    hookContext:                t.hook_context ?? "",
    hookContextHindi:           t.hook_context_hindi ?? "",
    needDiscoveryQuestion:      t.need_discovery_question ?? "",
    needDiscoveryQuestionHindi: t.need_discovery_question_hindi ?? "",
    bridgeStatement:            t.bridge_statement ?? "",
    bridgeStatementHindi:       t.bridge_statement_hindi ?? "",
    offerName:                  t.offer_name ?? "",
    offerNameHindi:             t.offer_name_hindi ?? "",
    offerDuration:              t.offer_duration ?? "15–20 minutes",
    offerWhatTheyGet:           t.offer_what_they_get ?? "",
    offerFreeStatement:         t.offer_free_statement ?? "",
    valueBullets:               t.value_bullets ?? "",
    cta:                        t.cta ?? "",
  };
}

function formToPayload(f: FormState) {
  return {
    name:                       f.name,
    productKey:                 f.productKey,
    productName:                f.productName || null,
    campaignFirstMessage:       f.campaignFirstMessage || null,
    campaignFirstMessageHindi:  f.campaignFirstMessageHindi || null,
    languageMode:               f.languageMode || "auto",
    notAPitchDisclaimer:        f.notAPitchDisclaimer || null,
    notAPitchDisclaimerHindi:   f.notAPitchDisclaimerHindi || null,
    hookContext:                f.hookContext || null,
    hookContextHindi:           f.hookContextHindi || null,
    needDiscoveryQuestion:      f.needDiscoveryQuestion || null,
    needDiscoveryQuestionHindi: f.needDiscoveryQuestionHindi || null,
    bridgeStatement:            f.bridgeStatement || null,
    bridgeStatementHindi:       f.bridgeStatementHindi || null,
    offerName:                  f.offerName || null,
    offerNameHindi:             f.offerNameHindi || null,
    offerDuration:              f.offerDuration || "15–20 minutes",
    offerWhatTheyGet:           f.offerWhatTheyGet || null,
    offerFreeStatement:         f.offerFreeStatement || null,
    valueBullets:               f.valueBullets || null,
    cta:                        f.cta || null,
  };
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider pt-2 border-t border-border/50">
      {children}
    </p>
  );
}

function Field({
  label, hint, value, onChange, multiline = false, mono = false, placeholder = "",
}: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
  multiline?: boolean; mono?: boolean; placeholder?: string;
}) {
  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {multiline ? (
        <Textarea
          className={cn("mt-1.5 text-sm min-h-[80px]", mono && "font-mono")}
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
      ) : (
        <Input
          className={cn("mt-1.5 h-8 text-sm", mono && "font-mono")}
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function TemplateSheet({
  open, onClose, initial, templateId,
}: {
  open: boolean;
  onClose: () => void;
  initial: FormState;
  templateId?: number;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(initial);
  const set = (key: keyof FormState) => (v: string) => setForm(f => ({ ...f, [key]: v }));

  const save = useMutation({
    mutationFn: () => templateId
      ? json(`/pitch-templates/${templateId}`, "PATCH", formToPayload(form)).then(r => r.json())
      : json("/pitch-templates", "POST", formToPayload(form)).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pitch-templates"] });
      toast({ title: templateId ? "Template updated" : "Template created" });
      onClose();
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const showHindi = form.languageMode !== "englishOnly";

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto flex flex-col gap-4 p-6">
        <SheetHeader>
          <SheetTitle>{templateId ? "Edit Pitch Template" : "New Pitch Template"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          {/* ── Identity ── */}
          <SectionHeading>Identity</SectionHeading>

          <Field label="Template Name *" placeholder="e.g. AI Search — Standard Pitch" value={form.name} onChange={set("name")} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Product *</Label>
              <select
                className="w-full h-8 px-2 text-sm border rounded bg-background mt-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                value={form.productKey}
                onChange={e => setForm(f => ({ ...f, productKey: e.target.value }))}
              >
                {PRODUCT_KEYS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Language Mode</Label>
              <select
                className="w-full h-8 px-2 text-sm border rounded bg-background mt-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                value={form.languageMode}
                onChange={e => setForm(f => ({ ...f, languageMode: e.target.value }))}
              >
                {LANG_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>

          <Field
            label="Product Name (Vapi variable: productName)"
            placeholder="e.g. AI Search Optimization"
            value={form.productName}
            onChange={set("productName")}
          />

          {/* ── Opening ── */}
          <SectionHeading>Opening</SectionHeading>

          <Field
            label="Campaign First Message — English (campaignFirstMessage)"
            hint="Set as assistantOverrides.firstMessage on every call. This is what the assistant says the moment the contact picks up."
            placeholder="Hi, am I speaking with {{contactFirstName}}? This is Alex calling on behalf of…"
            value={form.campaignFirstMessage}
            onChange={set("campaignFirstMessage")}
            multiline
          />
          {showHindi && (
            <Field
              label="Campaign First Message — Hindi (campaignFirstMessageHindi)"
              hint="Passed as {{campaignFirstMessageHindi}} — your assistant prompt can switch to this when languageMode is hindiOnly."
              placeholder="Namaste {{contactFirstName}} ji, main Alex bol raha hoon…"
              value={form.campaignFirstMessageHindi}
              onChange={set("campaignFirstMessageHindi")}
              multiline
            />
          )}
          <Field
            label="Not-a-Pitch Disclaimer (notAPitchDisclaimer)"
            placeholder="I'm not here to sell you anything today — I just want to share something that's helping teams like yours…"
            value={form.notAPitchDisclaimer}
            onChange={set("notAPitchDisclaimer")}
            multiline
          />
          {showHindi && (
            <Field
              label="Not-a-Pitch Disclaimer — Hindi (notAPitchDisclaimerHindi)"
              value={form.notAPitchDisclaimerHindi}
              onChange={set("notAPitchDisclaimerHindi")}
              multiline
            />
          )}

          <Field
            label="Hook / Context (hookContext)"
            placeholder="We've been helping B2B teams improve search visibility by 3× in under 90 days…"
            value={form.hookContext}
            onChange={set("hookContext")}
            multiline
          />
          {showHindi && (
            <Field
              label="Hook Context — Hindi (hookContextHindi)"
              value={form.hookContextHindi}
              onChange={set("hookContextHindi")}
              multiline
            />
          )}

          <Field
            label="Need Discovery Question (needDiscoveryQuestion)"
            placeholder="How are you currently handling [X] for your team?"
            value={form.needDiscoveryQuestion}
            onChange={set("needDiscoveryQuestion")}
          />
          {showHindi && (
            <Field
              label="Need Discovery Question — Hindi (needDiscoveryQuestionHindi)"
              value={form.needDiscoveryQuestionHindi}
              onChange={set("needDiscoveryQuestionHindi")}
            />
          )}

          {/* ── Middle ── */}
          <SectionHeading>Bridge & Offer</SectionHeading>

          <Field
            label="Bridge Statement (bridgeStatement)"
            placeholder="Based on what you said, I think our [product] could really help because…"
            value={form.bridgeStatement}
            onChange={set("bridgeStatement")}
            multiline
          />
          {showHindi && (
            <Field
              label="Bridge Statement — Hindi (bridgeStatementHindi)"
              value={form.bridgeStatementHindi}
              onChange={set("bridgeStatementHindi")}
              multiline
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Offer Name (offerName)"
              placeholder="15-minute AI Search Audit"
              value={form.offerName}
              onChange={set("offerName")}
            />
            <Field
              label="Offer Duration (offerDuration)"
              placeholder="15–20 minutes"
              value={form.offerDuration}
              onChange={set("offerDuration")}
            />
          </div>
          {showHindi && (
            <Field
              label="Offer Name — Hindi (offerNameHindi)"
              value={form.offerNameHindi}
              onChange={set("offerNameHindi")}
            />
          )}

          <Field
            label="What They Get (offerWhatTheyGet)"
            placeholder="A personalised report showing exactly where you're losing search visibility…"
            value={form.offerWhatTheyGet}
            onChange={set("offerWhatTheyGet")}
            multiline
          />
          <Field
            label="Free Statement (offerFreeStatement)"
            placeholder="It's completely free and there's no obligation."
            value={form.offerFreeStatement}
            onChange={set("offerFreeStatement")}
          />

          {/* ── Closing ── */}
          <SectionHeading>Value & CTA</SectionHeading>

          <Field
            label="Value Bullets (valueBullets) — one per line"
            placeholder={"- Clients see 3× more inbound in 60 days\n- No tech setup required\n- Works with your existing content"}
            value={form.valueBullets}
            onChange={set("valueBullets")}
            multiline
          />
          <Field
            label="Call to Action (cta)"
            placeholder="Can we book a quick 15-minute slot this week?"
            value={form.cta}
            onChange={set("cta")}
          />
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <Button
            className="bg-indigo-600 hover:bg-indigo-700"
            disabled={!form.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {templateId ? "Save Changes" : "Create Template"}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function PitchTemplatesPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: templates = [], isLoading } = useQuery<any[]>({
    queryKey: ["pitch-templates"],
    queryFn: () => api("/pitch-templates").then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api(`/pitch-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pitch-templates"] });
      setDeleteId(null);
      toast({ title: "Template deleted" });
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const openCreate = () => { setEditTarget(null); setSheetOpen(true); };
  const openEdit = (t: any) => { setEditTarget(t); setSheetOpen(true); };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-600" />
            Pitch Templates
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define product-level scripts injected into every call (Vapi <em>and</em> RetellAI) as dynamic variables
          </p>
        </div>
        <Button className="bg-indigo-600 hover:bg-indigo-700 gap-1.5" onClick={openCreate}>
          <Plus className="w-4 h-4" /> New Template
        </Button>
      </div>

      {/* Variable reference */}
      <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-xs text-indigo-800 space-y-1">
        <p className="font-semibold">Variable names injected per call (Vapi + RetellAI)</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
          {[
            "campaignProductKey","productName","languageMode",
            "campaignFirstMessage","campaignFirstMessageHindi",
            "notAPitchDisclaimer","notAPitchDisclaimerHindi",
            "hookContext","hookContextHindi",
            "needDiscoveryQuestion","needDiscoveryQuestionHindi",
            "bridgeStatement","bridgeStatementHindi",
            "offerName","offerNameHindi","offerDuration",
            "offerWhatTheyGet","offerFreeStatement",
            "valueBullets","cta",
            "contactFirstName","contactLastName","contactName","companyName","leadScore","stage",
          ].map(v => <span key={v} className="text-indigo-600">{`{{${v}}}`}</span>)}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center">
              <Layers className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-sm font-medium">No pitch templates yet</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Create a template for each product you pitch. Assign it to a call campaign and Kaboom will inject all script variables into every Vapi call automatically.
            </p>
            <Button variant="outline" size="sm" className="mt-2 gap-1.5" onClick={openCreate}>
              <Plus className="w-3.5 h-3.5" /> Create your first template
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((t: any) => (
            <Card key={t.id} className="hover:shadow-md transition-shadow">
              <CardContent className="px-4 py-3.5">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold">{t.name}</p>
                      <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", productBadgeClass(t.product_key))}>
                        {productLabel(t.product_key)}
                      </Badge>
                      {t.language_mode && t.language_mode !== "auto" && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-amber-50 text-amber-700 border-amber-200">
                          {t.language_mode === "hindiOnly" ? "Hindi only" : "English only"}
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-[11px] text-muted-foreground">
                      {t.product_name && <span><span className="font-medium text-foreground/70">Product:</span> {t.product_name}</span>}
                      {t.offer_name && <span><span className="font-medium text-foreground/70">Offer:</span> {t.offer_name}</span>}
                      {t.offer_duration && <span><span className="font-medium text-foreground/70">Duration:</span> {t.offer_duration}</span>}
                      {t.cta && <span><span className="font-medium text-foreground/70">CTA:</span> {t.cta.slice(0, 60)}{t.cta.length > 60 ? "…" : ""}</span>}
                    </div>
                    {/* Filled field count */}
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Phone className="w-3 h-3" />
                      {[
                        t.not_a_pitch_disclaimer, t.hook_context, t.need_discovery_question,
                        t.bridge_statement, t.offer_what_they_get, t.value_bullets,
                      ].filter(Boolean).length} / 6 script fields filled
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => openEdit(t)}>
                      <Pencil className="w-3 h-3" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                      onClick={() => setDeleteId(t.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Sheet */}
      {sheetOpen && (
        <TemplateSheet
          open={sheetOpen}
          onClose={() => { setSheetOpen(false); setEditTarget(null); }}
          initial={editTarget ? rowFromTemplate(editTarget) : { ...EMPTY_FORM }}
          templateId={editTarget?.id}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              Campaigns using this template will lose their pitch script on the next run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
