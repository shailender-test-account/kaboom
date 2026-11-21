import { hpContextFields, hpDimensions } from "./hpBiImport";

export type HpImportKind = "accounts" | "activities";
export const activityMappingTargets = ["recordId", "hpId", "hp_id", "UNIQUE ID", "accountName", "email", "kind", "occurredAt", "category", "product", "horizonMonths", "orderValue", "currency", "sourceName", "status", "externalEventId"];
export function hpMappingTargets(kind: HpImportKind) {
  return kind === "accounts"
    ? ["accountName", "hpId", ...Object.keys(hpDimensions), ...Object.values(hpDimensions), ...Object.keys(hpContextFields), ...Object.values(hpContextFields)]
    : activityMappingTargets;
}
export function mappingErrors(kind: HpImportKind, headers: string[], mappings: Record<string, string>) {
  const targets = new Set(hpMappingTargets(kind));
  const errors: string[] = [];
  for (const [header, target] of Object.entries(mappings)) {
    if (!headers.includes(header)) errors.push(`Mapped heading "${header}" is missing. Correct or remove this mapping; renamed headings are not guessed.`);
    if (!targets.has(target)) errors.push(`Unsupported ${kind} mapping target "${target}" for "${header}".`);
  }
  return errors;
}
