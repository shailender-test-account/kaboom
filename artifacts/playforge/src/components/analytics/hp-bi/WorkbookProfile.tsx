import { useState } from "react";
import { HP_DIMENSIONS } from "./format";

type Member = { id: number; name: string; dimensions: Record<string, unknown>; variants: Record<string, unknown>[] };
const GROUPS: [string, string[]][] = [
  ["Context", ["deployment", "gtm", "account_group", "state_ut", "zone", "parent_sub", "city", "state"]],
  ["Industry", ["industry_vertical", "industry_segment", "hpi_segment", "e_cat", "emp_size"]],
  ["PS & Print planning (TAM in $K, not ToV)", ["ps_tam_k", "prt_tam_k", "ps_rad", "prt_rad"]],
  ["RTM, partners, HP ownership emails (not leads)", ["rtm_ps", "ps_partners", "rtm_print", "print_partners", "eam_email", "pam_email", "rm_email", "isr_email", "zm_email", "poly_am_email", "poly_mgr_email"]],
  ["Hierarchy and IDs", ["hp_id", "top_id", "top_name", "mid_id", "mid_name", "act_st", "st_name", "partial_st", "partial_name", "org_id", "opsi", "legal_name", "relationship_link"]],
];
const shown = (v: unknown) => v == null || /^(?:\s*|-|n\/?a|null|none)$/i.test(String(v).trim()) ? null : typeof v === "object" ? JSON.stringify(v) : String(v);

export default function WorkbookProfile({ members }: { members: Member[] }) {
  const [mi, setMi] = useState(0);
  const [vi, setVi] = useState(0);
  const m = members[Math.min(mi, members.length - 1)];
  if (!m) return null;
  const variants = Array.isArray(m.variants) ? m.variants : [];
  const variant = variants[Math.min(vi, variants.length - 1)] as (Record<string, unknown> & { _source?: { fileName?: string; sheet?: string; row?: number } }) | undefined;
  const src = variant?._source;
  // A selected source row is authoritative: do not fill its blank cells from another variant.
  const get = (k: string) => variant ? shown(variant[k] ?? variant[HP_DIMENSIONS[k]]) : shown(m.dimensions?.[k] ?? m.dimensions?.[HP_DIMENSIONS[k]]);
  const grouped = new Set(GROUPS.flatMap(g => g[1]));
  const groups = [...GROUPS, ["Other", Object.keys(HP_DIMENSIONS).filter(k => !grouped.has(k))] as [string, string[]]].filter(g => g[1].length);
  const all = Object.keys(HP_DIMENSIONS);
  const filled = all.filter(k => get(k) !== null).length;
  return (
    <div data-testid="workbook-profile" className="rounded border border-[#e3ebf2] p-2 space-y-2">
      <h5 className="text-[10.5px] uppercase tracking-wider font-semibold text-[#5d7388]">Workbook profile (read-only, all {all.length} columns)</h5>
      <div className="flex flex-wrap gap-2 text-xs">
        <label>Member <select data-testid="select-wb-member" className="rounded border border-[#c5d3df] px-1 py-0.5" value={mi} onChange={e => { setMi(Number(e.target.value)); setVi(0); }}>{members.map((x, i) => <option key={x.id} value={i}>{x.name}</option>)}</select></label>
        <label>Source variant <select data-testid="select-wb-variant" className="rounded border border-[#c5d3df] px-1 py-0.5" value={vi} disabled={!variants.length} onChange={e => setVi(Number(e.target.value))}>
          {!variants.length && <option>No source rows</option>}
          {variants.map((v, i) => { const s = (v as { _source?: { fileName?: string; sheet?: string; row?: number } })._source; return <option key={i} value={i}>{s ? `${s.fileName ?? "file"} / ${s.sheet ?? "sheet"} / row ${s.row ?? "?"}` : `Variant ${i + 1}`}</option>; })}</select></label>
        <span className="text-[#5d7388]" data-testid="text-wb-filled">{filled} of {all.length} fields supplied{src ? ` (row ${src.row ?? "?"})` : ""}</span>
      </div>
      {groups.map(([title, keys]) => <div key={title}><h6 className="text-[11px] font-semibold text-[#0B2A4A]">{title}</h6>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">{keys.map(k => { const v = get(k); return <div key={k} className="flex justify-between gap-2 border-t border-[#e3ebf2] py-0.5 text-xs" data-testid={`wb-${k}`}><dt className="text-[#5d7388]">{HP_DIMENSIONS[k]}</dt><dd className={`text-right break-all ${v === null ? "text-[#8CA0B3]" : "font-medium"}`}>{v ?? "Not supplied"}</dd></div>; })}</dl></div>)}
    </div>
  );
}
