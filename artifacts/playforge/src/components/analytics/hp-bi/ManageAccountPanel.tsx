import { useState } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useHpAccountManagement, useManageHpAccount, type ManagementAction, type ManagedContact } from "./manage-api";
import type { HpBiDetail } from "./types";
import { Chip, ErrorBox, Skel } from "./ui";
import { canAccess } from "@workspace/api-zod";

const inp = "w-full rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40 disabled:opacity-60";
const lab = "text-[10.5px] uppercase tracking-wider font-semibold text-[#5d7388]";
const btn = "rounded text-xs font-semibold px-3 py-1.5 disabled:opacity-50";
const FIELDS = ["firstName", "lastName", "email", "phone", "title", "city", "country"] as const;
type Draft = Record<(typeof FIELDS)[number], string> & { dnc: boolean };
const toDraft = (c: ManagedContact): Draft => ({ firstName: c.firstName ?? "", lastName: c.lastName ?? "", email: c.email ?? "", phone: c.phone ?? "", title: c.title ?? "", city: c.city ?? "", country: c.country ?? "", dnc: !!c.dnc });
const ACTIVE = ["active", "paused"];

interface Confirm { title: string; body: string; label: string; run: () => ManagementAction; success: string; after?: () => void }

type RoutingAccount = { contacts: Pick<HpBiDetail["contacts"][number], "id" | "companyId" | "name">[]; members: { id: number; name: string }[] };
export default function ManageAccountPanel({ d, clientId, routingOnly = false }: { d: RoutingAccount; clientId: number; routingOnly?: boolean }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const canEdit = !!user && canAccess(user, "analytics", true);
  const canJourney = canEdit && !!user && canAccess(user, "journeys", true);
  const canSequence = canEdit && !!user && canAccess(user, "sequences", true);
  const canOpportunity = canEdit && !!user && canAccess(user, "deals", true);
  const [sel, setSel] = useState<number | null>(d.contacts[0]?.id ?? null);
  const contact = sel === null ? d.contacts[0] : d.contacts.find(c => c.id === sel);
  const accountId = contact?.companyId;
  const q = useHpAccountManagement(clientId, accountId, contact?.id);
  const mut = useManageHpAccount();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [jid, setJid] = useState("");
  const [sid, setSid] = useState("");
  const [did, setDid] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const data = q.data;
  const person = data?.contact;
  const inactive = !!person && (person.dnc || person.status !== "active");
  const memberName = (id: number) => d.members.find(m => m.id === id)?.name ?? "Account";

  const changeContact = (id: number) => { setSel(id); setEditing(false); setDraft(null); setJid(""); setSid(""); setDid(""); setConfirm(null); setErr(null); };
  const startEdit = () => { if (!person) return; const initial = toDraft(person); setDraft(initial); setBaseline(initial); setEditing(true); setErr(null); };
  const run = (c: Confirm) => {
    if (!contact || !accountId) return;
    setErr(null);
    mut.mutate({ ...c.run(), clientId, accountId, contactId: contact.id }, {
      onSuccess: () => { toast({ title: c.success }); setConfirm(null); c.after?.(); },
      onError: e => { setConfirm(null); setErr((e as Error).message); toast({ title: "Action not completed", description: (e as Error).message, variant: "destructive" }); },
    });
  };
  const save = () => {
    if (!draft || !person || !baseline) return;
    const values: NonNullable<ManagementAction["values"]> = {};
    for (const k of FIELDS) {
      const value = draft[k].trim();
      if (value === baseline[k].trim()) continue;
      if (k === "firstName" || k === "email") values[k] = value;
      else values[k] = value || null;
    }
    if (draft.dnc !== baseline.dnc) values.dnc = draft.dnc;
    if (!Object.keys(values).length) return;
    run({ title: "", body: "", label: "", run: () => ({ action: "update-contact", values } as ManagementAction), success: "Contact saved", after: () => { setEditing(false); setDraft(null); } });
  };
  const busy = mut.isPending;
  const ro = !canEdit;
  const hasEdits = !!draft && !!baseline && (draft.dnc !== baseline.dnc || FIELDS.some(k => draft[k].trim() !== baseline[k].trim()));
  const invalidRequiredEdit = !!draft && !!baseline &&
    ((draft.firstName.trim() !== baseline.firstName.trim() && !draft.firstName.trim()) ||
     (draft.email.trim() !== baseline.email.trim() && !draft.email.trim()));

  return (
    <div className="space-y-4" data-testid="manage-account-panel">
      {!canEdit && <p className="rounded border border-[#d5e0ea] bg-white p-2 text-xs text-[#5d7388]" data-testid="text-manage-readonly">Read-only: your role cannot change contacts, journeys or sequences. Admin, manager or editor access is required.</p>}
      {!contact ? (
        <div className="rounded border border-dashed border-[#c5d3df] bg-white p-4 text-xs text-[#41586e]" data-testid="empty-manage-contacts">
          <p className="font-semibold text-[#0B2A4A]">{d.contacts.length ? "Selected contact is no longer linked" : "No contacts on this account"}</p>
          <p className="mt-1">{d.contacts.length ? "Choose another contact before continuing. Unsaved edits have not been applied to anyone else." : "There is no one to manage yet. Add or import contacts and link them to a member account in CRM."}</p>
          {d.contacts.length > 0 && <button className={`${btn} mt-2 border border-[#c5d3df]`} disabled={busy} onClick={() => changeContact(d.contacts[0].id)}>Select another contact</button>}
          <Link href="/crm/contacts" className="mt-2 inline-block text-[#0096D6] font-semibold underline" data-testid="link-crm-contacts">Open CRM contacts</Link>
        </div>
      ) : (<>
        <div className="flex items-end gap-2">
          <label className="flex-1 min-w-0"><span className={lab}>Contact</span>
            <select data-testid="select-manage-contact" className={inp} value={contact.id} disabled={busy} onChange={e => changeContact(Number(e.target.value))}>
              {d.contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({memberName(c.companyId)})</option>)}</select></label>
          <Link href={`/crm/contacts/${contact.id}`} className={`${btn} border border-[#c5d3df] bg-white text-[#0B2A4A]`} data-testid="link-open-managed-contact">Open contact</Link>
        </div>
        <p className="text-[11px] text-[#5d7388]" data-testid="text-manage-legal-account">Legal account: {memberName(contact.companyId)}. Changes apply in this account context.</p>
        {err && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-testid="text-manage-error">{err}</div>}
        {q.isLoading && <div className="space-y-2"><Skel className="h-24" /><Skel className="h-24" /></div>}
        {q.isError && <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />}
        {data && person && (<>
          {!routingOnly && <div className="rounded border border-[#d5e0ea] bg-white p-3 space-y-2" data-testid="section-managed-contact">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[#0B2A4A]">{person.firstName} {person.lastName ?? ""} {person.dnc && <Chip tone="hot">DNC</Chip>} <Chip tone={inactive && !person.dnc ? "amber" : "teal"}>{person.status}</Chip></div>
              {!editing && <button className={`${btn} bg-[#0B2A4A] text-white`} data-testid="button-edit-managed-contact" disabled={ro || busy || !user || !canAccess(user, "contacts", true)} onClick={startEdit}>Edit</button>}
            </div>
            {editing && draft ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FIELDS.map(k => (
                  <label key={k}><span className={lab}>{k.replace(/([A-Z])/g, " $1")}</span>
                    <input data-testid={`input-managed-${k}`} className={inp} value={draft[k]} disabled={busy} type={k === "email" ? "email" : "text"} onChange={e => setDraft(p => p && { ...p, [k]: e.target.value })} /></label>))}
                <label className="sm:col-span-2 flex items-center gap-2 text-xs"><input type="checkbox" data-testid="checkbox-managed-dnc" checked={draft.dnc} disabled={busy} onChange={e => setDraft(p => p && { ...p, dnc: e.target.checked })} /> Do not contact (DNC)</label>
                <div className="sm:col-span-2 flex gap-2">
                  <button className={`${btn} bg-[#0096D6] text-white`} data-testid="button-save-managed-contact" disabled={busy || !hasEdits || invalidRequiredEdit} onClick={save}>{busy ? "Saving" : "Save contact"}</button>
                  <button className={`${btn} border border-[#c5d3df] bg-white`} data-testid="button-cancel-edit-managed-contact" disabled={busy} onClick={() => { setEditing(false); setDraft(null); }}>Discard</button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-[#41586e]" data-testid="list-managed-contact-values">
                {FIELDS.map(k => <div key={k} className="min-w-0"><dt className={lab}>{k.replace(/([A-Z])/g, " $1")}</dt><dd className="truncate">{person[k] || "Not set"}</dd></div>)}
              </dl>)}
            <p className="text-[11px] text-[#5d7388]">Ownership and scores are not editable here.</p>
          </div>}

          <div className="rounded border border-[#d5e0ea] bg-white p-3 space-y-2" data-testid="section-managed-journeys">
            <h5 className={lab}>Journeys</h5>
            {data.journeys.length === 0 ? <p className="text-xs text-[#5d7388]" data-testid="text-no-journeys">Not in any journey.</p> :
              <ul className="divide-y divide-[#e3ebf2] text-xs">{data.journeys.map(j => (
                <li key={j.id} className="py-1.5 flex flex-wrap items-center justify-between gap-2" data-testid={`row-managed-journey-${j.id}`}>
                  <div className="min-w-0"><span className="font-medium">{j.name}</span> <Chip>{j.status}</Chip>
                    <div className="text-[11px] text-[#5d7388]">{j.removable ? `Added via ${j.addedVia}` : `Inherited via ${j.addedVia}. Membership comes from a rule or segment, so it cannot be removed here; change the rule or segment instead.`}</div></div>
                  <div className="flex gap-2">
                    <Link href={`/journeys/${j.id}`} className="text-[#0096D6] font-semibold underline" data-testid={`link-journey-${j.id}`}>Open / edit</Link>
                    {j.removable && <button className="text-[#a8400f] font-semibold underline disabled:opacity-50" data-testid={`button-remove-journey-${j.id}`} disabled={!canJourney || busy}
                      onClick={() => setConfirm({ title: "Remove from journey", body: `Remove this contact from "${j.name}"? Only this manual assignment is removed.`, label: "Remove", success: "Removed from journey", run: () => ({ action: "remove-journey", journeyId: j.id } as ManagementAction) })}>Remove</button>}
                  </div></li>))}</ul>}
            <div className="flex gap-2 pt-1">
              <select aria-label="HP journey" data-testid="select-manage-journey" className={inp} value={jid} disabled={!canJourney || busy || inactive} onChange={e => setJid(e.target.value)}>
                <option value="">{data.journeyOptions.length ? "Add to HP journey" : "No HP journeys available"}</option>
                {data.journeyOptions.filter(o => !data.journeys.some(j => j.id === o.id)).map(o => <option key={o.id} value={o.id}>{o.name} ({o.status})</option>)}</select>
              <button className={`${btn} bg-[#0096D6] text-white`} data-testid="button-add-managed-journey" disabled={!canJourney || busy || !jid || inactive}
                onClick={() => run({ title: "", body: "", label: "", success: "Added to journey", run: () => ({ action: "add-journey", journeyId: Number(jid) } as ManagementAction), after: () => setJid("") })}>{busy ? "Working" : "Add"}</button>
            </div>
          </div>

          <div className="rounded border border-[#d5e0ea] bg-white p-3 space-y-2" data-testid="section-managed-sequences">
            <h5 className={lab}>Sequences</h5>
            {data.enrollments.length === 0 ? <p className="text-xs text-[#5d7388]" data-testid="text-no-enrollments">No sequence history.</p> :
              <ul className="divide-y divide-[#e3ebf2] text-xs">{data.enrollments.map(en => (
                <li key={en.id} className="py-1.5 flex flex-wrap items-center justify-between gap-2" data-testid={`row-managed-enrollment-${en.id}`}>
                  <div className="min-w-0"><span className="font-medium">{en.sequenceName}</span> <Chip tone={en.status === "active" ? "teal" : en.status === "paused" ? "amber" : "gray"}>{en.status}</Chip>
                    <div className="text-[11px] text-[#5d7388]">Enrolled {new Date(en.enrolledAt).toLocaleDateString()}</div></div>
                  <div className="flex gap-2">
                    <Link href={`/sequences/${en.sequenceId}`} className="text-[#0096D6] font-semibold underline" data-testid={`link-sequence-${en.sequenceId}`}>Open / edit</Link>
                    {ACTIVE.includes(en.status) && <button className="text-[#a8400f] font-semibold underline disabled:opacity-50" data-testid={`button-cancel-enrollment-${en.id}`} disabled={!canSequence || busy}
                      onClick={() => setConfirm({ title: "Cancel enrollment", body: `Cancel enrollment in "${en.sequenceName}"? This stops future steps. Messages already sent are not recalled.`, label: "Cancel enrollment", success: "Enrollment cancelled", run: () => ({ action: "cancel-sequence", enrollmentId: en.id } as ManagementAction) })}>Cancel</button>}
                  </div></li>))}</ul>}
            {data.sequenceOptions.length === 0 ? <p className="text-xs text-[#5d7388]" data-testid="text-no-sequence-options">No active sequences are available. Link a sequence to an HP play or routing rule to make it appear here.</p> : (
              <div className="flex gap-2 pt-1">
                <select aria-label="Active sequence" data-testid="select-manage-sequence" className={inp} value={sid} disabled={!canSequence || busy || inactive} onChange={e => setSid(e.target.value)}>
                  <option value="">Enroll in active sequence</option>
                  {data.sequenceOptions.filter(o => o.status === "active" && !data.enrollments.some(e => e.sequenceId === o.id && ["active", "paused", "completed"].includes(e.status))).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                <button className={`${btn} bg-[#0096D6] text-white`} data-testid="button-enroll-managed-sequence" disabled={!canSequence || busy || !sid || inactive}
                  onClick={() => { const o = data.sequenceOptions.find(x => x.id === Number(sid)); setConfirm({ title: "Enroll in sequence", body: `Enroll this contact in "${o?.name}"? Messages may start sending. Existing routes are not replaced.`, label: "Enroll", success: "Enrolled in sequence", run: () => ({ action: "enroll-sequence", sequenceId: Number(sid) } as ManagementAction), after: () => setSid("") }); }}>Enroll</button>
              </div>)}
            {inactive && <p className="text-[11px] text-[#a8400f]" data-testid="text-enroll-blocked">{person.dnc ? "This contact is on the DNC list" : "This contact is inactive"}, so enrollment is disabled.</p>}
          </div>

          <div className="rounded border border-[#d5e0ea] bg-white p-3 space-y-2" data-testid="section-managed-opportunities">
            <h5 className={lab}>CRM opportunities</h5>
            {(data.opportunities ?? []).map(o => <div key={o.id} className="flex flex-wrap gap-2 text-xs">
              <Link href={`/crm/deals?dealId=${o.id}`} className="font-semibold text-[#0096D6] underline">{o.title}</Link>
              <Chip>{o.stage}</Chip>{o.isPrimary && <span className="text-[#5d7388]">Primary contact</span>}
            </div>)}
            {!data.opportunities?.length && <p className="text-xs text-[#5d7388]">No linked opportunity.</p>}
            <div className="flex gap-2">
              <select aria-label="CRM opportunity" data-testid="select-manage-opportunity" className={inp} value={did} disabled={!canOpportunity || busy} onChange={e => setDid(e.target.value)}>
                <option value="">Link existing account opportunity</option>
                {(data.opportunityOptions ?? []).filter(o => !data.opportunities?.some(p => p.id === o.id)).map(o => <option key={o.id} value={o.id}>{o.title} ({o.stage})</option>)}
              </select>
              <button className={`${btn} bg-[#0096D6] text-white`} data-testid="button-link-managed-opportunity" disabled={!canOpportunity || busy || !did}
                onClick={() => run({ title: "", body: "", label: "", success: "Contact linked to opportunity", run: () => ({ action: "link-opportunity", dealId: Number(did) } as ManagementAction), after: () => setDid("") })}>Link</button>
            </div>
            {!data.opportunityOptions?.length && <p className="text-xs text-[#5d7388]">No CRM opportunities exist for this legal account. <Link href="/crm/deals" className="underline">Open opportunities</Link></p>}
            <p className="text-[11px] text-[#5d7388]">Adds a stakeholder; never replaces the primary contact or changes opportunity value or qualification.</p>
          </div>

          {confirm && (
            <div role="alertdialog" aria-label={confirm.title} className="rounded border-2 border-[#0B2A4A] bg-white p-3 space-y-2" data-testid="dialog-manage-confirm">
              <p className="text-xs font-semibold text-[#0B2A4A]">{confirm.title}</p>
              <p className="text-xs text-[#41586e]">{confirm.body}</p>
              <div className="flex gap-2">
                <button className={`${btn} bg-[#0B2A4A] text-white`} data-testid="confirm-manage-action" disabled={busy} onClick={() => run(confirm)}>{busy ? "Working" : confirm.label}</button>
                <button className={`${btn} border border-[#c5d3df] bg-white`} data-testid="button-dismiss-manage-confirm" disabled={busy} onClick={() => setConfirm(null)}>Keep as is</button>
              </div>
            </div>)}
        </>)}
      </>)}
    </div>
  );
}
