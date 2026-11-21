import { Label } from "@/components/ui/label";

export default function TemporaryPasswordLifetime({ id, value, onChange, disabled }: {
  id: string; value: number; onChange: (hours: number) => void; disabled?: boolean;
}) {
  return <div className="space-y-1.5">
    <Label htmlFor={id}>Temporary password expires after</Label>
    <select id={id} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}
      className="h-9 rounded-md border bg-background px-3 w-full">
      {[1, 24, 72, 168].map(hours => <option key={hours} value={hours}>{hours} hours{hours === 72 ? " (default)" : ""}</option>)}
    </select>
    <p className="text-xs text-muted-foreground">The user must choose a personal password before this deadline. No email is sent.</p>
  </div>;
}
