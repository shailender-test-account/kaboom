export type HpEvidenceInput = {
  id: string | number;
  text: string;
  source?: string | null;
  occurredAt?: string | null;
};

export type HpSolutionRecommendation = {
  name: string;
  family: "Workforce Solutions" | "Business PCs" | "Commercial Printing" | "HP Poly";
  score: number;
  fit: "strong" | "moderate" | "exploratory";
  rationale: string;
  sourceUrl: string;
  evidence: Array<{ id: string | number; summary: string; source?: string | null; occurredAt?: string | null }>;
};

type HpSolutionRule = {
  name: string;
  family: HpSolutionRecommendation["family"];
  sourceUrl: string;
  patterns: RegExp[];
  rationale: string;
};

const HP_SOLUTION_RULES: HpSolutionRule[] = [
  { name: "HP Workforce Experience Platform & Fleet Management", family: "Workforce Solutions", sourceUrl: "https://www.hp.com/in-en/business-solutions/services-solutions.html", patterns: [/\bdevice fleet\b/i, /\bfleet management\b/i, /\bemployee experience\b/i, /\bworkforce experience\b/i, /\bendpoint management\b/i, /\bdevice[- ]as[- ]a[- ]service\b/i, /\bdaas\b/i], rationale: "Supports proactive fleet management, device insights and workforce experience improvement." },
  { name: "HP Managed Device & Computing Services", family: "Workforce Solutions", sourceUrl: "https://www.hp.com/in-en/business-solutions/services-solutions.html", patterns: [/\bmanaged devices?\b/i, /\bdevice lifecycle\b/i, /\bpc refresh\b/i, /\bendpoint refresh\b/i, /\bit support\b/i, /\bmanaged it\b/i, /\bdistributed workforce\b/i], rationale: "Fits device lifecycle, refresh, deployment and managed-support requirements." },
  { name: "HP Workforce Security Solutions & HP Wolf Security", family: "Workforce Solutions", sourceUrl: "https://www.hp.com/in-en/business-solutions/services-solutions.html", patterns: [/\bendpoint security\b/i, /\bzero trust\b/i, /\bcyber(?:security)?\b/i, /\bransomware\b/i, /\bdevice security\b/i, /\bsecurity posture\b/i, /\bthreat protection\b/i], rationale: "Fits endpoint protection and secure-workforce requirements." },
  { name: "HP Digital Workspaces", family: "Workforce Solutions", sourceUrl: "https://www.hp.com/in-en/business-solutions/services-solutions.html", patterns: [/\bdigital workspace\b/i, /\bvirtual desktop\b/i, /\bvdi\b/i, /\bremote work\b/i, /\bhybrid work\b/i, /\bworkspace modernization\b/i], rationale: "Fits secure digital workspace and hybrid-work enablement needs." },
  { name: "HP EliteBook AI Laptops", family: "Business PCs", sourceUrl: "https://www.hp.com/in-en/business-solutions/business-computers.html", patterns: [/\bbusiness laptops?\b/i, /\bmobile workforce\b/i, /\bhybrid professionals?\b/i, /\bexecutive laptops?\b/i, /\bai pcs?\b/i, /\blaptop refresh\b/i], rationale: "Fits secure, mobile and AI-ready computing for professional and executive users." },
  { name: "HP ProBook AI Laptops", family: "Business PCs", sourceUrl: "https://www.hp.com/in-en/business-solutions/business-computers.html", patterns: [/\bgrowing (?:team|workforce|business)\b/i, /\bnew employees?\b/i, /\bemployee laptops?\b/i, /\bmainstream laptops?\b/i, /\bbranch expansion\b/i], rationale: "Fits practical business computing for growing teams and expanding locations." },
  { name: "HP EliteDesk / ProDesk AI PCs", family: "Business PCs", sourceUrl: "https://www.hp.com/in-en/business-solutions/business-computers.html", patterns: [/\bbusiness desktops?\b/i, /\bdesktop refresh\b/i, /\bfixed workstations?\b/i, /\bnew offices?\b/i, /\bbranch opening\b/i, /\bsite rollout\b/i], rationale: "Fits managed desktop estates, office refreshes and new-site rollouts." },
  { name: "HP Z Workstations", family: "Business PCs", sourceUrl: "https://www.hp.com/in-en/business-solutions/business-computers.html", patterns: [/\bworkstations?\b/i, /\bengineering\b/i, /\bcad\b/i, /\b3d design\b/i, /\bdata science\b/i, /\bcontent creat(?:ion|ors?)\b/i, /\bai development\b/i], rationale: "Fits compute-intensive engineering, design, data and AI workloads." },
  { name: "HP Thin Clients", family: "Business PCs", sourceUrl: "https://www.hp.com/in-en/business-solutions/business-computers.html", patterns: [/\bthin clients?\b/i, /\bvdi\b/i, /\bvirtual desktop\b/i, /\bshared workstations?\b/i, /\bcall cent(?:er|re)\b/i, /\bcontact cent(?:er|re)\b/i], rationale: "Fits centralized, secure computing for shared desks, VDI and contact-center environments." },
  { name: "HP Managed Print Services & Enterprise Printing", family: "Commercial Printing", sourceUrl: "https://www.hp.com/in-en/business-solutions/commercial-printers.html", patterns: [/\bmanaged print\b/i, /\bprint fleet\b/i, /\benterprise printing\b/i, /\boffice printers?\b/i, /\bmultifunction\b/i, /\bsecure print\b/i, /\bdistributed teams?\b/i], rationale: "Fits managed office printing, secure print fleets and distributed-team requirements." },
  { name: "HP Print & Digital Workflow Solutions", family: "Commercial Printing", sourceUrl: "https://www.hp.com/in-en/business-solutions/services-solutions.html", patterns: [/\bdocument workflow\b/i, /\bdigital workflow\b/i, /\bscan(?:ning)? workflow\b/i, /\bdocument automation\b/i, /\bpaperless\b/i], rationale: "Fits document digitization, workflow automation and print-to-digital processes." },
  { name: "HP Industrial, Large Format & 3D Printing", family: "Commercial Printing", sourceUrl: "https://www.hp.com/in-en/business-solutions/commercial-printers.html", patterns: [/\bpackaging\b/i, /\blabel printing\b/i, /\bdirect mail\b/i, /\bcommercial print\b/i, /\blarge format\b/i, /\bplotters?\b/i, /\b3d print(?:ing)?\b/i, /\badditive manufacturing\b/i], rationale: "Fits production print, labels, packaging, technical graphics or additive-manufacturing needs." },
  { name: "HP Poly Headsets", family: "HP Poly", sourceUrl: "https://www.hp.com/in-en/poly.html", patterns: [/\bheadsets?\b/i, /\bcontact cent(?:er|re)\b/i, /\bcall cent(?:er|re)\b/i, /\bnoise cancell(?:ing|ation)\b/i, /\bhybrid professionals?\b/i, /\bvoice agents?\b/i], rationale: "Fits voice-intensive, contact-center and hybrid-work roles needing reliable personal audio." },
  { name: "HP Poly Video Conferencing", family: "HP Poly", sourceUrl: "https://www.hp.com/in-en/poly.html", patterns: [/\bvideo conferenc(?:e|ing)\b/i, /\bmeeting rooms?\b/i, /\bvideo bars?\b/i, /\bhybrid meetings?\b/i, /\bboardrooms?\b/i, /\bzoom rooms?\b/i, /\bmicrosoft teams rooms?\b/i], rationale: "Fits meeting-room modernization and secure hybrid video collaboration." },
  { name: "HP Poly Phones & Collaboration Software", family: "HP Poly", sourceUrl: "https://www.hp.com/in-en/poly.html", patterns: [/\bdesk phones?\b/i, /\bphone systems?\b/i, /\bvoice services?\b/i, /\bunified communications?\b/i, /\bucaa?s\b/i, /\bcall routing\b/i, /\bcollaboration management\b/i], rationale: "Fits enterprise voice, unified communications and collaboration-device management." },
];

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

