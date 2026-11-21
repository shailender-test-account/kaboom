import { useState } from "react";
import { FolderSync, Lock, Plus, Eye, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CANONICAL_KEYS, useFeedbackSources, useSaveSource, useSourcePreview, useSyncSource,
  type FeedbackOptions, type FeedbackSource, type FeedbackType, type SyncResult,
} from "@/hooks/use-sales-feedback";
import { fmtDate, typeLabel } from "./FeedbackEntryCard";

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-60";

export function SourcesPanel({ options, canWrite }: { options?: FeedbackOptions; canWrite: boolean }) {
  const q = useFeedbackSources();
  const sync = useSyncSource();
  const save = useSaveSource();
  const { toast } = useToast();
  const [editing, setEditing] = useState<FeedbackSource | "new" | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, SyncResult>>({});
  const clientName = (id: number) => options?.clients.find(c => c.id === id)?.name ?? `Client #${id}`;
  const drive = options?.googleDriveConnected;

  const runSync = (s: FeedbackSource) => sync.mutate(s.id, {
    onSuccess: r => { setResults(m => ({ ...m, [s.id]: r })); toast({ title: `Imported ${r.imported} rows`, description: `${r.duplicates} duplicates skipped across ${r.files} files${r.remainingFiles ? `, ${r.remainingFiles} files remaining` : ""}. New rows wait for review.` }); },
    onError: e => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });
  const toggle = (s: FeedbackSource) => save.mutate({ id: s.id, body: { clientId: s.clientId, name: s.name, folderUrl: s.folderUrl, type: s.type, enabled: !s.enabled, fieldMappings: s.fieldMappings } }, {
    onError: e => toast({ title: "Could not update source", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3" data-testid="panel-sources">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground flex-1 min-w-60">Drive folders of call trackers. The sample workbook is never imported automatically.</p>
        {canWrite && <Button size="sm" onClick={() => setEditing("new")} data-testid="button-add-source"><Plus className="mr-1 h-3.5 w-3.5" />Add Drive source</Button>}
      </div>
      <div className="grid gap-2 rounded-md border border-sky-200 bg-sky-50/70 p-3 text-xs text-sky-950 sm:grid-cols-2" data-testid="text-sync-schedule">
        <div><p className="font-semibold">Published app: automatic every 10 minutes</p><p className="text-sky-900/80">After publishing, enabled sources sync on their own in production. New rows still wait for admin review.</p></div>
        <div><p className="font-semibold">Preview and development: Sync now only</p><p className="text-sky-900/80">No background sync runs here, so copied or test data is never pulled in by automation. Press Sync now to import.</p></div>
      </div>
      {options && !drive && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="text-drive-disconnected">Google Drive is not connected for this workspace. Preview and sync will fail until an administrator connects it in Settings. Manual entries still work.</p>}
      {q.isLoading && <div className="space-y-2"><div className="h-20 rounded bg-muted animate-pulse" /><div className="h-20 rounded bg-muted animate-pulse" /></div>}
      {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">Could not load sources: {q.error.message} <button className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-sources-retry">Retry</button></div>}
      {q.data && q.data.items.length === 0 && <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground" data-testid="sources-empty">
        <FolderSync className="mx-auto mb-2 h-6 w-6 opacity-50" />No Drive sources yet. Point one at a folder holding the Lead Tracker and Call History workbook.</div>}
      <div className="grid gap-3 lg:grid-cols-2">
        {q.data?.items.map(s => {
          const r = results[s.id];
          return (
            <div key={s.id} className={cn("rounded-md border bg-card p-3 text-xs space-y-2", !s.enabled && "opacity-75")} data-testid={`card-source-${s.id}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{s.name}</div>
                  <div className="text-muted-foreground">{clientName(s.clientId)} · default {typeLabel(s.type)}</div>
                  <div className="font-mono text-[10.5px] text-muted-foreground truncate" title={s.folderUrl}>{s.folderUrl}</div>
                </div>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", s.enabled ? "border-teal-300 bg-teal-50 text-teal-900" : "border-slate-300 bg-slate-100 text-slate-600")} data-testid={`status-source-${s.id}`}>{s.enabled ? "Enabled" : "Disabled"}</span>
              </div>
              <p className="text-muted-foreground">Last synced {fmtDate(s.lastSyncedAt) ?? "never"}{s.hasImported && <span className="ml-1 inline-flex items-center gap-0.5"><Lock className="h-3 w-3" />client, folder and type locked</span>}</p>
              {s.lastError && <p className="rounded bg-red-50 p-1.5 text-red-800" data-testid={`error-source-${s.id}`}>Last error: {s.lastError}</p>}
              {Object.keys(s.fieldMappings ?? {}).length > 0 && <p className="text-muted-foreground">{Object.keys(s.fieldMappings).length} custom heading mappings</p>}
              {r && <div className="rounded bg-muted/60 p-1.5 font-mono text-[10.5px]" data-testid={`sync-result-${s.id}`}>imported {r.imported} · duplicates {r.duplicates} · files {r.files} · remaining {r.remainingFiles}
                {r.errors.map((e, i) => <div key={i} className="text-red-800">{e}</div>)}</div>}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPreviewId(s.id)} data-testid={`button-preview-${s.id}`}><Eye className="mr-1 h-3 w-3" />Preview headers</Button>
                {canWrite && <>
                  <Button size="sm" className="h-7 text-xs" disabled={!s.enabled || sync.isPending} onClick={() => runSync(s)} data-testid={`button-sync-${s.id}`}>
                    <RefreshCw className={cn("mr-1 h-3 w-3", sync.isPending && sync.variables === s.id && "animate-spin")} />Sync now</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(s)} data-testid={`button-edit-source-${s.id}`}><Pencil className="mr-1 h-3 w-3" />Edit</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={save.isPending} onClick={() => toggle(s)} data-testid={`button-toggle-source-${s.id}`}>{s.enabled ? "Disable" : "Enable"}</Button>
                </>}
              </div>
              {!s.enabled && <p className="text-[10.5px] text-muted-foreground">Enable to sync.</p>}
            </div>
          );
        })}
      </div>
      <SourceDialog source={editing} options={options} onClose={() => setEditing(null)} />
      <PreviewDialog id={previewId} onClose={() => setPreviewId(null)} />
    </div>
  );
}

function SourceDialog({ source, options, onClose }: { source: FeedbackSource | "new" | null; options?: FeedbackOptions; onClose: () => void }) {
  return <Dialog open={!!source} onOpenChange={o => { if (!o) onClose(); }}>
    {source && <SourceForm key={source === "new" ? "new" : source.id} source={source === "new" ? null : source} options={options} onClose={onClose} />}
  </Dialog>;
}

function SourceForm({ source, options, onClose }: { source: FeedbackSource | null; options?: FeedbackOptions; onClose: () => void }) {
  const { toast } = useToast();
  const save = useSaveSource();
  const locked = !!source?.hasImported;
  const [clientId, setClientId] = useState(source ? String(source.clientId) : "");
  const [name, setName] = useState(source?.name ?? "");
  const [folderUrl, setFolderUrl] = useState(source?.folderUrl ?? "");
  const [type, setType] = useState<FeedbackType>(source?.type ?? "telesales");
  const [enabled, setEnabled] = useState(source?.enabled ?? false);
  const [maps, setMaps] = useState<{ h: string; k: string }[]>(Object.entries(source?.fieldMappings ?? {}).map(([h, k]) => ({ h, k })));
  const valid = clientId && name.trim() && /^https?:\/\//.test(folderUrl.trim()) && maps.every(m => m.h.trim() && m.k);

  const submit = () => save.mutate({
    id: source?.id,
    body: { clientId: Number(clientId), name: name.trim(), folderUrl: folderUrl.trim(), type, enabled, fieldMappings: Object.fromEntries(maps.map(m => [m.h.trim(), m.k])) },
  }, {
    onSuccess: () => { toast({ title: source ? "Source updated" : "Source created", description: "Nothing was imported. Use Preview, then Sync when ready." }); onClose(); },
    onError: e => toast({ title: "Could not save source", description: e.message, variant: "destructive" }),
  });

  return (
    <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-source">
      <DialogHeader>
        <DialogTitle>{source ? "Edit Drive source" : "New Drive source"}</DialogTitle>
        <DialogDescription>Uses the existing Google Drive connection. No credentials are entered here.{locked && " This source has imported rows, so client, folder and type are locked."}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <label className="text-xs space-y-1"><span>Name</span><Input value={name} onChange={e => setName(e.target.value)} data-testid="input-source-name" /></label>
        <label className="text-xs space-y-1"><span>Client {locked && <Lock className="inline h-3 w-3" />}</span>
          <select className={sel} disabled={locked} value={clientId} onChange={e => setClientId(e.target.value)} data-testid="select-source-client">
            <option value="">Choose client</option>{(options?.clients ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="text-xs space-y-1"><span>Drive folder URL {locked && <Lock className="inline h-3 w-3" />}</span>
          <Input disabled={locked} value={folderUrl} onChange={e => setFolderUrl(e.target.value)} placeholder="https://drive.google.com/drive/folders/..." data-testid="input-source-folder" /></label>
        <label className="text-xs space-y-1"><span>Default feedback type {locked && <Lock className="inline h-3 w-3" />}</span>
          <select className={sel} disabled={locked} value={type} onChange={e => setType(e.target.value as FeedbackType)} data-testid="select-source-type">
            <option value="telesales">Telesales</option><option value="sales_rep">Sales rep</option>
          </select>
          <span className="text-muted-foreground">Lead Tracker can still emit both types from its two feedback columns; Call History uses its Role column when present.</span></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} data-testid="checkbox-source-enabled" />Enabled for manual sync</label>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs"><span className="font-semibold">Heading mappings (optional)</span>
            <button type="button" className="underline" onClick={() => setMaps(m => [...m, { h: "", k: "" }])} data-testid="button-add-mapping">Add mapping</button></div>
          <p className="text-[11px] text-muted-foreground">The sample tracker headings are recognised automatically. Map only custom headings.</p>
          {maps.map((m, i) => <div key={i} className="flex gap-1.5">
            <Input className="h-8 text-xs" placeholder="Sheet heading" value={m.h} onChange={e => setMaps(all => all.map((x, j) => j === i ? { ...x, h: e.target.value } : x))} data-testid={`input-mapping-heading-${i}`} />
            <select className={cn(sel, "h-8 text-xs")} value={m.k} onChange={e => setMaps(all => all.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} data-testid={`select-mapping-key-${i}`}>
              <option value="">Field</option>{CANONICAL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove mapping" onClick={() => setMaps(all => all.filter((_, j) => j !== i))} data-testid={`button-remove-mapping-${i}`}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>)}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!valid || save.isPending} onClick={submit} data-testid="button-save-source">{save.isPending ? "Saving" : "Save source"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PreviewDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useSourcePreview(id);
  return (
    <Dialog open={id != null} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-preview">
        <DialogHeader><DialogTitle>Header preview</DialogTitle><DialogDescription>Read-only look at what Sync would see. Nothing is imported.</DialogDescription></DialogHeader>
        {q.isLoading && <div className="space-y-2"><div className="h-10 rounded bg-muted animate-pulse" /><div className="h-24 rounded bg-muted animate-pulse" /></div>}
        {q.isError && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">Preview failed: {q.error.message} <button className="underline font-semibold" onClick={() => q.refetch()} data-testid="button-preview-retry">Retry</button></div>}
        {q.data && <div className="space-y-3 text-xs">
          <div><h4 className="font-semibold mb-1">Files ({q.data.files.length})</h4>
            {q.data.files.length === 0 ? <p className="text-muted-foreground">No spreadsheet files found in this folder.</p> : <ul className="font-mono text-[11px] space-y-0.5">{q.data.files.map(f => <li key={f.id}>{f.name}</li>)}</ul>}</div>
          {q.data.sheets.map(s => <div key={s.name} className="rounded border p-2" data-testid={`preview-sheet-${s.name}`}>
            <div className="mb-1 flex justify-between"><strong>{s.name}</strong><span className="text-muted-foreground">{s.rowCount} data rows</span></div>
            <div className="flex flex-wrap gap-1">{s.headers.length ? s.headers.map((h, i) => <span key={`${h}-${i}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">{h || "(blank)"}</span>) : <span className="text-muted-foreground">No headers detected</span>}</div>
          </div>)}
          {q.data.errors.length > 0 && <div className="rounded bg-red-50 p-2 text-red-800">{q.data.errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
