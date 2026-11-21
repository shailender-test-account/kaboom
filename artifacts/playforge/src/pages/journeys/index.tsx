import { useState } from "react";
import { slugify } from "@/pages/journeys/viewer";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen, Plus, Search, Pencil, Trash2, Loader2,
  Eye, FileStack, ExternalLink, MoreHorizontal, Copy, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface LinkedPlay { id: number; name: string; }
interface ClientOption { id: number; name: string; }

interface Journey {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  clientId: number;
  clientName: string | null;
  clientLogoUrl: string | null;
  pageCount: number;
  totalViews: number;
  createdAt: string;
  linkedPlays: LinkedPlay[];
  linkedPlaysCount: number;
}

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive"; dot: string }> = {
  draft:     { label: "Draft",     variant: "secondary", dot: "bg-gray-400" },
  published: { label: "Published", variant: "default",   dot: "bg-emerald-500" },
  archived:  { label: "Archived",  variant: "outline",   dot: "bg-red-400" },
};

function ClientAvatar({ name, logoUrl }: { name: string | null; logoUrl: string | null }) {
  if (logoUrl) return <img src={logoUrl} alt={name ?? ""} className="w-6 h-6 rounded object-contain border border-border bg-white" />;
  const initials = (name ?? "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["bg-indigo-100 text-indigo-700", "bg-violet-100 text-violet-700", "bg-sky-100 text-sky-700", "bg-amber-100 text-amber-700"];
  const color = colors[(name ?? "").charCodeAt(0) % colors.length];
  return <span className={`w-6 h-6 rounded text-[10px] font-semibold flex items-center justify-center ${color}`}>{initials}</span>;
}

export default function JourneysPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<Journey | null>(null);
  const [renameTarget, setRenameTarget] = useState<Journey | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const { data: journeys = [], isLoading, isError, refetch } = useQuery<Journey[]>({
    queryKey: ["journeys"],
    queryFn: async () => {
      const response = await fetch("/api/journeys", { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load journeys");
      return response.json();
    },
  });
  // Use the same client registry as Analytics, including clients with no journeys.
  const { data: clients = [], isLoading: clientsLoading, isError: clientsError, refetch: refetchClients } = useQuery<ClientOption[]>({
    queryKey: ["clients"],
    queryFn: async () => {
      const response = await fetch("/api/clients", { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load clients");
      return response.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/journeys/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete journey", variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      fetch(`/api/journeys/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then(r => { if (!r.ok) throw new Error(); return r.json(); }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey renamed" });
      setRenameTarget(null);
    },
    onError: () => toast({ title: "Failed to rename journey", variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/journeys/${id}/duplicate`, { method: "POST", credentials: "include" }).then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      }),
    onSuccess: (newJourney) => {
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey duplicated", description: `"${newJourney.name}" created as a draft.` });
    },
    onError: () => toast({ title: "Failed to duplicate journey", variant: "destructive" }),
  });

  const filtered = journeys.filter(j => {
    const matchesSearch = j.name.toLowerCase().includes(search.toLowerCase()) ||
      (j.clientName ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || j.status === statusFilter;
    const matchesClient = clientFilter === "all" || String(j.clientId) === clientFilter;
    return matchesSearch && matchesStatus && matchesClient;
  });

  const journeyPublicPath = (journey: Journey) => {
    const clientSl = slugify(journey.clientName ?? "");
    return clientSl ? `/${clientSl}/play/${journey.slug}` : `/play/${journey.slug}`;
  };

  const copyPublicLink = (journey: Journey) => {
    const url = `${window.location.origin}${journeyPublicPath(journey)}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied", description: url });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Journeys</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Content journeys for prospect engagement</p>
        </div>
        <Button onClick={() => navigate("/journeys/new")} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4 mr-2" /> New Journey
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search journeys..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={clientFilter} onValueChange={setClientFilter} disabled={clientsLoading || clientsError}>
          <SelectTrigger className="w-48" aria-label="Filter by client">
            <SelectValue placeholder="All clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {[...clients].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id).map(client =>
              <SelectItem key={client.id} value={String(client.id)}>{client.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {clientsError && <p role="alert" className="text-sm text-destructive">
        Unable to load the client list. <Button variant="link" onClick={() => void refetchClients()}>Retry clients</Button>
      </p>}

      <div className="border rounded-lg bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Journey</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-center">Pages</TableHead>
              <TableHead className="text-center">Views</TableHead>
              <TableHead>Plays</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-16 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow><TableCell colSpan={8} className="py-12 text-center">
                <p role="alert" className="text-sm text-destructive">Unable to load journeys.</p>
                <Button variant="outline" onClick={() => void refetch()}>Retry journeys</Button>
              </TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-16 text-center">
                  <BookOpen className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-muted-foreground text-sm">
                    {clientFilter !== "all"
                      ? `No journeys match your filters for ${clients.find(c => String(c.id) === clientFilter)?.name ?? "this client"}`
                      : search || statusFilter !== "all" ? "No journeys match your filters" : "No journeys yet — create your first one"}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(journey => {
                const cfg = STATUS_CONFIG[journey.status] ?? STATUS_CONFIG.draft;
                return (
                  <TableRow key={journey.id} className="group cursor-pointer hover:bg-muted/30"
                    onClick={() => navigate(`/journeys/${journey.id}`)}>
                    <TableCell>
                      <div className="font-medium text-foreground">{journey.name}</div>
                      {journey.description && (
                        <div className="text-xs text-muted-foreground truncate max-w-xs">{journey.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ClientAvatar name={journey.clientName} logoUrl={journey.clientLogoUrl} />
                        <span className="text-sm">{journey.clientName ?? "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={cfg.variant} className="gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                        {cfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                        <FileStack className="w-3.5 h-3.5" />
                        {journey.pageCount}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
                        <Eye className="w-3.5 h-3.5" />
                        {journey.totalViews.toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      {(journey.linkedPlaysCount ?? journey.linkedPlays?.length ?? 0) === 0 ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1">
                          <span
                            title={(journey.linkedPlays ?? []).map(p => p.name).join(", ")}
                            className="inline-flex items-center gap-1 text-[11px] font-medium bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full"
                          >
                            <Layers className="w-2.5 h-2.5 shrink-0" />
                            {journey.linkedPlaysCount ?? journey.linkedPlays.length} {(journey.linkedPlaysCount ?? journey.linkedPlays.length) === 1 ? "play" : "plays"}
                          </span>
                          {(journey.linkedPlays ?? []).map(play => (
                            <button
                              key={play.id}
                              onClick={() => navigate(`/plays/${play.id}`)}
                              title={`Open play: ${play.name}`}
                              className="inline-flex items-center gap-1 text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full hover:bg-indigo-100 transition-colors"
                            >
                              {play.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(journey.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        {journey.status === "published" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-indigo-600 hover:text-indigo-700"
                            title="Open public journey"
                            onClick={() => window.open(journeyPublicPath(journey), "_blank")}
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/journeys/${journey.id}`)}>
                              <Pencil className="w-4 h-4 mr-2" /> Edit Builder
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => { setRenameValue(journey.name); setRenameTarget(journey); }}
                            >
                              <Pencil className="w-4 h-4 mr-2" /> Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={duplicateMutation.isPending}
                              onClick={() => duplicateMutation.mutate(journey.id)}
                            >
                              <FileStack className="w-4 h-4 mr-2" />
                              {duplicateMutation.isPending ? "Duplicating…" : "Duplicate"}
                            </DropdownMenuItem>
                            {journey.status === "published" && (
                              <>
                                <DropdownMenuItem onClick={() => window.open(journeyPublicPath(journey), "_blank")}>
                                  <ExternalLink className="w-4 h-4 mr-2" /> Open in New Tab
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => copyPublicLink(journey)}>
                                  <Copy className="w-4 h-4 mr-2" /> Copy Public Link
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDeleteTarget(journey)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete journey?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" and all its pages will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!renameTarget} onOpenChange={open => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename journey</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="journey-rename-input">Name</Label>
            <Input
              id="journey-rename-input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && renameValue.trim() && !renameMutation.isPending)
                  renameMutation.mutate({ id: renameTarget!.id, name: renameValue.trim() });
                if (e.key === "Escape") setRenameTarget(null);
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700"
              disabled={!renameValue.trim() || renameMutation.isPending}
              onClick={() => renameMutation.mutate({ id: renameTarget!.id, name: renameValue.trim() })}
            >
              {renameMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
