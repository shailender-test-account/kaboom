import { useEffect, useRef, useState } from "react";
import { useSearch } from "wouter";
import { DndContext, closestCenter, DragEndEvent, PointerSensor, useDroppable, useDraggable, useSensor, useSensors } from "@dnd-kit/core";
import { useListDeals, useUpdateDeal, type Deal } from "@workspace/api-client-react";
import { Plus, Calendar, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { CrmSubNav } from "./sub-nav";
import { cn } from "@/lib/utils";
import { DealEditor, useRefreshDeals } from "./deal-editor";
import { STAGES, MEANING_LABEL, formatAmount, subtotals, stageLabel, dealErrorMessage, type Subtotal } from "./deal-utils";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-gray-100 text-gray-600", medium: "bg-blue-100 text-blue-600", high: "bg-red-100 text-red-600",
};
const KIND_TONE: Record<Subtotal["kind"], string> = {
  unknown: "bg-slate-100 text-slate-600", prospective: "bg-amber-100 text-amber-800",
  total_order_value: "bg-indigo-100 text-indigo-700", booked: "bg-emerald-100 text-emerald-800",
};

function TotalsList({ deals, testId }: { deals: Deal[]; testId: string }) {
  const t = subtotals(deals);
  if (!t.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 min-w-0" data-testid={testId}>
      {t.map(s => (
        <li key={s.key} className={cn("text-[10.5px] rounded px-1.5 py-0.5 truncate", KIND_TONE[s.kind])} title={`${s.label}: ${s.count} deal${s.count === 1 ? "" : "s"}`}>
          {s.label}: {new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(s.amount)}
        </li>
      ))}
    </ul>
  );
}

