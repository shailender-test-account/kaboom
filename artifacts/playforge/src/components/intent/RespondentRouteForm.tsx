import { useId, useState } from "react";
import { Button } from "@/components/ui/button";

export type RespondentSequence = { id: number; name: string; status?: string; clientId?: number | null };

export default function RespondentRouteForm({ journeys, sequences, busy, onSubmit }: {
  journeys: { id: number; name: string }[];
  sequences: RespondentSequence[];
  busy: boolean;
  onSubmit: (selection: { journeyId: number; sequenceId: number }) => void;
}) {
  const id = useId();
  const [journeyId, setJourneyId] = useState("");
  const [sequenceId, setSequenceId] = useState("");
  const valid = journeys.some(j => String(j.id) === journeyId) && sequences.some(s => String(s.id) === sequenceId);
  const input = "h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-900";
  return <form className="mt-2 space-y-2" data-testid="respondent-route-form" onSubmit={event => {
    event.preventDefault();
    if (valid && !busy) onSubmit({ journeyId: Number(journeyId), sequenceId: Number(sequenceId) });
  }}>
    <label htmlFor={`${id}-journey`} className="block text-xs font-semibold">Journey · all journeys for this client</label>
    <select id={`${id}-journey`} className={input} value={journeyId} onChange={e => setJourneyId(e.target.value)}>
      <option value="">Choose journey</option>
      {journeys.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
    </select>
    {!journeys.length && <p role="status" className="text-xs text-amber-800">No journeys available for this client.</p>}
    <label htmlFor={`${id}-sequence`} className="block text-xs font-semibold">Sequence · draft or active</label>
    <select id={`${id}-sequence`} className={input} value={sequenceId} onChange={e => setSequenceId(e.target.value)}>
      <option value="">Choose sequence</option>
      {sequences.map(s => <option key={s.id} value={s.id}>{s.name}{s.status ? ` · ${s.status === "draft" ? "Draft" : "Active"}` : ""}</option>)}
    </select>
    {!sequences.length && <p role="status" className="text-xs text-amber-800">No draft or active sequences available for this client.</p>}
    <p className="text-[11px] text-slate-600">Saves this response’s journey and sequence destination only. Does not enroll the contact in email delivery or send any emails.</p>
    {!valid && journeys.length > 0 && sequences.length > 0 && <p className="text-[11px] text-slate-500">Choose both a journey and a sequence to enable Save.</p>}
    <Button type="submit" size="sm" className="w-full font-bold bg-sky-600 hover:bg-sky-700" disabled={!valid || busy}>
      {busy ? "Saving route…" : "Save route (no emails)"}
    </Button>
  </form>;
}
