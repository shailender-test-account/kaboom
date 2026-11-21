import * as XLSX from "xlsx";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

const text = v => String(v ?? "").trim();
const usable = v => text(v) && !/^(?:-|n\/?a|null|none)$/i.test(text(v));

/** Shared by synchronous contract tests and the isolated Excel-reading worker. */
export function readHpWorkbook(bytes, kind, mappings = {}) {
  const book = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const rows = [], headers = new Set();
  const names = kind === "accounts" && book.SheetNames.includes("Final") ? ["Final"] : book.SheetNames;
  for (const sheet of names) {
    const worksheet = book.Sheets[sheet];
    let lastRow = 0, lastColumn = 0;
    for (const [address, cell] of Object.entries(worksheet)) {
      if (address.startsWith("!") || !cell?.v || !text(cell.v)) continue;
      const pos = XLSX.utils.decode_cell(address);
      lastRow = Math.max(lastRow, pos.r); lastColumn = Math.max(lastColumn, pos.c);
    }
    if (lastColumn > 255 || lastRow > 100_002) throw new Error("Upload at most 100,000 rows and 256 populated columns per sheet.");
    const cells = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: true,
      range: { s: { r: 0, c: 0 }, e: { r: lastRow, c: lastColumn } } });
    const headerIndex = cells.findIndex(r => r.filter(v => usable(v)).length >= 2);
    if (headerIndex < 0) continue;
    const labels = cells[headerIndex].map(text);
    labels.forEach(l => l && headers.add(l));
    cells.slice(headerIndex + 1).forEach((cells, i) => {
      if (!cells.some(v => usable(v))) return;
      const values = {};
      labels.forEach((l, j) => { if (l) { values[l] = cells[j] ?? ""; if (mappings[l]) values[mappings[l]] = cells[j] ?? ""; } });
      rows.push({ sheet, row: headerIndex + i + 2, values });
    });
  }
  if (rows.length > 100_000) throw new Error("Upload at most 100,000 rows per file.");
  return { rows, headers: [...headers] };
}

if (!isMainThread && parentPort && workerData?.hpWorkbookReader === true) {
  try {
    parentPort.postMessage({ parsed: readHpWorkbook(Buffer.from(workerData.bytes), workerData.kind, workerData.mappings) });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : "The workbook could not be read." });
  } finally {
    parentPort.close();
  }
}
