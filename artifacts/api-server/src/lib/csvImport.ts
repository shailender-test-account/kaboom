import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

export interface CsvRow {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyName: string | null;
  designation: string | null;
  function: string | null;
  employeeSize: string | null;
  companyRevenue: string | null;
  linkedinUrl: string | null;
  companyLinkedinUrl: string | null;
  city: string | null;
  pin: string | null;
  state: string | null;
  country: string | null;
  identifier: string | null;
  extraData: Record<string, string | null>;
}

export interface CsvImportResult {
  rows: CsvRow[];
  errors: string[];
  validationSkippedCount: number;
}

export interface CsvPreviewRow {
  rowNum: number;
  data: Partial<CsvRow>;
  errors: string[];
}

export interface CsvPreviewResult {
  headers: string[];
  headerErrors: string[];
  unknownHeaders: string[];
  previewRows: CsvPreviewRow[];
  totalDataRows: number;
  validRowCount: number;
}

export type CsvField = keyof Omit<CsvRow, "extraData">;

export interface ColumnMapping {
  action: "map" | "ignore" | "custom";
  mapTo?: CsvField;
}

export type ColumnMappings = Record<string, ColumnMapping>;

const HEADER_MAP: Record<string, CsvField> = {
  "first name":           "firstName",
  "first_name":           "firstName",
  "last name":            "lastName",
  "last_name":            "lastName",
  "email":                "email",
  "phone":                "phone",
  "title":                "title",
  "company":              "companyName",
  "company name":         "companyName",
  "company_name":         "companyName",
  "designation":          "designation",
  "seniority":            "designation",
  "function":             "function",
  "employee size":        "employeeSize",
  "employee_size":        "employeeSize",
  "company revenue":      "companyRevenue",
  "company_revenue":      "companyRevenue",
  "linkedin url":         "linkedinUrl",
  "linkedin_url":         "linkedinUrl",
  "company linkedin url": "companyLinkedinUrl",
  "company_linkedin_url": "companyLinkedinUrl",
  "city":                 "city",
  "pin":                  "pin",
  "state":                "state",
  "country":              "country",
  "company domain":       "companyLinkedinUrl",
  "company location":     "city",
  "industry":             "function",
  "identifier":           "identifier",
  "unique id":            "identifier",
  "unique_id":            "identifier",
  "batch id":             "identifier",
  "batch_id":             "identifier",
  "upload id":            "identifier",
  "upload_id":            "identifier",
  "code":                 "identifier",
};

export const HEADER_DISPLAY: Record<CsvField, string> = {
  firstName:          "First Name",
  lastName:           "Last Name",
  email:              "Email",
  phone:              "Phone",
  title:              "Title",
  companyName:        "Company",
  designation:        "Designation",
  function:           "Function",
  employeeSize:       "Employee Size",
  companyRevenue:     "Company Revenue",
  linkedinUrl:        "LinkedIn URL",
  companyLinkedinUrl: "Company LinkedIn URL",
  city:               "City",
  pin:                "Pin",
  state:              "State",
  country:            "Country",
  identifier:         "Identifier",
};

const EMAIL_RE = /.+@.+\..+/;
const HAS_PROTOCOL_RE = /^https?:\/\//;
const SCI_NOTE_RE = /^-?\d+\.?\d*[eE][+\-]?\d+$/;

/**
 * Normalize a URL-like string: strip leading/trailing whitespace, then
 * prepend "https://" if no protocol is present.  Returns null for blank values.
 */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (HAS_PROTOCOL_RE.test(t)) return t;
  // e.g. "www.linkedin.com/in/foo" or "linkedin.com/in/foo"
  return `https://${t}`;
}

function nullify(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Excel often exports long phone numbers (e.g. 918234567890) in scientific
 * notation like "9.18234567890E+11". Parse it back to a full digit string so
 * the stored value is human-readable. Uses BigInt conversion to avoid floating-
 * point precision loss for numbers up to 18 significant digits.
 */
function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;

  let digits: string | null = null; // set only when we reconstruct from numeric form

  if (SCI_NOTE_RE.test(t)) {
    try {
      // Convert via BigInt to avoid floating-point precision loss
      const num = parseFloat(t);
      if (!isNaN(num) && isFinite(num)) {
        digits = BigInt(Math.round(num)).toString();
      }
    } catch {
      // fall through
    }
  }

  if (digits !== null) {
    // Excel drops the leading + when it stores a number. Restore it:
    // Any pure-digit string of 11+ characters with no leading zero is an
    // international E.164 number (country code 1-3 digits + subscriber).
    // Numbers starting with 0 use "00" international prefix — leave as-is.
    if (/^\d{11,}$/.test(digits) && !digits.startsWith("0")) {
      return `+${digits}`;
    }
    return digits;
  }

  // String value — strip internal spaces but preserve leading + and any dashes/parens
  return t.replace(/\s+/g, "");
}

