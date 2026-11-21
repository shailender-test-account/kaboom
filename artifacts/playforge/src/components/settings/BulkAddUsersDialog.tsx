import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTeamAccessQueryKey, useAddTeamMembersBulk, useListClients, type TeamMemberCreated } from "@workspace/api-client-react";
import { SECTIONS, type AccessLevel, type SectionKey } from "@workspace/api-zod";
import { Download, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errorMessage, fillMatrix, toPermissions } from "./teamAccessModel";
import { downloadUserCsv, parseBulkUserRows, parseUserCsv } from "./bulkUsers";
import TemporaryPasswordLifetime from "./TemporaryPasswordLifetime";

type Matrix = Record<SectionKey, AccessLevel>;
type AccessFields = {
  matrix: Matrix; setMatrix: (value: Matrix) => void;
  clientIds: number[] | null; setClientIds: (value: number[] | null) => void; disabled: boolean;
};

export default function BulkAddUsersDialog({ open, onOpenChange, existingEmails, renderAccess }: {
  open: boolean; onOpenChange: (value: boolean) => void; existingEmails: string[];
  renderAccess: (fields: AccessFields) => ReactNode;
}) {
  const qc = useQueryClient();
  // Credentials are never persisted to storage or retained in the mutation cache.
  const create = useAddTeamMembersBulk({ mutation: { gcTime: 0, retry: false } });
  const { data: clients } = useListClients();
  const [text, setText] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "manager">("viewer");
  const [hours, setHours] = useState(72);
  const [matrix, setMatrix] = useState<Matrix>(fillMatrix("none"));
  const [clientIds, setClientIds] = useState<number[] | null>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [results, setResults] = useState<TeamMemberCreated[] | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const busy = reading || create.isPending;
  useEffect(() => {
    if (!create.isPending && !results) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [create.isPending, results]);
  const preview = useMemo(() => {
    if (!text.trim()) return { rows: [], error: "" };
    try { return { rows: parseUserCsv(text, existingEmails), error: "" }; }
    catch (err) { return { rows: [], error: (err as Error).message }; }
  }, [text, existingEmails]);
  const valid = preview.rows.length > 0 && !preview.error && preview.rows.every(row => !row.errors.length);
  const clientLabel = clientIds === null ? "All clients (unrestricted)" : clientIds.length
    ? clientIds.map(id => clients?.find(client => client.id === id)?.name ?? `Client ${id}`).join(", ") : "No client data access";
  const rights = SECTIONS.filter(([key]) => matrix[key] !== "none").map(([key, name]) => `${name}: ${matrix[key]}`).join(" · ") || "No sections";

  const close = (value: boolean) => {
    if (busy) return;
    if (!value && results) { setConfirmDiscard(true); return; }
    onOpenChange(value);
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError(""); setReading(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("Use a file smaller than 2 MB.");
      if (/\.csv$/i.test(file.name)) {
        const csv = await file.text();
        parseUserCsv(csv, existingEmails);
        setText(csv);
      } else if (/\.xlsx$/i.test(file.name)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", sheetRows: 52 });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet) throw new Error("The workbook has no worksheet.");
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: "A1:Z52", defval: "", blankrows: false, raw: false });
        const parsed = parseBulkUserRows(rows, existingEmails);
        const invalid = parsed.find(row => row.errors.length);
        if (invalid) throw new Error(`Row ${invalid.rowNumber}: ${invalid.errors.join(" ")}`);
        const Papa = (await import("papaparse")).default;
        setText(Papa.unparse([["first_name", "last_name", "email"], ...parsed.map(row => [row.firstName, row.lastName, row.email])]));
      } else throw new Error("Choose a CSV or XLSX file.");
    } catch (err) {
      setText(""); setError((err as Error).message);
    } finally { setReading(false); }
  };
  const submit = async () => {
    setConfirm(false); setError("");
    try {
      const created = await create.mutateAsync({ data: {
        users: preview.rows.map(({ firstName, lastName, email }) => ({ firstName, lastName, email })),
        role, clientIds, sectionPermissions: toPermissions(matrix),
        temporaryPasswordHours: hours,
      } });
      setResults(created); setText("");
      void qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
    } catch (err) {
      setError(`${errorMessage(err, "Could not confirm creation.")} Refresh the team list before retrying. If accounts were created but passwords were not received, reset their passwords individually.`);
      void qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
    } finally { create.reset(); }
  };

  return <>
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-3xl max-h-[92dvh] overflow-y-auto" data-testid="bulk-users-dialog"
        onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
        onInteractOutside={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{results ? `${results.length} users created` : "Add users in bulk"}</DialogTitle>
          <DialogDescription>{results
            ? "Save these temporary passwords now. They are shown only in this session. Share them securely; no invitation emails were sent."
            : "Upload CSV/Excel or paste CSV for up to 50 users. One role, client selection and section-access policy applies to the whole batch. Use Add user for administrators."}</DialogDescription>
        </DialogHeader>
        {results ? <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowPasswords(value => !value)}>{showPasswords ? "Hide passwords" : "Show passwords"}</Button>
            <Button data-testid="download-bulk-credentials" onClick={() => downloadUserCsv("new-user-credentials.csv", [
              ["First name", "Last name", "Email", "Temporary password", "Expires at (UTC)"],
              ...results.map(({ user, tempPassword }) => [user.firstName, user.lastName, user.email, tempPassword, user.temporaryPasswordExpiresAt ?? "Not tracked"]),
            ])}><Download className="w-4 h-4 mr-1" />Download credentials</Button>
          </div>
          <div className="max-h-80 overflow-auto border rounded-lg"><table className="w-full text-sm">
            <thead><tr className="bg-muted text-left"><th className="p-2">User</th><th className="p-2">Email</th><th className="p-2">Temporary password</th></tr></thead>
            <tbody>{results.map(({ user, tempPassword }) => <tr key={user.id} className="border-t">
              <td className="p-2">{user.firstName} {user.lastName}</td><td className="p-2">{user.email}</td>
              <td className="p-2 font-mono whitespace-nowrap">{showPasswords ? tempPassword : "••••••••••••"}
                <p className="text-xs font-sans text-muted-foreground">Expires {user.temporaryPasswordExpiresAt ? new Date(user.temporaryPasswordExpiresAt).toLocaleString() : "not tracked"}</p>
              </td>
            </tr>)}</tbody>
          </table></div>
        </div> : <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => downloadUserCsv("users-template.csv", [
              ["first_name", "last_name", "email"], ["Sample", "User", "sample@example.com"],
            ])}><Download className="w-4 h-4 mr-1" />Download template</Button>
            <Label className="text-xs text-muted-foreground" htmlFor="bulk-user-file">CSV or Excel (first worksheet)</Label>
            <Input id="bulk-user-file" type="file" accept=".csv,.xlsx" className="sm:max-w-xs" disabled={busy}
              onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} />
          </div>
          <div className="space-y-1.5"><Label htmlFor="bulk-user-csv">Or paste CSV</Label>
            <textarea id="bulk-user-csv" data-testid="bulk-user-csv" value={text} maxLength={100000} rows={5} disabled={busy}
              placeholder={"first_name,last_name,email\nFirst,Last,user@example.com"}
              onChange={event => { setText(event.target.value); setError(""); }}
              className="w-full rounded-md border bg-background p-3 text-xs font-mono" />
          </div>
          {reading && <p className="text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Reading file…</p>}
          {(error || preview.error) && <p role="alert" className="text-sm text-destructive">{error || preview.error}</p>}
          {preview.rows.length > 0 && <div className="border rounded-lg max-h-64 overflow-auto" data-testid="bulk-user-preview">
            <table className="w-full text-sm"><thead className="bg-muted text-left"><tr><th className="p-2">Row</th><th className="p-2">Name</th><th className="p-2">Email</th><th className="p-2">Check</th></tr></thead>
              <tbody>{preview.rows.map(row => <tr key={row.rowNumber} className="border-t"><td className="p-2">{row.rowNumber}</td><td className="p-2">{row.firstName} {row.lastName}</td>
                <td className="p-2 break-all">{row.email}</td><td className={`p-2 text-xs ${row.errors.length ? "text-destructive" : "text-emerald-700"}`}>{row.errors.join(" ") || "Ready"}</td></tr>)}</tbody>
            </table>
          </div>}
          <div className="space-y-1.5"><Label htmlFor="bulk-user-role">Role for all users</Label>
            <select id="bulk-user-role" className="h-9 rounded-md border bg-background px-3 w-full" value={role}
              disabled={busy} onChange={event => setRole(event.target.value as typeof role)}>
              {(["viewer", "editor", "manager"] as const).map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
          </div>
          <TemporaryPasswordLifetime id="bulk-lifetime" value={hours} onChange={setHours} disabled={busy} />
          {renderAccess({ matrix, setMatrix, clientIds, setClientIds, disabled: busy })}
        </div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>{results ? "Close" : "Cancel"}</Button>
          {!results && <Button data-testid="bulk-users-review" onClick={() => setConfirm(true)} disabled={!valid || busy}>
            {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Users className="w-4 h-4 mr-1" />}
            Review {preview.rows.length || ""} users
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Create {preview.rows.length} users?</AlertDialogTitle>
        <AlertDialogDescription asChild><div className="space-y-2 text-sm">
          <p>Role: {role}. Clients: {clientLabel}.</p><p className="max-h-40 overflow-y-auto">Section access: {rights}.</p>
          <p>All users are created together, or none if validation fails. Existing users are never overwritten. No emails or outreach will be sent.</p>
        </div></AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Back</AlertDialogCancel><AlertDialogAction data-testid="bulk-users-confirm" disabled={!valid || busy} onClick={() => void submit()}>Create users</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
    <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Close the password list?</AlertDialogTitle><AlertDialogDescription>
        Download or securely save the passwords first. They cannot be retrieved after closing; an administrator would need to reset them.
      </AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Keep open</AlertDialogCancel><AlertDialogAction onClick={() => { setResults(null); create.reset(); onOpenChange(false); }}>Close and clear</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
