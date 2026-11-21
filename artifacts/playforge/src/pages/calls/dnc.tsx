import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { PhoneOff, Trash2, UserX, Search, ShieldCheck, Plus, MailX, X, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  auto_ai: { label: "AI inferred",   cls: "bg-amber-50 text-amber-700 border-amber-200" },
  manual:  { label: "Manual",        cls: "bg-gray-50  text-gray-600  border-gray-200"  },
};

type ContactRow = {
  id: number; firstName: string; lastName: string; email: string | null;
  phone: string | null; companyName: string | null; dnc: boolean;
  status: string; tags: string[];
};

export default function DncListPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  const { data: list = [], isLoading } = useQuery<any[]>({
    queryKey: ["dnc-list"],
    queryFn: () => api("/call-campaigns/dnc").then(r => r.json()),
  });

  const { data: contactsData, isLoading: contactsLoading } = useQuery<{ contacts: ContactRow[] }>({
    queryKey: ["contacts-for-dnc-picker", addSearch],
    queryFn: () => api(`/contacts?search=${encodeURIComponent(addSearch)}&limit=30`).then(r => r.json()),
    enabled: addOpen,
  });

  const removeMut = useMutation({
    mutationFn: (contactId: number) =>
      api(`/call-campaigns/dnc/${contactId}`, { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setRemovingId(null);
      toast({ title: "Contact removed from negative list — they can be reached again." });
    },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const addDncMut = useMutation({
    mutationFn: (contactId: number) =>
      api(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dnc: true }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contacts-for-dnc-picker"] });
      toast({ title: "Contact marked as DNC — they won't be emailed or called." });
    },
    onError: () => toast({ title: "Failed to mark contact as DNC", variant: "destructive" }),
  });

  const removeDncMut = useMutation({
    mutationFn: (contactId: number) =>
      api(`/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dnc: false }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setRemovingId(null);
      toast({ title: "DNC removed — contact can be reached again." });
    },
    onError: () => toast({ title: "Failed to remove DNC", variant: "destructive" }),
  });

  const filtered = list.filter(row => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (row.first_name ?? "").toLowerCase().includes(q) ||
      (row.last_name  ?? "").toLowerCase().includes(q) ||
      (row.email      ?? "").toLowerCase().includes(q) ||
      (row.company_name ?? "").toLowerCase().includes(q)
    );
  });

  const pickerContacts = (contactsData?.contacts ?? []).filter(c => !c.dnc);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
              <PhoneOff className="w-4 h-4 text-red-600" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">DNC / Negative List</h1>
          </div>
          <p className="text-sm text-muted-foreground max-w-lg">
            Contacts blocked from all emails and calls. Added manually or auto-inferred from call outcomes.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            Auto-enforced on every dial &amp; email
          </div>
          <Button size="sm" className="h-8 text-xs" onClick={() => { setAddOpen(true); setAddSearch(""); }}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add contact
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          className="pl-9 h-8 text-sm"
          placeholder="Search contacts…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">Loading…</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 flex flex-col items-center gap-3">
            <UserX className="w-10 h-10 text-muted-foreground/20" />
            <p className="text-sm font-medium">
              {list.length === 0 ? "Negative list is empty" : "No contacts match your search"}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              {list.length === 0
                ? "Add contacts manually using the button above, or they'll be added automatically when they opt out or are flagged by AI analysis."
                : "Try a different search term."}
            </p>
            {list.length === 0 && (
              <Button size="sm" variant="outline" className="mt-1" onClick={() => { setAddOpen(true); setAddSearch(""); }}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add contact manually
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-card">
          {/* Stats bar */}
          <div className="bg-muted/40 border-b px-4 py-2 flex items-center gap-4">
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{list.length}</span> contact{list.length !== 1 ? "s" : ""} blocked
            </span>
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {list.filter(r => r.source === "auto_ai").length}
              </span> AI-inferred
            </span>
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {list.filter(r => r.source === "manual").length}
              </span> manual
            </span>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Contact</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Company</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Reason</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Source</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Blocks</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2 px-4">Added</th>
                <th className="py-2 px-4 w-12" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row: any) => {
                const src = SOURCE_LABEL[row.source] ?? SOURCE_LABEL.manual;
                return (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 group">
                    <td className="py-2.5 px-4">
                      <p className="text-sm font-medium">{row.first_name} {row.last_name}</p>
                      <p className="text-xs text-muted-foreground">{row.email ?? row.phone ?? "—"}</p>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-muted-foreground">{row.company_name ?? "—"}</td>
                    <td className="py-2.5 px-4 text-xs text-muted-foreground max-w-[240px]">
                      <span title={row.reason ?? "—"} className="line-clamp-2 leading-snug">
                        {row.reason ?? "—"}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <Badge variant="outline" className={cn("text-[10px] h-4 px-1.5", src.cls)}>
                        {src.label}
                      </Badge>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-red-50 text-red-700 border-red-200">
                          <PhoneOff className="w-2 h-2 mr-0.5" />Calls
                        </Badge>
                        <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-orange-50 text-orange-700 border-orange-200">
                          <MailX className="w-2 h-2 mr-0.5" />Email
                        </Badge>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-muted-foreground whitespace-nowrap">
                      {row.added_at
                        ? formatDistanceToNow(new Date(row.added_at), { addSuffix: true })
                        : "—"}
                    </td>
                    <td className="py-2.5 px-4">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                        title="Remove from negative list"
                        onClick={() => setRemovingId(row.contact_id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Remove confirm */}
      <AlertDialog open={removingId !== null} onOpenChange={() => setRemovingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from negative list?</AlertDialogTitle>
            <AlertDialogDescription>
              This contact will be allowed to receive emails and calls again. They can be re-added automatically if future signals trigger the same rules.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removingId === null) return;
                removeDncMut.mutate(removingId);
                removeMut.mutate(removingId);
              }}
              disabled={removeMut.isPending || removeDncMut.isPending}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add contact dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneOff className="w-4 h-4 text-red-600" />
              Add contact to DNC list
            </DialogTitle>
            <DialogDescription>
              Search for a contact to block from all emails and calls.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                className="pl-9 h-9 text-sm"
                placeholder="Search by name, email or company…"
                value={addSearch}
                onChange={e => setAddSearch(e.target.value)}
                autoFocus
              />
              {addSearch && (
                <button
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setAddSearch("")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="border rounded-md overflow-hidden max-h-72 overflow-y-auto">
              {contactsLoading ? (
                <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…
                </div>
              ) : pickerContacts.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {addSearch ? "No contacts found" : "Type to search contacts"}
                </div>
              ) : (
                pickerContacts.map(c => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between px-3 py-2.5 hover:bg-muted/50 border-b last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{c.firstName} {c.lastName}</p>
                      <p className="text-xs text-muted-foreground truncate">{c.email ?? c.phone ?? "—"} · {c.companyName ?? "No company"}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-3 h-7 text-xs text-red-700 border-red-300 hover:bg-red-50 shrink-0"
                      disabled={addDncMut.isPending}
                      onClick={() => addDncMut.mutate(c.id)}
                    >
                      <PhoneOff className="w-3 h-3 mr-1" />
                      Mark DNC
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
