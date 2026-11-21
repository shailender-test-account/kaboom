import { hpDimensions } from "./hpBiImport";

/** Blanks are a coverage warning, never a reason to exclude a real account.
 * Source parent fields are checked, not the internal standalone grouping name. */
export function hpMissingFields(profile: Record<string, any>): string[] {
  return Object.entries(hpDimensions).filter(([key]) => {
    const value = profile[key] ?? profile.dimensions?.[key];
    return value == null || (typeof value === "string" &&
      ["", "-", "unknown", "n/a", "na", "null"].includes(value.trim().toLowerCase()));
  }).map(([, label]) => label);
}
