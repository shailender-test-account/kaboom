import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HpWarmRoutingCheck, HpWarmRoutingStatus, HpRoutingContact } from "@workspace/api-client-react";
import { routeHpContacts, type BulkRoutingResult } from "./bulk-routing";

const control = "rounded border border-slate-300 bg-white p-2 text-xs disabled:opacity-50";
export default function BulkRoutingControls({clientId,rows,data,onDone,onBusyChange}: {
  clientId:number; rows:HpWarmRoutingCheck[]; data:HpWarmRoutingStatus; onDone:()=>void; onBusyChange:(busy:boolean)=>void;
}) {
  const [journey,setJourney] = useState("");
  const [sequence,setSequence] = useState("");
  const [product,setProduct] = useState("");
  const [preview,setPreview] = useState(false);
  const [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false);
  const [results,setResults] = useState<BulkRoutingResult[]>([]);
  const [snapshot,setSnapshot] = useState<HpRoutingContact[]>([]);
  const lock = useRef(false);
  const qc = useQueryClient();
  const products = [...new Set(rows.flatMap(r => r.products))].sort();
  const contacts = [...new Map(rows.flatMap(r => r.contacts)
    .filter(c => !product || c.products.includes(product)).map(c => [c.id,c])).values()];
  const reviewedContacts = preview ? snapshot : contacts;
  const eligible = reviewedContacts.filter(c => c.eligible);
  const truncated = rows.some(r => r.contactCount>r.contacts.length);
  const reset = () => { setPreview(false);setConfirmed(false);setResults([]); };
  async function submit() {
    if (lock.current || !confirmed || !journey || !eligible.length || eligible.length>200 || truncated) return;
    lock.current=true;setBusy(true);onBusyChange(true);
    try {
      setResults(await routeHpContacts(clientId,eligible,Number(journey),sequence ? Number(sequence) : undefined,product || undefined));
      setPreview(false);setConfirmed(false);
    } finally {
      lock.current=false;setBusy(false);onBusyChange(false);
      await qc.invalidateQueries();
      onDone();
    }
  }
  return <div className="space-y-3 rounded border border-slate-300 bg-slate-50 p-3">
    <h4 className="font-semibold">Bulk route selected accounts ({rows.length})</h4>
    <p className="text-xs">Routes contacts, not the company itself. Qualification is unchanged. Existing assignments are retained; historical sequences are never restarted.</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label="Product interest for bulk routing" className={control} disabled={busy} value={product} onChange={e => {setProduct(e.target.value);reset();}}>
        <option value="">All selected contacts (manual targeting)</option>
        {products.map(p => <option key={p}>{p}</option>)}
      </select>
      <select aria-label="Destination journey" className={control} disabled={busy} value={journey} onChange={e => {setJourney(e.target.value);reset();}}>
        <option value="">Choose published journey</option>
        {data.journeyOptions.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
      </select>
      <select aria-label="Destination sequence" className={control} disabled={busy} value={sequence} onChange={e => {setSequence(e.target.value);reset();}}>
        <option value="">Journey only — no sequence</option>
        {data.sequenceOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button className={control} disabled={busy || !journey || !rows.length} onClick={() => {setSnapshot(contacts);setPreview(true);setConfirmed(false);setResults([]);}}>Preview contacts</button>
    </div>
    {!data.journeyOptions.length && <p>No published HP journey is available. Publish a destination before routing.</p>}
    {data.outreachPaused && <p className="text-xs text-amber-800">This environment pauses outbound delivery. Sequence enrollment does not override that pause.</p>}
    {preview && <div className="space-y-2">
      <p>{eligible.length} eligible contacts; {reviewedContacts.length-eligible.length} blocked contacts will be skipped.</p>
      {(eligible.length>200 || truncated) && <p role="alert">Too many contacts for one batch. Select fewer accounts (maximum 200 contacts; no truncated account previews).</p>}
      {!reviewedContacts.length && <p>No contacts match this product. Choose another product or open the account to add contacts.</p>}
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs">
        <thead><tr><th>Contact</th><th>Recorded product interest</th><th>Eligibility</th></tr></thead>
        <tbody>{reviewedContacts.map(c => <tr key={c.id} className="border-t"><td className="p-2">{c.name}</td><td>{c.products.join(", ") || "Not declared"}</td><td>{c.eligible ? "Eligible" : c.reason}</td></tr>)}</tbody>
      </table></div>
      <label className="flex gap-2 text-xs"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        I reviewed these contacts and the destination{sequence ? "; enroll them in this sequence, which may start outreach when delivery is enabled" : "; add journey membership only"}.
      </label>
      <button className={control} disabled={busy || !confirmed || !eligible.length || eligible.length>200 || truncated} onClick={() => void submit()}>
        {busy ? "Routing contacts…" : "Confirm bulk routing"}
      </button>
    </div>}
    {!!results.length && <div role="status" className="max-h-64 overflow-auto">
      <p className="font-semibold">Batch finished — {results.length} contacts checked</p>
      <table className="w-full text-left text-xs"><thead><tr><th>Contact</th><th>Journey result</th><th>Sequence result</th></tr></thead>
        <tbody>{results.map(r => <tr className="border-t" key={r.contactId}><td className="p-2">{r.name}</td><td>{r.journey}</td><td>{r.sequence}</td></tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
