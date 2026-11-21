// Reports use a fixed business timezone regardless of the viewer's device.
// API timestamps remain instants; only presentation is converted.
export const REPORT_TIME_ZONE = "Asia/Kolkata";
export const REPORT_TIME_ZONE_LABEL = "GMT+05:30";

function validDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatReportDateTime(value: string | Date | null | undefined, seconds = false): string {
  const date = validDate(value);
  if (!date) return "—";
  const text = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23", timeZone: REPORT_TIME_ZONE,
  }).format(date);
  return `${text} ${REPORT_TIME_ZONE_LABEL}`;
}

export function formatReportDate(value: string | Date | null | undefined): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Calendar dates from daily SQL buckets are not instants; never shift their day.
    const date = validDate(`${value}T00:00:00Z`);
    return date ? new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
    }).format(date) : "—";
  }
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: REPORT_TIME_ZONE,
  }).format(date) : "—";
}

export function formatReportTime(value: string | Date | null | undefined): string {
  const date = validDate(value);
  if (!date) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: REPORT_TIME_ZONE,
  }).format(date)} ${REPORT_TIME_ZONE_LABEL}`;
}

export function formatReportDayLabel(value: string, year = false): string {
  const date = validDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!date) return value;
  return new Intl.DateTimeFormat("en-GB", {
    month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}),
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : REPORT_TIME_ZONE,
  }).format(date);
}