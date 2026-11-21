import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  Plus, Zap, Loader2, Calendar, Eye, Copy, Pencil, Trash2,
  MoreHorizontal, Users, GripVertical, Map,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

interface Play {
  id: number;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  clientId: number;
  clientName: string | null;
  clientLogoUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  pageViews: number;
  contactsEnrolled: number;
  linkedJourneysCount: number;
}

const COLUMNS: { id: Play["status"]; label: string; color: string; dot: string }[] = [
  { id: "draft",    label: "Draft",    color: "text-gray-600",    dot: "bg-gray-400" },
  { id: "active",   label: "Active",   color: "text-emerald-700", dot: "bg-emerald-500" },
  { id: "paused",   label: "Paused",   color: "text-amber-700",   dot: "bg-amber-400" },
  { id: "archived", label: "Archived", color: "text-red-700",     dot: "bg-red-400" },
];

function ClientAvatar({ play }: { play: Play }) {
  if (play.clientLogoUrl) {
    return (
      <img
        src={play.clientLogoUrl}
        alt={play.clientName ?? ""}
        className="w-5 h-5 rounded object-contain border border-border bg-white"
      />
    );
  }
  const name = play.clientName ?? "??";
  const initials = name.slice(0, 2).toUpperCase();
  const colors = ["bg-indigo-100 text-indigo-700", "bg-violet-100 text-violet-700", "bg-sky-100 text-sky-700"];
  const color = colors[play.clientId % colors.length];
  return (
    <div className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center shrink-0 ${color}`}>
      {initials}
    </div>
  );
}

function PlayCard({
  play,
  onEdit,
  onDuplicate,
  onDelete,
  onOpenJourneys,
  isDragging,
}: {
  play: Play;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenJourneys: () => void;
  isDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: play.id });
  const style = { transform: CSS.Translate.toString(transform) };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onEdit}
      className={`bg-card border border-border rounded-lg p-3 shadow-xs cursor-pointer select-none transition-opacity ${
        isDragging ? "opacity-40" : "hover:shadow-sm hover:border-primary/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          <div
            {...listeners}
            {...attributes}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 cursor-grab active:cursor-grabbing shrink-0 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </div>
          <p className="text-sm font-medium text-foreground leading-snug flex-1 min-w-0">{play.name}</p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 -mr-1 -mt-0.5">
                <MoreHorizontal className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem className="text-xs cursor-pointer" onClick={onEdit}>
                <Pencil className="w-3.5 h-3.5 mr-2" /> Open
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs cursor-pointer" onClick={onDuplicate}>
                <Copy className="w-3.5 h-3.5 mr-2" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-xs text-destructive focus:text-destructive cursor-pointer"
                onClick={onDelete}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-2">
        <ClientAvatar play={play} />
        <span className="text-xs text-muted-foreground truncate">{play.clientName ?? "Unknown"}</span>
      </div>

      {(play.startDate || play.endDate) && (
        <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground">
          <Calendar className="w-3 h-3 shrink-0" />
          <span>
            {play.startDate && format(new Date(play.startDate), "MMM d")}
            {play.startDate && play.endDate && " – "}
            {play.endDate && format(new Date(play.endDate), "MMM d")}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/60">
        <div
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title={`${play.pageViews} page views`}
        >
          <Eye className="w-3 h-3" />
          <span>{play.pageViews}</span>
        </div>
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-xs font-medium"
          title={`${play.contactsEnrolled} contacts enrolled`}
        >
          <Users className="w-3 h-3" />
          <span>{play.contactsEnrolled}</span>
          <span className="text-[10px] font-normal text-indigo-600/80">enrolled</span>
        </div>
        {play.linkedJourneysCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenJourneys();
            }}
            className="ml-auto flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-1.5 py-0.5 rounded-full font-medium transition-colors"
            title="View linked journeys"
          >
            <Map className="w-3 h-3" />
            <span>{play.linkedJourneysCount} {play.linkedJourneysCount === 1 ? "journey" : "journeys"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({
  status,
  label,
  color,
  dot,
  plays,
  activeId,
  onEdit,
  onDuplicate,
  onDelete,
  onOpenJourneys,
}: {
  status: string;
  label: string;
  color: string;
  dot: string;
  plays: Play[];
  activeId: number | null;
  onEdit: (id: number) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  onOpenJourneys: (id: number) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });

  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <h3 className={`text-xs font-semibold uppercase tracking-wider ${color}`}>{label}</h3>
        <span className="ml-auto text-xs text-muted-foreground font-medium">{plays.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 space-y-2 rounded-xl p-2 min-h-32 transition-colors ${
          isOver ? "bg-muted/60 ring-1 ring-primary/30" : "bg-muted/30"
        }`}
      >
        {plays.map((play) => (
          <PlayCard
            key={play.id}
            play={play}
            isDragging={activeId === play.id}
            onEdit={() => onEdit(play.id)}
            onDuplicate={() => onDuplicate(play.id)}
            onDelete={() => onDelete(play.id)}
            onOpenJourneys={() => onOpenJourneys(play.id)}
          />
        ))}
        {plays.length === 0 && (
          <div className="h-16 flex items-center justify-center">
            <p className="text-xs text-muted-foreground/50">Drop here</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PlaysPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { data: plays = [], isLoading } = useQuery<Play[]>({
    queryKey: ["plays"],
    queryFn: () => fetch("/api/plays", { credentials: "include" }).then((r) => r.json()),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      fetch(`/api/plays/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plays"] }),
    onError: () => toast({ title: "Failed to update play status", variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/plays/${id}/duplicate`, {
        method: "POST",
        credentials: "include",
      }).then((r) => r.json()),
    onSuccess: (play) => {
      qc.invalidateQueries({ queryKey: ["plays"] });
      toast({ title: "Play duplicated", description: play.name });
    },
    onError: () => toast({ title: "Failed to duplicate play", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/plays/${id}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plays"] });
      toast({ title: "Play deleted" });
      setDeleteId(null);
    },
    onError: () => toast({ title: "Failed to delete play", variant: "destructive" }),
  });

  const activePlay = plays.find((p) => p.id === activeId) ?? null;

  function onDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  function onDragEnd(event: DragEndEvent) {
    const { over } = event;
    setActiveId(null);
    if (!over || !activeId) return;
    const newStatus = over.id as string;
    const play = plays.find((p) => p.id === activeId);
    if (play && play.status !== newStatus) {
      updateStatus.mutate({ id: activeId, status: newStatus });
    }
  }

  const byStatus = (status: string) => plays.filter((p) => p.status === status);

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Plays</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {plays.length} ABM {plays.length === 1 ? "play" : "plays"} total
          </p>
        </div>
        <Button size="sm" onClick={() => navigate("/plays/new")}>
          <Plus className="w-4 h-4 mr-1.5" />
          New Play
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-4 gap-4 flex-1 min-h-0">
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col.id}
                status={col.id}
                label={col.label}
                color={col.color}
                dot={col.dot}
                plays={byStatus(col.id)}
                activeId={activeId}
                onEdit={(id) => navigate(`/plays/${id}`)}
                onDuplicate={(id) => duplicateMutation.mutate(id)}
                onDelete={(id) => setDeleteId(id)}
                onOpenJourneys={(id) => navigate(`/plays/${id}?tab=journeys`)}
              />
            ))}
          </div>

          <DragOverlay>
            {activePlay && (
              <div className="bg-card border border-primary/40 rounded-lg p-3 shadow-lg rotate-1 opacity-95 w-64">
                <p className="text-sm font-medium text-foreground">{activePlay.name}</p>
                <p className="text-xs text-muted-foreground mt-1">{activePlay.clientName}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {plays.length === 0 && !isLoading && (
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <Zap className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-sm font-medium text-foreground mb-1">No plays yet</h3>
            <p className="text-xs text-muted-foreground mb-4">Create your first ABM play to get started</p>
            <Button size="sm" onClick={() => navigate("/plays/new")}>
              <Plus className="w-4 h-4 mr-1.5" />
              New Play
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete play?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this play. This action cannot be undone.
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
