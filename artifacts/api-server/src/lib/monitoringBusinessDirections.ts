import type { analyzeMonitoringFindings } from "./monitoringFindingAnalysis";
import { containsSavedSourceQuote } from "./savedNewsCoverage";

type Finding = ReturnType<typeof analyzeMonitoringFindings>[number];
export type MonitoringBusinessDirection = {
  theme: string; signal: string; direction: string; evidenceIds: number[];
};

/** Organize verified business events before considering any vendor/product. */
export function monitoringBusinessDirections(findings: Finding[], saved: Array<{
  theme:string;signal:string;direction:string;sourceQuote:string;sourceUrls:string[];
}> = []): MonitoringBusinessDirection[] {
  const themes = new Map<string, MonitoringBusinessDirection>();
  const add = (finding: Finding, theme: string, signal: string, direction: string) => {
    // Merge repeated interpretations across sources, retaining every citation.
    // Theme alone is insufficient: growth and financial pressure (or distinct
    // saved analyses) must not be collapsed into the same conclusion.
    const labeledSignal = `${finding.country}: ${signal}`;
    const key = JSON.stringify([theme, labeledSignal, direction]);
    const previous = themes.get(key);
    if (previous) {
      if (!previous.evidenceIds.includes(finding.id)) previous.evidenceIds.push(finding.id);
      return previous;
    }
    const point = { theme, signal: labeledSignal, direction, evidenceIds: [finding.id] };
    themes.set(key, point);
    return point;
  };
  for(const point of saved) {
    if(!point || typeof point.sourceQuote!=="string" || !point.sourceQuote || typeof point.signal!=="string" ||
      typeof point.direction!=="string" || !Array.isArray(point.sourceUrls))continue;
    const finding=findings.find(row=>row.sourceUrl&&point.sourceUrls?.includes(row.sourceUrl)&&
      containsSavedSourceQuote(row,point.sourceQuote));
    if(finding) {
      const direction=add(finding,point.theme,point.signal,point.direction);
      // A joint interpretation can cite multiple validated stories. Its verbatim
      // anchor belongs to the primary source, not to every contributing article.
      for(const related of findings.filter(row=>row.sourceUrl&&point.sourceUrls.includes(row.sourceUrl))) {
        if(!direction.evidenceIds.includes(related.id))direction.evidenceIds.push(related.id);
      }
    }
  }
  for (const finding of findings) {
    const text = finding.sourcePassage.normalize("NFKC");
    if (/\b(?:AI|artificial intelligence|machine learning|digital twins?|engineering automation)\b/i.test(text)
      && /\b(?:engineering|design|product|acceleration|develop|infrastructure|automation)\b/i.test(text)
      && !/\b(?:no|not|cancelled|abandoned)\b[^.!?]{0,40}\b(?:AI|artificial intelligence|automation)\b/i.test(text)) {
      add(finding,"AI engineering & product development",
        "The source links the account's AI activity to engineering, product development or infrastructure workflows.",
        "The account may be moving AI-enabled design or automation from experimentation into delivery. Validate which India teams run interactive CAD, simulation, model preparation or local AI inference versus cloud-only workloads; this is a workload-discovery hypothesis, not a workstation order or confirmed budget.");
    }
    if (/\b(?:court|regulatory|regulator|enforcement directorate)\b/i.test(text)
      && /\b(?:seizure|seize|noc|no objection certificate|approval|investment)\b/i.test(text)) {
      add(finding, "Regulatory constraints & investment timing",
        "The source reports a regulatory or court decision affecting property, approvals or investment.",
        "Business continuity and approval-dependent investment timing may be priorities. Distinguish permission to continue operations from permission for new investment; confirm the India legal/finance owner, affected sites and decision dates. This is not evidence of a security incident, approved capex or technology demand.");
    }
    if(/\b(?:sponsor(?:s|ed|ship)?|silver partner|gold partner)\b/i.test(text)
      &&/\b(?:summit|conference|event)\b/i.test(text)
      &&!/\b(?:not|never|denied)\b[^.!?]{0,35}\b(?:sponsor|partner)/i.test(text)){
      const audience=/\b(?:credit|collections|banking|financial services)\b/i.test(text)
        ?"credit, collections and financial-services decision-makers":"the event's stated industry audience";
      add(finding,"Market positioning","The account is named as a sponsor or commercial partner of the cited event.",
        `The account may be prioritizing influence with ${audience}. This is a commercial-positioning hypothesis, not an operational requirement. Validate its presentation topic, intended audience, India delivery owner and follow-up plan; sponsorship alone establishes no buying intent.`);
    }
    const denied = (terms: string) => new RegExp(`\\b(?:no|not|denied|ruled out)\\b[^.!?]{0,45}\\b(?:${terms})\\b`, "i").test(text);
    if (/\b(?:cost[- ]cutting|cost (?:cuts?|reduction|optimisation|optimization)|reduce (?:operating |operational |it )?costs|restructuring|layoffs?|job cuts?|spending freeze)\b/i.test(text)
      && !denied("cost[- ]cutting|cost cuts?|cost reduction|restructuring|layoffs?|job cuts?")) {
      add(finding, "Cost discipline", "The source reports cost reduction or restructuring measures.",
        "Near-term focus may shift toward operating efficiency and tighter spending approval; this is not evidence of a technology budget.");
    }
    if (/\b(?:acquisition|acquires?|acquired|merger|merges?|merging)\b/i.test(text) && !denied("acquisition|merger")) {
      add(finding, "Mergers & acquisitions", "The source discusses acquisition or merger activity.",
        "Integration, supplier consolidation and operating-model alignment may follow; transaction completion and the affected local entities need confirmation.");
    }
    if (/\b(?:new(?: [\w.-]+){0,3} (?:office|branch|campus|site|centre|center)|office expansion|new branches|infrastructure investment|capital expenditure|capex|invest(?:s|ed|ing)? in (?:infrastructure|facilities|technology))\b/i.test(text)) {
      add(finding, "Infrastructure & footprint", "The source reports a site, infrastructure or capital-investment initiative.",
        "Capacity build-out or modernization may be a near-term priority; distinguish approved local deployment from a plan or company-wide capex.");
    }
    if (/\b(?:hiring|recruitment drive|adding (?:\d[\d,]* )?(?:employees|people|staff|jobs)|create (?:\d[\d,]* )?jobs|workforce expansion)\b/i.test(text)
      && !/\b(?:hiring freeze|not hiring|no (?:new )?hiring)\b/i.test(text)) {
      add(finding, "Workforce scaling", "The source reports recruitment or workforce expansion.",
        "Onboarding and operational capacity may need to scale; planned hires are neither filled roles nor confirmed device demand.");
    }
    if (/\b(?:ransomware|cyberattack|data breach|endpoint security|endpoint protection|zero trust)\b/i.test(text)) {
      add(finding, "Security resilience", "The source reports a security incident or endpoint-protection initiative.",
        "Risk reduction and control remediation may become operational priorities; verify the affected local systems and current response.");
    }
    if (/\b(?:hybrid work|video conferencing|meeting rooms?|unified communications|collaboration upgrade|device refresh|pc refresh)\b/i.test(text)) {
      add(finding,"Workplace modernization","The source reports an endpoint or collaboration-workplace change.",
        "Endpoint standards or collaboration readiness may need review; confirm the affected users, rooms, platform compatibility and rollout dates before proposing a solution.");
    }
    if (/\b(?:revenue|earnings|profit|financial results|quarterly results|funding|margin)\b/i.test(text)) {
      const decline = /\b(?:declin(?:e|ed|ing)|fell|falling|loss(?:es)?|miss(?:ed)?|down|contracted|margin pressure)\b/i.test(text);
      const growth = /\b(?:grew|growth|increas(?:e|ed)|rose|rising|record|raises?|raised|secured)\b/i.test(text);
      add(finding, "Financial trajectory", decline ? "The source reports financial pressure or a performance shortfall."
        : growth ? "The source reports improved financial performance or growth." : "The source reports financial performance, without a clear directional change.",
      decline ? "Management may prioritize margin protection and disciplined investment; cost cutting is a hypothesis unless explicitly announced."
        : growth ? "There may be greater investment flexibility, but expansion, hiring and a specific spending plan must be validated."
          : "No specific near-term operating direction can be inferred from financial reporting alone.");
    }
  }
  // Concrete operational decisions lead; financial capacity is context, not a purchase signal.
  return [...themes.values()].sort((a, b) => Number(a.theme === "Financial trajectory") - Number(b.theme === "Financial trajectory"));
}