export type SpreadsheetType = "csv" | "xls" | "xlsx";

function parseRawRows(buffer: Buffer): { rawRows: string[][] | null; parseError: string | null } {
  const text = buffer.toString("utf-8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  try {
    const rawRows = parse(text, {
      relax_quotes: true,
      skip_empty_lines: false,
    }) as string[][];
    return { rawRows, parseError: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rawRows: null, parseError: `CSV parse error: ${msg}` };
  }
}

function parseXlsRawRows(buffer: Buffer): { rawRows: string[][] | null; parseError: string | null } {
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { rawRows: null, parseError: "Spreadsheet has no sheets." };
    const ws = wb.Sheets[sheetName];
    // AOA = array of arrays; raw:false formats cells as display strings
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      defval: "",
      raw: false,
    }) as string[][];
    // Normalize everything to string
    const rawRows = aoa.map(row => row.map(cell => (cell == null ? "" : String(cell))));
    return { rawRows, parseError: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rawRows: null, parseError: `Spreadsheet parse error: ${msg}` };
  }
}

function parseAnyBuffer(buffer: Buffer, fileType: SpreadsheetType): { rawRows: string[][] | null; parseError: string | null } {
  if (fileType === "xls" || fileType === "xlsx") return parseXlsRawRows(buffer);
  return parseRawRows(buffer);
}

function emptyRow(): CsvRow {
  return {
    firstName: null, lastName: null, email: null, phone: null, title: null,
    companyName: null, designation: null, function: null, employeeSize: null,
    companyRevenue: null, linkedinUrl: null, companyLinkedinUrl: null,
    city: null, pin: null, state: null, country: null, identifier: null, extraData: {},
  };
}

function validateField(field: CsvField, val: string | null, rowNum: number, errors: string[]): boolean {
  if (field === "email") {
    // Email is optional — only validate format when a value is actually present
    if (val !== null && !EMAIL_RE.test(val)) { errors.push(`Row ${rowNum}: Email "${val}" is not a valid email`); return false; }
  }
  // LinkedIn URLs are normalized (https:// prepended if missing) — no validation rejection
  return true;
}

export function parseCsvBuffer(buffer: Buffer, fileType: SpreadsheetType = "csv"): CsvImportResult {
  return parseCsvBufferWithMappings(buffer, {}, fileType);
}

export function parseCsvBufferWithMappings(buffer: Buffer, mappings: ColumnMappings, fileType: SpreadsheetType = "csv"): CsvImportResult {
  const errors: string[] = [];
  const rows: CsvRow[] = [];

  const { rawRows, parseError } = parseAnyBuffer(buffer, fileType);
  if (parseError) { errors.push(parseError); return { rows, errors, validationSkippedCount: 0 }; }
  if (!rawRows || rawRows.length === 0) { errors.push("CSV file is empty."); return { rows, errors, validationSkippedCount: 0 }; }

  const headerRow = rawRows[0];
  const seenHeaders = new Set<string>();
  const colMap = new Map<number, CsvField | null>(); // null = ignore
  const customColMap = new Map<number, string>(); // index → custom field label

  for (let i = 0; i < headerRow.length; i++) {
    const raw = headerRow[i].trim();
    const lower = raw.toLowerCase();
    if (lower === "") {
      colMap.set(i, null); // silently skip blank-header columns
      continue;
    }
    const builtIn = HEADER_MAP[lower];
    if (!builtIn) {
      const m = mappings[raw];
      if (!m || m.action === "ignore") { colMap.set(i, null); continue; }
      if (m.action === "map" && m.mapTo) {
        colMap.set(i, m.mapTo);
      } else if (m.action === "custom") {
        customColMap.set(i, raw);
        colMap.set(i, null);
      } else {
        colMap.set(i, null);
      }
      continue;
    }
    if (seenHeaders.has(lower)) {
      errors.push(`Duplicate column header: "${raw}"`);
      continue;
    }
    seenHeaders.add(lower);
    colMap.set(i, builtIn);
  }

  if (errors.length > 0) return { rows, errors, validationSkippedCount: 0 };

  let validationSkippedCount = 0;

  for (let ri = 1; ri < rawRows.length; ri++) {
    const rawRow = rawRows[ri];
    const rowNum = ri + 1;
    if (rawRow.every(cell => cell.trim() === "")) continue;

    const rowObj = emptyRow();
    let rowHasError = false;
    const rowErrors: string[] = [];

    for (const [colIdx, field] of colMap.entries()) {
      if (field === null) continue;
      const raw = rawRow[colIdx] ?? "";
      const val = field === "phone"
        ? normalizePhone(raw)
        : (field === "linkedinUrl" || field === "companyLinkedinUrl")
          ? normalizeUrl(raw)
          : nullify(raw);
      if (!validateField(field, val, rowNum, rowErrors)) { rowHasError = true; continue; }
      rowObj[field] = val as any;
    }

    for (const [colIdx, label] of customColMap.entries()) {
      const val = nullify(rawRow[colIdx] ?? "");
      rowObj.extraData[label] = val;
    }

    if (!rowHasError) {
      rows.push(rowObj);
    } else {
      errors.push(...rowErrors);
      validationSkippedCount++;
    }
  }

  return { rows, errors, validationSkippedCount };
}

