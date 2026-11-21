import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Layers, Plus, Trash2, Pencil, MoreHorizontal, RefreshCw, Loader2,
  Users, Tag, TrendingUp, ArrowRight, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

type Segment = {
  id: number; name: string; description: string | null;
  segment_type: string; filter_criteria: any[]; last_computed_count: number;
  last_computed_at: string | null; created_at: string;
};

const TYPE_CONFIG: Record<string, { label: string; classes: string }> = {
  dynamic: { label: "Dynamic", classes: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  static:  { label: "Static",  classes: "bg-gray-100 text-gray-700 border-gray-200" },
};

export default function SegmentsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);
  const [deleteContacts, setDeleteContacts] = useState(false);

  const { data: segments = [], isLoading } = useQuery<Segment[]>({
    queryKey: ["segments"],
    queryFn: () => api("/segments").then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, withContacts }: { id: number; withContacts: boolean }) => {
      const url = withContacts ? `/segments/${id}?deleteContacts=true` : `/segments/${id}`;
      return api(url, { method: "DELETE" });
    },
    onSuccess: (_, { withContacts }) => {
      qc.invalidateQueries({ queryKey: ["segments"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast({ title: withContacts ? "Segment and contacts deleted" : "Segment deleted" });
      setDeleteTarget(null);
      setDeleteContacts(false);
    },
    onError: () => toast({ title: "Failed to delete segment", variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Segments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Dynamic and static groups of contacts for targeting
          </p>
        </div>
        <Button
          onClick={() => navigate("/database/segments/new")}
          className="bg-indigo-600 hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4 mr-2" /> New Segment
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : segments.length === 0 ? (
        <div className="border-2 border-dashed rounded-xl p-12 text-center">
          <Layers className="w-10 h-10 mx-auto text-muted-foreground/40 mb-4" />
          <h3 className="text-base font-medium text-foreground mb-1">No segments yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Create a segment to group contacts by score, tags, title, and more
          </p>
          <Button onClick={() => navigate("/database/segments/new")} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" /> Build your first segment
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {segments.map(seg => {
            const typeCfg = TYPE_CONFIG[seg.segment_type] ?? TYPE_CONFIG.dynamic;
            const criteriaCount = Array.isArray(seg.filter_criteria) ? seg.filter_criteria.length : 0;
            return (
              <div
                key={seg.id}
                className="group relative bg-card border rounded-xl p-4 hover:shadow-sm hover:border-indigo-200 transition-all cursor-pointer"
                onClick={() => navigate(`/database/segments/${seg.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                      <Layers className="w-4.5 h-4.5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground leading-tight">{seg.name}</p>
                      {seg.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{seg.description}</p>
                      )}
                    </div>
                  </div>
                  <div onClick={e => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100">
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(`/database/segments/${seg.id}`)}>
                          <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(seg)}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="w-3.5 h-3.5" />
                    <span className="font-semibold text-foreground">{seg.last_computed_count}</span>
                    <span>contacts</span>
                  </div>
                  <span className="text-muted-foreground/30">·</span>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Tag className="w-3.5 h-3.5" />
                    <span>{criteriaCount} condition{criteriaCount !== 1 ? "s" : ""}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border", typeCfg.classes)}>
                    {typeCfg.label}
                  </span>
                  <div className="flex items-center gap-1 text-xs text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span>View</span><ArrowRight className="w-3 h-3" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) { setDeleteTarget(null); setDeleteContacts(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete segment?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>"{deleteTarget?.name}"</strong> will be permanently deleted.
              Any journey assignments using this segment will be unlinked.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Delete contacts option */}
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 my-1">
            <Checkbox
              id="del-contacts"
              checked={deleteContacts}
              onCheckedChange={v => setDeleteContacts(!!v)}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="del-contacts" className="text-sm font-medium cursor-pointer">
                Also delete all contacts in this segment
              </Label>
              <p className="text-xs text-muted-foreground">
                Permanently removes every contact matched by this segment. This cannot be undone.
              </p>
            </div>
          </div>

          {deleteContacts && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{deleteTarget?.last_computed_count ?? "All"} contact{(deleteTarget?.last_computed_count ?? 0) !== 1 ? "s" : ""} will be permanently deleted along with their activity history.</span>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteContacts(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id, withContacts: deleteContacts })}
            >
              {deleteMutation.isPending
                ? "Deleting…"
                : deleteContacts
                  ? `Delete segment + ${deleteTarget?.last_computed_count ?? ""} contacts`
                  : "Delete segment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
