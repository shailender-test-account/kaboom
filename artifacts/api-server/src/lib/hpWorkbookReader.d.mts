export interface HpParsedWorkbook {
  rows: { sheet: string; row: number; values: Record<string, unknown> }[];
  headers: string[];
}
export function readHpWorkbook(bytes: Buffer, kind: string, mappings?: Record<string, string>): HpParsedWorkbook;