export function previewCsvBuffer(buffer: Buffer, mappings: ColumnMappings = {}, fileType: SpreadsheetType = "csv"): CsvPreviewResult {
  const headerErrors: string[] = [];
  const unknownHeaders: string[] = [];

  const { rawRows, parseError } = parseAnyBuffer(buffer, fileType);
  if (parseError) {
    return { headers: [], headerErrors: [parseError], unknownHeaders: [], previewRows: [], totalDataRows: 0, validRowCount: 0 };
  }
  if (!rawRows || rawRows.length === 0) {
    return { headers: [], headerErrors: ["File is empty."], unknownHeaders: [], previewRows: [], totalDataRows: 0, validRowCount: 0 };
  }

  const headerRow = rawRows[0];
  const seenHeaders = new Set<string>();
  const colMap = new Map<number, CsvField | null>(); // null = skip/custom
  const customColMap = new Map<number, string>();

  for (let i = 0; i < headerRow.length; i++) {
    const raw = headerRow[i].trim();
    const lower = raw.toLowerCase();
    if (lower === "") {
      colMap.set(i, null); // silently skip blank-header columns
      continue;
    }
    const builtIn = HEADER_MAP[lower];
    if (!builtIn) {
      const m = mappings[raw];
      if (!m) {
        unknownHeaders.push(raw);
        colMap.set(i, null);
      } else if (m.action === "map" && m.mapTo) {
        colMap.set(i, m.mapTo);
      } else if (m.action === "custom") {
        customColMap.set(i, raw);
        colMap.set(i, null);
      } else {
        colMap.set(i, null);
      }
      continue;
    }
    if (seenHeaders.has(lower)) {
      headerErrors.push(`Duplicate column header: "${raw}"`);
      continue;
    }
    seenHeaders.add(lower);
    colMap.set(i, builtIn);
  }

  const knownFields = Array.from(colMap.values()).filter((f): f is CsvField => f !== null);
  const headers = knownFields.map(f => HEADER_DISPLAY[f]);

  if (headerErrors.length > 0) {
    return { headers, headerErrors, unknownHeaders, previewRows: [], totalDataRows: 0, validRowCount: 0 };
  }

  const previewRows: CsvPreviewRow[] = [];
  let totalDataRows = 0;
  let validRowCount = 0;

  for (let ri = 1; ri < rawRows.length; ri++) {
    const rawRow = rawRows[ri];
    const rowNum = ri + 1;
    if (rawRow.every(cell => cell.trim() === "")) continue;
    totalDataRows++;

    const rowErrors: string[] = [];
    const data: Partial<CsvRow> = {};

    for (const [colIdx, field] of colMap.entries()) {
      if (field === null) continue;
      const raw = rawRow[colIdx] ?? "";
      const val = field === "phone"
        ? normalizePhone(raw)
        : (field === "linkedinUrl" || field === "companyLinkedinUrl")
          ? normalizeUrl(raw)
          : nullify(raw);
      if (field === "email" && val !== null && !EMAIL_RE.test(val)) {
        rowErrors.push(`Email "${val}" is not valid`);
        (data as any)[field] = val;
        continue;
      }
      (data as any)[field] = val;
    }

    if (rowErrors.length === 0) validRowCount++;
    if (previewRows.length < 5) {
      previewRows.push({ rowNum, data, errors: rowErrors });
    }
  }

  return { headers, headerErrors, unknownHeaders, previewRows, totalDataRows, validRowCount };
}
