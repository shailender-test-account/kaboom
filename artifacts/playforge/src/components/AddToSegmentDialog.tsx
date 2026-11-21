import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Search, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Segment {
  id: number;
  name: string;
  segment_type: string;
  last_computed_count: number;
}

interface Props {
  contactIds: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AddToSegmentDialog({ contactIds, open, onOpenChange, onSuccess }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [newSegmentName, setNewSegmentName] = useState("");

  const { data: segments = [] } = useQuery<Segment[]>({
    queryKey: ["segments-list"],
    queryFn: () => fetch("/api/segments", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });

  const staticSegments = segments.filter(s => s.segment_type === "static");
  const filtered = staticSegments.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  const dynamicCount = segments.filter(s => s.segment_type === "dynamic").length;

  const addMutation = useMutation({
    mutationFn: async () => {
      if (mode === "create") {
        const res = await fetch("/api/segments", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newSegmentName.trim(),
            segmentType: "static",
            staticContactIds: contactIds,
            filterCriteria: [],
            logicOperator: "AND",
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      } else {
        const res = await fetch(`/api/segments/${selectedSegmentId}/contacts`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }
    },
    onSuccess: () => {
      const count = contactIds.length;
      toast({ title: `${count} contact${count !== 1 ? "s" : ""} added to segment` });
      queryClient.invalidateQueries({ queryKey: ["segments-list"] });
      onSuccess?.();
      handleClose();
    },
    onError: () => {
      toast({ title: "Failed to add contacts to segment", variant: "destructive" });
    },
  });

  function handleClose() {
    onOpenChange(false);
    setSelectedSegmentId(null);
    setSearch("");
    setMode("pick");
    setNewSegmentName("");
  }

  const canConfirm =
    mode === "create" ? newSegmentName.trim().length > 0 : selectedSegmentId !== null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to segment</DialogTitle>
          <DialogDescription>
            {contactIds.length === 1
              ? "Add this contact"
              : `Add ${contactIds.length} contacts`}{" "}
            to an existing static segment or create a new one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex rounded-lg border p-1 gap-1 bg-muted/40">
            <button
              className={cn(
                "flex-1 text-sm rounded-md py-1.5 font-medium transition-colors",
                mode === "pick"
                  ? "bg-white shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setMode("pick")}
            >
              Existing segment
            </button>
            <button
              className={cn(
                "flex-1 text-sm rounded-md py-1.5 font-medium transition-colors",
                mode === "create"
                  ? "bg-white shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setMode("create")}
            >
              New segment
            </button>
          </div>

          {mode === "pick" ? (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search segments…"
                  className="pl-8 h-9"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="max-h-56 overflow-y-auto space-y-1 rounded-md border p-1">
                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    {search
                      ? "No matching segments"
                      : "No static segments yet — use the 'New segment' tab to create one."}
                  </p>
                ) : (
                  filtered.map(seg => (
                    <button
                      key={seg.id}
                      className={cn(
                        "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm text-left transition-colors",
                        selectedSegmentId === seg.id
                          ? "bg-indigo-50 text-indigo-800 border border-indigo-200"
                          : "hover:bg-muted/60"
                      )}
                      onClick={() =>
                        setSelectedSegmentId(seg.id === selectedSegmentId ? null : seg.id)
                      }
                    >
                      <span className="flex items-center gap-2">
                        {selectedSegmentId === seg.id && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                        )}
                        <span className="font-medium">{seg.name}</span>
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 text-muted-foreground"
                      >
                        {seg.last_computed_count} contacts
                      </Badge>
                    </button>
                  ))
                )}
              </div>
              {dynamicCount > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Dynamic segments are filtered automatically and cannot have contacts added
                  manually.
                </p>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="new-seg-name">Segment name</Label>
              <Input
                id="new-seg-name"
                placeholder="e.g. High-Value Prospects"
                value={newSegmentName}
                onChange={e => setNewSegmentName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && canConfirm && !addMutation.isPending)
                    addMutation.mutate();
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                Creates a new static segment with the{" "}
                {contactIds.length === 1
                  ? "selected contact"
                  : `${contactIds.length} selected contacts`}
                .
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={!canConfirm || addMutation.isPending}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            <FolderPlus className="w-3.5 h-3.5 mr-1.5" />
            {addMutation.isPending
              ? "Adding…"
              : mode === "create"
              ? "Create & add"
              : "Add to segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
