import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Plus, ChevronRight, Globe, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/contexts/AuthContext";
import { CrmSubNav } from "./sub-nav";

const api = (path: string) => fetch(`/api${path}`, { credentials: "include" }).then(r => r.json());

type Company = {
  id: number; name: string; domain: string | null; industry: string | null;
  size: string | null; website: string | null; contactsCount: number; dealsCount: number; createdAt: string;
};

export default function CompaniesPage() {
  const [, navigate] = useLocation();
  const {user}=useAuthContext();
  const {toast}=useToast();
  const qc=useQueryClient();
  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget,setDeleteTarget]=useState<Company|null>(null);
  const [confirmName,setConfirmName]=useState("");
  const remove=useMutation({
    mutationFn:async(id:number)=>{
      const response=await fetch(`/api/companies/${id}`,{method:"DELETE",credentials:"include"});
      if(!response.ok)throw new Error((await response.json().catch(()=>null))?.error??"Deletion failed");
    },
    onSuccess:()=>{
      setDeleteTarget(null);setConfirmName("");
      qc.invalidateQueries({queryKey:["companies"]});
      qc.invalidateQueries({queryKey:["contacts"]});
      qc.invalidateQueries({queryKey:["intent"]});
      toast({title:"Company and linked history deleted"});
    },
    onError:(error:Error)=>toast({title:"Could not delete company",description:error.message,variant:"destructive"}),
  });

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ["companies"],
    queryFn: () => api("/companies"),
  });

  const filtered = companies.filter(c => {
    const q = search.toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || (c.domain ?? "").toLowerCase().includes(q);
  });

  const initials = (name: string) => name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col h-full">
      <CrmSubNav active="companies" />
      <div className="p-6 flex-1 overflow-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground tracking-tight">Companies</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{companies.length} companies in workspace</p>
          </div>
          <Button className="bg-indigo-600 hover:bg-indigo-700" size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> New Company
          </Button>
        </div>

        <div className="relative max-w-xs mb-4">
          <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search companies..." className="pl-8 h-8 text-sm" />
        </div>

        <div className="border rounded-lg overflow-hidden bg-card">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Company</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Domain</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Industry</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Size</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Contacts</th>
                <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Deals</th>
                <th className="py-2.5 px-4 w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">No companies found</td></tr>}
              {filtered.map(c => (
                <tr key={c.id}
                  className="border-b last:border-0 hover:bg-muted/40 cursor-pointer transition-colors"
                  onClick={() => navigate(`/crm/companies/${c.id}`)}>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                        {initials(c.name)}
                      </div>
                      <span className="text-sm font-medium">{c.name}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    {c.domain ? (
                      <a href={`https://${c.domain}`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1 text-sm text-indigo-600 hover:underline">
                        <Globe className="w-3 h-3" />{c.domain}
                      </a>
                    ) : <span className="text-muted-foreground/50 text-sm">—</span>}
                  </td>
                  <td className="py-3 px-4">
                    {c.industry ? <Badge variant="outline" className="text-xs">{c.industry}</Badge>
                      : <span className="text-muted-foreground/50 text-sm">—</span>}
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">{c.size ?? "—"}</td>
                  <td className="py-3 px-4">
                    <span className="text-sm font-medium">{c.contactsCount}</span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="text-sm font-medium">{c.dealsCount}</span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      {user?.role==="admin"&&<Button variant="ghost" size="icon" aria-label={`Delete ${c.name}`} title={`Delete ${c.name}`} className="text-rose-700"
                        onClick={event=>{event.stopPropagation();setDeleteTarget(c);setConfirmName("");}}><Trash2 className="h-4 w-4"/></Button>}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <NewCompanyDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <Dialog open={deleteTarget!==null} onOpenChange={open=>{if(!open&&!remove.isPending){setDeleteTarget(null);setConfirmName("");}}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name} permanently?</DialogTitle>
            <DialogDescription>This deletes the company, its contacts, inbound responses, deals, and linked history. It cannot be undone. Source files or later imports can recreate records.</DialogDescription>
          </DialogHeader>
          <Label htmlFor="confirm-company-delete">Type the company name to confirm</Label>
          <Input id="confirm-company-delete" value={confirmName} onChange={event=>setConfirmName(event.target.value)} autoComplete="off"/>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setDeleteTarget(null)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="destructive" disabled={!deleteTarget||confirmName!==deleteTarget.name||remove.isPending}
              onClick={()=>deleteTarget&&remove.mutate(deleteTarget.id)}>{remove.isPending?"Deleting…":"Delete company and history"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewCompanyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [industry, setIndustry] = useState("");
  const [size, setSize] = useState("");
  const [website, setWebsite] = useState("");
  const [clientId, setClientId] = useState("");

  const { data: clients = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["clients"],
    queryFn: () => api("/clients"),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/companies", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: parseInt(clientId),
          name: name.trim(),
          domain: domain.trim() || null,
          industry: industry.trim() || null,
          size: size || null,
          website: website.trim() || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "Failed to create company");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["hp-bi"] });
      qc.invalidateQueries({ queryKey: ["hp-bi-detail"] });
      toast({ title: "Company saved" });
      handleClose();
    },
    onError: (e: Error) => toast({ title: "Failed to create company", description: e.message, variant: "destructive" }),
  });

  const handleClose = () => {
    setName(""); setDomain(""); setIndustry(""); setSize(""); setWebsite(""); setClientId("");
    onClose();
  };

  const canSubmit = name.trim().length > 0 && clientId !== "" && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New Company</DialogTitle></DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>Client *</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger><SelectValue placeholder="Select a client" /></SelectTrigger>
              <SelectContent>
                {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Company name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Acme Corp" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Domain</Label>
              <Input value={domain} onChange={e => setDomain(e.target.value)} placeholder="acme.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <Input value={industry} onChange={e => setIndustry(e.target.value)} placeholder="Technology" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Size</Label>
              <Select value={size} onValueChange={setSize}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1-10">1-10</SelectItem>
                  <SelectItem value="11-50">11-50</SelectItem>
                  <SelectItem value="51-200">51-200</SelectItem>
                  <SelectItem value="201-1000">201-1000</SelectItem>
                  <SelectItem value="1000+">1000+</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Website</Label>
              <Input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://acme.com" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700" disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create Company"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
