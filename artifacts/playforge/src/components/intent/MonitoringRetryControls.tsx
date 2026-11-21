import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMonitoringRetryOptions, useRetryMonitoringRun, type MonitoringRetryInput } from "@workspace/api-client-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import type { IntentMonitoringSchedule } from "@/hooks/use-intent";
import { hasManageGrant } from "@workspace/api-zod";

type ProviderRun = NonNullable<IntentMonitoringSchedule["latestRun"]>["providers"][number];

export default function MonitoringRetryControls({ schedule }: { schedule: IntentMonitoringSchedule }) {
  const { user } = useAuthContext();
  if (!user || !hasManageGrant(user, "monitoring")) return null;
  const failures = schedule.latestRun?.providers.filter(run =>
    run.status === "failed" || run.status === "partial" || run.accountsFailed > 0) ?? [];
  return <div className="mt-3 space-y-3">
    {failures.map((run, index) => run.runId
      ? <EngineRetry key={run.runId} configId={schedule.id} run={run} />
      : <p key={index} className="text-xs text-amber-800">Refresh this page to load engine recovery options.</p>)}
  </div>;
}

function EngineRetry({ configId, run }: { configId: number; run: ProviderRun }) {
  const options = useGetMonitoringRetryOptions({ query: { staleTime: 30_000 } });
  const retry = useRetryMonitoringRun();
  const queryClient = useQueryClient();
  const [selectedProvider, setProvider] = useState<MonitoringRetryInput["provider"] | "" | null>(null);
  const [notice, setNotice] = useState("");
  const engines = options.data?.engines ?? [];
  const provider = selectedProvider ?? (engines.some(engine => engine.provider === "perplexity" && engine.configured) ? "perplexity" : "");
  const error = retry.error as (Error & { data?: { error?: string } }) | null;
  return <section className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3" aria-label={`Recover ${run.provider} monitoring`}>
    <p className="text-xs font-bold text-stone-800">Retry unfinished accounts with another engine</p>
    <p className="text-[11px] text-stone-600">Source engine: {run.provider}. Completed results and original usage are retained. A retry can incur provider charges. This choice applies to this recovery only.</p>
    {options.isLoading ? <p role="status" className="text-xs">Loading available engines…</p>
      : options.isError ? <p role="alert" className="text-xs text-red-800">Could not load engines. <button type="button" className="underline" onClick={() => options.refetch()}>Retry loading engines</button></p>
      : <>
        <label className="block text-xs font-semibold text-stone-700">
          Retry engine
          <select className="mt-1 h-9 w-full rounded-md border border-stone-300 bg-white px-2 text-xs"
            value={provider} disabled={retry.isPending || !!notice}
            onChange={event => { setProvider(event.target.value as MonitoringRetryInput["provider"] | ""); retry.reset(); }}>
            <option value="">Choose an engine</option>
            {engines.map(engine => <option key={engine.provider} value={engine.provider} disabled={!engine.configured}>
              {engine.label}{!engine.configured ? " — not configured" : ""}
            </option>)}
          </select>
        </label>
        {options.data?.safetyPaused && <p role="alert" className="text-xs text-amber-900">Research is paused by copied-data safety mode. No engine retry can start while that protection is enabled.</p>}
        {!engines.some(engine => engine.configured) && <p role="alert" className="text-xs text-amber-900">No research engine is configured. Configure one before retrying.</p>}
        <Button type="button" size="sm" variant="outline"
          disabled={!provider || !engines.some(engine => engine.provider === provider && engine.configured) || retry.isPending || !!notice || options.data?.safetyPaused}
          onClick={() => {
            if (!provider || !run.runId) return;
            retry.mutate({ id: configId, data: { runId: run.runId, provider } }, {
              onSuccess: result => {
                setNotice(result.duplicate
                  ? "A recovery already exists for this run. Refreshing its progress."
                  : `${result.accountsQueued} unfinished accounts queued with the selected engine.`);
                void queryClient.invalidateQueries({ queryKey: ["intent"] });
              },
            });
          }}>
          {retry.isPending ? "Queuing retry…" : "Retry unfinished accounts"}
        </Button>
      </>}
    {error && <p role="alert" className="text-xs text-red-800">{error.data?.error ?? error.message}</p>}
    {notice && <p role="status" className="text-xs text-emerald-800">{notice}</p>}
  </section>;
}
