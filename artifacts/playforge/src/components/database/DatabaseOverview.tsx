import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Database, Layers, ChevronRight, ChevronLeft, X, Building2, GitBranch,
  Clock, FileStack, AlertCircle, RefreshCw, ShieldCheck, Loader2, CheckCircle2, ArrowRight, Coins,
} from "lucide-react";
import {
  useListContactDatabases, useListContactDatasets, getListContactDatasetsQueryKey,
  useGetContactVerification, getGetContactVerificationQueryKey,
  useVerifyContactDetails, useReviewContactVerification,
  getGetContactVerificationUsageQueryKey,
  type ContactDatabaseSummary, type ContactVerification,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { VerificationUsage } from "./VerificationUsage";

function rel(iso?: string | null): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export type DatasetSelection = { id: number; name: string } | null;

// ─────────── OVERVIEW ───────────
export function DatabaseOverview({
  selectedDatabaseId, selectedDataset, onSelectDatabase, onSelectDataset, onOpenSegment,
}: {
  selectedDatabaseId: number | null;
  selectedDataset: DatasetSelection;
  onSelectDatabase: (db: ContactDatabaseSummary | null) => void;
  onSelectDataset: (ds: DatasetSelection) => void;
  onOpenSegment: (id: number) => void;
}) {
  const { data, isLoading, isError, refetch, isFetching } = useListContactDatabases();
  const dbs = data?.databases ?? [];
  const selected = dbs.find(d => d.id === selectedDatabaseId) ?? null;
  const total = data?.totalContacts ?? 0;

  return (
    <section className="border-b bg-gradient-to-b from-indigo-50/70 to-card shrink-0" data-testid="section-database-overview">
      <div className="px-4 pt-3 pb-2 flex items-center gap-3">
        <div className="w-7 h-7 rounded-md bg-indigo-600 flex items-center justify-center">
          <Database className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-tight">Named databases</h2>
          <p className="text-[11px] text-muted-foreground">
            {isLoading ? "Loading provenance..." : `${dbs.length} databases · ${total.toLocaleString()} contacts · ${data?.unassignedCount ?? 0} not assigned to a named database`}
          </p>
        </div>
        {selected && (
          <button onClick={() => onSelectDatabase(null)} data-testid="button-clear-database"
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
            Showing {selected.name}{selectedDataset ? ` / ${selectedDataset.name}` : ""} <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="px-4 pb-3 flex gap-2.5 overflow-x-auto snap-x">
        {isLoading && Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="w-60 h-[112px] shrink-0 rounded-lg border bg-card animate-pulse" />
        ))}
        {isError && (
          <div className="flex items-center gap-2 text-xs text-destructive py-6">
            <AlertCircle className="w-3.5 h-3.5" /> Could not load databases.
            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1" onClick={() => refetch()}>
              <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} /> Retry
            </Button>
          </div>
        )}
        {!isLoading && !isError && dbs.length === 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-indigo-200 bg-card px-4 py-4 text-xs text-muted-foreground">
            <FileStack className="w-5 h-5 text-indigo-300" />
            No named databases yet. Import a file and give it a name, or let the filename name it for you.
          </div>
        )}
        {dbs.map(db => {
          const active = db.id === selectedDatabaseId;
          return (
            <button key={db.id} data-testid={`card-database-${db.id}`}
              onClick={() => onSelectDatabase(active ? null : db)}
              className={cn(
                "group snap-start w-64 shrink-0 text-left rounded-lg border p-3 transition-all duration-200 hover:-translate-y-0.5",
                active ? "bg-indigo-600 border-indigo-600 text-white shadow-md" : "bg-card hover:border-indigo-300 hover:shadow-sm",
              )}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold truncate">{db.name}</p>
                <span className={cn("text-[10px] tabular-nums px-1.5 py-0.5 rounded", active ? "bg-white/20" : "bg-indigo-50 text-indigo-700")}>
                  {db.contactCount.toLocaleString()}
                </span>
              </div>
              <p className={cn("text-[11px] mt-0.5", active ? "text-indigo-100" : "text-muted-foreground")}>
                {db.datasetCount} dataset{db.datasetCount !== 1 ? "s" : ""}, last added {rel(db.lastDatasetAddedAt)}
              </p>
              <div className={cn("mt-2 flex flex-wrap gap-1 text-[10px]", active ? "text-indigo-50" : "text-muted-foreground")}>
                {db.clients.slice(0, 2).map(c => (
                  <span key={c.id} className={cn("inline-flex items-center gap-0.5 px-1.5 rounded border", active ? "border-white/30" : "border-border")}>
                    <Building2 className="w-2.5 h-2.5" />{c.name}
                  </span>
                ))}
                {db.clients.length > 2 && <span>+{db.clients.length - 2}</span>}
                {db.sequences.length > 0 && (
                  <span className="inline-flex items-center gap-0.5"><GitBranch className="w-2.5 h-2.5" />{db.sequences.length} seq</span>
                )}
                <span className="inline-flex items-center gap-0.5 ml-auto"><Clock className="w-2.5 h-2.5" />used {rel(db.lastUsedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <VerificationUsage />
      {selected && (
        <DatabaseDrillIn key={selected.id} db={selected}
          selectedDataset={selectedDataset} onSelectDataset={onSelectDataset} onOpenSegment={onOpenSegment} />
      )}
    </section>
  );
}

function DatabaseDrillIn({
  db, selectedDataset, onSelectDataset, onOpenSegment,
}: {
  db: ContactDatabaseSummary; selectedDataset: DatasetSelection;
  onSelectDataset: (ds: DatasetSelection) => void; onOpenSegment: (id: number) => void;
}) {
  const [page, setPage] = useState(1);
  const params = { page };
  const { data, isLoading, isError, refetch } = useListContactDatasets(db.id, params, {
    query: { queryKey: getListContactDatasetsQueryKey(db.id, params), placeholderData: prev => prev },
  });
  const datasets = data?.datasets ?? [];
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  return (
    <div className="mx-4 mb-3 rounded-lg border bg-card overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="px-3 py-2 border-b flex flex-wrap items-center gap-2 bg-muted/30">
        <span className="text-xs font-semibold">Datasets in {db.name}</span>
        <span className="text-[11px] text-muted-foreground">Imports keep each client's contacts separate; nothing is merged across clients.</span>
        <div className="ml-auto flex flex-wrap gap-1">
          {db.segments.map(s => (
            <button key={s.id} onClick={() => onOpenSegment(s.id)} data-testid={`link-segment-${s.id}`}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-indigo-200 text-indigo-700 hover:bg-indigo-50 transition-colors">
              <Layers className="w-2.5 h-2.5" />{s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y">
        {isLoading && Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-9 mx-3 my-1 rounded bg-muted animate-pulse" />)}
        {isError && (
          <div className="px-3 py-3 text-xs text-destructive flex items-center gap-2">
            Failed to load datasets. <button className="underline" onClick={() => refetch()}>Retry</button>
          </div>
        )}
        {!isLoading && !isError && datasets.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No datasets recorded for this database yet.</p>
        )}
        {datasets.map(ds => {
          const on = selectedDataset?.id === ds.id;
          return (
            <button key={ds.id} data-testid={`row-dataset-${ds.id}`}
              onClick={() => onSelectDataset(on ? null : { id: ds.id, name: ds.name })}
              className={cn("w-full flex items-center gap-3 px-3 py-2 text-left text-xs transition-colors",
                on ? "bg-indigo-50 text-indigo-900" : "hover:bg-muted/50")}>
              <FileStack className={cn("w-3.5 h-3.5 shrink-0", on ? "text-indigo-600" : "text-muted-foreground")} />
              <span className="font-medium truncate flex-1">{ds.name}</span>
              <span className="text-muted-foreground truncate max-w-[120px]">{ds.clientName ?? "No client"}</span>
              {ds.segmentName && <span className="text-muted-foreground truncate max-w-[110px] hidden md:inline">{ds.segmentName}</span>}
              <span className="tabular-nums w-14 text-right">{ds.contactCount.toLocaleString()}</span>
              <span className="text-muted-foreground w-16 text-right">{rel(ds.addedAt)}</span>
              <ChevronRight className={cn("w-3 h-3 transition-transform", on && "rotate-90 text-indigo-600")} />
            </button>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="px-3 py-1.5 border-t flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="disabled:opacity-30" data-testid="button-datasets-prev"><ChevronLeft className="w-3.5 h-3.5" /></button>
          Page {page} of {totalPages}
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="disabled:opacity-30" data-testid="button-datasets-next"><ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

// ─────────── VERIFY DETAILS ───────────
const FIELD_LABEL = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").replace(/^./, s => s.toUpperCase());

export function VerifyDetailsDialog({
  contactId, contactName, canEdit, onClose,
}: { contactId: number | null; contactName: string; canEdit: boolean; onClose: () => void }) {
  const open = contactId !== null;
  const id = contactId ?? 0;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ContactVerification | null>(null);

  const { data: existing, isLoading } = useGetContactVerification(id, {
    query: { enabled: open, queryKey: getGetContactVerificationQueryKey(id), retry: false },
  });
  const v = result ?? existing ?? null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["db-contacts"] });
    qc.invalidateQueries({ queryKey: getGetContactVerificationQueryKey(id) });
    qc.invalidateQueries({ queryKey: getGetContactVerificationUsageQueryKey() });
  };

  const verify = useVerifyContactDetails({
    mutation: {
      retry: false,
      onSuccess: r => {
        setResult(r); setPicked(new Set()); invalidate();
        toast({ title: "Lookup complete", description: r.filledFields.length ? `Filled ${r.filledFields.length} empty field(s). Review any changes below.` : "Review proposed changes below." });
      },
      onError: (error) => {
        setResult(null); invalidate();
        const message = (error as { data?: { error?: string } }).data?.error;
        toast({ title: "Lookup not completed", description: message ?? "The lookup may have used provider credits. Refresh the saved result before explicitly retrying.", variant: "destructive" });
      },
    },
  });
  const review = useReviewContactVerification({
    mutation: {
      onSuccess: r => { setResult(r); setPicked(new Set()); invalidate(); toast({ title: "Replacements applied" }); },
      onError: () => toast({ title: "Could not apply replacements", variant: "destructive" }),
    },
  });

  const reviewable = v ? Object.keys(v.proposed).filter(k =>
    !v.filledFields.includes(k) && (v.original[k] ?? "") !== v.proposed[k]) : [];

  const close = () => { setResult(null); setPicked(new Set()); onClose(); };

  return (
    <>
      <Dialog open={open} onOpenChange={o => !o && close()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-indigo-600" /> Verify details</DialogTitle>
            <DialogDescription>{contactName}. Missing fields are filled automatically; existing details are only replaced after you review them.</DialogDescription>
          </DialogHeader>

          {isLoading && !result ? (
            <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-8 rounded bg-muted animate-pulse" />)}</div>
          ) : !v ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
              This contact has not been verified yet.
            </div>
          ) : (
            <div className="space-y-3 max-h-[50vh] overflow-y-auto">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 capitalize">{v.status}</span>
                {v.completedAt && <span className="text-muted-foreground">checked {rel(v.completedAt)}</span>}
              </div>
              {v.error && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3" />{v.error}</p>}
              {v.filledFields.length > 0 && (
                <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                  <CheckCircle2 className="w-3 h-3 inline mr-1" />Filled: {v.filledFields.map(FIELD_LABEL).join(", ")}
                </div>
              )}
              {reviewable.length === 0 ? (
                <p className="text-xs text-muted-foreground">No conflicting changes to review.</p>
              ) : (
                <div className="divide-y rounded-md border">
                  {reviewable.map(k => {
                    const on = picked.has(k);
                    return (
                      <label key={k} data-testid={`row-verify-field-${k}`}
                        className={cn("flex items-center gap-3 px-3 py-2 text-xs cursor-pointer transition-colors", on && "bg-indigo-50/60", !canEdit && "cursor-default")}>
                        <input type="checkbox" disabled={!canEdit || picked.size >= 10 && !on} checked={on}
                          onChange={() => setPicked(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                          className="accent-indigo-600" />
                        <span className="w-24 shrink-0 font-medium">{FIELD_LABEL(k)}</span>
                        <span className={cn("flex-1 truncate text-muted-foreground", on && "line-through")}>{v.original[k] || "empty"}</span>
                        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="flex-1 truncate text-indigo-700 font-medium">{v.proposed[k]}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            {canEdit && (
              <Button variant="outline" size="sm" className="gap-1" disabled={verify.isPending} onClick={() => setConfirm(true)} data-testid="button-run-verification">
                {verify.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
                {v ? "Run new lookup" : "Run paid lookup"}
              </Button>
            )}
            {canEdit && v?.id != null && reviewable.length > 0 && (
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700" disabled={picked.size === 0 || review.isPending}
                data-testid="button-apply-replacements"
                onClick={() => review.mutate({ id, verificationId: v.id!, data: { fields: Array.from(picked) } })}>
                {review.isPending && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                Replace {picked.size || ""} selected
              </Button>
            )}
            {!canEdit && <span className="text-[11px] text-muted-foreground">View-only access</span>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run a paid lookup?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends one external lookup for {contactName} and may spend data provider credits.
              It consumes one request from your tenant's all-time ceiling, even if it fails. No automatic retry is made.
              Empty fields will be filled; existing details stay unchanged until you approve them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-indigo-600 hover:bg-indigo-700" data-testid="button-confirm-verification"
              onClick={() => verify.mutate({ id })}>Spend credits and verify</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
