import { useRef, useState } from "react";
import { useCreateIntentInboundSource, type IntentInboundSource } from "@/hooks/use-intent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Draft = { key: number; name: string; folderUrl: string; formType: "lead_form" | "event_feedback";
  saved?: IntentInboundSource; error?: string };
const folderId = (url: string) => {
  const value = url.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "drive.google.com") return null;
    return parsed.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? parsed.searchParams.get("id");
  } catch { return null; }
};

export default function MultipleDriveFolders({ clients, clientId, onSaved, onCancel }: {
  clients: { id: number; name: string }[]; clientId?: number;
  onSaved: (source: IntentInboundSource) => void; onCancel: () => void;
}) {
  const nextKey = useRef(3);
  const busy = useRef(false);
  const [rows, setRows] = useState<Draft[]>([
    { key: 1, name: "", folderUrl: "", formType: "lead_form" },
    { key: 2, name: "", folderUrl: "", formType: "event_feedback" },
  ]);
  const [selectedClient, setClient] = useState(clientId ? String(clientId) : "");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const create = useCreateIntentInboundSource();
  const update = (key: number, patch: Partial<Draft>) => setRows(old => old.map(row =>
    row.key === key ? { ...row, error: undefined, ...patch } : row));
  const hasSaved = rows.some(row => row.saved);
  async function save() {
    if (busy.current) return;
    const ids = rows.map(row => folderId(row.folderUrl));
    if (!selectedClient || rows.some(row => !row.name.trim()) || ids.some(id => !id)) {
      setError("Select a client and enter a name and valid Google Drive folder URL for every row."); return;
    }
    if (new Set(ids).size !== ids.length) {
      setError("Each folder must be unique. Remove duplicate URLs, including different links to the same folder."); return;
    }
    busy.current = true; setSaving(true); setError("");
    let lastSaved = rows.findLast(row => row.saved)?.saved;
    let failed = 0;
    try {
      for (const row of rows) {
        if (row.saved) continue;
        try {
          const result = await create.mutateAsync({ name: row.name.trim(), folderUrl: row.folderUrl.trim(),
            clientId: Number(selectedClient), formType: row.formType, enabled, fieldMappings: {} });
          lastSaved = result.source;
          update(row.key, { saved: result.source });
        } catch (err) {
          failed++;
          update(row.key, { error: err instanceof Error ? err.message : "Could not save this folder." });
        }
      }
      if (!failed && lastSaved) onSaved(lastSaved);
      else setError(`${failed} folder(s) could not be saved. Saved folders are retained; retry only the remaining rows.`);
    } finally { busy.current = false; setSaving(false); }
  }
  return <div className="space-y-4" data-testid="multiple-drive-folders">
    <p className="text-sm text-slate-600">Add multiple Drive folders. Each URL is saved separately with its own name and response type. Existing sources are not changed.</p>
    <Label className="block">Target client
      <select aria-label="Target client for folders" value={selectedClient} disabled={saving || hasSaved}
        onChange={event => setClient(event.target.value)} className="block w-full border rounded p-2 mt-1">
        <option value="">Select client…</option>{clients.map(client =>
          <option key={client.id} value={client.id}>{client.name}</option>)}
      </select>
    </Label>
    {rows.map((row, index) => <fieldset key={row.key} disabled={saving || !!row.saved} className="rounded border p-3 space-y-3">
      <legend className="text-xs font-semibold px-1">Folder {index + 1}{row.saved ? " · Saved" : ""}</legend>
      <Label className="block">Source name
        <Input aria-label={`Folder ${index + 1} name`} value={row.name} onChange={event => update(row.key, { name: event.target.value })} />
      </Label>
      <Label className="block">Google Drive folder URL
        <Input aria-label={`Folder ${index + 1} URL`} value={row.folderUrl} placeholder="https://drive.google.com/drive/folders/…"
          onChange={event => update(row.key, { folderUrl: event.target.value })} />
      </Label>
      <Label className="block">Response type
        <select aria-label={`Folder ${index + 1} response type`} className="block w-full border rounded p-2 mt-1" value={row.formType}
          onChange={event => update(row.key, { formType: event.target.value as Draft["formType"] })}>
          <option value="lead_form">Lead Form</option><option value="event_feedback">Event Feedback Form / questionnaire</option>
        </select>
      </Label>
      {row.error && <p role="alert" className="text-sm text-red-700">{row.error}</p>}
      {!row.saved && rows.length > 1 && <Button variant="outline" onClick={() => setRows(old => old.filter(item => item.key !== row.key))}>Remove folder {index + 1}</Button>}
    </fieldset>)}
    <Button variant="outline" disabled={saving || rows.length >= 20} onClick={() => setRows(old =>
      [...old, { key: nextKey.current++, name: "", folderUrl: "", formType: "lead_form" }])}>Add another URL</Button>
    <Label className="flex gap-2 items-center"><input type="checkbox" checked={enabled} disabled={saving || hasSaved}
      onChange={event => setEnabled(event.target.checked)} />Enable automatic sync for new folders</Label>
    <p className="text-xs text-slate-500">Use folder URLs, not individual file links. Put lead forms and event feedback in separate folders. Configure each saved folder's field mappings through Edit.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="flex gap-2 justify-end">
      <Button variant="outline" disabled={saving} onClick={onCancel}>Back</Button>
      <Button disabled={saving} onClick={save}>{saving ? "Saving folders…" : "Save folders"}</Button>
    </div>
  </div>;
}
