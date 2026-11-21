import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Search, ExternalLink, Pencil, Trash2, Loader2, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface Client {
  id: number;
  name: string;
  domain: string | null;
  industry: string | null;
  companySize: string | null;
  logoUrl: string | null;
  playsCount: number;
  contactsCount: number;
  createdAt: string;
}

const INDUSTRIES = [
  "Technology", "Finance", "Healthcare", "Manufacturing",
  "Retail", "Education", "Real Estate", "Media", "Other",
];

function ClientAvatar({ client }: { client: Client }) {
  if (client.logoUrl) {
    return (
      <img
        src={client.logoUrl}
        alt={client.name}
        className="w-8 h-8 rounded-md object-contain border border-border bg-white"
      />
    );
  }
  const initials = client.name.slice(0, 2).toUpperCase();
  const colors = [
    "bg-indigo-100 text-indigo-700",
    "bg-violet-100 text-violet-700",
    "bg-sky-100 text-sky-700",
    "bg-emerald-100 text-emerald-700",
    "bg-orange-100 text-orange-700",
  ];
  const color = colors[client.id % colors.length];
  return (
    <div className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${color}`}>
      {initials}
    </div>
  );
}

export default function ClientsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [industryFilter, setIndustryFilter] = useState<string>("all");
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["clients"],
    queryFn: () => fetch("/api/clients", { credentials: "include" }).then((r) => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/clients/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      toast({ title: "Client deleted" });
      setDeleteId(null);
    },
    onError: () => toast({ title: "Failed to delete client", variant: "destructive" }),
  });

  const filtered = clients.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.domain ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesIndustry = industryFilter === "all" || c.industry === industryFilter;
    return matchesSearch && matchesIndustry;
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Clients</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {clients.length} client{clients.length !== 1 ? "s" : ""} in your workspace
          </p>
        </div>
        <Button size="sm" onClick={() => navigate("/clients/new")}>
          <Plus className="w-4 h-4 mr-1.5" />
          New Client
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Select value={industryFilter} onValueChange={setIndustryFilter}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="All industries" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All industries</SelectItem>
            {INDUSTRIES.map((i) => (
              <SelectItem key={i} value={i}>{i}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Building2 className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium text-foreground mb-1">
            {search || industryFilter !== "all" ? "No clients match your filters" : "No clients yet"}
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            {search || industryFilter !== "all"
              ? "Try adjusting your search or filter"
              : "Add your first client to get started"}
          </p>
          {!search && industryFilter === "all" && (
            <Button size="sm" onClick={() => navigate("/clients/new")}>
              <Plus className="w-4 h-4 mr-1.5" />
              New Client
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="text-xs font-medium">Client</TableHead>
                <TableHead className="text-xs font-medium">Industry</TableHead>
                <TableHead className="text-xs font-medium">Plays</TableHead>
                <TableHead className="text-xs font-medium">Contacts</TableHead>
                <TableHead className="text-xs font-medium">Created</TableHead>
                <TableHead className="text-xs font-medium w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((client) => (
                <TableRow
                  key={client.id}
                  className="hover:bg-muted/30 cursor-pointer"
                  onClick={() => navigate(`/clients/${client.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <ClientAvatar client={client} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{client.name}</p>
                        {client.domain && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Globe className="w-3 h-3" />
                            {client.domain}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {client.industry ? (
                      <Badge variant="secondary" className="text-xs font-normal">
                        {client.industry}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm font-medium">{client.playsCount}</span>
                    <span className="text-xs text-muted-foreground ml-1">
                      {client.playsCount === 1 ? "play" : "plays"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{client.contactsCount}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(new Date(client.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => navigate(`/clients/${client.id}/edit`)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      {client.domain && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          asChild
                        >
                          <a
                            href={`https://${client.domain}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteId(client.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete client?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this client and all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
