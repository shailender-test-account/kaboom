import type { HpBiDetail } from "./types";
import { dateTimeText } from "./format";

/** Research completion is operational context, not an intent temperature. */
export function monitoringCoverage(d: HpBiDetail) {
  const members = new Set((d.members ?? []).map(member => member.id));
  const contexts = [...new Map((d.monitoringContext ?? [])
    .filter(account => account.researchScope !== "parent" && (!members.size || members.has(account.accountId)))
    .map(account => [account.accountId, account])).values()];
  const parents = [...new Map((d.monitoringContext ?? [])
    .filter(account => account.researchScope === "parent" && (!members.size ||
      account.memberAccountIds?.some(id => members.has(id))))
    .map(account => [account.accountId, account])).values()];
  const total = members.size || contexts.length;
  const completed = (account: typeof contexts[number]) => !!account.lastCheckedAt || account.runStatus === "completed";
  const checked = contexts.filter(completed).length;
  const parentChecked = parents.filter(completed).length;
  const all = [...contexts, ...parents];
  const active = all.filter(account => ["running", "claimed", "queued", "pending"].includes(account.runStatus ?? "")).length;
  const failed = all.filter(account => account.runStatus === "failed").length;
  const latest = all.map(account => account.lastCheckedAt).filter((value): value is string => !!value)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const label = active ? "In progress" : failed ? "Latest check failed"
    : parentChecked ? "Parent checked"
    : checked ? checked < total ? "Partly checked" : "Checked"
    : all.some(account => account.findings.length) ? "Research available" : "Not checked";
  const analysisAccountId = parents.find(account => account.sourceEvidence?.length || account.findings.length)?.analysisAccountId
    ?? parents.find(completed)?.analysisAccountId;
  return { total, checked, parentChecked, parentTotal: parents.length, active, failed, latest, label, analysisAccountId };
}

export default function MonitoringCoverage({ d, hasIntent, showLabel = false }: {
  d: HpBiDetail; hasIntent: boolean; showLabel?: boolean;
}) {
  const coverage = monitoringCoverage(d);
  return <div data-testid="monitoring-coverage" className="space-y-1 text-[11px] font-normal text-[#5d7388]">
    <p>{showLabel && <strong>Monitoring: {coverage.label} · </strong>}
      {coverage.parentChecked > 0 && <>{coverage.parentChecked}/{coverage.parentTotal} parent organizations checked · </>}
      {coverage.checked}/{coverage.total} member accounts checked separately
      {coverage.latest && ` · Last checked: ${dateTimeText(coverage.latest)}`}
      {coverage.active > 0 && ` · ${coverage.active} in progress`}
      {coverage.failed > 0 && ` · ${coverage.failed} latest checks failed`}</p>
    {!coverage.checked && !coverage.parentChecked && <p>No completed monitoring check for these member accounts or their parent organization.</p>}
    {coverage.parentChecked > 0 && <p>Parent research is shown separately; it does not count as a fresh check of each member.</p>}
    {(coverage.checked > 0 || coverage.parentChecked > 0) && !hasIntent && <p>No qualifying Hot/Warm monitoring evidence available. A completed check does not establish buying intent.</p>}
    {coverage.analysisAccountId != null && <a className="text-[#05628f] underline"
      href={`${import.meta.env.BASE_URL}intent/accounts/${coverage.analysisAccountId}${d.clientId ? `?clientId=${d.clientId}` : ""}#account-research-details`}>View parent news, interpretation &amp; HP pitch</a>}
  </div>;
}
