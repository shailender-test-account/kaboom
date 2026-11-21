import { useMemo, useState } from "react";
import { X } from "lucide-react";

type Opt = { key: string; name: string; accounts: number };
const LIMIT = 40;

export default function ParentPicker({ options, selected, onChange, names }: {
  options: Opt[]; selected: string[]; onChange: (keys: string[]) => void; names: Map<string, string>;
}) {
  const [q, setQ] = useState("");
  const { slice, matches } = useMemo(() => {
    const t = q.trim().toLowerCase();
    const m = t ? options.filter(o => o.name.toLowerCase().includes(t)) : options;
    return { slice: m.slice(0, LIMIT), matches: m.length };
  }, [options, q]);
  const toggle = (k: string) => onChange(selected.includes(k) ? selected.filter(s => s !== k) : [...selected, k]);
  return (
    <div className="space-y-2">
      <label className="block text-xs font-semibold text-[#41586e]" htmlFor="pivot-parent-search">Parent groups ({selected.length} selected)</label>
      <input id="pivot-parent-search" data-testid="pivot-parent-search" type="search" value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search parent groups" className="w-full rounded border border-[#c5d3df] bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40" />
      {selected.length > 0 && <ul className="flex flex-wrap gap-1" aria-label="Selected parent groups">
        {selected.map(k => <li key={k}><button type="button" data-testid={`pivot-chip-${k}`} onClick={() => toggle(k)} aria-label={`Remove ${names.get(k) ?? k}`}
          className="inline-flex items-center gap-1 rounded bg-[#0B2A4A] px-2 py-0.5 text-[11px] text-white">{names.get(k) ?? k}<X className="h-3 w-3" /></button></li>)}
        <li><button type="button" data-testid="pivot-parents-clear" onClick={() => onChange([])} className="px-2 py-0.5 text-[11px] text-[#05628f] underline">Clear parents</button></li>
      </ul>}
      {selected.some(k => !options.some(o => o.key === k)) && <p className="text-[11px] text-[#8a5200]" data-testid="pivot-parent-unavailable">
        Some selected parents are not in the current filtered roster. Their selection is retained; clear them or widen the inherited scope if needed.
      </p>}
      <div className="max-h-48 overflow-y-auto rounded border border-[#c5d3df] bg-white p-1" role="group" aria-label="Parent group options">
        {slice.length === 0 && <p className="p-2 text-xs text-[#5d7388]">No parent groups match.</p>}
        {slice.map(o => <label key={o.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[#eaf6fc]">
          <input id={`pivot-parent-${o.key}`} data-testid={`pivot-parent-${o.key}`} type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} />
          <span className="min-w-0 flex-1 truncate">{o.name}</span><span className="tabular-nums text-[#5d7388]">{o.accounts}</span>
        </label>)}
      </div>
      <p className="text-[11px] text-[#5d7388]">Showing {slice.length.toLocaleString("en-IN")} of {matches.toLocaleString("en-IN")} matching parents{matches > LIMIT ? "; refine the search to see others" : ""}.</p>
    </div>
  );
}
