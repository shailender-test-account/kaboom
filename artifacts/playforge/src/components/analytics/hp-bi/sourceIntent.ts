import type { HpBiDetail, HpSourceIntent } from "./types";

export type IntentHeat = "Hot" | "Warm" | "Cold" | "Not available";
export const strongest = (values: string[]): IntentHeat =>
  values.includes("Hot") ? "Hot" : values.includes("Warm") ? "Warm" : values.includes("Cold") ? "Cold" : "Not available";

/** Read-only display projection. Never changes BI qualification or metrics. */
export function sourceIntent(d: HpBiDetail) {
  const sources = {
    gtm: d.intentSources?.gtm ?? [],
    monitoring: (d.monitoringContext ?? []).flatMap(account => account.findings.flatMap(finding =>
      finding.categories.map(category => ({ category: category.name, product: null, status: category.heat })))),
    journey: d.intentSources?.journey ?? [],
  };
  const statuses = {
    gtm: d.account?.priority?.declaredQualification ?? strongest(sources.gtm.map(row => row.status)),
    monitoring: strongest(sources.monitoring.map(row => row.status)),
    journey: strongest(sources.journey.map(row => row.status)),
  };
  const categories = [...new Set(Object.values(sources).flatMap(rows => rows
    .filter(row => row.status === "Hot" || row.status === "Warm")
    .map(row => row.category).filter((category): category is string => !!category)))].sort();
  const categoryStatus = (rows: HpSourceIntent[], category: string) =>
    strongest(rows.filter(row => row.category === category).map(row => row.status));
  return { sources, statuses, overall: d.account?.priority?.status ?? strongest(Object.values(statuses)),
    categories: categories.map(category => ({ category,
      gtm: categoryStatus(sources.gtm, category), monitoring: categoryStatus(sources.monitoring, category),
      journey: categoryStatus(sources.journey, category) })) };
}
