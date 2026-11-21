import { toast } from "@/hooks/use-toast";
type Exports = typeof import("./analyticsExport");

function deferred<K extends keyof Exports>(name: K) {
  return async (...args: Parameters<Exports[K]>) => {
    try {
      const exports = await import("./analyticsExport");
      const run = exports[name] as (...input: Parameters<Exports[K]>) => unknown;
      run(...args);
    } catch {
      toast({ title: "Export failed", description: "The report could not be prepared. Please try again.", variant: "destructive" });
    }
  };
}
export const exportTrafficExcel = deferred("exportTrafficExcel");
export const exportTrafficPdf = deferred("exportTrafficPdf");
export const exportStageExcel = deferred("exportStageExcel");
export const exportStagePdf = deferred("exportStagePdf");
export const exportContentExcel = deferred("exportContentExcel");
export const exportContentPdf = deferred("exportContentPdf");
export const exportSourceExcel = deferred("exportSourceExcel");
export const exportSourcePdf = deferred("exportSourcePdf");
export const exportUsersExcel = deferred("exportUsersExcel");
export const exportUsersPdf = deferred("exportUsersPdf");
export const exportScrollDepthExcel = deferred("exportScrollDepthExcel");
export const exportScrollDepthPdf = deferred("exportScrollDepthPdf");
export const exportAbmExcel = deferred("exportAbmExcel");
export const exportAbmPdf = deferred("exportAbmPdf");
export const exportAccountIntelExcel = deferred("exportAccountIntelExcel");
export const exportAccountIntelPdf = deferred("exportAccountIntelPdf");
export const exportVelocityExcel = deferred("exportVelocityExcel");
export const exportVelocityPdf = deferred("exportVelocityPdf");
export const exportScoreIntelExcel = deferred("exportScoreIntelExcel");
export const exportScoreIntelPdf = deferred("exportScoreIntelPdf");
export const exportCallsExcel = deferred("exportCallsExcel");
export const exportCallsPdf = deferred("exportCallsPdf");
export const exportAccountsExcel = deferred("exportAccountsExcel");
export const exportAccountsPdf = deferred("exportAccountsPdf");
