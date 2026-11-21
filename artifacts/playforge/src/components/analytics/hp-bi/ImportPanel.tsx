import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Download, Upload } from "lucide-react";
import { useImportHpAccounts, usePreviewHpImport, type HpImportPreview } from "./api";
import { download, HP_DIMENSIONS } from "./format";
import { Chip, Empty, ErrorBox, Skel } from "./ui";
import { MappingPresets } from "./MappingPresets";
import { PreviewRevision } from "./previewRevision";
import { describeMatch, queueCount } from "./matchPresentation";

type Kind = "accounts" | "activities";
const TARGETS: Record<Kind, string[]> = {
  accounts: ["accountName", "hpId", ...Object.values(HP_DIMENSIONS), ...Object.keys(HP_DIMENSIONS), "top200", "abmClassification", "globalAccount", "profiled", "buyingBehavior", "propensity", "buyerCategories", "whitespaceCategories",
    "top_200", "abm_classification", "global_account", "buying_behavior", "buyer_categories", "whitespace_categories"],
  activities: ["recordId", "hpId", "accountName", "email", "kind", "occurredAt", "category", "product", "horizonMonths", "orderValue", "currency", "sourceName", "status", "externalEventId"],
};
const sel = "rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs";

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`/api/analytics/hp-bi${path}`, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
  return r.json();
}
const asList = (x: unknown): Record<string, unknown>[] => Array.isArray(x) ? x : Array.isArray((x as { items?: unknown })?.items) ? (x as { items: Record<string, unknown>[] }).items : Array.isArray((x as { rows?: unknown })?.rows) ? (x as { rows: Record<string, unknown>[] }).rows : [];
const show = (v: unknown) => v == null || v === "" ? "Unknown" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function ImportFlow({ clientId }: { clientId: number }) {
  const { toast } = useToast();
  const preview = usePreviewHpImport(clientId), run = useImportHpAccounts(clientId);
  const [kind, setKind] = useState<Kind>("accounts");
  const [file, setFile] = useState<File | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [previewed, setPreviewed] = useState(false);
  const [p, setPreview] = useState<HpImportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expectedHeaders, setExpectedHeaders] = useState<string[]>([]);
  const revision = useRef(new PreviewRevision());
  useEffect(() => () => { revision.current.invalidate(); }, []);
  const [fileKey, setFileKey] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const working = pending || run.isPending;
  useEffect(() => {
    setSeconds(0);
    if (!working) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const cache = useQueryClient();
  const stale = !previewed;
  const invalidate = (clear = false) => {
    revision.current.invalidate(); setPreviewed(false); setPending(false); setError(null); setConfirmed(false);
    if (clear) setPreview(null);
  };
  const doPreview = async (m = map) => {
    if (!file) return;
    const token = revision.current.invalidate();
    setPreviewed(false); setPending(true); setError(null); setConfirmed(false);
    try {
      const result = await preview.mutateAsync({ file, kind, mappings: m });
      if (!revision.current.isCurrent(token)) return;
      setPreview(result); setPreviewed(result.errors.length === 0);
    } catch (e) {
      if (revision.current.isCurrent(token)) setError((e as Error).message);
    } finally { if (revision.current.isCurrent(token)) setPending(false); }
  };
  const setM = (h: string, t: string) => { invalidate(); const m = { ...map }; if (t) m[h] = t; else delete m[h]; setMap(m); };
  const missing = p ? Object.keys(map).filter(h => !p.headers.includes(h)) : [];
  const invalid = Object.entries(map).filter(([, t]) => !TARGETS[kind].includes(t)
    && !(kind === "activities" && ["hp_id", "UNIQUE ID"].includes(t)));
  const missingExpected = p ? expectedHeaders.filter(h => !p.headers.includes(h) && !missing.includes(h)) : [];
  return (
    <div className="min-w-0 space-y-3 break-words" data-testid="import-flow">
      <div className="flex flex-wrap items-center gap-2">
        <select data-testid="select-import-kind" disabled={run.isPending} className={sel} value={kind} onChange={e => { invalidate(true); setKind(e.target.value as Kind); setMap({}); setExpectedHeaders([]); }}><option value="accounts">Accounts (workbook headings)</option><option value="activities">Activities</option></select>
        <button data-testid="button-download-template" onClick={() => download(`/api/analytics/hp-bi/template?clientId=${clientId}&kind=${kind}`)} className="inline-flex items-center gap-1 text-xs rounded border border-[#c5d3df] px-2 py-1 hover:bg-[#eaf6fc]"><Download className="w-3.5 h-3.5" />Template CSV</button>
        <input key={fileKey} disabled={run.isPending} data-testid="input-import-file" type="file" accept=".csv,.xlsx,.xls" className="min-w-0 max-w-full text-xs" onChange={e => { invalidate(true); setFile(e.target.files?.[0] ?? null); }} />
        <button data-testid="button-preview-import" disabled={!file || pending || run.isPending} onClick={() => doPreview()} className="text-xs rounded bg-[#0B2A4A] text-white px-3 py-1 disabled:opacity-50">{pending ? "Reading" : "Preview"}</button>
      </div>
      {working && <p role="status" aria-live="polite" data-testid="text-import-progress" className="text-xs text-[#41586e]">
        {run.isPending ? "Importing workbook safely" : "Reading the workbook and checking account identities"} — {seconds}s.
        {" "}Large workbooks take longer. The rest of the app remains available; do not start another import while this one is running.
      </p>}
      <fieldset disabled={run.isPending} className="min-w-0">
        <MappingPresets key={`${clientId}:${kind}`} clientId={clientId} kind={kind} headers={p?.headers} mappings={map}
          canSave={!missing.length && !invalid.length && !pending}
          onApply={preset => { invalidate(); setMap(preset?.mappings ?? {}); setExpectedHeaders(preset?.headers ?? []); }} />
      </fieldset>
      {kind === "activities" && <p className="text-[11px] text-[#5d7388]">recordId is required for later corrections. Kinds: invitation, attendance, digital, content, other, interest, lead, opportunity, closed_won.</p>}
      {error && <ErrorBox message={error} onRetry={() => doPreview()} />}
      {p && (
        <div className="min-w-0 space-y-3 hpbi-fade">
          <div className="text-xs text-[#41586e]" data-testid="text-preview-counts">{p.rows} rows / {p.uniqueAccounts} unique accounts / kind {p.importKind}</div>
          {p.impact && <div className="rounded-lg border border-[#c5d3df] bg-[#f1f6fa] p-3 text-xs space-y-1" data-testid="roster-import-impact">
            <p className="font-semibold text-[#0B2A4A]">Account roster impact in the current environment</p>
            <p>{p.impact.legalAccounts.toLocaleString("en-IN")} distinct legal accounts / {p.impact.sourceParentGroups.toLocaleString("en-IN")} source parent groups / {p.impact.duplicateRows.toLocaleString("en-IN")} consolidated duplicate rows.</p>
            <p>{p.impact.newAccounts.toLocaleString("en-IN")} new CRM accounts / {p.impact.existingMatches.toLocaleString("en-IN")} existing matches / {p.impact.conflicts.toLocaleString("en-IN")} held for identity review.</p>
            <p>Expected reporting universe: {p.impact.resultingLegalAccounts.toLocaleString("en-IN")} legal accounts / {p.impact.resultingParentGroups.toLocaleString("en-IN")} parent groups, including retained existing accounts.</p>
            <p>{p.impact.note}</p>
            {p.impact.hierarchyReviews > 0 && <p>{p.impact.hierarchyReviews} conflicting source hierarchies will remain independent pending review.</p>}
            {p.impact.conflictExamples.map(c => <p key={c.hpId}>{c.hpId} / {c.name}: {c.reason}</p>)}
          </div>}
          {p.errors.length > 0 && <ul className="rounded border border-[#e7b8a4] bg-[#fdf1ea] p-2 text-xs text-[#8a3511] list-disc pl-5" data-testid="list-import-errors">{p.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          {p.warnings.length > 0 && <ul className="rounded border border-[#f0dfa6] bg-[#fdf8e6] p-2 text-xs text-[#6d5206] list-disc pl-5" data-testid="list-import-warnings">{p.warnings.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#0B2A4A] mb-1">Column mapping</div>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
              {p.headers.map(h => (
                <label key={h} className="min-w-0 flex items-center justify-between gap-2 text-xs"><span className="min-w-0 truncate" title={h}>{h}</span>
                  <select disabled={run.isPending} data-testid={`select-map-${h}`} className={`${sel} min-w-0 max-w-[65%]`} value={map[h] ?? ""} onChange={e => setM(h, e.target.value)}><option value="">Automatic</option>{map[h] && !TARGETS[kind].includes(map[h]) && <option value={map[h]}>{invalid.some(([key]) => key === h) ? "Unsupported: " : ""}{map[h]}</option>}{TARGETS[kind].map(t => <option key={t} value={t}>{t}</option>)}</select></label>))}
            </div>
            {missing.map(h => <p role="alert" key={h} className="text-xs text-[#8a3511] mt-2">Missing mapped heading: “{h}” → {map[h]}. Renamed headings are not guessed. <button disabled={run.isPending} className="underline" onClick={() => setM(h, "")}>Remove missing mapping</button></p>)}
            {invalid.map(([h, t]) => <p role="alert" key={h} className="text-xs text-[#8a3511] mt-2">Unsupported target: “{t}” for “{h}”. <button disabled={run.isPending} className="underline" onClick={() => setM(h, "")}>Remove invalid mapping</button></p>)}
            {missingExpected.length > 0 && <p className="text-xs text-[#6d5206] mt-2">Other preset headings not in this file: {missingExpected.join(", ")}. Review the current columns before importing.</p>}
            <button disabled={pending || run.isPending} data-testid="button-reapply-mapping" onClick={() => doPreview()} className="mt-2 text-xs rounded border border-[#c5d3df] px-2 py-1 hover:bg-[#eaf6fc] disabled:opacity-50">Re-run preview with mapping</button>
          </div>
          <div className="min-w-0 overflow-x-auto max-h-48 border border-[#e3ebf2] rounded">
            <table className="text-[11px] w-full"><thead className="bg-[#f1f6fa]"><tr>{p.headers.map(h => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>{p.samples.map((r, i) => <tr key={i} className="border-t border-[#e3ebf2]">{p.headers.map(h => <td key={h} className="px-2 py-1 whitespace-nowrap max-w-[180px] truncate">{show(r[h])}</td>)}</tr>)}</tbody></table>
          </div>
          {kind === "accounts" && <label className="flex items-start gap-2 text-xs text-[#41586e]">
            <input data-testid="check-approve-roster" type="checkbox" checked={confirmed} disabled={stale || pending || run.isPending || !p.impact || p.errors.length > 0} onChange={e => setConfirmed(e.target.checked)} />
            I reviewed the impact and approve importing this account roster into the current HP client. This writes account context, not contacts or leads; identity conflicts remain held for review.
          </label>}
          <button data-testid="button-run-import" disabled={!file || pending || run.isPending || p.errors.length > 0 || stale || missing.length > 0 || invalid.length > 0 || kind === "accounts" && (!confirmed || !p.impact)}
            onClick={() => file && run.mutate({ file, kind, mappings: map, confirmAccounts: confirmed }, {
              onSuccess: r => { toast({ title: "Import complete", description: `${r.imported} imported, ${r.created} created, ${r.linkedContacts} contacts linked, ${r.unresolved} unresolved of ${r.rows} rows.` }); invalidate(true); setFile(null); setFileKey(k => k + 1); ["hp-bi-imports", "hp-bi-matches"].forEach(k => cache.invalidateQueries({ queryKey: [k] })); },
              onError: e => toast({ title: "Import failed", description: (e as Error).message, variant: "destructive" }) })}
            className="inline-flex items-center gap-1 text-xs rounded bg-[#0096D6] text-white px-4 py-1.5 disabled:opacity-50"><Upload className="w-3.5 h-3.5" />{run.isPending ? "Importing" : "Import file"}</button>
          {p.errors.length > 0 && <p className="text-[11px] text-[#8a3511]">Resolve errors before importing.</p>}
          {stale && <p className="text-[11px] text-[#8f4f0f]" data-testid="text-mapping-stale">File or mapping changed, or validation has not passed. Re-run the preview before importing.</p>}
        </div>
      )}
    </div>
  );
}

function AccountSearch({ clientId, id, value, onPick }: { clientId: number; id: string; value: string; onPick: (v: string) => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery({ queryKey: ["hp-bi-account-search", clientId, term], enabled: term.length >= 2,
    queryFn: () => getJson<{ id: number; name: string; hpId: string | null }[]>(`/account-search?clientId=${clientId}&search=${encodeURIComponent(term)}`) });
  return (
    <div className="flex-1 min-w-0 flex gap-2">
      <input data-testid={`input-match-search-${id}`} className={`${sel} w-40`} placeholder="Search legal accounts" value={text} onChange={e => setText(e.target.value)} />
      <select data-testid={`select-match-found-${id}`} className={`${sel} flex-1 min-w-0`} value={value} onChange={e => onPick(e.target.value)}>
        <option value="">{q.isFetching ? "Searching" : q.isError ? "Search failed" : term.length < 2 ? "Type 2+ characters" : (q.data ?? []).length ? "Choose account" : "No matches"}</option>
        {(q.data ?? []).map(a => <option key={a.id} value={a.id}>{a.name}{a.hpId ? ` (${a.hpId})` : ""}</option>)}
      </select>
    </div>
  );
}

function Matches({ clientId }: { clientId: number }) {
  const { toast } = useToast(); const cache = useQueryClient();
  const q = useQuery({ queryKey: ["hp-bi-matches", clientId], queryFn: () => getJson<unknown>(`/matches?clientId=${clientId}`) });
  const [pick, setPick] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Record<string, string>>({});
  const resolve = useMutation({
    mutationFn: async (v: { id: string; accountId: number; reportingCategory?: string }) => {
      const r = await fetch(`/api/analytics/hp-bi/matches/${v.id}?clientId=${clientId}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: v.accountId, reportingCategory: v.reportingCategory }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      return r.json();
    },
    onSuccess: () => { toast({ title: "Match resolved" }); ["hp-bi-matches", "hp-bi", "hp-bi-detail"].forEach(k => cache.invalidateQueries({ queryKey: [k] })); },
    onError: e => toast({ title: "Resolve failed", description: (e as Error).message, variant: "destructive" }),
  });
  if (q.isLoading) return <Skel className="h-24" />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const rows = asList(q.data);
  if (!rows.length) return <Empty title="No unresolved matches" body="Every imported name was matched to an account unambiguously." />;
  return (
    <ul className="space-y-2" data-testid="list-matches">{rows.map((m, i) => {
      const id = String(m.id ?? i);
      const cands = Array.isArray(m.candidates) ? (m.candidates as Record<string, unknown>[]) : [];
      const description = describeMatch(m);
      return (
        <li key={id} className="rounded border border-[#e3ebf2] p-2 text-xs space-y-1.5" data-testid={`row-match-${id}`}>
          <div className="font-semibold">{description.title}</div>
          <div className="text-[#41586e] break-words">{description.details.map(([key, value]) => `${key}: ${value}`).join(" · ")}</div>
          <div><span className="text-[#5d7388]">Reason:</span> {show(m.reason)}</div>
          <p className="text-[#5d7388]">{description.roster ? "This account is held for HP-ID review; other accepted accounts remain imported. Do not select an account with a different HP ID." : description.contactReview ? "Review the contact's email ownership first. Choosing a legal account here cannot resolve this conflict." : "This item needs review; it does not mean the whole import failed."}</p>
          <details><summary className="cursor-pointer text-[#5d7388]">Source details</summary><pre className="mt-1 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{JSON.stringify(m.payload ?? {}, null, 2)}</pre></details>
          {/Unknown reporting category/.test(String(m.reason)) && <select aria-label="Reporting category" className={sel} value={categories[id] ?? ""} onChange={e => setCategories(c => ({ ...c, [id]: e.target.value }))}>
            <option value="">Choose saved reporting category</option>{["IT Hardware", "Business Collaboration", "Security", "Business Services"].map(c => <option key={c}>{c}</option>)}
          </select>}
          {description.contactReview ? <a className="inline-block underline text-[#0B2A4A]" href="/intent/inbound-accounts">Open contact identity review in Inbound Accounts</a> : <div className="flex flex-wrap gap-2 items-center">
            {cands.length > 0 && <select data-testid={`select-match-account-${id}`} className={`${sel} w-44`} value={pick[id] ?? ""} onChange={e => setPick(p => ({ ...p, [id]: e.target.value }))}>
              <option value="">Suggested</option>{cands.map(c => <option key={`c${String(c.id)}`} value={String(c.id)}>{show(c.name ?? c.accountName ?? c.id)}</option>)}</select>}
            <AccountSearch clientId={clientId} id={id} value={pick[id] ?? ""} onPick={v => setPick(p => ({ ...p, [id]: v }))} />
            <button data-testid={`button-resolve-${id}`} disabled={!pick[id] || resolve.isPending || /Unknown reporting category/.test(String(m.reason)) && !categories[id]} onClick={() => resolve.mutate({ id, accountId: Number(pick[id]), reportingCategory: categories[id] || undefined })} className="rounded bg-[#0B2A4A] text-white px-3 py-1 disabled:opacity-50">Resolve</button>
          </div>}
        </li>);
    })}</ul>
  );
}

function History({ clientId }: { clientId: number }) {
  const q = useQuery({ queryKey: ["hp-bi-imports", clientId], queryFn: () => getJson<unknown>(`/imports?clientId=${clientId}`) });
  if (q.isLoading) return <Skel className="h-24" />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const rows = asList(q.data);
  if (!rows.length) return <Empty title="No imports yet" body="Imported files and their row counts will be listed here for audit." />;
  const cols = ["fileName", "kind", "rows", "accounts", "importedAt", "result"];
  return (
    <div className="overflow-x-auto" data-testid="table-import-history"><table className="w-full text-[11px]"><thead><tr className="text-left text-[#5d7388] uppercase">{cols.map(c => <th key={c} className="px-2 py-1">{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-[#e3ebf2]">{cols.map(c => <td key={c} className="px-2 py-1 whitespace-nowrap">{c === "importedAt" && r[c] ? new Date(String(r[c])).toLocaleString("en-IN") : c === "result" ? <span title={show(r[c])} className="inline-block max-w-[260px] truncate align-bottom">{show(r[c])}</span> : show(r[c])}</td>)}</tr>)}</tbody></table></div>
  );
}

export default function ImportPanel({ open, onClose, clientId, unresolved }: { open: boolean; onClose: () => void; clientId: number; unresolved: number }) {
  const [tab, setTab] = useState<"import" | "matches" | "history">("import");
  const matches = useQuery({ queryKey: ["hp-bi-matches", clientId], enabled: open,
    queryFn: () => getJson<unknown>(`/matches?clientId=${clientId}`) });
  const pendingCount = queueCount(matches.data, unresolved);
  const tabs: [typeof tab, string][] = [["import", "Import"], ["matches", `Matching queue (${pendingCount})`], ["history", "History"]];
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="w-[95vw] sm:w-full max-w-3xl grid-cols-[minmax(0,1fr)] max-h-[88vh] overflow-y-auto" data-testid="dialog-hp-import">
        <DialogHeader><DialogTitle>HP data import</DialogTitle><DialogDescription>Preview, map and import accounts or activities. Unmatched names wait in the queue for review.</DialogDescription></DialogHeader>
        <div className="flex gap-1 border-b border-[#d5e0ea]">{tabs.map(([k, l]) => (
          <button key={k} data-testid={`tab-import-${k}`} onClick={() => setTab(k)} className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px ${tab === k ? "border-[#0096D6] text-[#0B2A4A]" : "border-transparent text-[#5d7388]"}`}>{l}</button>))}
          {pendingCount !== "0" && <span className="ml-auto self-center"><Chip tone="amber">{pendingCount} unresolved</Chip></span>}</div>
        {tab === "import" && <ImportFlow key={clientId} clientId={clientId} />}
        {tab === "matches" && <Matches clientId={clientId} />}
        {tab === "history" && <History clientId={clientId} />}
      </DialogContent>
    </Dialog>
  );
}
