import { useState } from "react";
import {
  useGetResendReadiness, usePreviewUserWelcomeEmail, useSendUserWelcomeEmail,
} from "@workspace/api-client-react";
import type { TeamMember } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { errorMessage } from "./teamAccessModel";

export default function WelcomeEmailsDialog({ members, onClose }: {
  members: TeamMember[]; onClose: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [filter, setFilter] = useState("");
  const { toast } = useToast();
  const status = useGetResendReadiness({ query: { staleTime: 0, refetchOnWindowFocus: false } });
  const preview = usePreviewUserWelcomeEmail({ mutation: { gcTime: 0 } });
  const send = useSendUserWelcomeEmail({ mutation: { gcTime: 0,
    onSuccess: result => {
      toast({ title: `${result.accepted} welcome email(s) accepted by Resend`,
        description: "Provider acceptance is not an inbox-delivery receipt." });
      onClose();
    },
  } });
  const changeSelection = (id: number) => {
    setSelected(ids => ids.includes(id) ? ids.filter(i => i !== id) : ids.length < 50 ? [...ids, id] : ids);
    setConfirmed(false);
    preview.reset();
  };
  const canSend = status.data?.welcomeSendingEnabled && status.data.senderConfigured
    && ["sending_only", "authenticated"].includes(status.data.authentication)
    && status.data.senderVerified !== false && confirmed && !!preview.data && !send.isPending;
  const close = () => { if (!send.isPending) { preview.reset(); send.reset(); onClose(); } };

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-testid="welcome-email-dialog">
      <DialogHeader>
        <DialogTitle>Welcome emails</DialogTitle>
        <DialogDescription>Choose users and preview a secure password-setup email. Creating users or previewing here never sends mail.</DialogDescription>
      </DialogHeader>
      <div className="rounded-lg border p-3 text-sm space-y-2" role="status">
        <p className="font-medium">{status.data?.welcomeSendingEnabled ? "Sending enabled" : "Sending paused"}</p>
        <p className="text-muted-foreground">{status.isPending ? "Checking the connection without sending email…" : status.data?.detail ?? "The connection could not be checked."}</p>
        {status.data?.copiedDataSafeMode && <p>Preview safe mode is active. No welcome emails can be sent.</p>}
        {!status.data?.welcomeBaseUrlConfigured && <p>A separate, trusted app URL must be configured before sending.</p>}
        <Button size="sm" variant="outline" disabled={status.isFetching} onClick={() => status.refetch()}>Check connection — no email</Button>
      </div>
      <label className="text-sm font-medium" htmlFor="welcome-user-search">Find users</label>
      <input id="welcome-user-search" className="border rounded-md px-3 py-2 text-sm" placeholder="Name or email"
        value={filter} disabled={send.isPending} onChange={e => setFilter(e.target.value)} />
      <div className="max-h-48 overflow-y-auto rounded-lg border divide-y">
        {members.filter(m => `${m.firstName} ${m.lastName} ${m.email}`.toLowerCase().includes(filter.toLowerCase())).map(m =>
          <label key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Checkbox checked={selected.includes(m.id)} disabled={preview.isPending || send.isPending || (!selected.includes(m.id) && selected.length >= 50)}
              onCheckedChange={() => changeSelection(m.id)} />
            <span className="min-w-0"><span className="block">{m.firstName} {m.lastName}</span><span className="block text-xs text-muted-foreground break-all">{m.email}</span></span>
          </label>)}
      </div>
      <p className="text-xs text-muted-foreground">{selected.length} selected · maximum 50 per batch. No plaintext passwords are emailed.</p>
      <Button variant="outline" disabled={!selected.length || preview.isPending || send.isPending}
        onClick={() => { setConfirmed(false); preview.mutate({ data: { userIds: selected } }); }}>Preview welcome email</Button>
      {preview.data && <div className="rounded-lg border p-3 space-y-3">
        <p className="font-medium text-sm">{preview.data.subject}</p>
        <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">{preview.data.exampleText}</pre>
        <p className="text-xs">Recipients: {preview.data.recipients.map(r => r.email).join(", ")}</p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={confirmed} disabled={!status.data?.welcomeSendingEnabled || send.isPending}
            onCheckedChange={value => setConfirmed(value === true)} />
          I reviewed these recipients and want to send these welcome emails.
        </label>
      </div>}
      {(preview.error || send.error) && <p role="alert" className="text-sm text-destructive">{errorMessage(preview.error || send.error, "The request could not be completed.")}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={send.isPending} onClick={close}>Close</Button>
        <Button disabled={!canSend} onClick={() => {
          if (preview.data) send.mutate({ data: { userIds: selected, confirmed: true,
            expectedRecipients: preview.data.recipients.map(({ id, email }) => ({ id, email })) } });
        }}>
          {send.isPending ? "Sending…" : "Send welcome emails"}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
