import type { HpBiRecord } from "./types";

export type Contribution = "forms" | "hot" | "warm";
export const CONTRIBUTION_LABELS: Record<Contribution, string> = { forms: "Form filled", hot: "Hot", warm: "Warm" };
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Only actual submission evidence, not visits, form views or form CTA clicks. */
export function matchesContribution(r: HpBiRecord, flag: Contribution): boolean {
  if (flag !== "forms") return norm(r.kind) === "lead" && norm(r.status) === flag;
  return /^(inbound:\d+(:response)?|form:\d+)$/.test(r.id)
    || ["questionnaire", "questionnaire_response", "journey_form"].includes(norm(r.source))
    || ["form_submit", "form_submitted", "form_submission", "questionnaire", "feedback_response"].includes(norm(r.status));
}

export function mergeContributionRecords(records: HpBiRecord[], forms: HpBiRecord[] = []) {
  const responseForms=new Set(records.flatMap(record=>{
    const ref=record.externalEventId?.replace(/^form_submission:(\d+)$/,"form:$1:response")??record.id;
    return /^form:\d+:response$/.test(ref)?[ref.replace(/:response$/,"")]:[];
  }));
  return [...new Map([...forms.filter(form=>!responseForms.has(form.id)), ...records].map(r => [r.id, r])).values()];
}
