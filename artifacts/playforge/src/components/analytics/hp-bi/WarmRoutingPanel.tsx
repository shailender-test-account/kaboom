import { useState } from "react";
import { useGetHpWarmRoutingStatus, type GetHpWarmRoutingStatusParams } from "@workspace/api-client-react";
import { Panel, Skel } from "./ui";
import BulkRoutingControls from "./BulkRoutingControls";

const labels: Record<string, string> = { routed: "Worker marked routed", blocked: "Blocked", unmapped: "Unmapped", not_eligible: "Not eligible", unchecked: "Not checked" };
const routingLabels: Record<string, string> = {
  journey_only: "Journey only", journey_and_sequence: "Journey and sequence",
  historical_enrollment: "Existing historical enrollment", blocked: "Blocked", pending: "Assignment needed",
};
const button = "rounded border border-[#c5d3df] px-3 py-1.5 text-xs disabled:opacity-50";
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet";

export default function WarmRoutingPanel({ clientId, onOpenAccount }: {
  clientId: number; onOpenAccount: (key: string) => void;
}) {
  const [status, setStatus] = useState<GetHpWarmRoutingStatusParams["status"]>();
  const [cursors, setCursors] = useState([""]);
  const [heat,setHeat] = useState("");
  const [selected,setSelected] = useState<Set<string>>(new Set());
  const [busy,setBusy] = useState(false);
  const q = useGetHpWarmRoutingStatus({ clientId, status, after: cursors.at(-1) },
    { query: { staleTime: 0, refetchOnMount: "always", refetchInterval: 60_000 } });
  const data = q.data;
  const visible = (data?.items ?? []).filter(r => !heat || r.qualification===heat);
  const clear = () => setSelected(new Set());
  return <Panel title="Warm journey routing" note="Automatic Warm routing status and manual bulk journey / sequence routing.">
    <div className="space-y-4 text-sm">
      <p>Live routing checks each respondent and product against the exact applicable saved rule destinations. Journey membership alone is not sequence routing. Existing historical enrollments are never adopted or restarted by this check. Manual routing below does not require Warm qualification.</p>
      <button className={button} disabled={q.isFetching || busy} onClick={() => void q.refetch()}>Refresh status</button>
      {q.isError && <p role="alert" className="text-red-700">Could not load routing status. {q.error.message}</p>}
      {q.isLoading && <Skel />}
      {data && <>
        {data.paused && <p role="status" className="rounded bg-amber-50 p-3 text-amber-900">Automatic routing is paused by copied-data safe mode. An administrator must approve its environment-specific enable switch. Manual journey assignment does not release paused outbound delivery.</p>}
        {data.sweep.lastFailureAt && <p role="alert" className="text-red-700">A sweep failed at {date(data.sweep.lastFailureAt)}. It will retry from the saved cursor; ask an administrator to inspect API logs if this persists.</p>}
        <dl className="grid gap-2 md:grid-cols-3">
          <div><dt className="font-semibold">Last successful batch</dt><dd>{date(data.sweep.lastSuccessAt)}</dd></div>
          <div><dt className="font-semibold">Last complete sweep</dt><dd>{date(data.sweep.lastCompletedAt)}</dd></div>
          <div><dt className="font-semibold">Resume position</dt><dd className="break-all">{data.sweep.cursor || "Start of next sweep"}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <span className="self-center text-xs font-semibold">Last worker check:</span>
          <button disabled={busy} className={button} aria-pressed={!status} onClick={() => { setStatus(undefined); setCursors([""]); clear(); }}>All accounts</button>
          {Object.entries(labels).map(([key, label]) => <button disabled={busy} className={button} key={key} aria-pressed={status === key}
            onClick={() => { setStatus(key as typeof status); setCursors([""]); clear(); }}>{label} ({data.counts[key] ?? 0})</button>)}
        </div>
        <label className="flex items-center gap-2 text-xs">Qualification on this page
          <select className={button} disabled={busy} value={heat} onChange={e => {setHeat(e.target.value);clear();}}>
            <option value="">Hot, Warm and Cold</option>{["Hot","Warm","Cold"].map(h => <option key={h}>{h}</option>)}
          </select>
        </label>
        <BulkRoutingControls key={[...selected].sort().join("|")} clientId={clientId} rows={data.items.filter(r => selected.has(r.parentKey))}
          data={data} onBusyChange={setBusy} onDone={() => {void q.refetch();}} />
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr><th className="p-2"><input type="checkbox" aria-label="Select all accounts on this page" disabled={busy || !visible.length}
            checked={!!visible.length && visible.every(r => selected.has(r.parentKey))}
            onChange={e => setSelected(new Set(e.target.checked ? visible.map(r => r.parentKey) : []))} /></th>
            <th className="p-2">Account group</th><th className="p-2">Qualification</th><th className="p-2">Recorded product interest</th><th className="p-2">Contacts</th><th className="p-2">Last worker outcome</th><th className="p-2">Live routing / next action</th><th className="p-2">Worker checked</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.parentKey} className="border-t">
            <td className="p-2"><input type="checkbox" aria-label={`Select ${row.name}`} disabled={busy} checked={selected.has(row.parentKey)}
              onChange={e => setSelected(s => {const next=new Set(s);e.target.checked ? next.add(row.parentKey) : next.delete(row.parentKey);return next;})} /></td>
            <td className="p-2"><button className="text-[#007bb4] underline" onClick={() => onOpenAccount(row.parentKey)}>{row.name}</button></td>
            <td className="p-2 font-semibold">{row.qualification}</td><td className="p-2">{row.products.join(", ") || "Not declared"}</td>
            <td className="p-2">{row.contactCount} ({row.contacts.filter(c => c.eligible).length} eligible)</td>
            <td className="p-2">{labels[row.status]}<p className="mt-1 text-slate-500">{row.reason}</p></td><td className="p-2">
              {row.routingDetails.length ? <ul className="space-y-3">{row.routingDetails.map((detail, index) => <li key={`${detail.submissionId}:${detail.contactId}:${detail.product}:${index}`}>
                <p className="font-semibold">{routingLabels[detail.state]} — {detail.product}</p>
                <p className="text-slate-500">{row.contacts.find(c => c.id === detail.contactId)?.name || `Contact ${detail.contactId ?? "not linked"}`}
                  {detail.submissionId ? ` · Response #${detail.submissionId}` : " · Overall Warm evidence"}</p>
                <p>Rule #{detail.ruleId ?? "not configured"} · Journey: {detail.journeyName ?? "Unavailable"} · Sequence: {detail.sequenceName ?? "Unavailable"}
                  {detail.enrollmentStatus && ` (${detail.enrollmentStatus})`}</p>
                <p className="mt-1">{detail.nextAction}</p>
              </li>)}</ul> : <p>No attributable product routing to check. Review current evidence and contact identity.</p>}
            </td>
            <td className="p-2">{date(row.checkedAt)}</td>
          </tr>)}</tbody>
        </table></div>
        {!visible.length && <p>No accounts match on this page. Use Next to review more accounts.</p>}
        <div className="flex gap-2">
          <button className={button} disabled={busy || cursors.length < 2 || q.isFetching} onClick={() => {clear();setCursors(c => c.slice(0, -1));}}>Previous</button>
          <button className={button} disabled={busy || !data.nextCursor || q.isFetching} onClick={() => {clear();setCursors(c => [...c, data.nextCursor!]);}}>Next</button>
        </div>
        <p className="text-xs text-slate-500">Qualification and routing details are live; filter counts and worker outcomes describe the last automatic check, not proof of sequence enrollment. Historical responses remain visible without renewing qualification or authorizing outreach. Product interest shows recorded first-party answers, not inferred research fit. Select accounts on one page, narrow to a product, and preview contacts before confirming. Never remove an opt-out solely to route an account.</p>
      </>}
    </div>
  </Panel>;
}
