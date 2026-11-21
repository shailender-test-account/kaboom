import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatReportDateTime } from "@/lib/reportTime";

type Review = {
  journeys: { id: number; name: string }[];
  events: { id: number; createdAt: string; eventType: string; pageName: string | null; tokenHint: string }[];
  contacts: { id: number; name: string; email: string | null; accountName: string | null }[];
  history: { id: number; journeyId: number; anchorEventId: number; eventIds: number[]; activityEventIds: number[]; contactId: number;
    evidence: string; reviewedBy: number; reviewedAt: string; reviewer: string | null; revokedAt: string | null;
    revokeReason: string | null; revoker: string | null }[];
  preview: { id: number; eventType: string; createdAt: string; pageName: string | null; pageUrl: string | null }[];
  activityPreview: { id: number; eventType: string; createdAt: string; pageName: string | null }[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not review the session");
  return body;
}

export function AnonymousSessionReview({ accountId }: { accountId: number }) {
  const [open, setOpen] = useState(false);
  const [journeyId, setJourneyId] = useState("");
  const [anchorId, setAnchorId] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [contactId, setContactId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const base = `/api/intent/inbound/accounts/${accountId}/anonymous-sessions`;
  const key = ["anonymous-sessions", accountId, journeyId, anchorId, contactQuery];
  const details = useQuery({
    queryKey: key,
    queryFn: () => request<Review>(`${base}?journeyId=${journeyId}&anchorEventId=${anchorId}&contactQuery=${encodeURIComponent(contactQuery)}`),
    enabled: open,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["anonymous-sessions", accountId] });
    queryClient.invalidateQueries({ queryKey: ["analytics"] });
  };
  const verify = useMutation({
    mutationFn: () => request(base, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchorEventId: Number(anchorId), contactId: Number(contactId), evidence, confirm: true }) }),
    onSuccess: () => {
      refresh(); setAnchorId(""); setConfirmed(false); setEvidence("");
      toast({ title: "Session verified", description: "Only the reviewed 30-minute event window is attributed." });
    },
    onError: (error: Error) => toast({ title: "Verification failed", description: error.message, variant: "destructive" }),
  });
  const revoke = useMutation({
    mutationFn: () => request(`${base}/${revokeId}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: revokeReason }) }),
    onSuccess: () => { refresh(); setRevokeId(null); setRevokeReason(""); toast({ title: "Verification revoked" }); },
    onError: (error: Error) => toast({ title: "Revocation failed", description: error.message, variant: "destructive" }),
  });
  const selected = details.data?.events.find(event => String(event.id) === anchorId)
    ?? details.data?.preview.find(event => String(event.id) === anchorId);
  return <>
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Review anonymous session</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Verify an anonymous journey session</DialogTitle>
          <DialogDescription>Choose a specific page view. The review covers its browser's events on this journey for the following 30 minutes only. A name, IP address, or nearby timestamp alone is not proof of identity.</DialogDescription>
        </DialogHeader>
        {details.isLoading && <p>Loading sessions…</p>}
        {details.isError && <p role="alert" className="text-destructive">{details.error.message}</p>}
        {details.data && <>
          <div className="space-y-2">
            <Label>Journey</Label>
            <Select value={journeyId} onValueChange={value => { setJourneyId(value); setAnchorId(""); }}>
              <SelectTrigger><SelectValue placeholder="Select journey" /></SelectTrigger>
              <SelectContent>{details.data.journeys.map(j => <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {journeyId && <div className="space-y-2">
            <Label>Anonymous page view (latest 50)</Label>
            <Select value={anchorId} onValueChange={setAnchorId}>
              <SelectTrigger><SelectValue placeholder="Select a page view" /></SelectTrigger>
              <SelectContent>{details.data.events.map(event =>
                <SelectItem key={event.id} value={String(event.id)}>
                  #{event.id} · {formatReportDateTime(event.createdAt)} · {event.pageName ?? "Page"} · browser {event.tokenHint}…
                </SelectItem>)}</SelectContent>
            </Select>
            {!details.data.events.length && <p className="text-sm text-muted-foreground">No unverified anonymous page views found for this journey.</p>}
            <Label htmlFor={`older-event-${accountId}`}>Or enter an older page-view event ID from Analytics</Label>
            <Input id={`older-event-${accountId}`} type="number" min="1" step="1"
              value={anchorId} onChange={e => setAnchorId(e.target.value)} placeholder="Event ID" />
          </div>}
          {selected && <div className="text-sm rounded border p-2 space-y-1">
            <p>Session anchored at #{selected.id} · {formatReportDateTime(selected.createdAt)} · next 30 minutes</p>
            {details.data.preview.map(event => <p key={event.id}>#{event.id} · {formatReportDateTime(event.createdAt)} · {event.eventType} · {event.pageName ?? event.pageUrl ?? "Journey page"}</p>)}
            {details.data.activityPreview.map(event => <p key={`activity-${event.id}`}>Activity #{event.id} · {formatReportDateTime(event.createdAt)} · {event.eventType} · {event.pageName ?? "Journey activity"}</p>)}
            {!details.data.preview.length && <p>Loading session details…</p>}
            {(details.data.preview.length > 200 || details.data.activityPreview.length > 200) &&
              <p role="alert" className="text-destructive">This window contains more than 200 events and cannot be verified.</p>}
          </div>}
          <div className="space-y-2">
            <Label htmlFor={`contact-search-${accountId}`}>Find known contact by name or email</Label>
            <Input id={`contact-search-${accountId}`} value={contactQuery} onChange={e => { setContactQuery(e.target.value); setContactId(""); }} placeholder="At least 2 characters" />
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger><SelectValue placeholder="Select contact" /></SelectTrigger>
              <SelectContent>{details.data.contacts.map(c => <SelectItem key={c.id} value={String(c.id)}>
                {c.name} · {c.email ?? "No email"} · {c.accountName ?? "No CRM account"}
              </SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`evidence-${accountId}`}>Evidence tying this visit to the contact</Label>
            <textarea id={`evidence-${accountId}`} value={evidence} onChange={e => setEvidence(e.target.value)}
              maxLength={2000} className="w-full min-h-20 rounded-md border bg-background p-2 text-sm"
              placeholder="Describe the direct confirmation and where it can be checked." />
          </div>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            I verified this specific session belongs to the selected contact; do not link other visits.</label>
          <DialogFooter><Button disabled={!selected || !details.data.preview.length ||
            details.data.preview.length > 200 || details.data.activityPreview.length > 200 ||
            !contactId || evidence.trim().length < 20 || !confirmed || verify.isPending}
            onClick={() => verify.mutate()}>{verify.isPending ? "Verifying…" : "Verify session"}</Button></DialogFooter>
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">Verification history</h3>
            {!details.data.history.length && <p className="text-sm text-muted-foreground">No reviews yet.</p>}
            {details.data.history.map(item => <div key={item.id} className="rounded border p-3 text-sm space-y-1">
              <p>#{item.anchorEventId} · {item.eventIds.length} journey events, {item.activityEventIds.length} activity events · contact #{item.contactId} · journey {details.data?.journeys.find(j => j.id === item.journeyId)?.name ?? `#${item.journeyId}`}</p>
              <p>{item.evidence}</p>
              <p className="text-muted-foreground">Reviewed {formatReportDateTime(item.reviewedAt)} by {item.reviewer ?? `user #${item.reviewedBy}`}</p>
              {item.revokedAt ? <p>Revoked {formatReportDateTime(item.revokedAt)} by {item.revoker ?? "admin"}: {item.revokeReason}</p> : <>
                {revokeId === item.id ? <div className="flex gap-2"><Input aria-label="Revocation reason" value={revokeReason} onChange={e => setRevokeReason(e.target.value)} placeholder="Why is this attribution invalid?" />
                  <Button variant="destructive" disabled={revokeReason.trim().length < 10 || revoke.isPending} onClick={() => revoke.mutate()}>Confirm revoke</Button></div> :
                  <Button size="sm" variant="outline" onClick={() => setRevokeId(item.id)}>Revoke</Button>}
              </>}
            </div>)}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}