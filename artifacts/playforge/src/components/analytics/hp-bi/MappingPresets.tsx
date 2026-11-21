import { useState } from "react";
import type { HpMappingPreset } from "@workspace/api-client-react";
import { useDeleteHpMappingPreset, useHpMappingPresets, useSaveHpMappingPreset } from "./api";
import { useToast } from "@/hooks/use-toast";
import { ErrorBox } from "./ui";

export type ImportKind = "accounts" | "activities";
const button = "rounded border border-[#c5d3df] px-2 py-1 text-xs hover:bg-[#eaf6fc] disabled:opacity-50";

export function MappingPresets({ clientId, kind, headers, mappings, canSave, onApply }: {
  clientId: number; kind: ImportKind; headers?: string[]; mappings: Record<string, string>; canSave: boolean;
  onApply: (preset: HpMappingPreset | null) => void;
}) {
  const { toast } = useToast();
  const list = useHpMappingPresets(clientId, kind), save = useSaveHpMappingPreset(clientId), remove = useDeleteHpMappingPreset(clientId);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = save.isPending || remove.isPending;
  const preset = list.data?.find(p => p.id === selected);
  const reportError = (e: Error) => toast({ title: "Preset operation failed", description: e.message, variant: "destructive" });
  const saved = (p: HpMappingPreset) => {
    setSelected(p.id); setName(p.name);
    toast({ title: "Mapping preset saved", description: p.name });
  };
  if (list.isError) return <ErrorBox message={list.error.message} onRetry={() => list.refetch()} />;
  return (
    <section aria-label="Saved mapping presets" className="rounded border border-[#d5e0ea] bg-[#f1f6fa] p-3 space-y-2">
      <p className="text-xs font-semibold text-[#0B2A4A]">Saved mappings — {kind === "accounts" ? "Accounts" : "Activities"}</p>
      <div className="flex flex-wrap gap-2 items-center">
        <select aria-label="Mapping preset" data-testid="select-mapping-preset" disabled={busy || list.isLoading}
          className="rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs max-w-full" value={selected ?? ""}
          onChange={e => {
            const p = list.data?.find(p => p.id === Number(e.target.value)) ?? null;
            setSelected(p?.id ?? null); setName(p?.name ?? ""); setConfirmDelete(false); onApply(p);
          }}>
          <option value="">{list.isLoading ? "Loading presets…" : "No preset / automatic mapping"}</option>
          {(list.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input aria-label="Preset name" maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)}
          placeholder="Preset name" className="rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs w-48 max-w-full" />
        <button className={button} disabled={busy || !name.trim() || !headers || !canSave}
          onClick={() => headers && save.mutate({ data: { name: name.trim(), kind, headers, mappings } }, { onSuccess: saved, onError: reportError })}>Save as new</button>
        {preset && <>
          <button className={button} disabled={busy || !headers || !canSave || !name.trim()}
            onClick={() => headers && save.mutate({ id: preset.id, data: { name: name.trim(), headers, mappings } }, { onSuccess: saved, onError: reportError })}>Update mappings</button>
          <button className={button} disabled={busy || !name.trim() || name.trim() === preset.name}
            onClick={() => save.mutate({ id: preset.id, data: { name: name.trim() } }, { onSuccess: saved, onError: reportError })}>Rename</button>
          <button className={button} disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>
        </>}
      </div>
      {!headers && <p className="text-[11px] text-[#5d7388]">Upload and preview a file to save its column mappings. Saved presets can be selected before uploading.</p>}
      {busy && <p role="status" className="text-xs">Saving changes…</p>}
      {confirmDelete && preset && <div className="text-xs flex flex-wrap gap-2 items-center">
        <span>Delete “{preset.name}”? Imported accounts and activities will not be deleted.</span>
        <button className={button} disabled={busy} onClick={() => remove.mutate(preset.id, {
          onSuccess: () => { setSelected(null); setConfirmDelete(false); setName(""); toast({ title: "Preset deleted", description: "Current mappings and imported data are unchanged." }); },
          onError: reportError,
        })}>Confirm delete</button>
        <button className={button} disabled={busy} onClick={() => setConfirmDelete(false)}>Keep preset</button>
      </div>}
    </section>
  );
}
