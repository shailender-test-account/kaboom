import type { analyzeMonitoringFindings } from "./monitoringFindingAnalysis";
import type { CategoryConclusion } from "./researchOpportunityInterpreter";
import { monitoringBusinessDirections } from "./monitoringBusinessDirections";
import { isCommercialPositioningOnly, type StrategicHypothesis } from "./researchStrategicHypotheses";
import { containsSavedSourceQuote, hasSavedNewsCoverage } from "./savedNewsCoverage";

type Finding = ReturnType<typeof analyzeMonitoringFindings>[number];
export type HpResearchTakeaway = {
  category: string; product: string; takeaway: string; recommendation: string; evidenceIds: number[];
  pitch?: string;
  supportingSources?: Array<{ url: string; quote: string }>;
};

/** Conservative, source-triggered sales hypotheses, not purchasing intent or catalog fit scores. */
export function hpResearchTakeaways(findings: Finding[], conclusions: CategoryConclusion[] = [], hypotheses: StrategicHypothesis[] = []): HpResearchTakeaway[] {
  const result = new Map<string, HpResearchTakeaway>();
  const add = (finding: Finding, category: string, product: string, takeaway: string, action: string, entryPitch?:string) => {
    const existing = result.get(category);
    if (existing) return; // Newest attributable event wins; do not repeat the same sales angle.
    const pitch = category === "Business Services"
      ? "Could a managed device lifecycle lower support overhead and make device costs more predictable? Start with a baseline-cost assessment."
      : category === "IT Hardware"
        ? "Can we match device performance to the affected roles and phase deployment around the actual rollout, rather than assume a full fleet purchase?"
        : category === "Business Collaboration"
          ? "Could standardized HP Poly rooms and endpoints improve collaboration across the affected locations? Start with a room and platform assessment."
          : "Could HP Wolf Security close the confirmed endpoint-control gap? Start with a scoped security assessment.";
    result.set(category, { category, product, takeaway: `${finding.country}: ${takeaway}`,
      recommendation: action, pitch:entryPitch||pitch, evidenceIds: [finding.id] });
  };
  const allowedCategories = new Map([
    ["it hardware", "IT Hardware"], ["business collaboration", "Business Collaboration"],
    ["collaboration", "Business Collaboration"], ["security", "Security"], ["business services", "Business Services"],
  ]);
  // Prefer the saved full-catalog interpretation when it names a specific product
  // and cites an original event that survived account, date and geography validation.
  for (const finding of findings) {
    for (const category of conclusions) {
      const name = allowedCategories.get(category.categoryName?.toLowerCase().trim());
      const cited = category.sourceUrls?.some(url => {
        try { return new URL(url).href === new URL(finding.sourceUrl!).href; } catch { return false; }
      });
      if (!name || !cited || category.tier === "cold" || result.has(name)) continue;
      const product = category.recommendedProducts?.find(item => Number.isInteger(item.productId) && item.productId > 0 && item.name?.trim() && item.rationale?.trim());
      if (!product) continue;
      const gaps = category.gaps?.filter(Boolean).slice(0, 2).join("; ");
      add(finding, name, product.name, `${product.rationale} Treat this as a research hypothesis, not declared buying intent.`,
        `Validate ${gaps || "the specific operational gap and product suitability"} before proposing ${product.name}.`,
        typeof category.entryPitch==="string"?category.entryPitch:undefined);
    }
  }
  // Kept separate from category conclusions: these may be useful even when the
  // deterministic account/category status is Cold. Never derive score from them.
  for (const hypothesis of hypotheses) {
    if (result.has(hypothesis.category)) continue;
    const finding = findings.find(row => row.sourceUrl === hypothesis.sourceUrl &&
      containsSavedSourceQuote(row,hypothesis.sourceQuote));
    if (!finding || !hypothesis.productName) continue;
    add(finding, hypothesis.category, hypothesis.productName,
      `${hypothesis.signal} Possible direction: ${hypothesis.direction} ${hypothesis.rationale} Discovery hypothesis only—not evidence of buying intent.`,
      hypothesis.validationQuestions.join(" "), hypothesis.entryPitch);
    const added = result.get(hypothesis.category);
    if (added) added.supportingSources = hypothesis.supportingSources;
  }
  for (const finding of findings) {
    const text = finding.sourcePassage.normalize("NFKC");
    // A completed per-story assessment (including "no fit") or an accepted
    // saved pitch takes precedence over generic keyword fallbacks for that story.
    if (hasSavedNewsCoverage({...finding,source_url:finding.sourceUrl})
      || [...result.values()].some(point=>point.evidenceIds.includes(finding.id))) continue;
    if (/\b(?:proposed|planned)\b[^.!?]{0,100}\binvestment\b/i.test(text)
      && /\b(?:noc|no objection certificate|court|approval)\b/i.test(text)) {
      add(finding, "Business Services", "HP managed device lifecycle services",
        "The reported proposed investment is approval-dependent. A phased device-lifecycle assessment may be relevant only if the India operating plan includes an endpoint estate; no approved device budget or purchase is established.",
        "Confirm approval status with the India finance/legal owner, then ask the IT owner about actual sites, existing devices, support contracts and rollout timing. Do not equate the reported investment value with an HP opportunity.",
        "If the proposed India investment proceeds and includes new or changed workplaces, would a phased HP device-lifecycle assessment help compare support cost and deployment options? Start only after validating approvals and the endpoint scope.");
    }
    if (isCommercialPositioningOnly(text)) {
      if(/\b(?:summit|conference|event)\b/i.test(text)&&/\b(?:credit|collections)\b/i.test(text)
        &&!/\b(?:not|never|denied)\b[^.!?]{0,35}\b(?:sponsor|partner)/i.test(text)){
        add(finding,"Security","HP Wolf Security",
          "The event positioning suggests an interest in credit-and-collections customers. Secure agent workspaces could support a joint customer demonstration; no endpoint gap, local rollout or purchase is established.",
          "Ask the India account owner which customer workflows are being demonstrated, how sensitive borrower data is handled, and whether an endpoint-security assessment would be relevant. Confirm the operational buyer, scale and timing before proposing deployment.",
          "Would a joint demonstration of HP Wolf Security for credit-and-collections agent workspaces help address this audience's data-protection concerns? First validate the workflow and existing controls.");
        add(finding,"Business Collaboration","HP Poly",
          "Credit-and-collections event positioning creates a possible conversation about customer-contact experience. Relevance to actual voice workflows and India users remains unconfirmed.",
          "Confirm the presentation topic, target customer audience, voice/video workflows, platform compatibility and responsible India team. Do not infer agent headcount, room counts or a device requirement from sponsorship.",
          "If your event follow-up includes collections-agent demonstrations, could a small HP Poly pilot help demonstrate call clarity and customer interaction quality? Validate the use case before recommending hardware.");
      }
      continue;
    }
    const directions = new Set(monitoringBusinessDirections([finding]).map(point => point.theme));
    if (directions.has("AI engineering & product development")) {
      add(finding,"IT Hardware","HP Z workstations / AI-capable workstations",
        "AI-led engineering, design or automation may create compute-intensive developer workflows. Suitable local workloads could benefit from HP Z workstation performance; cloud AI activity or one manager vacancy alone does not establish workstation demand.",
        "Identify the India engineering owner and benchmark actual CAD, simulation, data preparation and local inference workloads. Confirm cloud-versus-local execution, software/GPU compatibility, existing devices, team size and timing.",
        "As your India teams develop AI-enabled engineering workflows, could we benchmark HP Z workstations against a real design, simulation or local AI task and compare time-to-result with your current setup? Proceed only if the team confirms a local endpoint bottleneck.");
    }
    const expansion = /\b(?:new(?: [\w.-]+){0,3} (?:office|campus|site|centre|center)|office expansion|opening|opened|expanding (?:its |the )?(?:office|campus|operations))\b/i.test(text);
    if (/\b(?:ransomware|cyberattack|data breach|endpoint security|endpoint protection|zero trust)\b/i.test(text)) {
      add(finding, "Security", "HP Wolf Security", "The reported security exposure supports an endpoint-protection discovery discussion—not a confirmed security purchase.",
        "Assess endpoint coverage, isolation and remediation gaps before proposing HP Wolf Security; confirm technical suitability.");
    }
    if (expansion || /\b(?:device refresh|pc refresh|laptop rollout|workstation|new laptops|new pcs)\b/i.test(text)) {
      add(finding, "IT Hardware", "HP business PCs / workstations", "The reported workplace or endpoint change may create a device deployment or refresh requirement; reported workforce scale is not a device order.",
        "Validate net-new seats, reusable devices and workload specifications before recommending HP business PCs or workstations.");
    }
    if (directions.has("Workforce scaling")) {
      add(finding, "IT Hardware", "HP business PCs / workstations",
        "Planned workforce growth may create onboarding-device demand if roles need net-new endpoints; hiring plans are not device orders.",
        "Confirm filled versus planned roles, device reuse and per-role specifications before pitching a phased HP device rollout.");
    }
    if (/\b(?:hybrid work|video conferencing|meeting rooms?|unified communications|collaboration upgrade)\b/i.test(text) || expansion) {
      add(finding, "Business Collaboration", "HP Poly meeting-room / collaboration solutions", "The reported workplace change provides a possible collaboration assessment opportunity; room counts and compatibility are unconfirmed.",
        "Assess meeting-room inventory, remote participation and platform compatibility before proposing HP Poly solutions.");
    }
    if (expansion || /\b(?:device as a service|managed (?:devices|endpoints)|device lifecycle|it outsourcing|device cost (?:reduction|optimization|optimisation))\b/i.test(text)) {
      add(finding, "Business Services", "HP Device as a Service / lifecycle services", "The reported operating-model or workplace change may justify evaluating device lifecycle support; it does not establish outsourcing demand.",
        "Compare owned-device and managed-service economics, support coverage and contract expiry before discussing HP Device as a Service.");
    }
    if (directions.has("Cost discipline") || directions.has("Mergers & acquisitions")) {
      add(finding, "Business Services", "HP Device as a Service / lifecycle services",
        "Cost discipline or integration may create a lifecycle-services discussion if device support or fragmented fleets are a material cost driver; that dependency is not yet established.",
        "Confirm the local device estate, support costs and contract constraints. Compare managed-service economics only if the account identifies an addressable device-cost or integration gap.");
    }
    if(directions.has("Financial trajectory") &&
      /\b(?:declin(?:e|ed|ing)|fell|falling|loss(?:es)?|miss(?:ed)?|down|contracted|margin pressure)\b/i.test(text)) {
      add(finding,"Business Services","HP Device as a Service / lifecycle services",
        "Reported financial pressure may make device-support costs worth reviewing, but an addressable India device-cost problem has not been established.",
        "Ask the India IT/finance owner whether endpoint support is a material controllable cost; confirm estate size, current contracts and timing before comparing lifecycle-service economics.",
        "With the reported pressure on performance, would a baseline assessment of India endpoint support costs be useful? Evaluate HP lifecycle services only if it identifies a measurable cost or support gap.");
    }
  }
  return [...result.values()].slice(0, 4);
}
