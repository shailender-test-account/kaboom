import type { HpCrmDeals } from "./types";
import { num } from "./format";
import { Chip } from "./ui";

export default function CrmDealQuality({ crm, scopeNote }: { crm: HpCrmDeals | undefined; scopeNote?: string }) {
  if (!crm) return null;
  const stats: [string, number][] = [["CRM deals", crm.total], ["Counted opportunities", crm.includedOpportunities], ["Counted outcomes", crm.includedOutcomes],
    ["Incomplete deals", crm.incompleteDeals], ["Excluded deals", crm.excludedDeals], ["Excel mirrors suppressed", crm.suppressedMirrors]];
  return (
    <div className="space-y-2" data-testid="crm-deal-quality">
      <div className="text-[10.5px] uppercase tracking-wider font-semibold text-[#5d7388]">CRM deal reporting{scopeNote ? ` (${scopeNote})` : ""}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {stats.map(([k, v]) => (
          <div key={k} data-testid={`crm-stat-${k.toLowerCase().replace(/ /g, "-")}`} className={`rounded border px-2 py-1.5 ${(k === "Incomplete deals" || k === "Excluded deals") && v > 0 ? "border-[#f0cfae] bg-[#fdf5ec]" : "border-[#d5e0ea] bg-[#f6f9fb]"}`}>
            <div className="text-lg font-semibold tabular-nums text-[#0B2A4A]">{num(v)}</div>
            <div className="text-[10.5px] text-[#5d7388] leading-tight">{k}</div>
          </div>
        ))}
      </div>
      {crm.issuesTruncated && <p className="text-xs text-[#5d7388]">
        Showing the first {crm.issues.length} of {num(crm.incompleteDeals)} deals needing review. All coverage counts and financial totals include the full scope.
      </p>}
      {crm.issues.length === 0 ? <p className="text-xs text-[#5d7388]">No incomplete or excluded CRM deals in this scope.</p> : (
        <ul className="space-y-1.5 max-h-72 overflow-y-auto" data-testid="list-crm-issues">
          {crm.issues.map(i => (
            <li key={i.dealId} className="rounded border border-[#f0cfae] bg-[#fdf9f4] px-2 py-1.5 text-xs" data-testid={`crm-issue-${i.dealId}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-[#10243B] break-words min-w-0">{i.title}</span>
                <Chip tone="gray">Deal {i.dealId}</Chip>
                <span className="text-[#5d7388]">{i.accountName ?? "No linked account"}</span>
              </div>
              <ul className="list-disc pl-4 mt-1 text-[#8f4f0f]">{i.reasons.map(r => <li key={r}>{r}</li>)}</ul>
              {(i.opportunityReference || i.outcomeReference) && (
                <div className="mt-0.5 text-[10px] text-[#5d7388] font-mono break-all">{[i.opportunityReference, i.outcomeReference].filter(Boolean).join(" / ")}</div>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
