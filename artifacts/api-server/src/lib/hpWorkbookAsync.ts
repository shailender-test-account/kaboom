import { Worker } from "node:worker_threads";
import type { HpParsedWorkbook } from "./hpWorkbookReader.mjs";

let busy = false;
/** Bound expensive HTTP file operations instead of growing a hidden work queue. */
export function claimHpWorkbookSlot() {
  if (busy) throw Object.assign(new Error("Another HP file preview or import is running. Wait for it to finish before trying again."), { status: 429 });
  busy = true;
  return () => { busy = false; };
}

export function readHpWorkbookAsync(bytes: Buffer, kind: string, mappings: Record<string, string> = {}): Promise<HpParsedWorkbook> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hpWorkbookReader.mjs", import.meta.url), {
      workerData: { hpWorkbookReader: true, bytes, kind, mappings },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error?: Error, parsed?: HpParsedWorkbook) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(parsed!);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("Workbook reading timed out. Split the file into smaller uploads and retry."), { status: 408 })), 60_000);
    worker.once("message", (message: { parsed?: HpParsedWorkbook; error?: string }) => {
      if (message.error) finish(Object.assign(new Error(message.error), { status: 422 }));
      else if (!message.parsed) finish(new Error("Workbook reader returned no result."));
      else finish(undefined, message.parsed);
    });
    worker.once("error", () => finish(Object.assign(new Error("Workbook reader exceeded its limits or failed. Use a smaller valid workbook and retry."), { status: 422 })));
    worker.once("exit", () => { if (!settled) finish(new Error("Workbook reader stopped without returning a result.")); });
  });
}
