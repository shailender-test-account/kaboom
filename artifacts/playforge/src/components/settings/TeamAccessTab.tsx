import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTeamAccess, useListClients, useAddTeamMember, useUpdateTeamAccess, useUpdateTeamProfile,
  getListTeamAccessQueryKey,
} from "@workspace/api-client-react";
import type { TeamMember } from "@workspace/api-client-react";
import BulkAddUsersDialog from "./BulkAddUsersDialog";
import WelcomeEmailsDialog from "./WelcomeEmailsDialog";
import DeleteMemberDialog from "./DeleteMemberDialog";
import SalesUserVisibility from "./SalesUserVisibility";
import TenantSalesAccessHistory from "./TenantSalesAccessHistory";
import TemporaryPasswordLifetime from "./TemporaryPasswordLifetime";
import ReissueTemporaryPasswordDialog from "./ReissueTemporaryPasswordDialog";
import { SECTIONS } from "@workspace/api-zod";
import type { AccessLevel, SectionKey } from "@workspace/api-zod";
import {
  Shield, UserPlus, Loader2, Copy, CheckCheck, Pencil, AlertTriangle, Lock, RefreshCw, X, KeyRound, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  ROLES, LEVELS, resolveMatrix, toPermissions, fillMatrix, errorMessage, sameMatrix,
} from "./teamAccessModel";
import type { Role } from "./teamAccessModel";

type Matrix = Record<SectionKey, AccessLevel>;
type IssuedCredential = { email: string; tempPassword: string; expiresAt?: string | null };

const ROLE_STYLE: Record<string, string> = {
  admin: "bg-indigo-100 text-indigo-700 border-indigo-200",
  manager: "bg-sky-100 text-sky-700 border-sky-200",
  editor: "bg-emerald-100 text-emerald-700 border-emerald-200",
  viewer: "bg-slate-100 text-slate-700 border-slate-200",
};
const LEVEL_LABEL: Record<AccessLevel, string> = { none: "None", view: "View", manage: "Manage" };

function initials(m: { firstName: string; lastName: string; email: string }) {
  return ((m.firstName?.[0] ?? "") + (m.lastName?.[0] ?? "")).toUpperCase() || m.email[0]?.toUpperCase() || "?";
}

