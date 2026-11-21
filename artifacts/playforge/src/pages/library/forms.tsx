import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Plus, Pencil, Trash2, Copy, Loader2, BarChart2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FormPreviewCanvas, type JourneyFormRecord, type FormConfig } from "./form-editor";

// ── Badge helpers ─────────────────────────────────────────────────────────────

const LAYOUT_LABELS: Record<string, string> = {
  centered_card:  "Centered Card",
  full_width:     "Full Width",
  two_column:     "Two Column",
  minimal_inline: "Minimal Inline",
};

const LAYOUT_COLORS: Record<string, string> = {
  centered_card:  "bg-indigo-50 text-indigo-700 border-indigo-200",
  full_width:     "bg-sky-50 text-sky-700 border-sky-200",
  two_column:     "bg-violet-50 text-violet-700 border-violet-200",
  minimal_inline: "bg-gray-50 text-gray-600 border-gray-200",
};

const TAG_LABELS: Record<string, string> = {
  everyone:    "Everyone",
  with_tag:    "With tag",
  without_tag: "Without tag",
};

// ── Scaled mini-preview ────────────────────────────────────────────────────────

const PREVIEW_HEIGHT = 110;
const SCALE = 0.3;

function FormCardPreview({ config }: { config: FormConfig }) {
  return (
    <div className="overflow-hidden rounded-md border bg-gray-50 relative" style={{ height: PREVIEW_HEIGHT }}>
      <div
        style={{
          transform: `scale(${SCALE})`,
          transformOrigin: "top left",
          width: `${100 / SCALE}%`,
          height: `${PREVIEW_HEIGHT / SCALE}px`,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <div className="p-4">
          <FormPreviewCanvas config={config} compact />
        </div>
      </div>
    </div>
  );
}

// ── FormsLibraryPage ──────────────────────────────────────────────────────────

export default function FormsLibraryPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<JourneyFormRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: forms = [], isLoading } = useQuery<JourneyFormRecord[]>({
    queryKey: ["journey-forms"],
    queryFn: async () => {
      const r = await fetch("/api/journey-forms", { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load forms: ${r.status}`);
      return r.json();
    },
  });

  async function handleDuplicate(form: JourneyFormRecord) {
    try {
      const r = await fetch("/api/journey-forms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${form.name} (copy)`, config: form.config }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["journey-forms"] });
      toast({ title: "Duplicated", description: `${form.name} (copy)` });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/journey-forms/${deleteTarget.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["journey-forms"] });
      toast({ title: "Deleted", description: deleteTarget.name });
      setDeleteTarget(null);
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-violet-100 rounded-lg flex items-center justify-center shrink-0">
            <ClipboardList className="w-5 h-5 text-violet-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Form Library</h1>
            <p className="text-sm text-muted-foreground">Reusable lead-capture forms for your journeys</p>
          </div>
        </div>
        <Button className="bg-indigo-600 hover:bg-indigo-700 gap-1.5" onClick={() => navigate("/library/forms/new")}>
          <Plus className="w-4 h-4" /> Create Form
        </Button>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : forms.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl py-24 text-center">
          <ClipboardList className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground mb-1">No forms yet</p>
          <p className="text-xs text-muted-foreground mb-4">Create your first form to embed in journey pages.</p>
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 gap-1.5" onClick={() => navigate("/library/forms/new")}>
            <Plus className="w-3.5 h-3.5" /> Create Form
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {forms.map(form => {
            const cfg = { ...form.config };
            const layout = cfg.layout ?? "centered_card";
            const tagMode = cfg.tagTargeting?.mode ?? "everyone";
            const fieldCount = cfg.fields?.length ?? 0;

            return (
              <div key={form.id} className="bg-card border rounded-xl overflow-hidden hover:shadow-md transition-shadow flex flex-col">
                {/* Mini preview */}
                <div className="border-b">
                  <FormCardPreview config={cfg} />
                </div>

                <div className="p-4 space-y-3 flex-1 flex flex-col">
                  {/* Name + meta */}
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground leading-tight flex-1">{form.name}</p>
                      <span className={cn(
                        "text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0",
                        form.submissionCount > 0
                          ? "bg-indigo-100 text-indigo-700 border-indigo-200"
                          : "bg-gray-100 text-gray-500 border-gray-200"
                      )}>
                        {form.submissionCount} {form.submissionCount === 1 ? "sub" : "subs"}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(form.createdAt).toLocaleDateString()} · {fieldCount} field{fieldCount !== 1 ? "s" : ""}
                    </p>
                  </div>

                  {/* Badges — all states always shown */}
                  <div className="flex flex-wrap gap-1">
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", LAYOUT_COLORS[layout] ?? "bg-gray-50 text-gray-700 border-gray-200")}>
                      {LAYOUT_LABELS[layout] ?? layout}
                    </span>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", tagMode === "everyone" ? "bg-gray-50 text-gray-500 border-gray-200" : "bg-violet-50 text-violet-700 border-violet-200")}>
                      {TAG_LABELS[tagMode] ?? tagMode}
                      {tagMode !== "everyone" && cfg.tagTargeting?.tag ? `: ${cfg.tagTargeting.tag}` : ""}
                    </span>
                    {cfg.ctaEnabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                        CTA button
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 pt-1 border-t mt-auto">
                    <Button size="sm" variant="outline" className="flex-1 h-7 text-xs gap-1.5" onClick={() => navigate(`/library/forms/${form.id}/edit`)}>
                      <Pencil className="w-3 h-3" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1 px-2 text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                      onClick={() => navigate(`/library/forms/${form.id}/submissions`)}
                      title="View submissions"
                    >
                      <BarChart2 className="w-3 h-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title="Export submissions as CSV"
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = `/api/form-submissions/export?formId=${form.id}`;
                        a.download = `form-submissions-${form.id}.csv`;
                        a.click();
                      }}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => handleDuplicate(form)}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => setDeleteTarget(form)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete form?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" will be permanently deleted and removed from any journey pages using it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
