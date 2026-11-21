import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTeamAccessQueryKey, useDeleteTeamMember } from "@workspace/api-client-react";
import type { TeamMember } from "@workspace/api-client-react";
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { errorMessage } from "./teamAccessModel";

export default function DeleteMemberDialog({ member, onClose }: {
  member: TeamMember;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deletion = useDeleteTeamMember();

  function remove() {
    if (confirmation !== member.email || deletion.isPending) return;
    deletion.mutate({ id: member.id }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
        toast({ title: "User deleted", description: "Their login account has been permanently removed." });
        onClose();
      },
    });
  }

  return (
    <AlertDialog open onOpenChange={open => { if (!open && !deletion.isPending) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete user permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the login account for {member.firstName} {member.lastName} ({member.email})
            and revokes their access. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="delete-member-email">Type their email address to confirm</Label>
          <Input id="delete-member-email" value={confirmation} autoComplete="off"
            disabled={deletion.isPending} onChange={event => setConfirmation(event.target.value)} />
          {deletion.isError && <p role="alert" className="text-sm text-destructive">
            {errorMessage(deletion.error, "Could not delete this user. Please try again.")}
          </p>}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={deletion.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={confirmation !== member.email || deletion.isPending}
            onClick={remove} data-testid="button-confirm-delete-member">
            {deletion.isPending ? "Deleting…" : "Delete user permanently"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