// ── Access matrix ────────────────────────────────────────────────────────────
function AccessMatrix({ matrix, onChange, disabled }: { matrix: Matrix; onChange: (m: Matrix) => void; disabled?: boolean }) {
  return (
    <div className="rounded-lg border overflow-hidden" data-testid="matrix-access">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 border-b">
        <span className="text-xs font-medium text-muted-foreground">Section access</span>
        <div className="flex gap-1">
          {LEVELS.map(l => (
            <Button key={l} type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
              disabled={disabled} onClick={() => onChange(fillMatrix(l))} data-testid={`button-all-${l}`}>
              All {LEVEL_LABEL[l]}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 max-h-[320px] overflow-y-auto">
        {SECTIONS.map(([key, label]) => (
          <div key={key} role="radiogroup" aria-label={`${label} access`}
            className="flex items-center justify-between gap-2 px-3 py-1.5 sm:border-b sm:odd:border-r">
            <span className="text-xs truncate" title={label}>{label}</span>
            <div className="inline-flex rounded-md border bg-muted/30 p-0.5 shrink-0">
              {LEVELS.map(l => {
                const active = matrix[key] === l;
                return (
                  <button key={l} type="button" role="radio" aria-checked={active} disabled={disabled}
                    aria-label={`${label}: ${LEVEL_LABEL[l]}`}
                    onClick={() => onChange({ ...matrix, [key]: l })}
                    data-testid={`radio-${key}-${l}`}
                    className={cn(
                      "px-2 py-0.5 text-[11px] rounded transition-colors disabled:opacity-50",
                      active
                        ? l === "manage" ? "bg-indigo-600 text-white" : l === "view" ? "bg-sky-100 text-sky-800" : "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}>
                    {LEVEL_LABEL[l]}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="px-3 py-2 text-[11px] text-muted-foreground border-t">
        For pages that use related client or contact selectors, also allow View for those sections. Sensitive administration, integration credentials and buying-committee CSV exports still require an admin.
      </p>
      <p className="px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/20 flex items-center gap-1.5">
        <Lock className="w-3 h-3 shrink-0" />
        Manage on Settings covers integrations and configuration only. Team and user management is always limited to admins.
      </p>
    </div>
  );
}

function RoleField({ value, onChange, id }: { value: Role; onChange: (r: Role) => void; id: string }) {
  return (
    <Select value={value} onValueChange={v => onChange(v as Role)}>
      <SelectTrigger id={id} data-testid={`select-${id}`}><SelectValue /></SelectTrigger>
      <SelectContent>
        {ROLES.map(r => <SelectItem key={r} value={r} className="capitalize">{r[0].toUpperCase() + r.slice(1)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function AdminNote() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 flex gap-2">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>Admins have full access to every section and can add users, change roles and manage workspace settings. The section matrix does not apply to them.</span>
    </div>
  );
}

function ClientAccessPicker({ value, onChange, disabled }: {
  value: number[] | null; onChange: (ids: number[] | null) => void; disabled?: boolean;
}) {
  const { data: clients, isLoading, isError } = useListClients();
  return (
    <fieldset className="rounded-lg border p-3 space-y-2" disabled={disabled} data-testid="client-access-picker">
      <legend className="px-1 text-xs font-medium">Client access</legend>
      <p className="text-xs text-muted-foreground">Only selected clients will be visible. Shared items and workspace-wide pages are unavailable to restricted users.</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === null} onChange={e => onChange(e.target.checked ? null : [])} />
        All clients (unrestricted)
      </label>
      {isLoading && <p className="text-xs">Loading clients…</p>}
      {isError && <p className="text-xs text-destructive">Could not load clients. Try again before saving.</p>}
      <div className="max-h-40 overflow-y-auto grid sm:grid-cols-2 gap-2">
        {clients?.map(client => (
          <label key={client.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" aria-label={client.name} checked={value === null || value.includes(client.id)}
              disabled={value === null} onChange={e => onChange(e.target.checked
                ? [...(value ?? []), client.id] : (value ?? []).filter(id => id !== client.id))} />
            <span className="truncate" title={client.name}>{client.name}</span>
          </label>
        ))}
      </div>
      {value?.length === 0 && <p className="text-xs text-amber-700">No clients selected: this user will have no client data access.</p>}
    </fieldset>
  );
}

// ── Add member dialog ────────────────────────────────────────────────────────
function AddMemberDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: (c: IssuedCredential) => void;
}) {
  const qc = useQueryClient();
  const add = useAddTeamMember({ mutation: { gcTime: 0, retry: false } });
  const [hours, setHours] = useState(72);
  const [firstName, setFirst] = useState(""); const [lastName, setLast] = useState("");
  const [email, setEmail] = useState(""); const [role, setRole] = useState<Role>("viewer");
  const [matrix, setMatrix] = useState<Matrix>(fillMatrix("none"));
  const [clientIds, setClientIds] = useState<number[] | null>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmAdmin, setConfirmAdmin] = useState(false);

  const reset = () => { setFirst(""); setLast(""); setEmail(""); setRole("viewer"); setMatrix(fillMatrix("none")); setClientIds([]); setHours(72); setError(null); add.reset(); };
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o); };
  const valid = firstName.trim() && lastName.trim() && /\S+@\S+\.\S+/.test(email.trim());

  const submit = () => {
    setError(null);
    add.mutate({ data: {
      firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), role,
      temporaryPasswordHours: hours,
      sectionPermissions: role === "admin" ? null : toPermissions(matrix),
      clientIds: role === "admin" ? null : clientIds,
    } }, {
      onSuccess: res => {
        qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
        onCreated({ email: res.user.email, tempPassword: res.tempPassword, expiresAt: res.user.temporaryPasswordExpiresAt });
        close(false);
      },
      onError: e => setError(errorMessage(e, "Could not add this user.")),
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-2xl max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
            <DialogDescription>Creates a local sign-in with a one-time temporary password. No invitation email is sent.</DialogDescription>
          </DialogHeader>
          <TemporaryPasswordLifetime id="add-lifetime" value={hours} onChange={setHours} disabled={add.isPending} />
          <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (!valid) return; role === "admin" ? setConfirmAdmin(true) : submit(); }}>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label htmlFor="add-first">First name</Label>
                <Input id="add-first" value={firstName} onChange={e => setFirst(e.target.value)} data-testid="input-add-first" /></div>
              <div className="space-y-1.5"><Label htmlFor="add-last">Last name</Label>
                <Input id="add-last" value={lastName} onChange={e => setLast(e.target.value)} data-testid="input-add-last" /></div>
              <div className="space-y-1.5"><Label htmlFor="add-email">Email</Label>
                <Input id="add-email" type="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} data-testid="input-add-email" /></div>
              <div className="space-y-1.5"><Label htmlFor="add-role">Role</Label><RoleField id="add-role" value={role} onChange={setRole} /></div>
            </div>
            {role === "admin" ? <AdminNote /> : <>
              <ClientAccessPicker value={clientIds} onChange={setClientIds} disabled={add.isPending} />
              <AccessMatrix matrix={matrix} onChange={setMatrix} disabled={add.isPending} />
            </>}
            {error && <p role="alert" className="text-sm text-destructive" data-testid="text-add-error">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" disabled={!valid || add.isPending} data-testid="button-add-submit">
                {add.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserPlus className="w-4 h-4 mr-1.5" />}
                Add user
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmAdmin} onOpenChange={setConfirmAdmin}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create a new admin?</AlertDialogTitle>
            <AlertDialogDescription>This person will have full workspace access, including adding users and changing anyone's access.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmAdmin(false); submit(); }} data-testid="button-confirm-add-admin">Create admin</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Edit member dialog ───────────────────────────────────────────────────────
function EditMemberDialog({ member, isSelf, onClose }: { member: TeamMember; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { refetch: refetchAuth } = useAuthContext();
  const profile = useUpdateTeamProfile();
  const access = useUpdateTeamAccess();

  const initialMatrix = useMemo(() => resolveMatrix(member.role === "admin" ? "manager" : member.role, member.sectionPermissions), [member]);
  const [firstName, setFirst] = useState(member.firstName); const [lastName, setLast] = useState(member.lastName);
  const [email, setEmail] = useState(member.email);
  const [role, setRole] = useState<Role>(member.role as Role);
  const [matrix, setMatrix] = useState<Matrix>(initialMatrix);
  const [clientIds, setClientIds] = useState<number[] | null>(member.clientIds ?? null);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [accessErr, setAccessErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "promote" | "demote">(null);

  const legacy = member.sectionPermissions == null && member.role !== "admin";
  const profileDirty = firstName !== member.firstName || lastName !== member.lastName || email !== member.email;
  const accessDirty = role !== member.role || (role !== "admin" && (legacy || !sameMatrix(matrix, initialMatrix)
    || JSON.stringify(clientIds?.slice().sort((a, b) => a - b) ?? null) !== JSON.stringify(member.clientIds?.slice().sort((a, b) => a - b) ?? null)));
  const profileValid = firstName.trim() && lastName.trim() && /\S+@\S+\.\S+/.test(email.trim());

  const afterSave = async () => {
    await qc.invalidateQueries({ queryKey: getListTeamAccessQueryKey() });
    if (isSelf) { await refetchAuth(); qc.invalidateQueries(); }
  };

  const saveProfile = () => {
    setProfileErr(null);
    profile.mutate({ id: member.id, data: { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() } }, {
      onSuccess: async () => { await afterSave(); toast({ title: "Profile saved" }); },
      onError: e => setProfileErr(errorMessage(e, "Could not save profile.")),
    });
  };
  const doSaveAccess = () => {
    setAccessErr(null);
    access.mutate({ id: member.id, data: { role, sectionPermissions: role === "admin" ? null : toPermissions(matrix), clientIds: role === "admin" ? null : clientIds } }, {
      onSuccess: async () => { await afterSave(); toast({ title: "Access saved" }); onClose(); },
      onError: e => setAccessErr(errorMessage(e, "Could not save access.")),
    });
  };
  const saveAccess = () => {
    if (role === "admin" && member.role !== "admin") return setConfirm("promote");
    if (member.role === "admin" && role !== "admin") return setConfirm("demote");
    doSaveAccess();
  };

  return (
    <>
      <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent className="max-w-2xl max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{member.firstName} {member.lastName}{isSelf && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}</DialogTitle>
            <DialogDescription>Profile and access are saved separately.</DialogDescription>
          </DialogHeader>

          <section className="space-y-3" aria-labelledby="edit-profile-h">
            <h3 id="edit-profile-h" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Profile</h3>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1.5"><Label htmlFor="edit-first">First name</Label>
                <Input id="edit-first" value={firstName} onChange={e => setFirst(e.target.value)} data-testid="input-edit-first" /></div>
              <div className="space-y-1.5"><Label htmlFor="edit-last">Last name</Label>
                <Input id="edit-last" value={lastName} onChange={e => setLast(e.target.value)} data-testid="input-edit-last" /></div>
              <div className="space-y-1.5"><Label htmlFor="edit-email">Email</Label>
                <Input id="edit-email" type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="input-edit-email" /></div>
            </div>
            {profileErr && <p role="alert" className="text-sm text-destructive">{profileErr}</p>}
            <div className="flex justify-end">
              <Button size="sm" variant="outline" disabled={!profileDirty || !profileValid || profile.isPending} onClick={saveProfile} data-testid="button-save-profile">
                {profile.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}Save profile
              </Button>
            </div>
          </section>

          <section className="space-y-3 border-t pt-4" aria-labelledby="edit-access-h">
            <h3 id="edit-access-h" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Access</h3>
            <div className="max-w-xs space-y-1.5"><Label htmlFor="edit-role">Role</Label><RoleField id="edit-role" value={role} onChange={setRole} /></div>
            {legacy && role !== "admin" && (
              <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
                This user currently follows legacy role defaults. Saving will store the explicit access shown below.
              </p>
            )}
            {role === "admin" ? <AdminNote /> : <>
              <ClientAccessPicker value={clientIds} onChange={setClientIds} disabled={access.isPending} />
              <AccessMatrix matrix={matrix} onChange={setMatrix} disabled={access.isPending} />
            </>}
            {accessErr && <p role="alert" className="text-sm text-destructive" data-testid="text-access-error">{accessErr}</p>}
            <SalesUserVisibility memberId={member.id} isAdmin={member.role === "admin"} />
          </section>

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button disabled={!accessDirty || access.isPending} onClick={saveAccess} data-testid="button-save-access">
              {access.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Shield className="w-4 h-4 mr-1.5" />}Save access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={o => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "promote" ? "Make this user an admin?" : isSelf ? "Remove your own admin access?" : "Remove admin access?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "promote"
                ? "Admins have full workspace access, including user management and every setting."
                : isSelf
                  ? "You will immediately lose user management and any sections not granted below. Another admin will need to restore your access."
                  : "This user will lose user management and keep only the sections granted in the matrix."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirm(null); doSaveAccess(); }} data-testid="button-confirm-access">
              {confirm === "promote" ? "Make admin" : "Remove admin"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Credentials banner ───────────────────────────────────────────────────────
function CredentialsBanner({ cred, onDismiss }: { cred: IssuedCredential; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(`Email: ${cred.email}\nTemporary password: ${cred.tempPassword}\nExpires: ${cred.expiresAt ?? "Not tracked"}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })
      .catch(() => undefined);
  };
  return (
    <div role="status" className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4" data-testid="banner-credentials">
      <div className="flex items-start gap-3">
        <KeyRound className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-sm font-medium text-indigo-900">Temporary password issued. Share these sign-in details securely.</p>
          <p className="text-xs text-indigo-800/80">No invitation email was sent. This password is shown once and cannot be retrieved after you dismiss it.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Email</dt><dd className="font-mono truncate">{cred.email}</dd>
            <dt className="text-muted-foreground">Password</dt><dd className="font-mono select-all" data-testid="text-temp-password">{cred.tempPassword}</dd>
            <dt className="text-muted-foreground">Expires</dt><dd>{cred.expiresAt ? new Date(cred.expiresAt).toLocaleString() : "Not tracked"}</dd>
          </dl>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-8" onClick={copy} data-testid="button-copy-credentials">
            {copied ? <CheckCheck className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}{copied ? "Copied" : "Copy"}
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onDismiss} aria-label="Dismiss credentials" data-testid="button-dismiss-credentials">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
function TeamAccessAdmin({ selfId }: { selfId: number | undefined }) {
  const { data: members, isLoading, isError, error, refetch, isFetching } = useListTeamAccess();
  const { data: availableClients } = useListClients();
  const [adding, setAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<TeamMember | null>(null);
  const [cred, setCred] = useState<IssuedCredential | null>(null);
  const [reissuing, setReissuing] = useState<TeamMember | null>(null);
  const editing = members?.find(m => m.id === editingId) ?? null;
  const adminCount = members?.filter(m => m.role === "admin").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Team and access</h2>
          <p className="text-sm text-muted-foreground">
            {members ? `${members.length} member${members.length === 1 ? "" : "s"} · ${adminCount} admin${adminCount === 1 ? "" : "s"}` : "Who can sign in, and what each person can see or change."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="shrink-0" onClick={() => setWelcomeOpen(true)} data-testid="button-welcome-emails">Welcome emails</Button>
          <Button variant="outline" onClick={() => setBulkAdding(true)} data-testid="button-add-users-bulk">Add users in bulk</Button>
          <Button onClick={() => setAdding(true)} data-testid="button-add-member"><UserPlus className="w-4 h-4 mr-1.5" />Add user</Button>
        </div>
      </div>

      {cred && <CredentialsBanner cred={cred} onDismiss={() => setCred(null)} />}
      {welcomeOpen && <WelcomeEmailsDialog members={members ?? []} onClose={() => setWelcomeOpen(false)} />}

      <TenantSalesAccessHistory members={members ?? []} />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y" aria-busy="true">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-muted animate-pulse" />
                  <div className="flex-1 space-y-1.5"><div className="h-3 w-40 bg-muted rounded animate-pulse" /><div className="h-2.5 w-56 bg-muted/70 rounded animate-pulse" /></div>
                </div>
              ))}
            </div>
          ) : isError ? (
            <div className="px-4 py-8 text-center space-y-3">
              <p className="text-sm text-destructive">{errorMessage(error, "Could not load the team.")}</p>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", isFetching && "animate-spin")} />Retry
              </Button>
            </div>
          ) : !members?.length ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">No team members yet. Add the first one to get started.</div>
          ) : (
            <ul className="divide-y">
              {members.map(m => {
                const matrix = resolveMatrix(m.role, m.sectionPermissions);
                const manage = SECTIONS.filter(([k]) => matrix[k] === "manage").length;
                const view = SECTIONS.filter(([k]) => matrix[k] === "view").length;
                const isSelf = m.id === selfId;
                return (
                  <li key={m.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors" data-testid={`row-member-${m.id}`}>
                    <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">{initials(m)}</div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{m.firstName} {m.lastName}{isSelf && <span className="ml-1.5 text-xs text-muted-foreground font-normal">(you)</span>}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                      {m.mustChangePassword && <p className="text-xs text-amber-700">
                        {m.temporaryPasswordExpiresAt
                          ? `${new Date(m.temporaryPasswordExpiresAt).getTime() <= Date.now() ? "Temporary password expired" : "Temporary password expires"}: ${new Date(m.temporaryPasswordExpiresAt).toLocaleString()}`
                          : "Personal password required · expiry not tracked"}
                      </p>}
                    </div>
                    <div className="text-xs text-muted-foreground w-full sm:w-48 order-last sm:order-none">
                      {m.role === "admin" ? "Full access, user management"
                        : `${m.clientIds == null ? "All clients" : m.clientIds.length
                          ? m.clientIds.map(id => availableClients?.find(c => c.id === id)?.name ?? `Client ${id}`).join(", ")
                          : "No clients"} · ${m.sectionPermissions == null ? "Legacy role defaults"
                            : `${manage} manage · ${view} view · ${SECTIONS.length - manage - view} none`}`}
                    </div>
                    <Badge variant="outline" className={cn("capitalize", ROLE_STYLE[m.role])} data-testid={`badge-role-${m.id}`}>{m.role}</Badge>
                    {m.mustChangePassword && !isSelf && <Button size="sm" variant="outline" onClick={() => { setCred(null); setReissuing(m); }}
                      data-testid={`button-reissue-${m.id}`}>Reissue password</Button>}
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditingId(m.id)} aria-label={`Edit ${m.firstName} ${m.lastName}`} data-testid={`button-edit-${m.id}`}>
                      <Pencil className="w-3.5 h-3.5 mr-1" />Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive"
                      disabled={isSelf || (m.role === "admin" && adminCount <= 1)}
                      title={isSelf ? "You cannot delete yourself" : m.role === "admin" && adminCount <= 1 ? "The last administrator cannot be deleted" : "Permanently delete this user"}
                      onClick={() => setDeleting(m)} aria-label={`Delete ${m.firstName} ${m.lastName}`}
                      data-testid={`button-delete-${m.id}`}>
                      <Trash2 className="w-3.5 h-3.5 mr-1" />Delete
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <AddMemberDialog open={adding} onOpenChange={setAdding} onCreated={setCred} />
      {reissuing && <ReissueTemporaryPasswordDialog member={reissuing} onClose={() => setReissuing(null)}
        onIssued={({ user, tempPassword }) => setCred({ email: user.email, tempPassword, expiresAt: user.temporaryPasswordExpiresAt })} />}
      {bulkAdding && <BulkAddUsersDialog open onOpenChange={setBulkAdding} existingEmails={members?.map(member => member.email) ?? []}
        renderAccess={({ matrix, setMatrix, clientIds, setClientIds, disabled }) => <>
          <ClientAccessPicker value={clientIds} onChange={setClientIds} disabled={disabled} />
          <AccessMatrix matrix={matrix} onChange={setMatrix} disabled={disabled} />
        </>} />}
      {editing && <EditMemberDialog key={editing.id} member={editing} isSelf={editing.id === selfId} onClose={() => setEditingId(null)} />}
      {deleting && <DeleteMemberDialog key={deleting.id} member={deleting} onClose={() => {
        if (editingId === deleting.id) setEditingId(null);
        if (cred?.email === deleting.email) setCred(null);
        setDeleting(null);
      }} />}
    </div>
  );
}

export function TeamAccessTab() {
  const { user } = useAuthContext();
  const u = user as { id?: number; role?: string } | null | undefined;
  if (u?.role !== "admin") {
    return (
      <Card><CardContent className="flex items-start gap-3 p-6" data-testid="notice-admin-only">
        <Lock className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium">Team and access is admin-only</p>
          <p className="text-sm text-muted-foreground">Ask a workspace admin to add users or change access.</p>
        </div>
      </CardContent></Card>
    );
  }
  return <TeamAccessAdmin selfId={u.id} />;
}

export default TeamAccessTab;
