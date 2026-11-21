import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileText, Plus, Search, Pencil, Trash2, Loader2,
  Mail, MoreHorizontal, Copy, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface EmailTemplate {
  id: number;
  name: string;
  category: string;
  subject: string;
  bodyHtml: string;
  blocksJson?: unknown;
  createdAt: string;
}

const CATEGORIES = ["Outreach", "Follow-up", "Nurture", "Event", "Re-engagement"];

const CATEGORY_COLORS: Record<string, string> = {
  Outreach: "bg-indigo-100 text-indigo-700",
  "Follow-up": "bg-sky-100 text-sky-700",
  Nurture: "bg-emerald-100 text-emerald-700",
  Event: "bg-amber-100 text-amber-700",
  "Re-engagement": "bg-orange-100 text-orange-700",
};

export default function TemplatesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<EmailTemplate | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const { data: templates = [], isLoading } = useQuery<EmailTemplate[]>({
    queryKey: ["templates"],
    queryFn: () => fetch("/api/templates", { credentials: "include" }).then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/templates/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: "Template deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete template", variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/templates/${id}/duplicate`, { method: "POST", credentials: "include" })
        .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (tpl) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast({ title: "Template duplicated", description: `"${tpl.name}" created` });
    },
    onError: () => toast({ title: "Failed to duplicate template", variant: "destructive" }),
  });

  const importZipMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/templates/import-zip", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error ?? "Import failed");
      }
      return r.json();
    },
    onSuccess: (tpl) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast({
        title: "Mailer imported",
        description: `"${tpl.name}" created${tpl.imagesImported ? ` with ${tpl.imagesImported} image${tpl.imagesImported === 1 ? "" : "s"}` : ""}`,
      });
      navigate(`/templates/${tpl.id}`);
    },
    onError: (err: Error) =>
      toast({ title: "Failed to import mailer", description: err.message, variant: "destructive" }),
  });

  const filtered = templates.filter(t => {
    const matchSearch = t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.subject.toLowerCase().includes(search.toLowerCase());
    const matchCat = catFilter === "all" || t.category === catFilter;
    return matchSearch && matchCat;
  });

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Email Templates</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Reusable email templates for your sequences</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) importZipMutation.mutate(file);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <Button
            variant="outline"
            onClick={() => zipInputRef.current?.click()}
            disabled={importZipMutation.isPending}
          >
            {importZipMutation.isPending
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <Upload className="w-4 h-4 mr-2" />}
            Import ZIP
          </Button>
          <Button onClick={() => navigate("/templates/new")} className="bg-indigo-600 hover:bg-indigo-700">
            <Plus className="w-4 h-4 mr-2" /> New Template
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="border rounded-lg bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Template</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-16 text-center">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-16 text-center">
                  <Mail className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                  <p className="text-muted-foreground text-sm">
                    {search || catFilter !== "all" ? "No templates match your filters" : "No templates yet — create your first one"}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(tpl => (
                <TableRow key={tpl.id} className="group cursor-pointer hover:bg-muted/30"
                  onClick={() => navigate(`/templates/${tpl.id}`)}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                        <FileText className="w-4 h-4 text-indigo-600" />
                      </div>
                      <div>
                        <span className="font-medium text-sm text-foreground">{tpl.name}</span>
                        {Array.isArray(tpl.blocksJson) && tpl.blocksJson.length > 0 && (
                          <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0 h-4 text-indigo-600 border-indigo-200 bg-indigo-50">
                            Visual
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[tpl.category] ?? "bg-gray-100 text-gray-700"}`}>
                      {tpl.category}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">{tpl.subject}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(new Date(tpl.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(`/templates/${tpl.id}`)}>
                          <Pencil className="w-4 h-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => duplicateMutation.mutate(tpl.id)}
                          disabled={duplicateMutation.isPending}
                        >
                          <Copy className="w-4 h-4 mr-2" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(tpl)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" will be permanently deleted. Sequences using it will not send emails.
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
    </div>
  );
}
