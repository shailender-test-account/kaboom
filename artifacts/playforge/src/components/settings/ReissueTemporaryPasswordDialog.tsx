import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReissueTemporaryPassword, getListTeamAccessQueryKey, type TeamMember, type TeamMemberCreated } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import TemporaryPasswordLifetime from "./TemporaryPasswordLifetime";
import { errorMessage } from "./teamAccessModel";

export default function ReissueTemporaryPasswordDialog({ member, onClose, onIssued }: {
  member: TeamMember; onClose: () => void; onIssued: (created: TeamMemberCreated) => void;
}) {
  const qc = useQueryClient();
  const issue = useReissueTemporaryPassword({ mutation: { gcTime: 0, retry: false } });
  const [hours, setHours] = useState(72);
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try {
      const result = await issue.mutateAsync({ id: member.id, data: { temporaryPasswordHours: hours } });
      void qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
      onIssued(result);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not reissue this password. Refresh the list before retrying."));
      void qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
    } finally { issue.reset(); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !issue.isPending) onClose(); }}>
    <DialogContent onInteractOutside={event => { if (issue.isPending) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Reissue temporary password?</DialogTitle>
        <DialogDescription>This replaces the current temporary password for {member.email}; the old password will stop working immediately.
          Save and share the new password securely. Existing reset and setup links will stop working. No email is sent.</DialogDescription>
      </DialogHeader>
      <TemporaryPasswordLifetime id="reissue-lifetime" value={hours} onChange={setHours} disabled={issue.isPending} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" disabled={issue.isPending} onClick={onClose}>Cancel</Button>
        <Button disabled={issue.isPending} onClick={submit}>{issue.isPending ? "Reissuing…" : "Replace temporary password"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
