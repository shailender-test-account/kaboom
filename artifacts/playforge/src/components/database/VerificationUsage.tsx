import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetContactVerificationUsage, getGetContactVerificationUsageQueryKey,
  useSetContactVerificationLimit,
} from "@workspace/api-client-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export function VerificationUsage() {
  const { user } = useAuthContext();
  return user?.role === "admin" ? <AdminUsage /> : null;
}

function AdminUsage() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useGetContactVerificationUsage({
    query: { enabled: open, refetchInterval: open ? 15000 : false, retry: false },
  });
  const save = useSetContactVerificationLimit({
    mutation: {
      retry: false,
      onSuccess: () => {
        setDraft(null);
        qc.invalidateQueries({ queryKey: getGetContactVerificationUsageQueryKey() });
        toast({ title: "Verification ceiling saved" });
      },
      onError: () => toast({ title: "Could not save ceiling", variant: "destructive" }),
    },
  });
  const data = query.data;
  const value = draft ?? String(data?.requestLimit ?? 0);
  const valid = /^\d+$/.test(value) && Number(value) <= 1_000_000;

  return (
    <div className="mx-4 mb-3 text-xs">
      <Button variant="outline" size="sm" onClick={() => setOpen(v => !v)}
        aria-expanded={open} data-testid="button-verification-usage">Verification usage</Button>
      {open && (
        <div className="mt-2 rounded-lg border bg-card p-3 space-y-3" data-testid="verification-usage">
          <p className="font-semibold">Tenant verification usage · all time · Apollo</p>
          {query.isLoading && <p>Loading usage…</p>}
          {query.isError && <p role="alert" className="text-destructive">Could not load usage. <button className="underline" onClick={() => query.refetch()}>Retry</button></p>}
          {data && !query.isError && <>
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              {[
                ["Reserved attempts", data.attempts], ["Provider responses", data.responses],
                ["Unconfirmed attempts", data.unconfirmedAttempts], ["Remaining requests", data.remaining],
              ].map(([label, count]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{count.toLocaleString()}</dd></div>)}
            </dl>
            <p className="text-muted-foreground">Attempts include failures, timeouts and interrupted requests. Responses include every HTTP status, even errors. These are request counts, not billed credits or a currency estimate. No automatic retries.</p>
            {data.legacyAttempts > 0 && <p className="text-muted-foreground">{data.legacyAttempts.toLocaleString()} historical attempts are included; their response outcomes were not recorded. Deleted historical records cannot be reconstructed.</p>}
            {data.remaining === 0 && <p role="status" className="text-destructive">Paid lookups are blocked. An admin must raise the ceiling to allow more requests.</p>}
            <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (valid) save.mutate({ data: { requestLimit: Number(value) } }); }}>
              <label className="space-y-1">All-time request ceiling
                <Input aria-label="All-time request ceiling" className="w-48" type="number" min={0} max={1000000} step={1}
                  value={value} onChange={e => setDraft(e.target.value)} disabled={save.isPending} />
              </label>
              <Button size="sm" disabled={!valid || save.isPending || Number(value) === data.requestLimit} type="submit">Save ceiling</Button>
            </form>
            <p className="text-muted-foreground">0 blocks new lookups. The ceiling is shared by all contacts and users in this tenant and never resets automatically. Saving a ceiling does not reset usage. To allow 10 more requests, set it to {(data.attempts + 10).toLocaleString()}.</p>
          </>}
        </div>
      )}
    </div>
  );
}
