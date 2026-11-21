import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLogoutAllDevices } from "@workspace/api-client-react";
import { useAuthContext } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "./teamAccessModel";

export function SignOutAllDevicesForm({ onCancel }: { onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const queryClient = useQueryClient();
  const { refetch } = useAuthContext();
  const { toast } = useToast();
  const revoke = useLogoutAllDevices({ mutation: { gcTime: 0 } });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password || !confirmed || revoke.isPending) return;
    try {
      await revoke.mutateAsync({ data: { currentPassword: password, confirm: true } });
      setPassword("");
      revoke.reset();
      // Discard user-scoped data and credentials before showing the login page.
      await queryClient.cancelQueries();
      queryClient.clear();
      toast({ title: "Signed out of every device", description: "Sign in again with your existing password." });
      await refetch();
    } catch { /* Keep the confirmation available and show the request error. */ }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Sign out every browser and device, including this one. Your password will not change.
        Other users will stay signed in.
      </p>
      <div className="space-y-2">
        <Label htmlFor="sign-out-all-password">Current password</Label>
        <Input id="sign-out-all-password" type="password" autoComplete="current-password" required maxLength={256}
          value={password} disabled={revoke.isPending} onChange={event => setPassword(event.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={confirmed} disabled={revoke.isPending}
          onChange={event => setConfirmed(event.target.checked)} />
        I understand that I will also be signed out of this device.
      </label>
      {revoke.isError && <p role="alert" className="text-sm text-destructive">
        {errorMessage(revoke.error, "Could not sign out every device. Please try again.")}
      </p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={revoke.isPending} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={!password || !confirmed || revoke.isPending}>
          {revoke.isPending ? "Signing out…" : "Sign out all devices"}
        </Button>
      </div>
    </form>
  );
}
