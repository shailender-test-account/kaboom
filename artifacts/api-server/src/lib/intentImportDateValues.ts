const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MILLISECONDS_PER_DAY = 86_400_000;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeSpreadsheetDate(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  const numeric = finiteNumber(value);
  if (numeric !== null && numeric >= 1 && numeric < 3_000_000) {
    return new Date(EXCEL_EPOCH_UTC + numeric * MILLISECONDS_PER_DAY).toISOString();
  }

  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeSpreadsheetTime(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(11, 19);
  }

  const numeric = finiteNumber(value);
  if (numeric !== null && numeric >= 0 && numeric < 1) {
    const totalSeconds = Math.round(numeric * 86_400) % 86_400;
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(part => String(part).padStart(2, "0")).join(":");
  }

  const clock = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3] ?? 0);
    if (hours < 24 && minutes < 60 && seconds < 60) {
      return [hours, minutes, seconds].map(part => String(part).padStart(2, "0")).join(":");
    }
  }
  return String(value).trim();
}