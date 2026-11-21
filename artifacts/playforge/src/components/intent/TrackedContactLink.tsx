import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatReportDate } from "@/lib/reportTime";

type LinkDetails = {
  candidates: { id: number; name: string; email: string | null; accountName: string }[];
  journeys: { id: number; name: string }[];
  linked: { contactId: number; journeyId: number; reviewedAt: string; effectiveFrom?: string } | null;
  accountAddedAt: string | null;
};

async function linkApi<T>(accountId: number, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/intent/inbound/accounts/${accountId}/tracked-contact`, {
    credentials: "include", ...init,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not update tracked visitor association.");
  return body;
}

export function TrackedContactLink({ accountId }: { accountId: number }) {
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState("");
  const [journeyId, setJourneyId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [startDate, setStartDate] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = ["intent", "inbound", "tracked-contact", accountId];
  const details = useQuery({
    queryKey: key,
    queryFn: () => linkApi<LinkDetails>(accountId),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: (body: object) => linkApi<{ linked: LinkDetails["linked"] }>(accountId, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      setOpen(false);
      toast({ title: "Visitor association updated", description: "Visits to the selected journey are attributed from the reviewed start date." });
    },
    onError: (error: Error) => toast({ title: "Could not link tracked visitor", description: error.message, variant: "destructive" }),
  });
  const linked = details.data?.linked;
  return <>
    <Button size="sm" variant="outline" onClick={() => { setOpen(true); setContactId(""); setJourneyId(""); setConfirmed(false); setStartDate(""); }}
      data-testid={`button-link-tracked-contact-${accountId}`}>
      Link tracked visitor
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a tracked visitor</DialogTitle>
          <DialogDescription>
            Confirm which existing contact is the same person. Only visits to the chosen journey will count for this account. Other account history is not moved.
          </DialogDescription>
        </DialogHeader>
        {details.isLoading && <p className="text-sm text-muted-foreground">Loading tracked contacts…</p>}
        {details.isError && <p role="alert" className="text-sm text-destructive">{details.error.message}</p>}
        {details.data && <>
          {linked && <div className="rounded-md border bg-muted/40 p-3 text-sm">
            Currently linked: {details.data.candidates.find(c => c.id === linked.contactId)?.name ?? "Tracked contact"} · {details.data.journeys.find(j => j.id === linked.journeyId)?.name ?? "Journey unavailable"}
            {linked.effectiveFrom && <> · From {formatReportDate(linked.effectiveFrom)}</>}
          </div>}
          {!details.data.candidates.length && <p className="text-sm text-muted-foreground">No other tracked contact with this exact name was found. Check the CRM contact records before linking.</p>}
          <div className="space-y-2">
            <Label>Existing tracked contact</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger data-testid="select-tracked-contact"><SelectValue placeholder="Choose a contact" /></SelectTrigger>
              <SelectContent>{details.data.candidates.map(candidate =>
                <SelectItem key={candidate.id} value={String(candidate.id)}>
                  {candidate.name} · {candidate.accountName}{candidate.email ? ` · ${candidate.email}` : ""}
                </SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Journey to attribute</Label>
            <Select value={journeyId} onValueChange={setJourneyId}>
              <SelectTrigger data-testid="select-tracked-journey"><SelectValue placeholder="Choose a journey" /></SelectTrigger>
              <SelectContent>{details.data.journeys.map(journey =>
                <SelectItem key={journey.id} value={String(journey.id)}>{journey.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`link-start-date-${accountId}`}>Include visits starting (optional)</Label>
            <input id={`link-start-date-${accountId}`} type="date" value={startDate}
              onChange={event => setStartDate(event.target.value)}
              className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
            <p className="text-xs text-muted-foreground">
              Leave blank to start when this account was added{details.data.accountAddedAt ? ` (${formatReportDate(details.data.accountAddedAt)})` : ""}.
              For a known earlier visit, choose its date. Earlier history on this journey will then appear under this account in Analytics.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />
            I confirm that these contacts are the same person and this account should receive their visits to the chosen journey.
          </label>
          <DialogFooter className="gap-2">
            {linked && <Button variant="outline" disabled={save.isPending}
              onClick={() => save.mutate({ contactId: null, journeyId: null })}>Remove link</Button>}
            <Button disabled={!contactId || !journeyId || !confirmed || save.isPending}
              onClick={() => save.mutate({ contactId: Number(contactId), journeyId: Number(journeyId), confirmSamePerson: true,
                ...(startDate ? { startDate } : {}) })}>
              {save.isPending ? "Saving…" : "Confirm link"}
            </Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}