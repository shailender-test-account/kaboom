type Source = { sourceRow: number; fileName: string; sheet: string; contactId: number | null; identityReview?: string;
  values: Record<string, string> };
export type GccMember = { id: number; name: string; dimensions: Record<string, unknown> };
const fields = [["companyName", "Source company"], ["name", "Name"], ["title", "Job title"],
  ["email", "Email"], ["email2", "Alternate email"], ["phone", "Phone"], ["phone2", "Alternate phone"], ["city", "City"]];

export function gccSourceRows(members: GccMember[]) {
  return members.flatMap(m => {
    const source = m.dimensions._gccProfiling;
    return Array.isArray(source) ? source.filter(r => r && !r.deleted && r.values && (r.contactId || r.identityReview))
      .map(r => ({ member: m.name, record: r as Source })) : [];
  });
}

export default function GccProfiling({ members }: { members: GccMember[] }) {
  const rows = gccSourceRows(members);
  if (!rows.length) return null;
  return <details open data-testid="gcc-profiling" className="rounded border border-[#e3ebf2] p-2">
    <summary className="cursor-pointer text-xs font-semibold text-[#05628f]">GCC profiling — {rows.length} source rows</summary>
    <p className="mt-1 text-[11px] text-[#5d7388]">Directory details from the approved GCC sheet. These are not responses, qualified leads or consent to outreach.</p>
    <div className="mt-2 space-y-2">{rows.map(({ member, record: r }, index) => <article key={`${r.contactId}-${r.sourceRow}-${index}`}
      className="rounded border border-[#e3ebf2] p-2 text-xs" data-testid="gcc-profile-row">
      <p className="font-semibold">{member} · {r.contactId ? `Contact #${r.contactId}` : "Contact link pending review"}</p>
      {r.identityReview && <p className="mt-1 text-[11px] text-amber-800" data-testid="gcc-identity-review">
        Needs identity review: {r.identityReview}. Source fields are retained; do not assume this email belongs to both people.
      </p>}
      <dl className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">{fields.map(([key, label]) => <div key={key}
        className="border-t border-[#e3ebf2] py-1"><dt className="text-[#5d7388]">{label}</dt>
        <dd className="break-words [overflow-wrap:anywhere]">{r.values[key] || "Not supplied"}</dd></div>)}</dl>
      <p className="mt-1 break-words text-[11px] text-[#5d7388]">{r.fileName} / {r.sheet} / row {r.sourceRow}</p>
    </article>)}</div>
  </details>;
}