function DealCard({ deal, onOpen }: { deal: Deal; onOpen: (d: Deal) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  const closeDate = deal.expectedCloseDate
    ? new Date(deal.expectedCloseDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const meaning = deal.valueMeaning ?? "unknown";
  const tone = deal.value != null ? KIND_TONE[meaning] : "";
  return (
    <div
      ref={setNodeRef} style={style} data-testid={`card-deal-${deal.id}`}
      onClick={() => onOpen(deal)}
      className={cn("bg-card border rounded-lg p-3 mb-2 cursor-grab active:cursor-grabbing shadow-xs hover:shadow-sm transition-shadow",
        isDragging && "opacity-50 rotate-1")}
      {...listeners} {...attributes}
    >
      <div className="flex items-start justify-between gap-1 mb-2">
        <p className="text-sm font-medium text-foreground leading-snug break-words min-w-0">{deal.title}</p>
        <button type="button" aria-label={`Edit ${deal.title}`} data-testid={`button-edit-deal-${deal.id}`}
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onOpen(deal); }}
          className="text-muted-foreground hover:text-foreground shrink-0 p-0.5"><Pencil className="w-3.5 h-3.5" /></button>
      </div>
      <div className="space-y-1">
        {deal.value != null ? (
          <div className="text-xs font-medium text-foreground" data-testid={`text-deal-value-${deal.id}`}>
            <span className={deal.currency ? "" : "text-amber-700"}>{formatAmount(deal.value, deal.currency)}</span>
            <span className={cn("ml-1.5 text-[10px] rounded px-1 py-0.5 font-normal", tone)}>{MEANING_LABEL[meaning]}</span>
          </div>
        ) : <div className="text-xs text-muted-foreground">No amount</div>}
        {deal.bookedValue != null && (
          <div className="text-xs font-medium text-emerald-800" data-testid={`text-deal-booked-${deal.id}`}>Booked {formatAmount(deal.bookedValue, deal.currency)}</div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <Badge variant="outline" className={cn("text-xs py-0 px-1.5", PRIORITY_COLORS[deal.priority])}>{deal.priority}</Badge>
        {deal.opportunityConfirmed && <span className="text-[10px] text-indigo-700">Opportunity confirmed</span>}
      </div>
      {closeDate && <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground"><Calendar className="w-3 h-3" />Expected {closeDate}</div>}
    </div>
  );
}

function StageColumn({ stage, deals, onOpen }: { stage: typeof STAGES[number]; deals: Deal[]; onOpen: (d: Deal) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return (
    <div className="flex flex-col min-w-[236px] w-[236px] shrink-0">
      <div className="mb-2 px-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{stage.label}</span>
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{deals.length}</span>
        </div>
        <TotalsList deals={deals} testId={`totals-${stage.key}`} />
      </div>
      <div ref={setNodeRef} className={cn("flex-1 min-h-[200px] rounded-lg border p-2 transition-colors", stage.color, isOver && "ring-2 ring-indigo-400")}>
        {deals.map(d => <DealCard key={d.id} deal={d} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

export default function DealsPage() {
  const [editing, setEditing] = useState<Deal | null>(null);
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const refresh = useRefreshDeals();
  const update = useUpdateDeal();
  const dragged = useRef(false);
  const { data: deals = [], isLoading, isError, error, refetch } = useListDeals();
  const requestedDeal = Number(new URLSearchParams(useSearch()).get("dealId"));
  const openedDeal = useRef<number | null>(null);
  useEffect(() => {
    const selected = deals.find(d => d.id === requestedDeal);
    if (selected && openedDeal.current !== requestedDeal) {
      openedDeal.current = requestedDeal;
      setEditing(selected); setOpen(true);
    }
  }, [deals, requestedDeal]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const openDeal = (d: Deal) => { if (dragged.current) return; setEditing(d); setOpen(true); };

  function handleDragEnd(event: DragEndEvent) {
    setTimeout(() => { dragged.current = false; }, 0);
    const { active, over } = event;
    if (!over) return;
    const deal = deals.find(d => d.id === active.id);
    const stage = over.id as Deal["stage"];
    if (!deal || deal.stage === stage) return;
    update.mutate({ id: deal.id, data: { stage } }, {
      onSuccess: () => {
        refresh(deal.id);
        toast({ title: `Moved to ${stageLabel(stage)}`, description: "Reporting results may now be incomplete. Open the deal to review its dates." });
      },
      onError: e => toast({ title: "Failed to move deal", description: dealErrorMessage(e, "The deal was not moved."), variant: "destructive" }),
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <CrmSubNav active="deals" />
      <div className="px-4 sm:px-6 py-4 border-b bg-card flex items-start sm:items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground tracking-tight">Deals Pipeline</h1>
          <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-deals-count">{deals.length} deals. Totals are per currency and meaning; nothing is converted.</p>
          {deals.length > 0 && <div className="mt-1.5 max-w-xl"><TotalsList deals={deals} testId="totals-all" /></div>}
        </div>
        <Button className="bg-indigo-600 hover:bg-indigo-700 shrink-0" size="sm" onClick={() => { setEditing(null); setOpen(true); }} data-testid="button-new-deal">
          <Plus className="w-4 h-4 mr-1.5" /> New Deal
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {isError && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 mb-4" role="alert">
            Deals failed to load: {(error as Error)?.message}. <button className="underline" onClick={() => refetch()}>Retry</button>
          </div>
        )}
        {isLoading ? (
          <div className="flex gap-4">{STAGES.map(s => <div key={s.key} className="min-w-[236px] h-48 rounded-lg bg-muted animate-pulse" />)}</div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => { dragged.current = true; }} onDragCancel={() => { dragged.current = false; }} onDragEnd={handleDragEnd}>
            <div className="flex gap-4">
              {STAGES.map(stage => <StageColumn key={stage.key} stage={stage} deals={deals.filter(d => d.stage === stage.key)} onOpen={openDeal} />)}
            </div>
          </DndContext>
        )}
        {!isLoading && !isError && deals.length === 0 && <p className="text-sm text-muted-foreground mt-4">No deals yet. Create one to start the pipeline.</p>}
      </div>

      <DealEditor deal={editing} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
