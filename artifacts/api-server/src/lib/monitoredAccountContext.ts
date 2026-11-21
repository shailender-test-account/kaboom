import { monitoringFindingAnalysis } from "./monitoringFindingAnalysis";
import { hpResearchTakeaways } from "./hpResearchTakeaways";
import { isCurrentResearchOpportunityBrief } from "./researchOpportunityInterpreter";
import { monitoringBusinessDirections } from "./monitoringBusinessDirections";
import { hasSavedNewsCoverage } from "./savedNewsCoverage";

export type MonitoringFinding = {
  id: number; excerpt: string; sourceUrl: string | null; occurredAt: string;
  eventType: string | null; reviewStatus: string; context: Record<string, any> | null;
  raw_evidence?: unknown;
};

/** Read-only sales context. Never used as a score, qualification or BI input. */
export function monitoredAccountContext(findings: MonitoringFinding[], now = new Date(), account?: { name: string; domain?: string | null; clientName?: string | null }, storedFindingCount = findings.length) {
  const analysis = monitoringFindingAnalysis(findings, now, account);
  const recent = analysis.findings;
  const expansion = recent.find(finding =>
    /\b(new(?: [\w.-]+){0,3} (?:office|branch|campus)|office (?:opening|expansion)|workspace|business park)\b/i.test(finding.excerpt)
    && /\b(open|opening|opened|announced|adding|expand|expansion|occupy)\b/i.test(finding.excerpt));
  const selected = recent[0];
  const selectedExpansion = selected && expansion?.id === selected.id;
  const displayed = selected ? [selected, ...recent.filter(finding => finding.id !== selected.id)] : [];
  const savedBrief = (finding: Pick<MonitoringFinding,"context">) => isCurrentResearchOpportunityBrief(finding.context?.opportunityBrief)
    ? finding.context!.opportunityBrief : null;
  const allDirections=monitoringBusinessDirections(displayed,findings.flatMap(finding=>savedBrief(finding)?.businessDirections??[]));
  const directionsFor = (finding: typeof recent[number]) => allDirections.filter(point=>point.evidenceIds.includes(finding.id));
  const takeawaysFor = (finding: typeof recent[number]) => /^hp(?:\b|[-_])/i.test(account?.clientName?.trim() ?? "")
    ? hpResearchTakeaways([finding],savedBrief(finding)?.categoryConclusions ?? [],
      savedBrief(finding)?.strategicHypotheses ?? []) : [];
  return {
    diagnostics: { ...analysis.diagnostics, storedFindingCount, truncated: storedFindingCount > findings.length },
    kind: selectedExpansion ? "expansion" as const : selected ? "business_context" as const : "no_recent_findings" as const,
    label: selectedExpansion ? "Workplace expansion · validate needs" : selected ? "Business context · validate relevance" : "No recent relevant findings",
    summary: selected?.excerpt ?? "No usable account news was found in the assessed stored findings. See research quality for exclusions. This is not proof that the account has no needs.",
    evidence: displayed.map(finding => ({
      id: finding.id, summary: finding.sourcePassage, sourceUrl: finding.sourceUrl,
      occurredAt: finding.occurredAt, publishedAt: finding.publishedAt,
      businessDirections:directionsFor(finding),takeaways:takeawaysFor(finding),
      analysisNote:hasSavedNewsCoverage({...finding,source_url:finding.sourceUrl})
        ? finding.context?.savedNewsInterpretation.analysisNote ?? null : null,
    })),
    validationSummary: selected
      ? `Owner: ${selected.ownerPassage ? "source names an operational lead; purchasing authority unconfirmed" : "not confirmed"}. Scale: ${selected.scale ? `${selected.scale} reported, not an order quantity` : "not established for this operation"}. Timing: ${selected.timing ? `${selected.timing} reported, not a purchase date` : "not confirmed"}.${selected.publishedAt ? "" : " Publication date unverified."}`
      : null,
    businessDirections: allDirections,
    takeaways: /^hp(?:\b|[-_])/i.test(account?.clientName?.trim() ?? "") ? hpResearchTakeaways(displayed, findings.flatMap(finding => {
      const brief = finding.context?.opportunityBrief;
      return isCurrentResearchOpportunityBrief(brief) ? brief.categoryConclusions ?? [] : [];
    }), findings.flatMap(finding => {
      const brief = finding.context?.opportunityBrief;
      return isCurrentResearchOpportunityBrief(brief) ? brief.strategicHypotheses ?? [] : [];
    })) : undefined,
    analysisPoints: selected ? [
      `Source fact (${selected.country}; ${selected.publishedAt ? `published ${selected.publishedAt.slice(0, 10)}` : "publication date unverified"}): ${selected.excerpt}`,
      selectedExpansion
        ? "Operational implication: a new workplace may require fit-out and IT deployment. Specific products, procurement and budget are not established."
        : "Operational requirement: not established by this event. Financial performance or business activity alone does not demonstrate a product requirement.",
      `Owner: ${selected.ownerPassage ? `source-reported responsibility — “${selected.ownerPassage}” (purchasing authority unconfirmed)` : "not confirmed"}. Scale: ${selected.scale ? `source reports ${selected.scale}; not a device quantity` : "not established for this operation"}. Timing: ${selected.timing ? `source reports ${selected.timing}; not a purchase date` : "not confirmed"}.${selected.publishedAt ? "" : " Publication date unverified; do not treat this as newly published news."}`,
    ] : ["No recent, account-attributable source meets the selected geography. Recheck coverage before proposing a requirement."],
    possibleNeeds: selectedExpansion ? ["Workplace devices and office IT setup", "Meeting-room and collaboration equipment", "Workplace IT deployment and support services"] : [],
    nextAction: selectedExpansion
      ? "Identify the workplace IT / facilities and procurement owners. Validate the fit-out timeline, affected users and rooms, existing suppliers, and budget."
      : selected
        ? `Validate whether this event creates a ${selected.country}-specific operational requirement, then confirm the owner, scale and timing.`
        : "Review research coverage and account identity, then recheck sources before choosing an outreach angle.",
    caution: "Research context only—not confirmed buying intent. No procurement, quantities or budget are established by this card. Qualification scores and BI results are unchanged.",
  };
}

/** Dashboard readiness, not monitoring completion or buying qualification. */
export function hasCompleteMonitoredResearch(context: Pick<ReturnType<typeof monitoredAccountContext>, "kind" | "businessDirections" | "takeaways"> & {
  evidence:Array<{id:number;summary:string;sourceUrl:string|null}>;
}) {
  const sourceIds=new Set(context.evidence.filter(source=>source.sourceUrl&&source.summary.trim()).map(source=>source.id));
  const cited=(ids:number[])=>ids.some(id=>sourceIds.has(id));
  return context.kind!=="no_recent_findings" && sourceIds.size>0
    && context.businessDirections.some(point=>point.signal.trim()&&point.direction.trim()&&cited(point.evidenceIds))
    && Boolean(context.takeaways?.some(point=>point.takeaway.trim()&&point.recommendation.trim()&&cited(point.evidenceIds)));
}
