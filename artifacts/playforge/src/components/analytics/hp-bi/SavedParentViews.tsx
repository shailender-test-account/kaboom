import { useState } from "react";
import type { HpParentView, HpParentViewConfig } from "./pivot-types";
import { useHpParentViews, useSaveHpParentView, useDeleteHpParentView } from "./api";

const input = "rounded border border-[#c5d3df] bg-white px-2 py-1.5 text-xs";
const button = "rounded border border-[#c5d3df] px-3 py-1.5 text-xs font-semibold disabled:opacity-40";
export default function SavedParentViews({ clientId, config, valid, onOpen }: {
  clientId: number; config: HpParentViewConfig; valid: boolean; onOpen: (view: HpParentView) => void;
}) {
  const views = useHpParentViews(clientId), save = useSaveHpParentView(clientId), remove = useDeleteHpParentView(clientId);
  const [selected, setSelected] = useState<HpParentView | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState("");
  const busy = save.isPending || remove.isPending;
  const missing = !!selected && !!views.data && !views.data.some(v => v.id === selected.id);
  const dirty = selected && JSON.stringify(config) !== JSON.stringify(selected.config);
  const clearErrors = () => { save.reset(); remove.reset(); setMessage(""); setConfirmDelete(false); };
  const open = (id: string) => {
    clearErrors();
    const view = views.data?.find(v => v.id === Number(id)) ?? null;
    setSelected(view); setName(view?.name ?? "");
    if (view) { onOpen(view); setMessage(`Opened "${view.name}" with freshly requested report data.`); }
  };
  const persist = (action: "create" | "rename" | "update") => {
    clearErrors();
    save.mutate({ id: action === "create" ? undefined : selected?.id,
      data: action === "rename" ? { name: name.trim() } : action === "update" ? { config } : { name: name.trim(), config } },
    { onSuccess: view => { setSelected(view); setName(view.name); setMessage(action === "create" ? "View created." : action === "rename" ? "View renamed." : "Saved settings updated."); } });
  };
  return <section data-testid="pivot-saved-views" aria-label="Saved parent comparisons" className="space-y-2 rounded border border-[#c5d3df] bg-[#f5f9fc] p-3">
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs font-semibold">Saved view
        <select data-testid="pivot-view-select" className={input} value={selected?.id ?? ""} disabled={busy || views.isLoading || views.isError} onChange={e => open(e.target.value)}>
          <option value="">{views.isLoading ? "Loading saved views…" : "Choose a saved view"}</option>
          {missing && <option value={selected!.id}>{selected!.name} (removed)</option>}
          {views.data?.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select></label>
      <button type="button" data-testid="pivot-view-reopen" className={button} disabled={!selected || missing || busy || views.isError} onClick={() => open(String(selected!.id))}>Reopen</button>
      <label className="flex flex-col gap-1 text-xs font-semibold">View name
        <input data-testid="pivot-view-name" className={input} maxLength={100} value={name} disabled={busy} onChange={e => { setName(e.target.value); setConfirmDelete(false); }} placeholder="Monthly parent review" /></label>
      <button type="button" data-testid="pivot-view-create" className={button} disabled={busy || !valid || !name.trim()} onClick={() => persist("create")}>Save as new</button>
      <button type="button" data-testid="pivot-view-rename" className={button} disabled={busy || !selected || missing || !name.trim() || name.trim() === selected.name} onClick={() => persist("rename")}>Rename</button>
      <button type="button" data-testid="pivot-view-update" className={button} disabled={busy || !selected || missing || !valid || !dirty} onClick={() => persist("update")}>Update saved settings</button>
      <button type="button" data-testid="pivot-view-delete" className={button} disabled={busy || !selected || missing} onClick={() => { clearErrors(); setConfirmDelete(true); }}>Delete</button>
    </div>
    <p className="text-[11px] text-[#41586e]">Shared within this tenant and HP client. Saves the comparison filters shown below, not report results, pagination or evidence. Dashboard-inherited scope remains in effect and is not saved.</p>
    {dirty && <p data-testid="pivot-view-dirty" className="text-xs text-[#8a5200]">Unsaved comparison changes. Apply affects the report; Update saved settings affects the saved view.</p>}
    {missing && <p role="alert" className="text-xs text-[#b3261e]">This view was deleted in another session. Your current filters remain available to save as new.</p>}
    {confirmDelete && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>Delete "{selected?.name}" for everyone in this client? Reports and source records will not be deleted.</span>
      <button type="button" data-testid="pivot-view-confirm-delete" className={button} disabled={busy} onClick={() => remove.mutate(selected!.id, {
        onSuccess: () => { setSelected(null); setName(""); setConfirmDelete(false); setMessage("Saved view deleted. Current filters are unchanged."); },
      })}>Confirm delete</button>
      <button type="button" className={button} disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
    </div>}
    {views.isError && <div role="alert" className="text-xs text-[#b3261e]">{(views.error as Error).message} <button type="button" className="underline" onClick={() => views.refetch()}>Retry</button></div>}
    {(save.error || remove.error) && <p role="alert" className="text-xs text-[#b3261e]">{(save.error || remove.error)?.message}</p>}
    {message && <p role="status" className="text-xs text-[#05628f]">{message}</p>}
  </section>;
}