const RECRUITMENT_BOILERPLATE = /\b(no vacanc(?:y|ies)|search jobs?|apply online|submit your resume|we'?ll reach out|future opportunities|careers? page|job alerts?)\b/i;
const DIRECT_BUY_OR_PROJECT = /\b(rfp|rfq|tender|procurement|pricing|quote|demo|pilot|purchase|buying|vendor evaluation|project timeline|refresh|replacement|rollout|deployment|capacity constraint)\b/i;

export function isHpClientName(value: unknown) {
  const name = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return name === "hp" || name.startsWith("hp ") || name.includes("hewlett packard");
}

export function recommendHpSolutions(evidence: HpEvidenceInput[]): HpSolutionRecommendation[] {
  const usable = evidence
    .map(item => ({ ...item, text: compact(item.text) }))
    .filter(item => item.text.length > 2 && !RECRUITMENT_BOILERPLATE.test(item.text));

  const recommendations: HpSolutionRecommendation[] = [];
  for (const rule of HP_SOLUTION_RULES) {
    const matches = usable
      .map(item => ({ item, hits: rule.patterns.filter(pattern => pattern.test(item.text)).length }))
      .filter(match => match.hits > 0)
      .sort((a, b) => b.hits - a.hits || String(b.item.occurredAt ?? "").localeCompare(String(a.item.occurredAt ?? "")));
    const dedupedMatches = [...new Map(matches.map(match => [match.item.text.toLowerCase().slice(0, 240), match])).values()];
    const uniquePatterns = new Set<string>();
    for (const match of matches) {
      for (const pattern of rule.patterns) if (pattern.test(match.item.text)) uniquePatterns.add(pattern.source);
    }
    const magnitudeBonus = dedupedMatches.some(match => /\b\d{2,}\s*(?:person|people|seat|agent|employee|user)s?\b/i.test(match.item.text)) ? 30 : 0;
    const directBonus = dedupedMatches.some(match => DIRECT_BUY_OR_PROJECT.test(match.item.text)) ? 18 : 0;
    const score = Math.min(96, uniquePatterns.size * 18 + Math.min(30, dedupedMatches.length * 10) + magnitudeBonus + directBonus);
    if (score < 28) continue;
    const fit = score >= 72 ? "strong" : score >= 48 ? "moderate" : "exploratory";
    const evidenceItems = dedupedMatches.slice(0, 3).map(({ item }) => ({
      id: item.id,
      summary: item.text.slice(0, 220),
      source: item.source,
      occurredAt: item.occurredAt,
    }));
    recommendations.push({
      name: rule.name,
      family: rule.family,
      score,
      fit,
      rationale: `${rule.rationale} Based on ${dedupedMatches.length} distinct matching signal${dedupedMatches.length === 1 ? "" : "s"}; validate scope, users and timing before positioning.`,
      sourceUrl: rule.sourceUrl,
      evidence: evidenceItems,
    });
  }
  return recommendations.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 6);
}