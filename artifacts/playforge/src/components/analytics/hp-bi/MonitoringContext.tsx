import { useId } from "react";
import { Link } from "wouter";
import type { HpBiDetail } from "./types";
import { dateTimeText } from "./format";
import { BusinessDirectionBullets, HpTakeawayBullets, ResearchSources } from "@/components/intent/HpResearchTakeaways";

type Contexts = NonNullable<HpBiDetail["monitoringContext"]>;
export const MAX_FINDINGS = 3;

export function MonitoringSourceEvidence({ contexts = [], sourcePrefix }: { contexts?: Contexts; sourcePrefix: string }) {
  return <div className="space-y-3">{contexts.map(account => account.sourceEvidence?.length ? <div key={`${account.researchScope}-${account.accountId}`}>
    <h5 className="text-xs font-semibold">{account.accountName}</h5>
    <ResearchSources sources={account.sourceEvidence} sourcePrefix={`${sourcePrefix}-${account.accountId}`} />
  </div> : null)}</div>;
}

export default function MonitoringContext({ contexts = [], accountId, clientId, sourcePrefix }: {
  contexts?: Contexts; accountId?: number; clientId?: number; sourcePrefix?: string;
}) {
  const localPrefix = useId();
  const prefix = sourcePrefix ?? `monitoring-${localPrefix}`;
  const accounts = [...new Map((accountId == null ? contexts : contexts.filter(account => account.accountId === accountId || account.memberAccountIds?.includes(accountId)))
    .map(account => [`${account.researchScope}-${account.accountId}`, account])).values()]
    .sort((a, b) => Number(b.researchScope === "parent") - Number(a.researchScope === "parent"));
  return <div className="space-y-2 border-t border-[#d5e0ea] pt-3" data-testid="monitoring-account-context">
    <div className="flex items-start gap-2">
      <h5 className="text-[11px] font-semibold uppercase tracking-wider text-[#0B2A4A]">Business direction &amp; HP opportunity <span className="font-normal normal-case tracking-normal text-[#5d7388]">· not declared buying intent</span></h5>
      <details className="text-[11px]"><summary aria-label="About monitoring context" className="cursor-pointer rounded-full border px-1 font-semibold">?</summary>
        <p>Up to three source-backed HP solution hypotheses, using India unless monitoring specifies another country. Publication dates, attribution and local relevance are checked; missing evidence is not a product requirement. Research does not change BI leads, qualification or order value.</p>
      </details>
    </div>
    {!accounts.length && <p className="text-xs text-[#5d7388]">No monitoring research available for this account yet.</p>}
    {accounts.map(account => <div key={`${account.researchScope}-${account.accountId}`} className="space-y-2 rounded border border-[#d5e0ea] bg-[#f7fafc] p-3" data-testid={`card-monitoring-account-${account.accountId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <strong>{account.accountName}{account.researchScope && <span className="ml-2 text-[10px] font-normal text-[#5d7388]">{account.researchScope === "parent" ? "Parent organization · roster grouping" : "Member company · separate findings"}</span>}</strong>
        {account.analysisAccountId !== null && <Link href={`/intent/accounts/${account.analysisAccountId ?? account.accountId}${clientId ? `?clientId=${clientId}` : ""}#account-research-details`} className="font-semibold text-[#05628f] underline">Open Intent Engine analysis</Link>}
      </div>
      <p className="text-[11px] text-[#5d7388]">{account.lastCheckedAt ? `Last checked: ${dateTimeText(account.lastCheckedAt)}` : "No completed check yet"}{account.runStatus && ` · Latest run: ${account.runStatus}`}</p>
      {account.researchScope === "parent" && !account.lastCheckedAt && <p className="text-xs text-[#5d7388]">Parent research pending. Existing member-company news has not been reassigned to this organization.</p>}
      {account.researchScope === "parent" && account.lastCheckedAt && !account.findings.length && !account.sourceEvidence?.length &&
        <p className="text-xs text-[#5d7388]">Parent check completed, but no usable parent-company news survived source validation. Retained member-company evidence remains separate.</p>}
      {!(account.researchScope==="parent"&&!account.findings.length&&!account.sourceEvidence?.length)&&<>
      <BusinessDirectionBullets directions={account.businessDirections} sources={account.sourceEvidence} sourcePrefix={`${prefix}-${account.accountId}`} />
      <section aria-label="Potential HP fit and pitch" className="space-y-2"><h5 className="text-xs font-semibold">Potential HP fit &amp; pitch · hypotheses</h5>
        <HpTakeawayBullets takeaways={account.takeaways} sources={account.sourceEvidence} sourcePrefix={`${prefix}-${account.accountId}`} validationSummary={account.validationSummary} /></section>
      </>}
    </div>)}
    {!sourcePrefix && <MonitoringSourceEvidence contexts={accounts} sourcePrefix={prefix} />}
  </div>;
}
