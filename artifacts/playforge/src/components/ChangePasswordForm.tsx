import { useState } from "react";
import { useChangeOwnPassword } from "@workspace/api-client-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/components/settings/teamAccessModel";
import { useToast } from "@/hooks/use-toast";

export function ChangePasswordForm({ required = false, onSuccess }: {
  required?: boolean;
  onSuccess?: () => void;
}) {
  const { refetch } = useAuthContext();
  const { toast } = useToast();
  const change = useChangeOwnPassword({ mutation: { gcTime: 0 } });
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validation, setValidation] = useState("");
  const [completed, setCompleted] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (change.isPending) return;
    setValidation("");
    if (password !== confirm) { setValidation("The new passwords do not match."); return; }
    if (password === current) { setValidation("Choose a different password from your current password."); return; }
    if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
      setValidation("Use at least 8 characters and at most 72 bytes."); return;
    }
    try {
      await change.mutateAsync({ data: { currentPassword: current, newPassword: password } });
      setCurrent(""); setPassword(""); setConfirm("");
      setCompleted(true);
      change.reset();
      toast({ title: "Password updated successfully" });
    } catch { /* The mutation error is shown below; keep the form available. */ }
  }

  if (completed) {
    return (
      <div className="space-y-4">
        <p role="status" className="text-sm text-emerald-700">Your password has been changed successfully.</p>
        <Button className="w-full" onClick={async () => { await refetch(); onSuccess?.(); }}>
          {required ? "Continue to workspace" : "Done"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current-password">{required ? "Temporary password" : "Current password"}</Label>
        <Input id="current-password" type="password" autoComplete="current-password" required maxLength={256}
          value={current} disabled={change.isPending} onChange={event => setCurrent(event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={72}
          value={password} disabled={change.isPending} onChange={event => setPassword(event.target.value)} />
        <p className="text-xs text-muted-foreground">Use at least 8 characters and choose a different password.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm new password</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} maxLength={72}
          value={confirm} disabled={change.isPending} onChange={event => setConfirm(event.target.value)} />
      </div>
      {(validation || change.isError) && <p role="alert" className="text-sm text-destructive">
        {validation || errorMessage(change.error, "Could not change your password. Please try again.")}
      </p>}
      <Button type="submit" className="w-full" disabled={change.isPending || !current || !password || !confirm}>
        {change.isPending ? "Updating password…" : required ? "Set password and continue" : "Update password"}
      </Button>
    </form>
  );
}
