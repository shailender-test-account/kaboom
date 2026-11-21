import { useState, useEffect, useRef, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation } from "wouter";
import { ContactsTab } from "./ContactsTab";
import { RoutingTab } from "./RoutingTab";
import { FormPreviewCanvas, type JourneyFormRecord, type FormConfig } from "@/pages/library/form-editor";
import { PublicFormRenderer, toPageSlug, slugify } from "@/pages/journeys/viewer";
import { AnimatePresence, motion } from "framer-motion";
import { CtaButtonPreview, type StyleConfig } from "@/components/CtaButtonPreview";
import { AssetPicker } from "@/components/AssetPicker";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDroppable, useDndMonitor,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft, Plus, Loader2, GripVertical, Pencil, Trash2,
  Youtube, FileText, Globe, Code2, Image, Eye, ExternalLink,
  CheckCircle2, ChevronDown, ChevronUp, Star, Megaphone, ClipboardList,
  EyeOff, Calendar, Save, X, Copy, CopyPlus, Layers, Link2, Moon, Sun, Upload, Palette,
  FolderOpen, Download, Video, File as FileIcon, Search, MousePointerClick, Unplug,
  Users, GitBranch, BarChart2, MousePointer2, EyeIcon, Lock,
  LayoutTemplate, Type as TypeIcon, AlignLeft,
  List as ListIcon, Minus as MinusIcon, MoveVertical, Monitor, Smartphone, Tablet,
  MousePointer, PlusCircle, Maximize2, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ── PreviewContactDropdown ────────────────────────────────────────────────────
// Searches contacts by name/email and calls onSelect(id, displayName) when picked.
function PreviewContactDropdown({
  search,
  onSelect,
  onClose,
}: {
  search: string;
  onSelect: (id: number, name: string) => void;
  onClose: () => void;
}) {
  const { data, isFetching } = useQuery<{ id: number; firstName: string; lastName: string; email: string }[]>({
    queryKey: ["preview-contact-search", search],
    queryFn: () =>
      fetch(`/api/contacts?search=${encodeURIComponent(search)}&pageSize=8`, { credentials: "include" })
        .then(r => r.json())
        .then((rows: any[]) =>
          rows.map(c => ({ id: c.id, firstName: c.firstName ?? "", lastName: c.lastName ?? "", email: c.email ?? "" }))
        ),
    enabled: search.length >= 1,
    staleTime: 10_000,
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = document.getElementById("preview-contact-dropdown");
      if (el && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      id="preview-contact-dropdown"
      className="absolute right-0 top-full mt-1 w-64 rounded-lg border bg-popover shadow-lg z-50 overflow-hidden"
    >
      {isFetching ? (
        <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Searching…
        </div>
      ) : !data || data.length === 0 ? (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">No contacts found</div>
      ) : (
        <div className="py-1">
          {data.map(c => {
            const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;
            return (
              <button
                key={c.id}
                type="button"
                className="w-full flex flex-col items-start px-3 py-2 hover:bg-muted/60 transition-colors text-left"
                onMouseDown={e => { e.preventDefault(); onSelect(c.id, name); }}
              >
                <span className="text-xs font-medium truncate w-full">{name}</span>
                <span className="text-[10px] text-muted-foreground truncate w-full">{c.email}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Personalization token hint panel ─────────────────────────────────────────
const PERSONALIZATION_TOKENS = [
  { token: "{{firstName|there}}",         desc: "First name" },
  { token: "{{lastName}}",                desc: "Last name" },
  { token: "{{companyName|your company}}", desc: "Company name" },
  { token: "{{jobTitle|colleague}}",      desc: "Job title" },
  { token: "{{industry}}",               desc: "Industry" },
  { token: "{{email}}",                  desc: "Email address" },
];

function PersonalizationTokenHint() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 overflow-hidden text-left">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-violet-800 hover:bg-violet-100/60 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Code2 className="w-3.5 h-3.5" />
          Personalisation tokens
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0.5 space-y-2">
          <p className="text-[11px] text-violet-700/80 leading-relaxed">
            Write <code className="bg-white border border-violet-200 px-1 rounded text-violet-700">{"{{token|fallback}}"}</code> anywhere in this content.
            The fallback shows when the visitor is anonymous. Tokens are substituted server-side at view time.
          </p>
          <div className="grid grid-cols-1 gap-1">
            {PERSONALIZATION_TOKENS.map(t => (
              <div key={t.token} className="flex items-center justify-between gap-3">
                <code
                  className="text-[11px] bg-white border border-violet-200 text-violet-700 px-2 py-0.5 rounded cursor-pointer select-all hover:bg-violet-100 transition-colors"
                  title="Click to select"
                >
                  {t.token}
                </code>
                <span className="text-[11px] text-muted-foreground shrink-0">{t.desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────
type PageType = "youtube" | "pdf" | "iframe" | "html" | "infographic" | "blocks";
type JourneyStatus = "draft" | "published" | "archived";

/** Data attached to a component drag item (useSortable / DnD data.current) */
interface CompDragData {
  comp: PageComponentRecord;
  fromPageId: number;
}

type StageConfig = { id: number; slug: string; label: string; color: string; minScore: number; displayOrder: number };
type BannerItem = { id: number; name: string; position: string; config: { template: string; bgColor: string; textColor: string; heading: string; body: string; ctaText?: string } };

interface CtaButtonItem {
  id: number;
  name: string;
  label: string;
  actionType: string;
  actionConfig: Record<string, any>;
  styleConfig: Record<string, any>;
}
interface PageComponentRecord {
  id: number;
  journeyPageId: number;
  componentType: "cta" | "form" | "banner";
  componentId: number;
  position: string;
  sortOrder: number;
  overrideConfig: Record<string, any>;
  ctaName?: string;
  ctaLabel?: string;
  ctaActionType?: string;
  formName?: string;
  bannerName?: string;
  bannerDefaultPosition?: string;
}

interface JourneyPage {
  id: number;
  journeyId: number;
  title: string;
  pageType: PageType;
  content: string | null;
  sortOrder: number;
  ctaText: string | null;
  ctaEnabled: boolean;
  ctaType: string | null;
  ctaAssetUrl: string | null;
  viewCount: number;
  createdAt: string;
  pageStage: string | null;
  score: number;
  isPublished: boolean;
  gatingAction?: string | null;
  biCategory?: string | null; biProduct?: string | null; biProgram?: string | null;
}

interface MediaAsset {
  id: number;
  name: string;
  url: string;
  mimeType: string;
  format: string;
  fileSizeLabel: string;
}

interface LinkedPlay { id: number; name: string; }

interface Journey {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  status: JourneyStatus;
  clientId: number;
  clientName: string | null;
  pageCount: number;
  totalViews: number;
  startDate: string | null;
  endDate: string | null;
  theme: string;
  navigationMode: string;
  viewerBg?: { type: "color" | "gradient" | "image"; value: string; imageBlur?: number | null } | null;
  clientLogoUrl: string | null;
  headerLogoUrl: string | null;
  headerLogoShowBg: boolean | null;
  headerBtnText: string | null;
  headerBtnUrl: string | null;
  headerBtnType: string | null;
  headerTagline: string | null;
  linkedPlays: LinkedPlay[];
  scenarioVideos?: { airport?: string | null; support?: string | null; home?: string | null } | null;
}

interface PlayOption { id: number; name: string; status: string; clientId: number; }

// ── Constants ────────────────────────────────────────────────────────────────
const PAGE_TYPES: { type: PageType; label: string; icon: React.ComponentType<any>; description: string; color: string }[] = [
  { type: "youtube",     label: "YouTube Video",  icon: Youtube,   description: "Embed a YouTube video",        color: "text-red-500" },
  { type: "pdf",         label: "PDF Document",   icon: FileText,  description: "Link to or embed a PDF file",  color: "text-orange-500" },
  { type: "iframe",      label: "Embed / Iframe", icon: Globe,     description: "Embed any external URL",       color: "text-sky-500" },
  { type: "html",        label: "HTML Content",   icon: Code2,     description: "Rich HTML content block",      color: "text-violet-500" },
  { type: "infographic", label: "Infographic",    icon: Image,     description: "Display an image or graphic",  color: "text-emerald-500" },
  { type: "blocks",      label: "Page Builder",   icon: LayoutTemplate, description: "Drag-and-drop blocks + form", color: "text-indigo-500" },
];

const STATUS_CONFIG: Record<JourneyStatus, { label: string; classes: string }> = {
  draft:     { label: "Draft",     classes: "bg-gray-100 text-gray-700 border-gray-200" },
  published: { label: "Published", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  archived:  { label: "Archived",  classes: "bg-red-50 text-red-700 border-red-200" },
};

const STAGE_COLOR_BADGE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  blue: "bg-blue-100 text-blue-700 border-blue-200",
  violet: "bg-violet-100 text-violet-700 border-violet-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
  rose: "bg-rose-100 text-rose-700 border-rose-200",
  indigo: "bg-indigo-100 text-indigo-700 border-indigo-200",
};

const DEMO_VALUES: Record<string, string> = {
  first_name: "Sarah", last_name: "Chen", company_name: "TechNova",
  industry: "Technology", location: "San Francisco", function: "Product", seniority: "Director",
};

function renderDemo(text: string) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => DEMO_VALUES[k] ?? `{{${k}}}`);
}

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function formatDateRange(startDate: string | null, endDate: string | null): string | null {
  if (!startDate && !endDate) return null;
  const fmt = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (startDate && endDate) return `${fmt(startDate)} – ${fmt(endDate)}`;
  if (startDate) return `Starts ${fmt(startDate)}`;
  return `Ends ${fmt(endDate!)}`;
}

// ── Helper components ────────────────────────────────────────────────────────
function PageTypeIcon({ type, className }: { type: PageType; className?: string }) {
  const cfg = PAGE_TYPES.find(t => t.type === type);
  if (!cfg) return null;
  const Icon = cfg.icon;
  return <Icon className={cn("w-4 h-4", cfg.color, className)} />;
}

// ── InlineComponentItem ───────────────────────────────────────────────────────
function InlineComponentItem({
  comp, fromPageId,
}: {
  comp: PageComponentRecord;
  fromPageId: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `comp-${comp.id}`,
    data: { comp, fromPageId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const typeIcon = comp.componentType === "cta"
    ? <MousePointerClick className="w-3 h-3 text-indigo-500 shrink-0" />
    : comp.componentType === "form"
    ? <ClipboardList className="w-3 h-3 text-sky-500 shrink-0" />
    : <Megaphone className="w-3 h-3 text-amber-500 shrink-0" />;

  const name = comp.ctaLabel ?? comp.ctaName ?? comp.formName ?? comp.bannerName ?? `${comp.componentType} #${comp.componentId}`;
  const popupTrigger = comp.overrideConfig?.popupTrigger as { type?: string; delaySec?: number; scrollPct?: number } | undefined;
  const posLabel = comp.position === "popup" && popupTrigger
    ? popupTrigger.type === "delay"
      ? `popup · ${popupTrigger.delaySec ?? 5}s delay`
      : popupTrigger.type === "scroll"
      ? `popup · ${popupTrigger.scrollPct ?? 50}% scroll`
      : "popup · on load"
    : comp.position === "_default" ? "default" : comp.position.replace(/_/g, " ");

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs bg-background border",
        isDragging && "opacity-30",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground/50 hover:text-muted-foreground shrink-0"
        title="Drag to reorder or move to another page"
      >
        <GripVertical className="w-3 h-3" />
      </button>
      {typeIcon}
      <span className="truncate flex-1 text-muted-foreground font-medium">{name}</span>
      <span className="text-[9px] text-muted-foreground/60 capitalize shrink-0">{posLabel}</span>
    </div>
  );
}

// ── SortableCompList ──────────────────────────────────────────────────────────
// Renders the sortable component list for a single page card with an explicit
// drop-indicator line that appears between items during within-page reordering.
function SortableCompList({
  comps, pageId,
}: {
  comps: PageComponentRecord[];
  pageId: number;
}) {
  const [overCompId, setOverCompId] = useState<number | null>(null);
  const [activeCompId, setActiveCompId] = useState<number | null>(null);
  const [dragFromPageId, setDragFromPageId] = useState<number | null>(null);

  useDndMonitor({
    onDragStart: (e) => {
      const activeStr = String(e.active.id);
      if (activeStr.startsWith("comp-")) {
        const data = e.active.data.current as CompDragData | undefined;
        setDragFromPageId(data?.fromPageId ?? null);
        setActiveCompId(data?.comp.id ?? null);
      } else {
        setDragFromPageId(null);
        setActiveCompId(null);
      }
    },
    onDragOver: (e) => {
      if (!e.over || !String(e.active.id).startsWith("comp-")) {
        setOverCompId(null);
        return;
      }
      const overId = String(e.over.id);
      setOverCompId(overId.startsWith("comp-") ? parseInt(overId.slice(5)) : null);
    },
    onDragEnd: () => { setOverCompId(null); setDragFromPageId(null); setActiveCompId(null); },
    onDragCancel: () => { setOverCompId(null); setDragFromPageId(null); setActiveCompId(null); },
  });

  // Only show indicator when dragging a component that originated from THIS page
  const showIndicator = dragFromPageId === pageId;

  // Determine where to show the "after last item" indicator:
  // When the active item is the first item and it's hovered over the last item,
  // or when hovering the last item and the active is coming from below.
  const lastComp = comps[comps.length - 1];
  const activeIdx = comps.findIndex(c => c.id === activeCompId);
  const overIdx = comps.findIndex(c => c.id === overCompId);
  // Show end-of-list indicator when active item is above over item (dragging down)
  const showEndIndicator = showIndicator && overCompId != null && lastComp && overCompId === lastComp.id && activeIdx < overIdx;

  return (
    <SortableContext
      items={comps.map(c => `comp-${c.id}`)}
      strategy={verticalListSortingStrategy}
    >
      <div className="space-y-1">
        {comps.map((comp, idx) => {
          // Show indicator above this item when: dragging within page AND this
          // is the hover target AND either it's not the last item, or we're
          // dragging up (active is below over).
          const showBefore = showIndicator && overCompId === comp.id
            && !(idx === comps.length - 1 && activeIdx < overIdx);
          return (
            <div key={comp.id}>
              {showBefore && (
                <div className="h-0.5 rounded-full bg-indigo-500 mb-1 mx-0.5" />
              )}
              <InlineComponentItem comp={comp} fromPageId={pageId} />
            </div>
          );
        })}
        {showEndIndicator && (
          <div className="h-0.5 rounded-full bg-indigo-500 mt-1 mx-0.5" />
        )}
      </div>
    </SortableContext>
  );
}

// ── PageComponentDropZone ─────────────────────────────────────────────────────
function PageComponentDropZone({ pageId }: { pageId: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `pdrop-${pageId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mt-1 rounded-md border-2 border-dashed py-2 text-center text-[11px] transition-all select-none",
        isOver
          ? "border-indigo-500 bg-indigo-50 text-indigo-600 font-medium"
          : "border-gray-300 bg-gray-50/50 text-muted-foreground",
      )}
    >
      {isOver ? "Release to move here" : "Drop component here"}
    </div>
  );
}

// ── SortablePageCard ─────────────────────────────────────────────────────────
function SortablePageCard({
  page, index, stages, onEdit, onDelete, onToggleVisibility, isTogglingVisibility,
  pageComponents, isCompDragging, formsById,
}: {
  page: JourneyPage; index: number; stages: StageConfig[];
  onEdit: (p: JourneyPage) => void;
  onDelete: (p: JourneyPage) => void;
  onToggleVisibility: (p: JourneyPage) => void;
  isTogglingVisibility: boolean;
  pageComponents: PageComponentRecord[];
  isCompDragging: boolean;
  formsById: Record<number, JourneyFormRecord>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const stageConfig = stages.find(s => s.slug === page.pageStage);
  const isHidden = page.isPublished === false;
  const [compsExpanded, setCompsExpanded] = useState(false);
  const [popupPreviewCompId, setPopupPreviewCompId] = useState<number | null>(null);

  const hasComponents = pageComponents.length > 0;
  const popupFormComps = pageComponents.filter(
    c => c.componentType === "form" && c.position === "popup" && formsById[c.componentId],
  );
  const hasPopupForms = popupFormComps.length > 0;
  const previewComp = popupPreviewCompId !== null
    ? popupFormComps.find(c => c.id === popupPreviewCompId) ?? null
    : null;
  const previewForm = previewComp ? formsById[previewComp.componentId] ?? null : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "border rounded-lg group transition-all",
        isDragging ? "opacity-40 shadow-lg" : "",
        isHidden
          ? "bg-gray-50 border-gray-200 opacity-60"
          : isCompDragging
            ? "bg-card border-indigo-200/60"
            : "bg-card hover:border-indigo-200 hover:bg-indigo-50/20",
      )}
    >
      <div className="flex items-center gap-3 p-4">
        <button {...attributes} {...listeners} className="touch-none text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing">
          <GripVertical className="w-4 h-4" />
        </button>
        <div className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0",
          isHidden ? "bg-gray-200 text-gray-500" : "bg-muted text-muted-foreground",
        )}>
          {index + 1}
        </div>
        <PageTypeIcon type={page.pageType} className={cn("w-5 h-5 shrink-0", isHidden && "opacity-40")} />
        <div className="flex-1 min-w-0">
          <div className={cn("font-medium text-sm truncate", isHidden ? "text-muted-foreground line-through" : "text-foreground")}>
            {page.title}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <span className="text-xs text-muted-foreground capitalize">{PAGE_TYPES.find(t => t.type === page.pageType)?.label ?? page.pageType}</span>
            {page.viewCount > 0 && <span className="flex items-center gap-0.5 text-xs text-muted-foreground"><Eye className="w-3 h-3" />{page.viewCount}</span>}
            {page.ctaEnabled && <span className="text-[10px] font-medium text-indigo-600">CTA</span>}
            {isHidden && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-gray-500 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded-full">
                <EyeOff className="w-2.5 h-2.5" /> Hidden
              </span>
            )}
            {stageConfig && (
              <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full border", STAGE_COLOR_BADGE[stageConfig.color] ?? "bg-gray-100 text-gray-700 border-gray-200")}>
                {stageConfig.label}
              </span>
            )}
            {page.score > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-emerald-600">
                <Star className="w-2.5 h-2.5" />+{page.score}pts
              </span>
            )}
            {page.gatingAction && page.gatingAction !== "none" && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded-full">
                <Lock className="w-2.5 h-2.5" />
                {page.gatingAction === "form_submit" ? "Gate: form" : "Gate: CTA"}
              </span>
            )}
            {hasComponents && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setCompsExpanded(v => !v); }}
                className="flex items-center gap-0.5 text-[10px] font-medium text-indigo-500 hover:text-indigo-700 transition-colors"
              >
                <Layers className="w-2.5 h-2.5" />
                {pageComponents.length} component{pageComponents.length !== 1 ? "s" : ""}
                {compsExpanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
              </button>
            )}
            {hasPopupForms && (
              <button
                type="button"
                title="Preview popup form"
                onClick={e => { e.stopPropagation(); setPopupPreviewCompId(popupFormComps[0].id); }}
                className="flex items-center gap-0.5 text-[10px] font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 px-1.5 py-0.5 rounded-full transition-colors"
              >
                <Eye className="w-2.5 h-2.5" />
                Preview popup
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", isHidden ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground hover:text-foreground")}
            title={isHidden ? "Show page" : "Hide page"}
            disabled={isTogglingVisibility}
            onClick={e => { e.stopPropagation(); onToggleVisibility(page); }}
          >
            {isTogglingVisibility
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : isHidden
                ? <Eye className="w-3.5 h-3.5" />
                : <EyeOff className="w-3.5 h-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" title="Edit page" onClick={() => onEdit(page)}>
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title="Delete page" onClick={() => onDelete(page)}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Inline components (expanded or during drag) ── */}
      {(compsExpanded || isCompDragging) && (() => {
        const sortedComps = [...pageComponents].sort((a, b) => a.sortOrder - b.sortOrder);
        return (
          <div className="px-4 pb-3 border-t pt-2 space-y-1">
            {compsExpanded && sortedComps.length > 0 && (
              <SortableCompList comps={sortedComps} pageId={page.id} />
            )}
            {compsExpanded && sortedComps.length === 0 && !isCompDragging && (
              <p className="text-[11px] text-muted-foreground py-1">No components on this page.</p>
            )}
            {isCompDragging && <PageComponentDropZone pageId={page.id} />}
          </div>
        );
      })()}

      <AnimatePresence>
        {previewComp && previewForm && (
          <motion.div
            key="popup-form-preview"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40"
            onClick={e => { if (e.target === e.currentTarget) setPopupPreviewCompId(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-md overflow-hidden bg-white rounded-2xl shadow-2xl"
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded-full shrink-0">
                    Preview
                  </span>
                  <h3 className="text-sm font-semibold text-foreground truncate">
                    {previewForm.name}
                  </h3>
                </div>
                <button
                  onClick={() => setPopupPreviewCompId(null)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  title="Close preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-5 pb-5 pt-4 max-h-[70vh] overflow-y-auto">
                <PublicFormRenderer
                  formId={previewForm.id}
                  config={previewForm.config as unknown as Record<string, any>}
                  journeyId={page.journeyId}
                  pageId={page.id}
                  visitorToken="preview"
                  isDark={false}
                  componentId={previewComp.id}
                  previewOnly
                  onClose={() => setPopupPreviewCompId(null)}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── ComponentCard ─────────────────────────────────────────────────────────────
function ComponentCard({
  comp, journeyPages, onDetach, onJumpPageChange, onPopupTriggerChange, onApplyToAll,
  ctaData, bannerData, formData,
}: {
  comp: PageComponentRecord;
  journeyPages: { id: number; title: string; sortOrder: number }[];
  onDetach: () => Promise<void>;
  onJumpPageChange: (pageOrder: number) => Promise<void>;
  onPopupTriggerChange: (trigger: { type: "load" | "delay" | "scroll"; delaySec?: number; scrollPct?: number }) => Promise<void>;
  onApplyToAll: () => Promise<void>;
  ctaData?: CtaButtonItem | null;
  bannerData?: BannerItem | null;
  formData?: JourneyFormRecord | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: comp.id });
  const sortStyle = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const [detaching, setDetaching] = useState(false);
  const [savingTrigger, setSavingTrigger] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const otherPagesCount = Math.max(0, journeyPages.length - 1);

  const isPopupForm = comp.componentType === "form" && comp.position === "popup";
  const existingTrigger = comp.overrideConfig?.popupTrigger as
    { type?: "load" | "delay" | "scroll"; delaySec?: number; scrollPct?: number } | undefined;
  const [triggerType, setTriggerType] = useState<"load" | "delay" | "scroll">(existingTrigger?.type ?? "load");
  const [delaySec, setDelaySec] = useState<number>(existingTrigger?.delaySec ?? 5);
  const [scrollPct, setScrollPct] = useState<number>(existingTrigger?.scrollPct ?? 50);
  useEffect(() => {
    setTriggerType(existingTrigger?.type ?? "load");
    setDelaySec(existingTrigger?.delaySec ?? 5);
    setScrollPct(existingTrigger?.scrollPct ?? 50);
  }, [existingTrigger?.type, existingTrigger?.delaySec, existingTrigger?.scrollPct]);

  const triggerDirty = isPopupForm && (
    triggerType !== (existingTrigger?.type ?? "load") ||
    (triggerType === "delay"  && delaySec  !== (existingTrigger?.delaySec  ?? 5)) ||
    (triggerType === "scroll" && scrollPct !== (existingTrigger?.scrollPct ?? 50))
  );

  const saveTrigger = async () => {
    setSavingTrigger(true);
    try {
      await onPopupTriggerChange({
        type: triggerType,
        ...(triggerType === "delay"  ? { delaySec  } : {}),
        ...(triggerType === "scroll" ? { scrollPct } : {}),
      });
    } finally {
      setSavingTrigger(false);
    }
  };

  const typeIcon = comp.componentType === "cta"
    ? <MousePointerClick className="w-3.5 h-3.5 text-indigo-500" />
    : comp.componentType === "form"
    ? <ClipboardList className="w-3.5 h-3.5 text-sky-500" />
    : <Megaphone className="w-3.5 h-3.5 text-amber-500" />;

  const name = comp.ctaLabel ?? comp.ctaName ?? comp.formName ?? comp.bannerName ?? `${comp.componentType} #${comp.componentId}`;
  const posLabel = comp.position === "_default" ? "default pos" : comp.position.replace(/_/g, " ");
  const actionBadge = comp.componentType === "cta" && comp.ctaActionType
    ? comp.ctaActionType.replace(/_/g, " ")
    : undefined;
  const isJumpPage = comp.componentType === "cta" && comp.ctaActionType === "jump_page";
  const jumpOrder = comp.overrideConfig?.pageOrder ?? 1;
  const editHref = comp.componentType === "cta" ? "/library/cta-buttons"
    : comp.componentType === "form" ? "/library/forms"
    : "/library/banners";

  return (
    <div ref={setNodeRef} style={sortStyle} className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <button type="button" {...attributes} {...listeners}
          className="cursor-grab text-muted-foreground hover:text-foreground shrink-0 touch-none" title="Drag to reorder">
          <GripVertical className="w-3.5 h-3.5" />
        </button>
        {typeIcon}
        <span className="text-sm font-medium flex-1 truncate">{name}</span>
        {actionBadge && (
          <span className="text-[10px] capitalize bg-indigo-50 text-indigo-600 border border-indigo-100 px-1.5 py-0.5 rounded shrink-0">{actionBadge}</span>
        )}
        <span className="text-[10px] text-muted-foreground capitalize bg-muted px-1.5 py-0.5 rounded shrink-0">{posLabel}</span>
        <a href={editHref} target="_blank" rel="noreferrer" title="Edit in library"
          className="text-muted-foreground hover:text-indigo-600 transition-colors shrink-0">
          <ExternalLink className="w-3 h-3" />
        </a>
        {otherPagesCount > 0 && (
          <button
            type="button"
            title={`Apply to all ${otherPagesCount} other page${otherPagesCount === 1 ? "" : "s"}`}
            disabled={applyingAll}
            onClick={async () => { setApplyingAll(true); try { await onApplyToAll(); } finally { setApplyingAll(false); } }}
            className="text-muted-foreground hover:text-indigo-600 transition-colors shrink-0"
          >
            {applyingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CopyPlus className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          type="button" title="Detach" disabled={detaching}
          onClick={async () => { setDetaching(true); try { await onDetach(); } finally { setDetaching(false); } }}
          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
        >
          {detaching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* ── Thumbnail preview ── */}
      {comp.componentType === "cta" && ctaData && (
        <div className="pl-6 pt-0.5">
          <div className="pointer-events-none inline-flex scale-90 origin-left">
            <CtaButtonPreview label={ctaData.label} styleConfig={ctaData.styleConfig as StyleConfig} />
          </div>
        </div>
      )}
      {comp.componentType === "banner" && bannerData && (
        <div className="pl-6 pt-0.5">
          <div
            className="rounded px-2.5 py-1.5 text-xs font-medium truncate max-w-xs"
            style={{
              backgroundColor: bannerData.config?.bgColor ?? "#4f46e5",
              color: bannerData.config?.textColor ?? "#ffffff",
            }}
          >
            {bannerData.config?.heading || bannerData.name}
          </div>
        </div>
      )}
      {comp.componentType === "form" && formData && (
        <div className="pl-6 pt-0.5 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {(formData.config?.fields?.length ?? 0)} field{(formData.config?.fields?.length ?? 0) !== 1 ? "s" : ""}
          </span>
          <div
            className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-semibold"
            style={{
              backgroundColor: formData.config?.submitButton?.bgColor ?? "#4f46e5",
              color: formData.config?.submitButton?.textColor ?? "#ffffff",
            }}
          >
            {formData.config?.submitButton?.label ?? "Submit"}
          </div>
        </div>
      )}

      {isJumpPage && journeyPages.length > 0 && (
        <div className="flex items-center gap-2 pl-6">
          <span className="text-[10px] text-muted-foreground shrink-0">Jumps to:</span>
          <Select value={String(jumpOrder)} onValueChange={v => onJumpPageChange(parseInt(v))}>
            <SelectTrigger className="h-6 text-xs flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {journeyPages.map((p, i) => (
                <SelectItem key={p.id} value={String(i + 1)}>{i + 1}. {p.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isPopupForm && (
        <div className="pl-6 mt-1 space-y-1.5 border-t pt-2">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Popup trigger</Label>
            {triggerDirty && (
              <Button
                type="button" size="sm" disabled={savingTrigger} onClick={saveTrigger}
                className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
              >
                {savingTrigger ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["load", "delay", "scroll"] as const).map(t => (
              <button
                key={t} type="button"
                onClick={() => setTriggerType(t)}
                className={cn(
                  "text-[11px] px-2 py-0.5 rounded border transition-colors",
                  triggerType === t
                    ? "bg-indigo-50 border-indigo-500 text-indigo-700"
                    : "border-border text-muted-foreground hover:bg-muted/50"
                )}
              >
                {t === "load" ? "On load" : t === "delay" ? "After delay" : "On scroll"}
              </button>
            ))}
          </div>
          {triggerType === "delay" && (
            <div className="flex items-center gap-2">
              <Input
                type="number" min={1} max={60}
                value={delaySec}
                onChange={e => setDelaySec(Math.max(1, parseInt(e.target.value) || 1))}
                className="h-6 w-16 text-xs"
              />
              <span className="text-[10px] text-muted-foreground">seconds after page loads</span>
            </div>
          )}
          {triggerType === "scroll" && (
            <div className="flex items-center gap-2">
              <Input
                type="number" min={1} max={100}
                value={scrollPct}
                onChange={e => setScrollPct(Math.max(1, Math.min(100, parseInt(e.target.value) || 50)))}
                className="h-6 w-16 text-xs"
              />
              <span className="text-[10px] text-muted-foreground">% of page scrolled</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AddComponentModal ─────────────────────────────────────────────────────────
function AddComponentModal({
  open, onClose, pageId, journeyPages, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  pageId: number;
  journeyPages: { id: number; title: string; sortOrder: number }[];
  onAdded: () => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"cta" | "form" | "banner">("cta");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [position, setPosition] = useState("floating");
  const [jumpPageOrder, setJumpPageOrder] = useState(1);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [popupTriggerType, setPopupTriggerType] = useState<"load" | "delay" | "scroll">("load");
  const [popupDelaySec, setPopupDelaySec] = useState(5);
  const [popupScrollPct, setPopupScrollPct] = useState(50);

  const { data: ctaButtons = [] } = useQuery<CtaButtonItem[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: addForms = [] } = useQuery<JourneyFormRecord[]>({
    queryKey: ["journey-forms"],
    queryFn: () => fetch("/api/journey-forms", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: addBanners = [] } = useQuery<BannerItem[]>({
    queryKey: ["banners"],
    queryFn: () => fetch("/api/banners", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setSearch("");
    setPosition(tab === "cta" ? "floating" : tab === "form" ? "inline" : "top_bar");
    setJumpPageOrder(1);
    setPopupTriggerType("load");
    setPopupDelaySec(5);
    setPopupScrollPct(50);
  }, [open, tab]);

  const selectedCta = ctaButtons.find(c => c.id === selectedId);
  const isJumpPage = tab === "cta" && selectedCta?.actionType === "jump_page";

  const positions =
    tab === "cta" ? [
      { value: "floating",  label: "Floating (bottom-right corner)" },
      { value: "inline",    label: "Inline (in page content area)" },
      { value: "top_strip", label: "Top strip (below header bar)" },
    ] :
    tab === "form" ? [
      { value: "inline", label: "Inline (embedded in page)" },
      { value: "modal",  label: "Modal (triggered by a CTA button)" },
      { value: "popup",  label: "Popup (auto-triggered modal)" },
    ] : [
      { value: "_default",   label: "Use banner's default position" },
      { value: "top_bar",    label: "Override: Top bar (inside header)" },
      { value: "bottom_bar", label: "Override: Bottom bar (above filmstrip)" },
      { value: "inline",     label: "Override: Inline (in page content)" },
      { value: "top_strip",  label: "Override: Top strip (below header)" },
    ];

  const q = search.toLowerCase();

  const LAYOUT_LABELS: Record<string, string> = {
    centered_card: "Centered Card", full_width: "Full Width",
    two_column: "Two Column", minimal_inline: "Minimal Inline",
  };

  const items: { id: number; name: string; sub?: string }[] =
    tab === "cta"   ? ctaButtons.filter(c => !q || c.name.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)).map(c => ({ id: c.id, name: c.name, sub: `${c.label} · ${(c.actionType ?? "").replace(/_/g, " ")}` })) :
    tab === "form"  ? addForms.filter(f => !q || f.name.toLowerCase().includes(q)).map(f => {
        const layout = LAYOUT_LABELS[f.config?.layout ?? ""] ?? (f.config?.layout ?? "");
        const fieldCount = f.config?.fields?.length ?? 0;
        return { id: f.id, name: f.name, sub: `${layout}${fieldCount > 0 ? ` · ${fieldCount} field${fieldCount !== 1 ? "s" : ""}` : ""}` };
      }) :
    addBanners.filter(b => !q || b.name.toLowerCase().includes(q)).map(b => ({ id: b.id, name: b.name, sub: b.position }));

  const handleAdd = async () => {
    if (!selectedId) return;
    setAdding(true);
    try {
      const overrideConfig: Record<string, any> = {};
      if (isJumpPage) overrideConfig.pageOrder = jumpPageOrder;
      if (position === "popup") {
        overrideConfig.popupTrigger = {
          type: popupTriggerType,
          ...(popupTriggerType === "delay"  ? { delaySec:  popupDelaySec  } : {}),
          ...(popupTriggerType === "scroll" ? { scrollPct: popupScrollPct } : {}),
        };
      }
      const r = await fetch("/api/page-components", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journeyPageId: pageId, componentType: tab, componentId: selectedId, position, sortOrder: 99, overrideConfig }),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Component added to page" });
      onAdded();
      onClose();
    } catch {
      toast({ title: "Failed to add component", variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const tabCls = (active: boolean) => cn(
    "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
    active ? "bg-indigo-600 text-white" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
  );

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4 text-indigo-600" /> Add Component to Page
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1 px-5 pt-3">
          {(["cta", "form", "banner"] as const).map(t => (
            <button key={t} type="button" className={tabCls(tab === t)} onClick={() => setTab(t)}>
              {t === "cta" ? "CTA Button" : t === "form" ? "Form" : "Banner"}
            </button>
          ))}
        </div>

        <div className="flex border-t mt-3 min-h-[340px]">
          {/* Left: item list */}
          <div className="w-1/2 border-r flex flex-col">
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder={`Search ${tab === "cta" ? "CTA buttons" : tab === "form" ? "forms" : "banners"}…`}
                  value={search} onChange={e => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {items.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">
                  {tab === "cta"    ? "No CTA buttons found. Create one in Library → CTA Buttons." :
                   tab === "form"   ? "No forms found. Create one in Library → Forms." :
                                      "No banners found. Create one in Library → Banners."}
                </div>
              ) : items.map(item => (
                <button
                  key={item.id} type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-lg border transition-all text-sm",
                    selectedId === item.id
                      ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                      : "border-transparent hover:border-border hover:bg-muted/40"
                  )}
                >
                  <div className="font-medium truncate">{item.name}</div>
                  {item.sub && <div className="text-xs text-muted-foreground mt-0.5 truncate">{item.sub}</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Right: config */}
          <div className="w-1/2 p-4 flex flex-col gap-4 overflow-y-auto">
            {selectedId ? (
              <>
                {/* Form preview */}
                {tab === "form" && (() => {
                  const selectedForm = addForms.find(f => f.id === selectedId);
                  if (!selectedForm?.config) return null;
                  const PREVIEW_HEIGHT = 120;
                  const SCALE = 0.28;
                  return (
                    <div className="space-y-1">
                      <Label className="text-xs">Preview</Label>
                      <div className="overflow-hidden rounded-lg border bg-gray-50 relative" style={{ height: PREVIEW_HEIGHT }}>
                        <div style={{
                          transform: `scale(${SCALE})`,
                          transformOrigin: "top left",
                          width: `${100 / SCALE}%`,
                          height: `${PREVIEW_HEIGHT / SCALE}px`,
                          overflow: "hidden",
                          pointerEvents: "none",
                        }}>
                          <div className="p-4">
                            <FormPreviewCanvas config={selectedForm.config as FormConfig} compact />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="space-y-2">
                  <Label className="text-xs">Position on page</Label>
                  <div className="space-y-1.5">
                    {positions.map(p => (
                      <label key={p.value} className={cn(
                        "flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-all text-sm",
                        position === p.value ? "border-indigo-500 bg-indigo-50" : "hover:bg-muted/40"
                      )}>
                        <input type="radio" name="position" value={p.value}
                          checked={position === p.value} onChange={() => setPosition(p.value)}
                          className="accent-indigo-600" />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>

                {position === "popup" && tab === "form" && (
                  <div className="space-y-2">
                    <Label className="text-xs">Trigger</Label>
                    <div className="space-y-1.5">
                      {(["load", "delay", "scroll"] as const).map(t => (
                        <label key={t} className={cn(
                          "flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-all text-sm",
                          popupTriggerType === t ? "border-indigo-500 bg-indigo-50" : "hover:bg-muted/40"
                        )}>
                          <input type="radio" name="popupTrigger" value={t}
                            checked={popupTriggerType === t} onChange={() => setPopupTriggerType(t)}
                            className="accent-indigo-600" />
                          {t === "load"   ? "On page load (immediately)"
                           : t === "delay" ? "After a delay"
                           :                "On scroll"}
                        </label>
                      ))}
                    </div>
                    {popupTriggerType === "delay" && (
                      <div className="flex items-center gap-2 pt-1">
                        <Input
                          type="number" min={1} max={60}
                          value={popupDelaySec}
                          onChange={e => setPopupDelaySec(Math.max(1, parseInt(e.target.value) || 1))}
                          className="h-8 w-20 text-sm"
                        />
                        <span className="text-xs text-muted-foreground">seconds after page loads</span>
                      </div>
                    )}
                    {popupTriggerType === "scroll" && (
                      <div className="flex items-center gap-2 pt-1">
                        <Input
                          type="number" min={1} max={100}
                          value={popupScrollPct}
                          onChange={e => setPopupScrollPct(Math.max(1, Math.min(100, parseInt(e.target.value) || 50)))}
                          className="h-8 w-20 text-sm"
                        />
                        <span className="text-xs text-muted-foreground">% of page scrolled</span>
                      </div>
                    )}
                  </div>
                )}

                {isJumpPage && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Jump to page</Label>
                    <Select value={String(jumpPageOrder)} onValueChange={v => setJumpPageOrder(parseInt(v))}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select page…" />
                      </SelectTrigger>
                      <SelectContent>
                        {journeyPages.map((p, i) => (
                          <SelectItem key={p.id} value={String(i + 1)}>{i + 1}. {p.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground">Overrides the button's default jump target for this page only.</p>
                  </div>
                )}

                <div className="mt-auto">
                  <Button onClick={handleAdd} disabled={adding} className="bg-indigo-600 hover:bg-indigo-700 w-full">
                    {adding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                    Add to Page
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center">
                <div className="text-muted-foreground">
                  <MousePointerClick className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Select an item to configure its position</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── PageMiniPreview helpers ──────────────────────────────────────────────────
const PREVIEW_LOGICAL_W = 900;
const PREVIEW_LOGICAL_H = 520;
const PREVIEW_SCALE = 0.32;

function PreviewBannerStrip({ comp, banners }: { comp: PageComponentRecord; banners: BannerItem[] }) {
  const banner = banners.find(b => b.id === comp.componentId);
  const cfg = (banner?.config ?? {}) as Record<string, any>;
  const bg = cfg.bgColor || "#4f46e5";
  const color = cfg.textColor || "#e0e7ff";
  const heading = cfg.heading || banner?.name || "";
  const body = cfg.body || "";
  const ctaText = cfg.ctaText || "";
  const isImage = cfg.type === "image" && cfg.imageUrl;

  if (isImage) {
    return (
      <div className="relative w-full shrink-0 overflow-hidden" style={{ maxHeight: 80 }}>
        <img src={cfg.imageUrl as string} alt={heading} className="w-full object-cover" style={{ maxHeight: 80 }} />
        {heading && (
          <div className="absolute inset-0 flex items-center px-4">
            <span className="font-semibold text-sm truncate" style={{ color }}>{heading}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs shrink-0 w-full" style={{ backgroundColor: bg, color }}>
      {heading && <span className="font-semibold flex-1 truncate">{heading}</span>}
      {body && <span className="opacity-70 truncate hidden sm:block">{body}</span>}
      {ctaText && (
        <span className="shrink-0 px-2.5 py-1 rounded font-semibold text-[11px]" style={{ backgroundColor: color, color: bg }}>
          {ctaText}
        </span>
      )}
    </div>
  );
}

function PreviewCtaBtn({ comp, ctaButtons }: { comp: PageComponentRecord; ctaButtons: CtaButtonItem[] }) {
  const cta = ctaButtons.find(c => c.id === comp.componentId);
  const style = (cta?.styleConfig ?? {}) as Record<string, any>;
  const radius = style.borderRadius === "pill" ? "9999px" : style.borderRadius === "sharp" ? "4px" : "8px";
  const bg = style.bgColor || "#4f46e5";
  const textColor = style.textColor || "#ffffff";
  const outline = !!style.outline;
  const label = cta?.label || comp.ctaLabel || "Click";
  return (
    <span
      style={{
        display: "inline-block",
        backgroundColor: outline ? "transparent" : bg,
        color: outline ? bg : textColor,
        borderRadius: radius,
        border: outline ? `2px solid ${bg}` : "none",
        padding: "6px 16px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "default",
      }}
    >
      {label}
    </span>
  );
}

function PreviewPageContent({ form, isDark }: { form: PageFormState; isDark: boolean }) {
  const gradDark: Record<PageType, string> = {
    youtube: "from-red-950 to-rose-900", pdf: "from-orange-950 to-amber-900",
    iframe: "from-sky-950 to-blue-900", html: "from-violet-950 to-purple-900",
    infographic: "from-emerald-950 to-teal-900", blocks: "from-indigo-950 to-violet-900",
  };
  const gradLight: Record<PageType, string> = {
    youtube: "from-red-50 to-rose-100", pdf: "from-orange-50 to-amber-100",
    iframe: "from-sky-50 to-blue-100", html: "from-violet-50 to-purple-100",
    infographic: "from-emerald-50 to-teal-100", blocks: "from-indigo-50 to-violet-100",
  };
  const iconColor: Record<PageType, string> = {
    youtube: "text-red-400", pdf: "text-orange-400", iframe: "text-sky-400",
    html: "text-violet-400", infographic: "text-emerald-400", blocks: "text-indigo-400",
  };
  const PageIcon = { youtube: Youtube, pdf: FileText, iframe: Globe, html: Code2, infographic: Image, blocks: LayoutTemplate }[form.pageType];

  if (form.pageType === "html" && form.content) {
    return (
      <div className="w-full h-full overflow-hidden p-6">
        <div className="max-w-3xl mx-auto bg-white rounded-xl p-6 shadow-xl">
          <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: form.content }} />
        </div>
      </div>
    );
  }
  if (form.pageType === "infographic" && form.content) {
    return (
      <div className="w-full h-full flex items-center justify-center p-6">
        <img src={form.content} alt={form.title} className="max-w-full max-h-full rounded-xl object-contain shadow-xl" />
      </div>
    );
  }
  if (form.pageType === "youtube" && form.content) {
    const match = form.content.match(/(?:youtu\.be\/|watch\?v=|embed\/)([^&?/]+)/);
    const videoId = match?.[1];
    if (videoId) {
      return (
        <div className="w-full h-full flex items-center justify-center p-6">
          <div className="w-full max-w-3xl aspect-video rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
            <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} alt={form.title} className="w-full h-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-red-600/85 flex items-center justify-center shadow-lg">
                <span className="text-white text-xl pl-1">▶</span>
              </div>
            </div>
          </div>
        </div>
      );
    }
  }
  return (
    <div className={cn("w-full h-full flex flex-col items-center justify-center gap-4 bg-gradient-to-br", isDark ? gradDark[form.pageType] : gradLight[form.pageType])}>
      <PageIcon className={cn("w-14 h-14 opacity-25", iconColor[form.pageType])} />
      <span className={cn("text-sm font-medium opacity-40", isDark ? "text-white" : "text-gray-700")}>
        {form.content ? form.content.replace(/^https?:\/\//, "").slice(0, 40) : form.pageType.toUpperCase()}
      </span>
    </div>
  );
}

function PageMiniPreview({
  form, localComps, banners, ctaButtons, isDark,
}: {
  form: PageFormState;
  localComps: PageComponentRecord[];
  banners: BannerItem[];
  ctaButtons: CtaButtonItem[];
  isDark: boolean;
}) {
  const [debouncedForm, setDebouncedForm] = useState(form);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedForm(form), 300);
    return () => clearTimeout(t);
  }, [form]);

  const resolvePos = (c: PageComponentRecord) =>
    c.position !== "_default" ? c.position : (c.bannerDefaultPosition ?? "inline");

  const topBarComps    = localComps.filter(c => resolvePos(c) === "top_bar");
  const topStripComps  = localComps.filter(c => resolvePos(c) === "top_strip");
  const inlineComps    = localComps.filter(c => resolvePos(c) === "inline");
  const floatingComps  = localComps.filter(c => c.componentType === "cta" && resolvePos(c) === "floating");
  const bottomBarComps = localComps.filter(c => resolvePos(c) === "bottom_bar");

  const bgColor = isDark ? "#111111" : "#f5f5f5";
  const borderColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

  return (
    <div
      className="relative overflow-hidden rounded-lg border shadow-inner"
      style={{
        width: PREVIEW_LOGICAL_W * PREVIEW_SCALE,
        height: PREVIEW_LOGICAL_H * PREVIEW_SCALE,
        maxWidth: "100%",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: PREVIEW_LOGICAL_W,
          height: PREVIEW_LOGICAL_H,
          transform: `scale(${PREVIEW_SCALE})`,
          transformOrigin: "top left",
          backgroundColor: bgColor,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* ── Top bar / top strip banners ── */}
        {[...topBarComps, ...topStripComps].map(c =>
          c.componentType === "banner" ? (
            <PreviewBannerStrip key={c.id} comp={c} banners={banners} />
          ) : c.componentType === "cta" ? (
            <div key={c.id} style={{ display: "flex", justifyContent: "center", padding: "6px 16px", borderBottom: `1px solid ${borderColor}`, background: isDark ? "rgba(0,0,0,0.25)" : "#f9fafb" }}>
              <PreviewCtaBtn comp={c} ctaButtons={ctaButtons} />
            </div>
          ) : null
        )}

        {/* ── Main content area ── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* Page title gradient */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
            padding: "12px 64px 24px",
            background: isDark ? "linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)" : "linear-gradient(to bottom, rgba(255,255,255,0.9), transparent)",
            pointerEvents: "none",
          }}>
            <p style={{ textAlign: "center", fontWeight: 600, fontSize: 14, color: isDark ? "#ffffff" : "#1f2937", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {debouncedForm.title || "Untitled Page"}
            </p>
          </div>

          <PreviewPageContent form={debouncedForm} isDark={isDark} />

          {/* Primary CTA overlay */}
          {debouncedForm.ctaEnabled && debouncedForm.ctaText && floatingComps.length === 0 && (
            <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10 }}>
              <span style={{ display: "inline-block", padding: "8px 20px", borderRadius: 9999, background: "#4f46e5", color: "#fff", fontSize: 14, fontWeight: 600, boxShadow: "0 4px 14px rgba(0,0,0,0.25)" }}>
                {debouncedForm.ctaText}
              </span>
            </div>
          )}

          {/* Floating CTAs */}
          {floatingComps.map((c, i) => (
            <div key={c.id} style={{ position: "absolute", bottom: 80 + i * 48, right: 24, zIndex: 10 }}>
              <PreviewCtaBtn comp={c} ctaButtons={ctaButtons} />
            </div>
          ))}
        </div>

        {/* ── Inline components ── */}
        {inlineComps.length > 0 && (
          <div style={{
            flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
            padding: "12px 16px", borderTop: `1px solid ${borderColor}`,
            background: isDark ? "rgba(0,0,0,0.4)" : "#f9fafb",
            maxHeight: 150, overflow: "hidden",
          }}>
            {inlineComps.map(c =>
              c.componentType === "banner" ? (
                <PreviewBannerStrip key={c.id} comp={c} banners={banners} />
              ) : c.componentType === "cta" ? (
                <div key={c.id} style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}>
                  <PreviewCtaBtn comp={c} ctaButtons={ctaButtons} />
                </div>
              ) : c.componentType === "form" ? (
                <div key={c.id} style={{
                  borderRadius: 12, border: `1px solid ${borderColor}`,
                  padding: "12px 16px",
                  background: isDark ? "#1a1a1a" : "#ffffff",
                }}>
                  <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, color: isDark ? "#e5e7eb" : "#374151" }}>
                    {c.formName || "Form"}
                  </p>
                  {[0.75, 1, 0.5].map((w, i) => (
                    <div key={i} style={{ height: 20, borderRadius: 4, background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)", marginBottom: 6, width: `${w * 100}%` }} />
                  ))}
                </div>
              ) : null
            )}
          </div>
        )}

        {/* ── Bottom bar banners ── */}
        {bottomBarComps.map(c =>
          c.componentType === "banner" ? (
            <PreviewBannerStrip key={c.id} comp={c} banners={banners} />
          ) : c.componentType === "cta" ? (
            <div key={c.id} style={{ flexShrink: 0, display: "flex", justifyContent: "center", padding: "8px 16px", background: isDark ? "rgba(0,0,0,0.3)" : "#f9fafb" }}>
              <PreviewCtaBtn comp={c} ctaButtons={ctaButtons} />
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

// ── Blocks page type ──────────────────────────────────────────────────────────
type ButtonStyle = "primary" | "secondary" | "outline";
type BlockAlign = "left" | "center" | "right";
type ListStyle = "bullet" | "number";

type BlockLink =
  | { kind: "url"; url: string; newTab?: boolean }
  | { kind: "page"; pageIndex: number };

type HotspotItem = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  link: BlockLink;
};

type PageBlock =
  | { id: string; link?: BlockLink; type: "headline"; text: string; level: 1 | 2 | 3; align?: BlockAlign }
  | { id: string; link?: BlockLink; type: "text"; text: string; align?: BlockAlign }
  | { id: string; link?: BlockLink; type: "image"; url: string; alt?: string }
  | { id: string; link?: BlockLink; type: "video"; url: string }
  | { id: string; link?: BlockLink; type: "youtube"; url: string }
  | { id: string; link?: BlockLink; type: "html"; html: string }
  | { id: string; link?: BlockLink; type: "form"; formId: number }
  | { id: string; link?: BlockLink; type: "button"; text: string; url: string; style: ButtonStyle; align: BlockAlign }
  | { id: string; link?: BlockLink; type: "divider" }
  | { id: string; link?: BlockLink; type: "spacer"; height: number }
  | { id: string; link?: BlockLink; type: "list"; items: string[]; style: ListStyle };

interface BlocksContent {
  template?: "blank_form" | "hero_form" | "video_showcase" | "custom";
  header?: { show: boolean; title?: string; subtitle?: string };
  footer?: { show: boolean; text?: string };
  blocks: PageBlock[];
  hotspots?: HotspotItem[];
}

const EMPTY_BLOCKS: BlocksContent = {
  template: undefined,
  header: { show: false, title: "", subtitle: "" },
  footer: { show: false, text: "" },
  blocks: [],
};

function parseBlocks(raw: string | null | undefined): BlocksContent {
  if (!raw) return { ...EMPTY_BLOCKS };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && Array.isArray(obj.blocks)) {
      return {
        template: obj.template,
        header: obj.header ?? { show: false },
        footer: obj.footer ?? { show: false },
        blocks: obj.blocks,
        hotspots: Array.isArray(obj.hotspots) ? obj.hotspots : undefined,
      };
    }
  } catch { /* ignore */ }
  return { ...EMPTY_BLOCKS };
}

function parseNonBlocksContent(raw: string): { rawValue: string; hotspots: HotspotItem[] } {
  if (!raw) return { rawValue: "", hotspots: [] };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj) && ("url" in obj || "html" in obj)) {
      return {
        rawValue: (obj.url ?? obj.html ?? raw) as string,
        hotspots: Array.isArray(obj.hotspots) ? obj.hotspots : [],
      };
    }
  } catch { /* ignore */ }
  return { rawValue: raw, hotspots: [] };
}

const blockUid = () => `b_${Math.random().toString(36).slice(2, 10)}`;

const BLOCKS_TEMPLATES: { id: NonNullable<BlocksContent["template"]>; name: string; description: string; Icon: React.ComponentType<any> }[] = [
  { id: "blank_form",     name: "Blank + Form",   description: "A clean page with just an embedded form.",          Icon: ClipboardList },
  { id: "hero_form",      name: "Hero + Form",    description: "Header, headline, image, intro copy, and a form.",  Icon: LayoutTemplate },
  { id: "video_showcase", name: "Video Showcase", description: "Header, headline, YouTube video, copy, and a form.",Icon: Video },
];

function makeBlocksTemplate(t: NonNullable<BlocksContent["template"]>, firstFormId?: number): BlocksContent {
  const formBlock: PageBlock[] = firstFormId ? [{ id: blockUid(), type: "form", formId: firstFormId }] : [];
  if (t === "blank_form") {
    return {
      template: t,
      header: { show: false, title: "", subtitle: "" },
      footer: { show: false, text: "" },
      blocks: formBlock,
    };
  }
  if (t === "hero_form") {
    return {
      template: t,
      header: { show: true, title: "Welcome", subtitle: "A short subtitle" },
      footer: { show: true, text: "© Your company" },
      blocks: [
        { id: blockUid(), type: "headline", text: "A clear, benefit-led headline", level: 1 },
        { id: blockUid(), type: "text", text: "A short paragraph that sets context and walks the visitor into the form below." },
        { id: blockUid(), type: "image", url: "", alt: "" },
        ...formBlock,
      ],
    };
  }
  return {
    template: t,
    header: { show: true, title: "Watch the demo", subtitle: "" },
    footer: { show: true, text: "© Your company" },
    blocks: [
      { id: blockUid(), type: "headline", text: "See it in action", level: 1 },
      { id: blockUid(), type: "youtube", url: "" },
      { id: blockUid(), type: "text", text: "Add a short explanation here." },
      ...formBlock,
    ],
  };
}

const BLOCK_TYPE_META: Record<PageBlock["type"], { label: string; Icon: React.ComponentType<any> }> = {
  headline: { label: "Headline",    Icon: TypeIcon },
  text:     { label: "Text",        Icon: AlignLeft },
  list:     { label: "List",        Icon: ListIcon },
  button:   { label: "Button",      Icon: MousePointerClick },
  image:    { label: "Image",       Icon: Image },
  video:    { label: "Video (MP4)", Icon: Video },
  youtube:  { label: "YouTube",     Icon: Youtube },
  divider:  { label: "Divider",     Icon: MinusIcon },
  spacer:   { label: "Spacer",      Icon: MoveVertical },
  html:     { label: "HTML / Embed",Icon: Code2 },
  form:     { label: "Form",        Icon: ClipboardList },
};

const BLOCK_GROUPS: { label: string; types: PageBlock["type"][] }[] = [
  { label: "Standard", types: ["headline", "text", "list", "button", "image", "video", "youtube"] },
  { label: "Layout",   types: ["divider", "spacer"] },
  { label: "Advanced", types: ["form", "html"] },
];

function newBlock(type: PageBlock["type"], firstFormId?: number): PageBlock {
  const id = blockUid();
  switch (type) {
    case "headline": return { id, type, text: "New headline", level: 1, align: "left" };
    case "text":     return { id, type, text: "Write something here…", align: "left" };
    case "image":    return { id, type, url: "", alt: "" };
    case "video":    return { id, type, url: "" };
    case "youtube":  return { id, type, url: "" };
    case "html":     return { id, type, html: "<p>Custom HTML…</p>" };
    case "form":     return { id, type, formId: firstFormId ?? 0 };
    case "button":   return { id, type, text: "Click me", url: "https://", style: "primary", align: "center" };
    case "divider":  return { id, type };
    case "spacer":   return { id, type, height: 32 };
    case "list":     return { id, type, items: ["First item", "Second item", "Third item"], style: "bullet" };
  }
}

function BlocksEditor({
  value, onChange, forms,
}: {
  value: BlocksContent;
  onChange: (v: BlocksContent) => void;
  forms: JourneyFormRecord[];
}) {
  const firstFormId = forms[0]?.id;
  const updateHeader = (patch: Partial<NonNullable<BlocksContent["header"]>>) =>
    onChange({ ...value, header: { show: false, ...value.header, ...patch } });
  const updateFooter = (patch: Partial<NonNullable<BlocksContent["footer"]>>) =>
    onChange({ ...value, footer: { show: false, ...value.footer, ...patch } });
  const replaceBlock = (id: string, patch: Partial<PageBlock>) =>
    onChange({ ...value, blocks: value.blocks.map(b => b.id === id ? ({ ...b, ...patch } as PageBlock) : b) });
  const removeBlock = (id: string) =>
    onChange({ ...value, blocks: value.blocks.filter(b => b.id !== id), template: "custom" });
  const moveBlock = (id: string, delta: -1 | 1) => {
    const idx = value.blocks.findIndex(b => b.id === id);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= value.blocks.length) return;
    const arr = [...value.blocks];
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    onChange({ ...value, blocks: arr, template: "custom" });
  };
  const addBlock = (type: PageBlock["type"]) =>
    onChange({ ...value, blocks: [...value.blocks, newBlock(type, firstFormId)], template: value.template ?? "custom" });

  // Template picker — shown when no template selected yet AND no blocks yet
  const showPicker = !value.template && value.blocks.length === 0;
  if (showPicker) {
    return (
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground">Pick a starting template — you can fully customize it after.</div>
        <div className="grid gap-2">
          {BLOCKS_TEMPLATES.map(t => {
            const Icon = t.Icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onChange(makeBlocksTemplate(t.id, firstFormId))}
                className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-indigo-400 hover:bg-indigo-50/40 text-left transition-colors"
              >
                <Icon className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.description}</div>
                </div>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_BLOCKS, template: "custom" })}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-2"
        >
          Start from scratch →
        </button>
      </div>
    );
  }

  const addMenuOptions: PageBlock["type"][] = ["headline", "text", "list", "button", "image", "video", "youtube", "divider", "spacer", "html", "form"];

  return (
    <div className="space-y-4">
      {/* Header config */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Header</Label>
          <Switch
            checked={!!value.header?.show}
            onCheckedChange={c => updateHeader({ show: c })}
          />
        </div>
        {value.header?.show && (
          <div className="space-y-2">
            <Input
              placeholder="Header title"
              value={value.header.title ?? ""}
              onChange={e => updateHeader({ title: e.target.value })}
            />
            <Input
              placeholder="Subtitle (optional)"
              value={value.header.subtitle ?? ""}
              onChange={e => updateHeader({ subtitle: e.target.value })}
            />
          </div>
        )}
      </div>

      {/* Blocks */}
      <div className="space-y-2">
        <Label className="text-xs font-medium">Blocks</Label>
        {value.blocks.length === 0 && (
          <div className="text-xs text-muted-foreground italic py-2">No blocks yet — add one below.</div>
        )}
        {value.blocks.map((b, i) => {
          const meta = BLOCK_TYPE_META[b.type];
          const Icon = meta.Icon;
          return (
            <div key={b.id} className="rounded-lg border bg-card p-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">{meta.label}</span>
                <div className="ml-auto flex items-center gap-0.5">
                  <button type="button" disabled={i === 0} onClick={() => moveBlock(b.id, -1)}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30">
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" disabled={i === value.blocks.length - 1} onClick={() => moveBlock(b.id, 1)}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => removeBlock(b.id)}
                    className="p-1 rounded hover:bg-red-50 text-red-600">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {b.type === "headline" && (
                <div className="space-y-1.5">
                  <Input value={b.text} onChange={e => replaceBlock(b.id, { text: e.target.value })} placeholder="Headline text" />
                  <Select value={String(b.level)} onValueChange={v => replaceBlock(b.id, { level: Number(v) as 1 | 2 | 3 })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">H1 — Large</SelectItem>
                      <SelectItem value="2">H2 — Medium</SelectItem>
                      <SelectItem value="3">H3 — Small</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {b.type === "text" && (
                <Textarea value={b.text} onChange={e => replaceBlock(b.id, { text: e.target.value })} rows={3} placeholder="Body text…" />
              )}
              {b.type === "image" && (
                <div className="space-y-1.5">
                  <Input value={b.url} onChange={e => replaceBlock(b.id, { url: e.target.value })} placeholder="Image URL" />
                  <Input value={b.alt ?? ""} onChange={e => replaceBlock(b.id, { alt: e.target.value })} placeholder="Alt text (optional)" />
                </div>
              )}
              {b.type === "video" && (
                <Input value={b.url} onChange={e => replaceBlock(b.id, { url: e.target.value })} placeholder="MP4 / video URL" />
              )}
              {b.type === "youtube" && (
                <Input value={b.url} onChange={e => replaceBlock(b.id, { url: e.target.value })} placeholder="https://www.youtube.com/watch?v=..." />
              )}
              {b.type === "html" && (
                <Textarea value={b.html} onChange={e => replaceBlock(b.id, { html: e.target.value })} rows={5}
                  className="font-mono text-xs" placeholder="<div>...</div>" />
              )}
              {b.type === "form" && (
                <Select value={String(b.formId || "")} onValueChange={v => replaceBlock(b.id, { formId: Number(v) })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={forms.length ? "Pick a form…" : "No forms yet — create one in Library → Forms"} />
                  </SelectTrigger>
                  <SelectContent>
                    {forms.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {b.type === "button" && (
                <div className="space-y-1.5">
                  <Input value={b.text} onChange={e => replaceBlock(b.id, { text: e.target.value })} placeholder="Button label" />
                  <Input value={b.url} onChange={e => replaceBlock(b.id, { url: e.target.value })} placeholder="https://…" />
                  <div className="grid grid-cols-2 gap-1.5">
                    <Select value={b.style} onValueChange={v => replaceBlock(b.id, { style: v as ButtonStyle })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="primary">Primary</SelectItem>
                        <SelectItem value="secondary">Secondary</SelectItem>
                        <SelectItem value="outline">Outline</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={b.align} onValueChange={v => replaceBlock(b.id, { align: v as BlockAlign })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="left">Left</SelectItem>
                        <SelectItem value="center">Center</SelectItem>
                        <SelectItem value="right">Right</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {b.type === "list" && (
                <div className="space-y-1.5">
                  <Select value={b.style} onValueChange={v => replaceBlock(b.id, { style: v as ListStyle })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bullet">Bulleted</SelectItem>
                      <SelectItem value="number">Numbered</SelectItem>
                    </SelectContent>
                  </Select>
                  <Textarea value={b.items.join("\n")} onChange={e => replaceBlock(b.id, { items: e.target.value.split("\n") })}
                    rows={4} placeholder="One item per line" />
                </div>
              )}
              {b.type === "spacer" && (
                <div className="flex items-center gap-2">
                  <Input type="number" min={4} max={400} value={b.height} onChange={e => replaceBlock(b.id, { height: Math.max(4, Number(e.target.value) || 32) })} className="w-24 h-8 text-xs" />
                  <span className="text-xs text-muted-foreground">px height</span>
                </div>
              )}
              {b.type === "divider" && (
                <p className="text-xs text-muted-foreground">A thin horizontal line.</p>
              )}
            </div>
          );
        })}

        {/* Add block menu */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {addMenuOptions.map(t => {
            const meta = BLOCK_TYPE_META[t];
            const Icon = meta.Icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => addBlock(t)}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-indigo-50 hover:border-indigo-400 transition-colors"
              >
                <Plus className="w-3 h-3" />
                <Icon className="w-3 h-3" />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer config */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium">Footer</Label>
          <Switch
            checked={!!value.footer?.show}
            onCheckedChange={c => updateFooter({ show: c })}
          />
        </div>
        {value.footer?.show && (
          <Input
            placeholder="Footer text"
            value={value.footer.text ?? ""}
            onChange={e => updateFooter({ text: e.target.value })}
          />
        )}
      </div>

      {/* Reset template */}
      {value.template && value.template !== "custom" && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_BLOCKS })}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Pick a different template
        </button>
      )}
    </div>
  );
}

// ── BlocksVisualBuilder ──────────────────────────────────────────────────────
function alignToClass(a?: BlockAlign) {
  return a === "center" ? "text-center" : a === "right" ? "text-right" : "text-left";
}

function BlockPreview({ block, forms }: { block: PageBlock; forms: JourneyFormRecord[] }) {
  if (block.type === "headline") {
    const cls = block.level === 1 ? "text-3xl font-bold tracking-tight"
              : block.level === 2 ? "text-2xl font-semibold tracking-tight"
              :                     "text-xl font-semibold";
    return <h2 className={cn(cls, alignToClass(block.align))}>{block.text || "Untitled headline"}</h2>;
  }
  if (block.type === "text") {
    return <p className={cn("text-base leading-relaxed whitespace-pre-wrap text-gray-700", alignToClass(block.align))}>{block.text || "Empty text block"}</p>;
  }
  if (block.type === "list") {
    const Tag = block.style === "number" ? "ol" : "ul";
    return (
      <Tag className={cn("pl-5 space-y-1 text-gray-700", block.style === "number" ? "list-decimal" : "list-disc")}>
        {(block.items.length ? block.items : ["Empty list"]).map((it, i) => <li key={i}>{it || <span className="text-gray-400">empty</span>}</li>)}
      </Tag>
    );
  }
  if (block.type === "button") {
    const styleCls = block.style === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700"
                   : block.style === "secondary" ? "bg-gray-900 text-white hover:bg-gray-800"
                   :                               "border border-indigo-600 text-indigo-600 hover:bg-indigo-50";
    const wrap = block.align === "center" ? "justify-center" : block.align === "right" ? "justify-end" : "justify-start";
    return (
      <div className={cn("flex", wrap)}>
        <span className={cn("inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg font-medium text-sm cursor-default", styleCls)}>
          {block.text || "Button"}
        </span>
      </div>
    );
  }
  if (block.type === "image") {
    if (!block.url) return <div className="h-40 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">Image placeholder — add a URL</div>;
    return <img src={block.url} alt={block.alt ?? ""} className="w-full rounded-lg" />;
  }
  if (block.type === "video") {
    const ytId = block.url ? block.url.match(/(?:youtu\.be\/|watch\?v=|embed\/)([^&?/]+)/)?.[1] : null;
    const isYt = ytId && /^[a-zA-Z0-9_-]{11}$/.test(ytId);
    if (isYt) {
      return (
        <div className="relative aspect-video rounded-lg overflow-hidden bg-black">
          <img src={`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`} alt="" className="w-full h-full object-cover opacity-80" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg">
              <span className="text-white text-base pl-0.5">▶</span>
            </div>
          </div>
        </div>
      );
    }
    if (!block.url) return <div className="aspect-video rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">Video placeholder</div>;
    return <video src={block.url} controls className="w-full aspect-video rounded-lg bg-black" />;
  }
  if (block.type === "youtube") {
    const ytId = block.url ? block.url.match(/(?:youtu\.be\/|watch\?v=|embed\/)([^&?/]+)/)?.[1] : null;
    const isYt = ytId && /^[a-zA-Z0-9_-]{11}$/.test(ytId);
    if (!isYt) return <div className="aspect-video rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400">YouTube URL not set</div>;
    return (
      <div className="relative aspect-video rounded-lg overflow-hidden bg-black">
        <img src={`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`} alt="" className="w-full h-full object-cover opacity-80" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-red-600/90 flex items-center justify-center shadow-lg">
            <span className="text-white text-base pl-0.5">▶</span>
          </div>
        </div>
      </div>
    );
  }
  if (block.type === "divider") return <hr className="border-t border-gray-200" />;
  if (block.type === "spacer") return <div style={{ height: block.height }} className="bg-indigo-50/30 border border-dashed border-indigo-200 rounded text-[10px] text-indigo-400 flex items-center justify-center">Spacer {block.height}px</div>;
  if (block.type === "html") return <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: block.html }} />;
  if (block.type === "form") {
    const f = forms.find(x => x.id === block.formId);
    return (
      <div className="rounded-xl border border-gray-200 p-4 bg-gray-50/60">
        <div className="text-xs font-semibold text-gray-600 mb-3">{f?.name || "Pick a form"}</div>
        {[0.7, 1, 0.6].map((w, i) => (
          <div key={i} style={{ width: `${w * 100}%` }} className="h-9 rounded-md bg-white border border-gray-200 mb-2" />
        ))}
        <div className="h-10 rounded-md bg-indigo-600 mt-3" />
      </div>
    );
  }
  return null;
}

function LinkSection({
  link, onChange, totalPages,
}: {
  link?: BlockLink;
  onChange: (link: BlockLink | undefined) => void;
  totalPages: number;
}) {
  return (
    <div className="pt-3 mt-1 border-t border-border">
      <div className="flex items-center justify-between mb-2">
        <Label className="text-xs font-semibold flex items-center gap-1.5">
          <Link2 className="w-3 h-3 text-indigo-500" /> Link
        </Label>
        <Switch
          checked={!!link}
          onCheckedChange={v =>
            v ? onChange({ kind: "url", url: "https://", newTab: true }) : onChange(undefined)
          }
        />
      </div>
      {link && (
        <div className="space-y-2">
          <Select
            value={link.kind}
            onValueChange={v =>
              v === "url"
                ? onChange({ kind: "url", url: "https://", newTab: true })
                : onChange({ kind: "page", pageIndex: 0 })
            }
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="url">External URL</SelectItem>
              <SelectItem value="page">Jump to page</SelectItem>
            </SelectContent>
          </Select>
          {link.kind === "url" && (
            <>
              <Input
                className="h-8 text-xs"
                value={link.url}
                onChange={e => onChange({ ...link, url: e.target.value })}
                placeholder="https://…"
              />
              <div className="flex items-center gap-2">
                <Switch
                  id="block-link-newtab"
                  checked={!!link.newTab}
                  onCheckedChange={v => onChange({ ...link, newTab: v })}
                />
                <Label htmlFor="block-link-newtab" className="text-xs cursor-pointer">Open in new tab</Label>
              </div>
            </>
          )}
          {link.kind === "page" && totalPages > 0 && (
            <Select
              value={String(link.pageIndex)}
              onValueChange={v => onChange({ kind: "page", pageIndex: Number(v) })}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: totalPages }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>Page {i + 1}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {link.kind === "page" && totalPages === 0 && (
            <p className="text-xs text-muted-foreground">No pages in this journey yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function BlockPropertyPanel({
  block, forms, onChange, totalPages,
}: {
  block: PageBlock;
  forms: JourneyFormRecord[];
  onChange: (patch: Partial<PageBlock>) => void;
  totalPages: number;
}) {
  const linkSec = (
    <LinkSection
      link={block.link}
      onChange={lnk => onChange({ link: lnk } as Partial<PageBlock>)}
      totalPages={totalPages}
    />
  );
  if (block.type === "headline") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Text</Label>
          <Input value={block.text} onChange={e => onChange({ text: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5"><Label className="text-xs">Level</Label>
            <Select value={String(block.level)} onValueChange={v => onChange({ level: Number(v) as 1 | 2 | 3 })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">H1</SelectItem><SelectItem value="2">H2</SelectItem><SelectItem value="3">H3</SelectItem>
              </SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label className="text-xs">Align</Label>
            <Select value={block.align ?? "left"} onValueChange={v => onChange({ align: v as BlockAlign })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="left">Left</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="right">Right</SelectItem>
              </SelectContent>
            </Select></div>
        </div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "text") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Body text</Label>
          <Textarea rows={6} value={block.text} onChange={e => onChange({ text: e.target.value })} /></div>
        <div className="space-y-1.5"><Label className="text-xs">Align</Label>
          <Select value={block.align ?? "left"} onValueChange={v => onChange({ align: v as BlockAlign })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Left</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select></div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "list") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Items (one per line)</Label>
          <Textarea rows={6} value={block.items.join("\n")} onChange={e => onChange({ items: e.target.value.split("\n") })} /></div>
        <div className="space-y-1.5"><Label className="text-xs">Style</Label>
          <Select value={block.style} onValueChange={v => onChange({ style: v as ListStyle })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="bullet">Bulleted</SelectItem><SelectItem value="number">Numbered</SelectItem>
            </SelectContent>
          </Select></div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "button") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Label</Label>
          <Input value={block.text} onChange={e => onChange({ text: e.target.value })} /></div>
        <div className="space-y-1.5"><Label className="text-xs">Link URL</Label>
          <Input value={block.url} onChange={e => onChange({ url: e.target.value })} placeholder="https://…" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5"><Label className="text-xs">Style</Label>
            <Select value={block.style} onValueChange={v => onChange({ style: v as ButtonStyle })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">Primary</SelectItem><SelectItem value="secondary">Secondary</SelectItem><SelectItem value="outline">Outline</SelectItem>
              </SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label className="text-xs">Align</Label>
            <Select value={block.align} onValueChange={v => onChange({ align: v as BlockAlign })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="left">Left</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="right">Right</SelectItem>
              </SelectContent>
            </Select></div>
        </div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "image") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Image URL</Label>
          <Input value={block.url} onChange={e => onChange({ url: e.target.value })} placeholder="https://…" /></div>
        <div className="space-y-1.5"><Label className="text-xs">Alt text</Label>
          <Input value={block.alt ?? ""} onChange={e => onChange({ alt: e.target.value })} /></div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "video" || block.type === "youtube") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">{block.type === "youtube" ? "YouTube URL" : "Video URL (MP4)"}</Label>
          <Input value={block.url} onChange={e => onChange({ url: e.target.value })} />
        </div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "spacer") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Height (px)</Label>
          <Input type="number" min={4} max={400} value={block.height} onChange={e => onChange({ height: Math.max(4, Number(e.target.value) || 32) })} />
        </div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "divider") {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">A thin horizontal line. No properties to configure.</p>
        {linkSec}
      </div>
    );
  }
  if (block.type === "html") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">HTML</Label>
          <Textarea rows={10} className="font-mono text-xs" value={block.html} onChange={e => onChange({ html: e.target.value })} />
        </div>
        {linkSec}
      </div>
    );
  }
  if (block.type === "form") {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5"><Label className="text-xs">Form</Label>
          <Select value={String(block.formId || "")} onValueChange={v => onChange({ formId: Number(v) })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={forms.length ? "Pick a form…" : "No forms yet — create one in Library → Forms"} />
            </SelectTrigger>
            <SelectContent>{forms.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {linkSec}
      </div>
    );
  }
  return linkSec;
}

function BlocksVisualBuilder({
  open, value, forms, onClose, onSave, totalPages,
}: {
  open: boolean;
  value: BlocksContent;
  forms: JourneyFormRecord[];
  onClose: () => void;
  onSave: (v: BlocksContent) => void;
  totalPages: number;
}) {
  const [draft, setDraft] = useState<BlocksContent>(value);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");

  useEffect(() => { if (open) { setDraft(value); setSelectedId(null); } }, [open, value]);

  const firstFormId = forms[0]?.id;
  const addBlock = (type: PageBlock["type"]) => {
    const nb = newBlock(type, firstFormId);
    setDraft(d => ({ ...d, blocks: [...d.blocks, nb], template: d.template ?? "custom" }));
    setSelectedId(nb.id);
  };
  const updateBlock = (id: string, patch: Partial<PageBlock>) =>
    setDraft(d => ({ ...d, blocks: d.blocks.map(b => b.id === id ? ({ ...b, ...patch } as PageBlock) : b) }));
  const moveBlock = (id: string, delta: -1 | 1) =>
    setDraft(d => {
      const idx = d.blocks.findIndex(b => b.id === id);
      if (idx < 0) return d;
      const next = idx + delta;
      if (next < 0 || next >= d.blocks.length) return d;
      const arr = [...d.blocks];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return { ...d, blocks: arr, template: "custom" };
    });
  const removeBlock = (id: string) => {
    setDraft(d => ({ ...d, blocks: d.blocks.filter(b => b.id !== id), template: "custom" }));
    setSelectedId(s => s === id ? null : s);
  };
  const duplicateBlock = (id: string) => {
    setDraft(d => {
      const idx = d.blocks.findIndex(b => b.id === id);
      if (idx < 0) return d;
      const copy = { ...d.blocks[idx], id: blockUid() } as PageBlock;
      const arr = [...d.blocks];
      arr.splice(idx + 1, 0, copy);
      return { ...d, blocks: arr, template: "custom" };
    });
  };

  const selected = draft.blocks.find(b => b.id === selectedId) ?? null;
  const canvasWidth = device === "desktop" ? "100%" : device === "tablet" ? 720 : 380;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[1280px] w-[96vw] h-[92vh] p-0 gap-0 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-12 px-4 border-b border-border bg-white flex items-center gap-3 shrink-0">
          <LayoutTemplate className="w-4 h-4 text-indigo-600" />
          <div className="text-sm font-semibold">Visual Page Builder</div>
          <div className="ml-auto flex items-center gap-1 p-0.5 rounded-md border border-border bg-gray-50">
            <button type="button" onClick={() => setDevice("desktop")}
              className={cn("p-1.5 rounded", device === "desktop" ? "bg-white shadow text-indigo-600" : "text-gray-500 hover:text-foreground")}>
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setDevice("tablet")}
              className={cn("p-1.5 rounded", device === "tablet" ? "bg-white shadow text-indigo-600" : "text-gray-500 hover:text-foreground")}>
              <Tablet className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setDevice("mobile")}
              className={cn("p-1.5 rounded", device === "mobile" ? "bg-white shadow text-indigo-600" : "text-gray-500 hover:text-foreground")}>
              <Smartphone className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700"
            onClick={() => { onSave(draft); onClose(); }}>
            <Save className="w-3.5 h-3.5 mr-1.5" /> Save
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0 bg-gray-100">
          {/* Left: block library */}
          <aside className="w-64 shrink-0 border-r border-border bg-white overflow-y-auto">
            <div className="p-3 border-b border-border">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Blocks</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">Click a block to add it to your page.</div>
            </div>
            {BLOCK_GROUPS.map(group => (
              <div key={group.label} className="p-3 border-b border-border last:border-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">{group.label}</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {group.types.map(t => {
                    const meta = BLOCK_TYPE_META[t];
                    const Icon = meta.Icon;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addBlock(t)}
                        className="flex flex-col items-center gap-1 p-2 rounded-md border border-border bg-white hover:border-indigo-400 hover:bg-indigo-50/40 transition-colors text-[10px] font-medium text-gray-700"
                      >
                        <Icon className="w-4 h-4 text-indigo-600" />
                        <span className="leading-tight text-center">{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>

          {/* Center: preview canvas */}
          <main className="flex-1 overflow-y-auto py-6 px-4">
            <div className="mx-auto bg-white rounded-xl shadow-sm border border-gray-200 transition-all"
              style={{ width: canvasWidth, maxWidth: "100%" }}>
              {draft.header?.show && (
                <header className="px-8 py-6 border-b border-gray-200">
                  {draft.header.title && <h1 className="text-2xl font-semibold tracking-tight">{draft.header.title}</h1>}
                  {draft.header.subtitle && <p className="mt-1 text-sm text-gray-500">{draft.header.subtitle}</p>}
                </header>
              )}
              <div className="p-6 sm:p-10 space-y-4 min-h-[400px]">
                {draft.blocks.length === 0 && (
                  <div className="py-16 text-center text-sm text-gray-400 border-2 border-dashed border-gray-200 rounded-lg">
                    Click any block on the left to add it here.
                  </div>
                )}
                {draft.blocks.map((b, i) => {
                  const isSel = selectedId === b.id;
                  return (
                    <div
                      key={b.id}
                      onClick={() => setSelectedId(b.id)}
                      className={cn(
                        "group relative rounded-md transition-all cursor-pointer p-2 -m-2",
                        isSel ? "ring-2 ring-indigo-500" : "hover:ring-1 hover:ring-indigo-200"
                      )}
                    >
                      <BlockPreview block={b} forms={forms} />
                      {b.link && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-indigo-600 font-medium">
                          <Link2 className="w-2.5 h-2.5 shrink-0" />
                          <span className="truncate">
                            {b.link.kind === "url" ? b.link.url : `→ Page ${b.link.pageIndex + 1}`}
                          </span>
                        </div>
                      )}
                      {isSel && (
                        <div className="absolute -top-3 -right-2 flex items-center gap-0.5 bg-white border border-gray-200 rounded-md shadow-sm px-1 py-0.5 z-10">
                          <button type="button" disabled={i === 0} onClick={e => { e.stopPropagation(); moveBlock(b.id, -1); }}
                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronUp className="w-3 h-3" /></button>
                          <button type="button" disabled={i === draft.blocks.length - 1} onClick={e => { e.stopPropagation(); moveBlock(b.id, 1); }}
                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronDown className="w-3 h-3" /></button>
                          <button type="button" onClick={e => { e.stopPropagation(); duplicateBlock(b.id); }}
                            className="p-1 rounded hover:bg-gray-100"><Copy className="w-3 h-3" /></button>
                          <button type="button" onClick={e => { e.stopPropagation(); removeBlock(b.id); }}
                            className="p-1 rounded hover:bg-red-50 text-red-600"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {draft.footer?.show && (
                <footer className="px-8 py-5 border-t border-gray-200 text-xs text-gray-500">
                  {draft.footer.text}
                </footer>
              )}
            </div>
          </main>

          {/* Right: property panel */}
          <aside className="w-80 shrink-0 border-l border-border bg-white overflow-y-auto">
            {selected ? (
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 pb-2 border-b border-border">
                  {(() => {
                    const Icon = BLOCK_TYPE_META[selected.type].Icon;
                    return <Icon className="w-4 h-4 text-indigo-600" />;
                  })()}
                  <div className="text-sm font-semibold">{BLOCK_TYPE_META[selected.type].label}</div>
                </div>
                <BlockPropertyPanel
                  block={selected}
                  forms={forms}
                  onChange={patch => updateBlock(selected.id, patch)}
                  totalPages={totalPages}
                />
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Page Settings</div>
                <div className="rounded-lg border border-border bg-gray-50/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Show header</Label>
                    <Switch checked={!!draft.header?.show} onCheckedChange={c => setDraft(d => ({ ...d, header: { ...d.header, show: c } }))} />
                  </div>
                  {draft.header?.show && (
                    <>
                      <Input placeholder="Header title" value={draft.header.title ?? ""}
                        onChange={e => setDraft(d => ({ ...d, header: { ...d.header, show: true, title: e.target.value } }))} />
                      <Input placeholder="Subtitle (optional)" value={draft.header.subtitle ?? ""}
                        onChange={e => setDraft(d => ({ ...d, header: { ...d.header, show: true, subtitle: e.target.value } }))} />
                    </>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-gray-50/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Show footer</Label>
                    <Switch checked={!!draft.footer?.show} onCheckedChange={c => setDraft(d => ({ ...d, footer: { ...d.footer, show: c } }))} />
                  </div>
                  {draft.footer?.show && (
                    <Input placeholder="Footer text" value={draft.footer.text ?? ""}
                      onChange={e => setDraft(d => ({ ...d, footer: { ...d.footer, show: true, text: e.target.value } }))} />
                  )}
                </div>
                <p className="text-xs text-muted-foreground pt-2">
                  Click any block in the preview to edit its properties here.
                </p>
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── VisualOverlayEditor ───────────────────────────────────────────────────────
const _clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function VisualOverlayEditor({
  hotspots, onChange, pageType, pageContent, totalPages, onClose,
}: {
  hotspots: HotspotItem[];
  onChange: (h: HotspotItem[]) => void;
  pageType: string;
  pageContent: string;
  totalPages: number;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(() => hotspots[0]?.id ?? null);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCur,   setDrawCur]   = useState<{ x: number; y: number } | null>(null);
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  function handleIframeLoad() {
    setPreviewLoading(false);
    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc || doc.body === null || doc.body.innerHTML.trim() === "") {
        setPreviewBlocked(true);
        return;
      }
      const text = (doc.body.textContent ?? "").trim();
      const isHttpError = /^(400|401|403|404|500|502|503|504)\b/.test(text) && text.length < 200;
      if (isHttpError) setPreviewBlocked(true);
    } catch {
      setPreviewBlocked(true);
    }
  }

  const [dragState, setDragState] = useState<{
    id: string;
    mode: "move" | "se" | "sw" | "ne" | "nw";
    spx: number; spy: number;
    ox: number; oy: number; ow: number; oh: number;
  } | null>(null);

  function pct(e: React.PointerEvent) {
    const r = containerRef.current!.getBoundingClientRect();
    return {
      px: _clamp(((e.clientX - r.left) / r.width)  * 100, 0, 100),
      py: _clamp(((e.clientY - r.top)  / r.height) * 100, 0, 100),
    };
  }

  function onBgDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).dataset.hs) return;
    e.preventDefault();
    const { px, py } = pct(e);
    setDrawStart({ x: px, y: py });
    setDrawCur({ x: px, y: py });
    setSelected(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onBgMove(e: React.PointerEvent<HTMLDivElement>) {
    if (dragState) {
      const { px, py } = pct(e);
      const dx = px - dragState.spx, dy = py - dragState.spy;
      onChange(hotspots.map(h => {
        if (h.id !== dragState.id) return h;
        if (dragState.mode === "move") {
          return { ...h, x: _clamp(dragState.ox + dx, 0, 100 - h.w), y: _clamp(dragState.oy + dy, 0, 100 - h.h) };
        }
        if (dragState.mode === "se") return { ...h, w: _clamp(dragState.ow + dx, 5, 100 - h.x), h: _clamp(dragState.oh + dy, 3, 100 - h.y) };
        if (dragState.mode === "sw") {
          const nw = _clamp(dragState.ow - dx, 5, dragState.ox + dragState.ow);
          return { ...h, x: _clamp(dragState.ox + dx, 0, dragState.ox + dragState.ow - 5), w: nw, h: _clamp(dragState.oh + dy, 3, 100 - h.y) };
        }
        if (dragState.mode === "ne") {
          const nh = _clamp(dragState.oh - dy, 3, dragState.oy + dragState.oh);
          return { ...h, y: _clamp(dragState.oy + dy, 0, dragState.oy + dragState.oh - 3), w: _clamp(dragState.ow + dx, 5, 100 - h.x), h: nh };
        }
        if (dragState.mode === "nw") {
          const nw = _clamp(dragState.ow - dx, 5, dragState.ox + dragState.ow);
          const nh = _clamp(dragState.oh - dy, 3, dragState.oy + dragState.oh);
          return { ...h, x: _clamp(dragState.ox + dx, 0, dragState.ox + dragState.ow - 5), y: _clamp(dragState.oy + dy, 0, dragState.oy + dragState.oh - 3), w: nw, h: nh };
        }
        return h;
      }));
      return;
    }
    if (drawStart) {
      const { px, py } = pct(e);
      setDrawCur({ x: px, y: py });
    }
  }

  function onBgUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragState) { setDragState(null); return; }
    if (drawStart && drawCur) {
      const x = Math.min(drawStart.x, drawCur.x), y = Math.min(drawStart.y, drawCur.y);
      const w = Math.abs(drawCur.x - drawStart.x), h = Math.abs(drawCur.y - drawStart.y);
      if (w > 3 && h > 2) {
        const id = `hs_${Math.random().toString(36).slice(2, 9)}`;
        const newH: HotspotItem = { id, label: "New overlay", x, y, w, h, link: { kind: "url", url: "", newTab: true } };
        onChange([...hotspots, newH]);
        setSelected(id);
      }
    }
    setDrawStart(null); setDrawCur(null);
  }

  function startDrag(e: React.PointerEvent, id: string, mode: "move" | "se" | "sw" | "ne" | "nw") {
    e.stopPropagation(); e.preventDefault();
    const { px, py } = pct(e);
    const h = hotspots.find(h => h.id === id)!;
    setDragState({ id, mode: mode as any, spx: px, spy: py, ox: h.x, oy: h.y, ow: h.w, oh: h.h });
    containerRef.current?.setPointerCapture(e.pointerId);
    setSelected(id);
  }

  function updateSel(patch: Partial<HotspotItem>) {
    if (!selected) return;
    onChange(hotspots.map(h => h.id === selected ? { ...h, ...patch } : h));
  }

  const sel = hotspots.find(h => h.id === selected);

  // Resolve the actual URL to proxy.
  // pageContent may be:
  //   (a) a bare URL  "https://example.com/page"
  //   (b) full iframe HTML  '<iframe src="https://example.com/page" ...></iframe>'
  //   (c) a relative path  "/api/storage/…"
  const resolvedProxyTarget = (() => {
    if (!pageContent) return "";
    // (a) already a valid absolute URL
    try { new URL(pageContent); return pageContent; } catch { /* not a bare URL */ }
    // (b) iframe/embed HTML — extract src="…"
    const srcMatch = pageContent.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
      const src = srcMatch[1];
      try { new URL(src); return src; } catch { /* relative src */ }
      return window.location.origin + (src.startsWith("/") ? src : `/${src}`);
    }
    // (c) relative path — make absolute
    return window.location.origin + (pageContent.startsWith("/") ? pageContent : `/${pageContent}`);
  })();
  const proxyUrl = resolvedProxyTarget ? `/api/proxy-embed?url=${encodeURIComponent(resolvedProxyTarget)}` : "";

  let contentEl: React.ReactNode;
  if (pageType === "iframe" || pageType === "pdf") {
    contentEl = proxyUrl ? (
      <iframe
        ref={iframeRef}
        src={proxyUrl}
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        title="page preview"
        onLoad={handleIframeLoad}
        onError={() => { setPreviewLoading(false); setPreviewBlocked(true); }}
      />
    ) : null;
  } else if (pageType === "youtube") {
    const vid = pageContent.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
    contentEl = vid ? (
      <iframe
        ref={iframeRef}
        src={`https://www.youtube.com/embed/${vid}`}
        className="w-full h-full border-0"
        title="youtube preview"
        onLoad={handleIframeLoad}
      />
    ) : null;
  } else if (pageType === "html") {
    contentEl = (
      <iframe
        ref={iframeRef}
        srcDoc={pageContent}
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin"
        title="html preview"
        onLoad={handleIframeLoad}
      />
    );
  } else if (pageType === "infographic") {
    contentEl = <img src={pageContent} className="w-full h-full object-contain" alt="page content" onLoad={() => setPreviewLoading(false)} />;
  } else {
    contentEl = (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <MousePointer className="w-5 h-5" />
        Preview not available for this page type — use the position fields to place overlays
      </div>
    );
  }

  const CORNERS: { key: "se"|"sw"|"ne"|"nw"; style: React.CSSProperties; cur: string }[] = [
    { key:"se", style:{ right:"-5px", bottom:"-5px" }, cur:"nwse-resize" },
    { key:"sw", style:{ left:"-5px",  bottom:"-5px" }, cur:"nesw-resize" },
    { key:"ne", style:{ right:"-5px", top:"-5px"    }, cur:"nesw-resize" },
    { key:"nw", style:{ left:"-5px",  top:"-5px"    }, cur:"nwse-resize" },
  ];

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-[92vw] w-[92vw] h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        <div className="px-4 py-2 border-b shrink-0 flex items-center justify-between bg-white">
          <div>
            <p className="text-sm font-semibold">Visual Overlay Editor</p>
            <p className="text-[11px] text-muted-foreground">Drag on the preview to draw a zone · Drag a zone to move it · Corner handles to resize</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-muted transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* ── Preview canvas ── */}
          <div
            ref={containerRef}
            className="flex-1 relative overflow-hidden bg-white select-none"
            style={{ cursor: dragState ? "grabbing" : "crosshair" }}
            onPointerDown={onBgDown}
            onPointerMove={onBgMove}
            onPointerUp={onBgUp}
          >
            {/* Page content — pointer-events:none so canvas captures all events */}
            <div className="absolute inset-0" style={{ pointerEvents: "none", visibility: previewBlocked ? "hidden" : "visible" }}>
              {contentEl}
            </div>

            {/* Loading spinner */}
            {previewLoading && !previewBlocked && (pageType === "iframe" || pageType === "pdf" || pageType === "youtube" || pageType === "html") && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50 pointer-events-none z-10">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              </div>
            )}

            {/* Blocked/blank — full overlay so raw HTTP error text is never visible */}
            {previewBlocked && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-gray-50">
                <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                  <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                    <EyeOff className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Preview unavailable</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      This page's security settings prevent it from being previewed here.
                      You can still draw overlay zones using the position fields on the right.
                    </p>
                  </div>
                  {(pageType === "iframe" || pageType === "pdf") && pageContent && (
                    <a
                      href={pageContent}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors"
                    >
                      Open page in new tab ↗
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Hotspot overlays */}
            {hotspots.map(h => {
              const isSel = selected === h.id;
              return (
                <div
                  key={h.id}
                  data-hs={h.id}
                  className={cn(
                    "absolute rounded flex items-center justify-center transition-colors",
                    isSel
                      ? "bg-indigo-500/20 shadow-lg"
                      : "bg-indigo-500/10 hover:bg-indigo-500/20",
                  )}
                  style={{
                    left:`${h.x}%`, top:`${h.y}%`, width:`${h.w}%`, height:`${h.h}%`,
                    cursor:"move",
                    border: isSel ? "2px solid #6366f1" : "2px solid rgba(99,102,241,0.7)",
                    boxShadow: "0 0 0 1px rgba(255,255,255,0.8)",
                  }}
                  onPointerDown={e => startDrag(e, h.id, "move")}
                  onClick={e => { e.stopPropagation(); setSelected(h.id); }}
                >
                  <span
                    className="text-[10px] font-bold px-1 truncate max-w-full pointer-events-none select-none"
                    style={{ color: "#6366f1", textShadow: "0 0 3px white, 0 0 6px white" }}
                  >
                    {h.label || "overlay"}
                  </span>
                  {isSel && CORNERS.map(({ key, style, cur }) => (
                    <div
                      key={key}
                      data-hs={h.id}
                      className="absolute w-3 h-3 bg-white border-2 border-indigo-500 rounded-sm shadow-md"
                      style={{ ...style, cursor: cur }}
                      onPointerDown={e => startDrag(e, h.id, key)}
                    />
                  ))}
                </div>
              );
            })}

            {/* Drawing ghost */}
            {drawStart && drawCur && (
              <div
                className="absolute border-2 border-dashed border-indigo-500 bg-indigo-500/10 rounded pointer-events-none"
                style={{
                  left:   `${Math.min(drawStart.x, drawCur.x)}%`,
                  top:    `${Math.min(drawStart.y, drawCur.y)}%`,
                  width:  `${Math.abs(drawCur.x - drawStart.x)}%`,
                  height: `${Math.abs(drawCur.y - drawStart.y)}%`,
                  boxShadow: "0 0 0 1px rgba(255,255,255,0.8)",
                }}
              />
            )}

            {/* Empty state hint */}
            {hotspots.length === 0 && !drawStart && !previewLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-end pb-8 pointer-events-none">
                <div className="bg-black/70 text-white text-xs px-3 py-1.5 rounded-full shadow">
                  Click and drag on the page to draw your first overlay zone
                </div>
              </div>
            )}
          </div>

          {/* ── Side panel ── */}
          <div className="w-72 shrink-0 border-l bg-white flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Zones ({hotspots.length})
              </span>
              <button
                type="button"
                onClick={() => {
                  const id = `hs_${Math.random().toString(36).slice(2, 9)}`;
                  onChange([...hotspots, { id, label: "New overlay", x: 25, y: 25, w: 50, h: 20, link: { kind: "url", url: "", newTab: true } }]);
                  setSelected(id);
                }}
                className="flex items-center gap-1 text-xs text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded transition-colors"
              >
                <PlusCircle className="w-3.5 h-3.5" /> Add
              </button>
            </div>

            {/* Zone list */}
            <div className="overflow-y-auto flex-1 divide-y">
              {hotspots.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <MousePointer className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  <p>Draw zones on the left</p>
                  <p className="text-xs mt-1 opacity-70">or click Add to create one</p>
                </div>
              )}
              {hotspots.map(h => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelected(h.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 transition-colors hover:bg-muted/50",
                    selected === h.id && "bg-indigo-50 border-l-[3px] border-indigo-500 pl-[9px]",
                  )}
                >
                  <div className="text-xs font-medium truncate">{h.label || "Unnamed"}</div>
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {h.link.kind === "url" ? (h.link.url || "No URL set") : `→ Page ${h.link.pageIndex + 1}`}
                  </div>
                </button>
              ))}
            </div>

            {/* Selected zone editor */}
            {sel && (
              <div className="border-t p-3 space-y-3 overflow-y-auto shrink-0 max-h-[55vh]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Edit zone</span>
                  <button
                    type="button"
                    onClick={() => { onChange(hotspots.filter(h => h.id !== selected)); setSelected(null); }}
                    className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Action — first and most prominent */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Action</Label>
                  <div className="flex gap-1.5">
                    <button type="button"
                      onClick={() => updateSel({ link: { kind: "url", url: sel.link.kind === "url" ? sel.link.url : "", newTab: true } })}
                      className={cn("flex-1 text-xs py-1.5 rounded-lg border transition-all",
                        sel.link.kind === "url" ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-medium" : "hover:bg-muted/50 text-muted-foreground")}>
                      External URL
                    </button>
                    <button type="button"
                      onClick={() => updateSel({ link: { kind: "page", pageIndex: sel.link.kind === "page" ? sel.link.pageIndex : 0 } })}
                      className={cn("flex-1 text-xs py-1.5 rounded-lg border transition-all",
                        sel.link.kind === "page" ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-medium" : "hover:bg-muted/50 text-muted-foreground")}>
                      Jump to Page
                    </button>
                  </div>
                  {sel.link.kind === "url" && (
                    <div className="space-y-1.5">
                      <Input className="h-7 text-xs" placeholder="https://..."
                        value={sel.link.url}
                        onChange={e => updateSel({ link: { kind: "url", url: e.target.value, newTab: (sel.link as any).newTab ?? true } })} />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input type="checkbox"
                          checked={(sel.link as any).newTab ?? true}
                          onChange={ev => updateSel({ link: { kind: "url", url: (sel.link as any).url, newTab: ev.target.checked } })}
                          className="w-3 h-3 accent-indigo-600" />
                        Open in new tab
                      </label>
                    </div>
                  )}
                  {sel.link.kind === "page" && (
                    <select
                      className="w-full h-8 text-xs border rounded-md px-2 bg-background"
                      value={(sel.link as any).pageIndex}
                      onChange={e => updateSel({ link: { kind: "page", pageIndex: Number(e.target.value) } })}>
                      {Array.from({ length: Math.max(totalPages, 1) }, (_, i) => (
                        <option key={i} value={i}>Page {i + 1}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Label */}
                <div className="space-y-1">
                  <Label className="text-xs">Label</Label>
                  <Input className="h-7 text-xs" value={sel.label}
                    onChange={e => updateSel({ label: e.target.value })}
                    placeholder="e.g. CTA button area" />
                </div>

                {/* Position — fine-tuning */}
                <div>
                  <Label className="text-xs">Position & Size (% of page)</Label>
                  <div className="grid grid-cols-4 gap-1 mt-1">
                    {(["x","y","w","h"] as const).map(f => (
                      <div key={f} className="space-y-0.5">
                        <div className="text-[9px] text-center text-muted-foreground">
                          {f === "x" ? "Left%" : f === "y" ? "Top%" : f === "w" ? "W%" : "H%"}
                        </div>
                        <Input type="number" min={0} max={100} className="h-6 text-xs text-center px-1"
                          value={Math.round(sel[f])}
                          onChange={e => updateSel({ [f]: _clamp(Number(e.target.value), 0, 100) })} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── HotspotsEditor ────────────────────────────────────────────────────────────
function HotspotsEditor({
  hotspots, onChange, totalPages, pageType, pageContent,
}: {
  hotspots: HotspotItem[];
  onChange: (h: HotspotItem[]) => void;
  totalPages: number;
  pageType?: string;
  pageContent?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visualOpen, setVisualOpen] = useState(false);

  const add = () => {
    const id = `hs_${Math.random().toString(36).slice(2, 9)}`;
    const newH: HotspotItem = { id, label: "Clickable Area", x: 25, y: 25, w: 50, h: 20, link: { kind: "url", url: "", newTab: true } };
    onChange([...hotspots, newH]);
    setExpanded(id);
    setOpen(true);
  };

  const update = (id: string, patch: Partial<HotspotItem>) =>
    onChange(hotspots.map(h => h.id === id ? { ...h, ...patch } : h));

  const remove = (id: string) => {
    onChange(hotspots.filter(h => h.id !== id));
    if (expanded === id) setExpanded(null);
  };

  const canVisual = !!pageType && !!pageContent && pageType !== "blocks";

  return (
    <>
    {visualOpen && canVisual && (
      <VisualOverlayEditor
        hotspots={hotspots}
        onChange={onChange}
        pageType={pageType!}
        pageContent={pageContent!}
        totalPages={totalPages}
        onClose={() => setVisualOpen(false)}
      />
    )}
    <div className="border rounded-lg bg-muted/20 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <MousePointer className="w-4 h-4 text-indigo-600" />
          <div>
            <div className="text-sm font-medium">Link Overlays</div>
            <div className="text-xs text-muted-foreground">
              {hotspots.length === 0
                ? "Add clickable regions over any part of this page"
                : `${hotspots.length} overlay${hotspots.length !== 1 ? "s" : ""} defined`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canVisual && (
            <button
              type="button"
              title="Open visual overlay editor"
              onClick={e => { e.stopPropagation(); setVisualOpen(true); setOpen(true); }}
              className="flex items-center gap-1 text-[11px] text-indigo-600 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded-full transition-colors"
            >
              <Maximize2 className="w-3 h-3" /> Edit visually
            </button>
          )}
          {hotspots.length > 0 && (
            <Badge variant="secondary" className="text-xs font-normal">{hotspots.length}</Badge>
          )}
          <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {open && (
        <div className="border-t divide-y">
          {hotspots.length === 0 && (
            <div className="px-4 py-6 text-center">
              <MousePointer className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No overlays yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1 mb-3">
                Define clickable zones on top of this page — works for iframe, embed, PDF, YouTube, image, and block pages.
              </p>
              {canVisual && (
                <button type="button" onClick={() => setVisualOpen(true)}
                  className="inline-flex items-center gap-1.5 text-xs text-indigo-600 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors">
                  <Maximize2 className="w-3.5 h-3.5" /> Open visual editor
                </button>
              )}
            </div>
          )}

          {hotspots.map(h => (
            <div key={h.id} className="px-4 py-3 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative w-16 h-9 bg-muted rounded border shrink-0 overflow-hidden">
                  <div
                    className="absolute bg-indigo-500/40 border border-indigo-500 rounded-sm"
                    style={{ left: `${h.x}%`, top: `${h.y}%`, width: `${h.w}%`, height: `${h.h}%` }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{h.label || "Unnamed"}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {h.link.kind === "url" ? (h.link.url || "No URL set") : `→ Page ${h.link.pageIndex + 1}`}
                  </div>
                </div>
                <button type="button" onClick={() => setExpanded(expanded === h.id ? null : h.id)}
                  className="p-1 rounded hover:bg-muted shrink-0">
                  <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", expanded === h.id && "rotate-180")} />
                </button>
                <button type="button" onClick={() => remove(h.id)}
                  className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500 shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {expanded === h.id && (
                <div className="space-y-3 pt-1">
                  {/* Action — top position so it's always visible without scrolling */}
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold">Action</Label>
                    <div className="flex gap-1.5">
                      <button type="button"
                        onClick={() => update(h.id, { link: { kind: "url", url: h.link.kind === "url" ? h.link.url : "", newTab: true } })}
                        className={cn("flex-1 text-xs py-1.5 rounded-lg border transition-all",
                          h.link.kind === "url" ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-medium" : "hover:bg-muted/50 text-muted-foreground")}>
                        External URL
                      </button>
                      <button type="button"
                        onClick={() => update(h.id, { link: { kind: "page", pageIndex: h.link.kind === "page" ? h.link.pageIndex : 0 } })}
                        className={cn("flex-1 text-xs py-1.5 rounded-lg border transition-all",
                          h.link.kind === "page" ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-medium" : "hover:bg-muted/50 text-muted-foreground")}>
                        Jump to Page
                      </button>
                    </div>
                    {h.link.kind === "url" && (
                      <div className="space-y-1.5">
                        <Input className="h-7 text-xs" placeholder="https://..."
                          value={h.link.kind === "url" ? h.link.url : ""}
                          onChange={e => update(h.id, { link: { kind: "url", url: e.target.value, newTab: h.link.kind === "url" ? (h.link.newTab ?? true) : true } })} />
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                          <input type="checkbox"
                            checked={h.link.kind === "url" ? (h.link.newTab ?? true) : true}
                            onChange={ev => update(h.id, { link: { kind: "url", url: h.link.kind === "url" ? h.link.url : "", newTab: ev.target.checked } })}
                            className="w-3 h-3 accent-indigo-600" />
                          Open in new tab
                        </label>
                      </div>
                    )}
                    {h.link.kind === "page" && (
                      <select
                        className="w-full h-8 text-xs border rounded-md px-2 bg-background"
                        value={(h.link as { kind: "page"; pageIndex: number }).pageIndex}
                        onChange={e => update(h.id, { link: { kind: "page", pageIndex: Number(e.target.value) } })}>
                        {Array.from({ length: Math.max(totalPages, 1) }, (_, i) => (
                          <option key={i} value={i}>Page {i + 1}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="space-y-1 pt-1 border-t">
                    <Label className="text-xs">Label</Label>
                    <Input className="h-7 text-xs" value={h.label}
                      onChange={e => update(h.id, { label: e.target.value })}
                      placeholder="e.g. CTA button area" />
                  </div>

                  <div>
                    <Label className="text-xs">Position & Size (% of page)</Label>
                    <div className="grid grid-cols-4 gap-1.5 mt-1">
                      {([
                        { f: "x" as const, label: "Left %" },
                        { f: "y" as const, label: "Top %" },
                        { f: "w" as const, label: "Width %" },
                        { f: "h" as const, label: "Height %" },
                      ]).map(({ f, label: fl }) => (
                        <div key={f} className="space-y-0.5">
                          <div className="text-[9px] text-center text-muted-foreground">{fl}</div>
                          <Input type="number" min={0} max={100} className="h-6 text-xs text-center px-1"
                            value={h[f]}
                            onChange={e => update(h.id, { [f]: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {canVisual && (
                    <button type="button" onClick={() => { setVisualOpen(true); }}
                      className="w-full flex items-center justify-center gap-1.5 text-xs text-indigo-600 border border-dashed border-indigo-200 rounded-lg py-1.5 hover:bg-indigo-50 transition-colors">
                      <Maximize2 className="w-3 h-3" /> Position visually
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}

          <div className="px-4 py-3">
            <button type="button" onClick={add}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-indigo-600 border border-dashed border-indigo-300 rounded-lg py-2 hover:bg-indigo-50 transition-colors">
              <PlusCircle className="w-3.5 h-3.5" />
              Add Link Overlay
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

// ── PageEditor ────────────────────────────────────────────────────────────────
interface PageFormState {
  title: string;
  pageType: PageType;
  content: string;
  hotspots: HotspotItem[];
  ctaEnabled: boolean;
  ctaText: string;
  ctaType: "next" | "url" | "page" | "download" | "gated_download";
  ctaAssetUrl: string;
  score: number;
  pageStage: string;
  sortOrder: number;
  isPublished: boolean;
  gatingAction: "none" | "form_submit" | "cta_click";
  biCategory: string; biProduct: string; biProgram: string;
}

function PageEditor({
  open, page, journeyId, stages, journeySlug, clientSlug, pageIndex,
  onClose, onSaved, isDarkTheme,
}: {
  open: boolean;
  page: JourneyPage | null;
  journeyId: number;
  stages: StageConfig[];
  journeySlug: string;
  clientSlug: string;
  pageIndex: number;
  isDarkTheme?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<PageFormState>({
    title: "", pageType: "youtube", content: "", hotspots: [], ctaEnabled: false, ctaText: "",
    ctaType: "next", ctaAssetUrl: "",
    score: 0, pageStage: "", sortOrder: 0, isPublished: true, gatingAction: "none",
    biCategory: "", biProduct: "", biProgram: "",
  });
  const [pdfUploading, setPdfUploading] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [assetUploading, setAssetUploading] = useState(false);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaPickerField, setMediaPickerField] = useState<"content" | "ctaAssetUrl">("content");

  const [addCompOpen, setAddCompOpen] = useState(false);
  const [compSectionOpen, setCompSectionOpen] = useState(true);
  const [localComps, setLocalComps] = useState<PageComponentRecord[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDark, setPreviewDark] = useState(isDarkTheme ?? true);
  useEffect(() => { setPreviewDark(isDarkTheme ?? true); }, [isDarkTheme]);
  const [visualBuilderOpen, setVisualBuilderOpen] = useState(false);
  const compSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const { data: mediaAssets = [] } = useQuery<MediaAsset[]>({
    queryKey: ["media"],
    queryFn: () => fetch("/api/media", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: forms = [] } = useQuery<JourneyFormRecord[]>({
    queryKey: ["journey-forms"],
    queryFn: () => fetch("/api/journey-forms", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: ctaButtons = [] } = useQuery<CtaButtonItem[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: banners = [] } = useQuery<BannerItem[]>({
    queryKey: ["banners"],
    queryFn: () => fetch("/api/banners", { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: journeyPages = [] } = useQuery<{ id: number; title: string; sortOrder: number }[]>({
    queryKey: ["journey-pages-list", journeyId],
    queryFn: () => fetch(`/api/journeys/${journeyId}/pages`, { credentials: "include" }).then(r => r.json()),
    enabled: open,
  });
  const { data: pageComponents, refetch: refetchComponents } = useQuery<PageComponentRecord[]>({
    queryKey: ["page-components", page?.id],
    queryFn: async () => {
      if (!page?.id) return [];
      const r = await fetch(`/api/page-components?pageId=${page.id}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: open && !!page?.id,
  });

  useEffect(() => {
    setLocalComps([...(pageComponents ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
  }, [pageComponents]);

  useEffect(() => {
    if (open) {
      const rawContent = page?.content ?? "";
      const pageType = (page?.pageType ?? "youtube") as PageType;
      let initContent = rawContent;
      let initHotspots: HotspotItem[] = [];
      if (pageType === "blocks") {
        initHotspots = parseBlocks(rawContent).hotspots ?? [];
      } else {
        const parsed = parseNonBlocksContent(rawContent);
        initContent = parsed.rawValue;
        initHotspots = parsed.hotspots;
      }
      setForm({
        title: page?.title ?? "",
        pageType,
        content: initContent,
        hotspots: initHotspots,
        ctaEnabled: page?.ctaEnabled ?? false,
        ctaText: page?.ctaText ?? "",
        ctaType: (page?.ctaType as PageFormState["ctaType"]) ?? "next",
        ctaAssetUrl: page?.ctaAssetUrl ?? "",
        score: page?.score ?? 0,
        pageStage: page?.pageStage ?? "",
        biCategory: page?.biCategory ?? "", biProduct: page?.biProduct ?? "", biProgram: page?.biProgram ?? "",
        sortOrder: page?.sortOrder ?? 0,
        isPublished: page?.isPublished ?? true,
        gatingAction: (page?.gatingAction as PageFormState["gatingAction"]) ?? "none",
      });
    }
  }, [open, page]);

  const isEdit = !!page;

  const mutation = useMutation({
    mutationFn: async (data: PageFormState) => {
      const finalContent = (() => {
        if (data.pageType === "blocks") {
          const parsed = parseBlocks(data.content);
          if (data.hotspots.length > 0) {
            return JSON.stringify({ ...parsed, hotspots: data.hotspots });
          }
          return data.content || null;
        }
        if (data.hotspots.length > 0) {
          const key = data.pageType === "html" ? "html" : "url";
          return JSON.stringify({ [key]: data.content, hotspots: data.hotspots });
        }
        return data.content || null;
      })();
      const corePayload = {
        title: data.title,
        pageType: data.pageType,
        content: finalContent,
        ctaEnabled: data.ctaEnabled,
        ctaText: data.ctaText || null,
      };
      const settingsPayload = {
        score: data.score,
        pageStage: data.pageStage || null,
        biCategory: data.biCategory || null, biProduct: data.biProduct || null, biProgram: data.biProgram || null,
        sortOrder: data.sortOrder,
        isPublished: data.isPublished,
        ctaType: data.ctaType,
        ctaAssetUrl: data.ctaAssetUrl || null,
        gatingAction: data.gatingAction,
      };

      let savedPage: any;
      if (isEdit) {
        const r = await fetch(`/api/journeys/pages/${page!.id}`, {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corePayload),
        });
        if (!r.ok) throw new Error(await r.text());
        savedPage = await r.json();
        const r2 = await fetch(`/api/journeys/pages/${page!.id}/settings`, {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settingsPayload),
        });
        if (!r2.ok) throw new Error(await r2.text());
      } else {
        const r = await fetch(`/api/journeys/${journeyId}/pages`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...corePayload, sortOrder: data.sortOrder || 999 }),
        });
        if (!r.ok) throw new Error(await r.text());
        savedPage = await r.json();
        await fetch(`/api/journeys/pages/${savedPage.id}/settings`, {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settingsPayload),
        });
      }
      return savedPage;
    },
    onSuccess: () => {
      toast({ title: isEdit ? "Page updated" : "Page added" });
      onSaved();
      onClose();
    },
    onError: () => toast({ title: "Failed to save page", variant: "destructive" }),
  });

  const contentLabel: Record<PageType, string> = {
    youtube: "YouTube URL", pdf: "PDF URL", iframe: "Embed URL",
    html: "HTML Content", infographic: "Image URL", blocks: "Page Layout",
  };
  const contentPlaceholder: Record<PageType, string> = {
    youtube: "https://www.youtube.com/watch?v=...",
    pdf: "https://example.com/document.pdf",
    iframe: "https://example.com/content",
    html: "<h2>Welcome</h2><p>Your content here...</p>",
    infographic: "https://example.com/image.png",
    blocks: "",
  };

  return (
    <>
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="flex-row items-center justify-between space-y-0">
          <SheetTitle>{isEdit ? "Edit Page" : "Add Page"}</SheetTitle>
          {isEdit && journeySlug && (
            pageIndex >= 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const base = clientSlug ? `/${clientSlug}/play/${journeySlug}` : `/play/${journeySlug}`;
                  window.open(`${base}/${toPageSlug(page.title ?? "", pageIndex)}`, "_blank");
                }}
                className="gap-1.5 text-xs h-7 text-muted-foreground hover:text-indigo-600 shrink-0"
                title="Open this page in the public viewer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Preview in viewer
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled
                className="gap-1.5 text-xs h-7 shrink-0 opacity-40 cursor-not-allowed"
                title="This page is hidden — publish it to preview in the viewer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Preview in viewer
              </Button>
            )
          )}
        </SheetHeader>

        <div className="space-y-5 py-5">

          {/* ── Visibility toggle ── */}
          <div className={cn(
            "border rounded-lg p-4 flex items-center justify-between",
            form.isPublished ? "bg-muted/20" : "bg-amber-50 border-amber-200",
          )}>
            <div>
              <div className="text-sm font-medium flex items-center gap-1.5">
                {form.isPublished
                  ? <Eye className="w-4 h-4 text-emerald-600" />
                  : <EyeOff className="w-4 h-4 text-amber-600" />}
                {form.isPublished ? "Page Visible" : "Page Hidden"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {form.isPublished
                  ? "Visitors can see this page"
                  : "This page is hidden from visitors"}
              </div>
            </div>
            <Switch
              checked={form.isPublished}
              onCheckedChange={v => setForm(f => ({ ...f, isPublished: v }))}
            />
          </div>

          {/* ── Page Title ── */}
          <div className="space-y-2">
            <Label>Page Title <span className="text-destructive">*</span></Label>
            <Input
              placeholder="e.g. Product Overview Video"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            />
          </div>

          {/* ── Page Type ── */}
          <div className="space-y-2">
            <Label>Page Type</Label>
            <div className="grid grid-cols-1 gap-2">
              {PAGE_TYPES.map(pt => {
                const Icon = pt.icon;
                return (
                  <button
                    key={pt.type}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, pageType: pt.type }))}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                      form.pageType === pt.type
                        ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                        : "border-border hover:border-muted-foreground/40 hover:bg-muted/30",
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0", pt.color)} />
                    <div>
                      <div className="text-sm font-medium">{pt.label}</div>
                      <div className="text-xs text-muted-foreground">{pt.description}</div>
                    </div>
                    {form.pageType === pt.type && <CheckCircle2 className="w-4 h-4 text-indigo-600 ml-auto" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Content ── */}
          <div className="space-y-2">
            <Label>{contentLabel[form.pageType]}</Label>
            {form.pageType === "blocks" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 p-2.5">
                  <div className="flex items-center gap-2">
                    <LayoutTemplate className="w-4 h-4 text-indigo-600" />
                    <div>
                      <div className="text-xs font-semibold text-indigo-900">Visual Page Builder</div>
                      <div className="text-[11px] text-indigo-700/80">Side-by-side block library and live preview.</div>
                    </div>
                  </div>
                  <Button type="button" size="sm" className="bg-indigo-600 hover:bg-indigo-700 h-7"
                    onClick={() => setVisualBuilderOpen(true)}>
                    Open builder
                  </Button>
                </div>
                <BlocksEditor
                  value={parseBlocks(form.content)}
                  onChange={v => setForm(f => ({ ...f, content: JSON.stringify(v) }))}
                  forms={forms}
                />
                <BlocksVisualBuilder
                  open={visualBuilderOpen}
                  value={parseBlocks(form.content)}
                  forms={forms}
                  totalPages={journeyPages.length}
                  onClose={() => setVisualBuilderOpen(false)}
                  onSave={v => setForm(f => ({ ...f, content: JSON.stringify(v) }))}
                />
                <PersonalizationTokenHint />
              </div>
            ) : form.pageType === "html" ? (
              <>
                <Textarea
                  placeholder={contentPlaceholder[form.pageType]}
                  value={form.content}
                  onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                  rows={6}
                  className="font-mono text-xs"
                />
                <PersonalizationTokenHint />
              </>
            ) : form.pageType === "iframe" ? (
              <Textarea
                placeholder={contentPlaceholder[form.pageType]}
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                rows={4}
                className="font-mono text-xs"
              />
            ) : (
              <Input
                placeholder={contentPlaceholder[form.pageType]}
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
              />
            )}
            {form.pageType === "iframe" && (
              <p className="text-[11px] text-muted-foreground">
                Paste a URL <em>or</em> a full <code>&lt;iframe …&gt;</code> embed snippet — both are supported. Embed snippets keep their original width, height, and other attributes.
              </p>
            )}

            {/* ── Browse media library (for PDF / image / embed) ── */}
            {(form.pageType === "pdf" || form.pageType === "infographic" || form.pageType === "iframe") && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">or</span>
                <button
                  type="button"
                  onClick={() => { setMediaPickerField("content"); setMediaPickerOpen(true); }}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border bg-muted/30 hover:bg-muted/60 text-foreground transition-colors"
                >
                  <FolderOpen className="w-3.5 h-3.5" /> Browse Media Library
                </button>
              </div>
            )}

            {/* ── PDF upload shortcut ── */}
            {form.pageType === "pdf" && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">or</span>
                <button
                  type="button"
                  disabled={pdfUploading}
                  onClick={() => pdfInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border bg-muted/30 hover:bg-muted/60 text-foreground transition-colors disabled:opacity-50"
                >
                  {pdfUploading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Upload className="w-3.5 h-3.5" />}
                  {pdfUploading ? "Uploading…" : "Upload PDF from disk"}
                </button>
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={async e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setPdfUploading(true);
                    try {
                      // Step 1: request a signed upload URL
                      const urlRes = await fetch("/api/storage/uploads/request-url", {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/pdf" }),
                      });
                      if (!urlRes.ok) throw new Error("Failed to get upload URL");
                      const { uploadURL, objectPath } = await urlRes.json();

                      // Step 2: PUT the file directly to storage
                      const putRes = await fetch(uploadURL, {
                        method: "PUT",
                        headers: { "Content-Type": file.type || "application/pdf" },
                        body: file,
                      });
                      if (!putRes.ok) throw new Error("Upload failed");

                      // Step 3: register in media_assets and set content URL
                      await fetch("/api/media", {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type || "application/pdf", fileSize: file.size }),
                      });

                      const servingUrl = `/api/storage/objects/${objectPath.slice("/objects/".length)}`;
                      setForm(f => ({ ...f, content: servingUrl }));
                      toast({ title: "PDF uploaded", description: file.name });
                    } catch {
                      toast({ title: "Upload failed", variant: "destructive" });
                    } finally {
                      setPdfUploading(false);
                      if (pdfInputRef.current) pdfInputRef.current.value = "";
                    }
                  }}
                />
                {form.content && form.pageType === "pdf" && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={form.content}>
                    {form.content.split("/").pop()}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ── Link Overlays (hotspots) ── */}
          <HotspotsEditor
            hotspots={form.hotspots}
            onChange={h => setForm(f => ({ ...f, hotspots: h }))}
            totalPages={journeyPages.length}
            pageType={form.pageType}
            pageContent={form.content}
          />

          {/* ── CTA ── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Call to Action</div>
                <div className="text-xs text-muted-foreground">Show a CTA button on this page</div>
              </div>
              <Switch
                checked={form.ctaEnabled}
                onCheckedChange={v => setForm(f => ({ ...f, ctaEnabled: v }))}
              />
            </div>
            {form.ctaEnabled && (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <Label className="text-xs">Button Label</Label>
                  <Input
                    placeholder="e.g. Continue, Download Now, Learn More"
                    value={form.ctaText}
                    onChange={e => setForm(f => ({ ...f, ctaText: e.target.value }))}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Button Action</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      { val: "url",           label: "Go to URL",           Icon: ExternalLink },
                      { val: "page",          label: "Go to Journey Page",  Icon: Layers       },
                      { val: "download",      label: "Download Asset",       Icon: Download     },
                      { val: "gated_download",label: "Form → Download",     Icon: ClipboardList},
                    ] as const).map(({ val, label, Icon }) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, ctaType: val }))}
                        className={cn(
                          "flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg border transition-all text-left",
                          form.ctaType === val
                            ? "bg-indigo-50 border-indigo-500 text-indigo-700 font-semibold"
                            : "hover:bg-muted/50 text-muted-foreground border-input",
                        )}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" /> {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* URL action */}
                {form.ctaType === "url" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Target URL</Label>
                    <Input
                      placeholder="https://..."
                      value={form.ctaAssetUrl}
                      onChange={e => setForm(f => ({ ...f, ctaAssetUrl: e.target.value }))}
                      className="h-8 text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground">Opens in a new tab.</p>
                  </div>
                )}

                {/* Page jump action */}
                {form.ctaType === "page" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Jump to Page</Label>
                    <Select
                      value={form.ctaAssetUrl}
                      onValueChange={v => setForm(f => ({ ...f, ctaAssetUrl: v }))}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select a page…" />
                      </SelectTrigger>
                      <SelectContent>
                        {journeyPages.filter(p => p.id !== page?.id).map(p => (
                          <SelectItem key={p.id} value={String(p.id)}>{p.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Download asset action */}
                {form.ctaType === "download" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Asset to download</Label>
                    <div className="flex gap-1.5">
                      <Input
                        placeholder="https://... or pick / upload"
                        value={form.ctaAssetUrl}
                        onChange={e => setForm(f => ({ ...f, ctaAssetUrl: e.target.value }))}
                        className="h-8 text-sm flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => assetInputRef.current?.click()}
                        disabled={assetUploading}
                        className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
                      >
                        {assetUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        Upload
                      </button>
                      <button
                        type="button"
                        onClick={() => { setMediaPickerField("ctaAssetUrl"); setMediaPickerOpen(true); }}
                        className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
                      >
                        <FolderOpen className="w-3.5 h-3.5" /> Library
                      </button>
                    </div>
                    <input
                      ref={assetInputRef}
                      type="file"
                      className="hidden"
                      onChange={async e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setAssetUploading(true);
                        try {
                          const urlRes = await fetch("/api/storage/uploads/request-url", {
                            method: "POST", credentials: "include",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
                          });
                          if (!urlRes.ok) throw new Error();
                          const { uploadURL, objectPath } = await urlRes.json();
                          const putRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
                          if (!putRes.ok) throw new Error();
                          await fetch("/api/media", {
                            method: "POST", credentials: "include",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type, fileSize: file.size }),
                          });
                          const servingUrl = `/api/storage/objects/${objectPath.slice("/objects/".length)}`;
                          setForm(f => ({ ...f, ctaAssetUrl: servingUrl }));
                          toast({ title: "Asset uploaded", description: file.name });
                        } catch {
                          toast({ title: "Upload failed", variant: "destructive" });
                        } finally {
                          setAssetUploading(false);
                          if (assetInputRef.current) assetInputRef.current.value = "";
                        }
                      }}
                    />
                  </div>
                )}

                {/* Gated download: form + optional override asset */}
                {form.ctaType === "gated_download" && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Visitor fills the Capture Form (configured below). The asset attached to that form is sent on submit. Optionally override the download URL here.
                    </p>
                    <div className="flex gap-1.5">
                      <Input
                        placeholder="Asset URL override (optional)"
                        value={form.ctaAssetUrl}
                        onChange={e => setForm(f => ({ ...f, ctaAssetUrl: e.target.value }))}
                        className="h-8 text-sm flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => { setMediaPickerField("ctaAssetUrl"); setMediaPickerOpen(true); }}
                        className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
                      >
                        <FolderOpen className="w-3.5 h-3.5" /> Library
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-semibold">HP BI solution context</h3>
            <p className="text-xs text-muted-foreground">Labels meaningful views, content downloads and CTAs as observed interest. This does not create a lead or an opportunity.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="text-xs space-y-1 block">Reporting category
                <Select value={form.biCategory || "_none"} onValueChange={v => setForm(f => ({ ...f, biCategory: v === "_none" ? "" : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="_none">Unassigned</SelectItem>
                    {["IT Hardware", "Business Collaboration", "Security", "Business Services"].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="text-xs space-y-1 block">Product / solution<Input value={form.biProduct} onChange={e => setForm(f => ({ ...f, biProduct: e.target.value }))} /></label>
              <label className="text-xs space-y-1 block">Campaign / program<Input value={form.biProgram} onChange={e => setForm(f => ({ ...f, biProgram: e.target.value }))} /></label>
            </div>
          </div>
          {/* ── Scoring & Stage ── */}
          <div className="border rounded-lg p-4 space-y-4 bg-muted/20">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Star className="w-4 h-4 text-amber-500" /> Scoring & Stage
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Points awarded on view</Label>
                <Input
                  type="number"
                  value={form.score === 0 ? "" : form.score}
                  onChange={e => setForm(f => ({ ...f, score: parseInt(e.target.value) || 0 }))}
                  min={0} max={200}
                  className="h-8 text-sm"
                  placeholder="0"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Display position</Label>
                <Input
                  type="number"
                  value={form.sortOrder === 0 ? "" : form.sortOrder}
                  onChange={e => setForm(f => ({ ...f, sortOrder: parseInt(e.target.value) || 0 }))}
                  min={0}
                  className="h-8 text-sm"
                  placeholder="Auto"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Assign stage to visitor on view</Label>
              <Select value={form.pageStage} onValueChange={v => setForm(f => ({ ...f, pageStage: v === "none" ? "" : v }))}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="No stage assignment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No stage assignment</SelectItem>
                  {stages.map(s => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── Gating Action (sequential mode) ── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Lock className="w-4 h-4 text-indigo-500" /> Navigation Gate
            </div>
            <p className="text-xs text-muted-foreground">
              In sequential mode, require visitors to complete an action before the Next button unlocks.
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              {([
                { val: "none",       label: "No gate",               desc: "Next button is always available" },
                { val: "form_submit", label: "Require form submit",   desc: "Visitor must submit an inline form" },
                { val: "cta_click",   label: "Require CTA click",    desc: "Visitor must click a CTA button" },
              ] as const).map(({ val, label, desc }) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, gatingAction: val }))}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-lg border text-left transition-all",
                    form.gatingAction === val
                      ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                      : "border-border hover:border-muted-foreground/40 hover:bg-muted/30",
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium">{label}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                  </div>
                  {form.gatingAction === val && <CheckCircle2 className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          {/* ── Page Components ── */}
          {page ? (
            <div className="border rounded-lg bg-muted/20">
              <div
                className="flex items-center justify-between p-3 cursor-pointer select-none"
                onClick={() => setCompSectionOpen(v => !v)}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Layers className="w-4 h-4 text-indigo-500" />
                  Page Components
                  {(pageComponents?.length ?? 0) > 0 && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">({pageComponents!.length})</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={e => { e.stopPropagation(); setAddCompOpen(true); }}>
                    <Plus className="w-3 h-3" /> Add
                  </Button>
                  {compSectionOpen
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
              </div>
              {compSectionOpen && <div className="px-3 pb-3 space-y-3 border-t pt-3">
              {localComps.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No components yet. Add CTA buttons, forms, or banners to this page.
                </p>
              ) : (
                <DndContext
                  sensors={compSensors}
                  onDragEnd={async (event) => {
                    const { active, over } = event;
                    if (!over || active.id === over.id) return;
                    const oldIdx = localComps.findIndex(c => c.id === active.id);
                    const newIdx = localComps.findIndex(c => c.id === over.id);
                    if (oldIdx === -1 || newIdx === -1) return;
                    const reordered = arrayMove(localComps, oldIdx, newIdx);
                    setLocalComps(reordered);
                    try {
                      const results = await Promise.all(reordered.map((c, i) =>
                        fetch(`/api/page-components/${c.id}`, {
                          method: "PATCH", credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ sortOrder: i + 1 }),
                        })
                      ));
                      if (results.some(r => !r.ok)) throw new Error("Partial failure");
                    } catch {
                      toast({ title: "Reorder failed", description: "Could not save the new order.", variant: "destructive" });
                      setLocalComps(localComps);
                    } finally {
                      refetchComponents();
                    }
                  }}
                >
                  <SortableContext items={localComps.map(c => c.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {localComps.map(comp => (
                        <ComponentCard
                          key={comp.id}
                          comp={comp}
                          journeyPages={journeyPages}
                          ctaData={comp.componentType === "cta" ? ctaButtons.find(c => c.id === comp.componentId) ?? null : null}
                          bannerData={comp.componentType === "banner" ? banners.find(b => b.id === comp.componentId) ?? null : null}
                          formData={comp.componentType === "form" ? forms.find(f => f.id === comp.componentId) ?? null : null}
                          onDetach={async () => {
                            await fetch(`/api/page-components/${comp.id}`, { method: "DELETE", credentials: "include" });
                            refetchComponents();
                          }}
                          onJumpPageChange={async (pageOrder: number) => {
                            await fetch(`/api/page-components/${comp.id}`, {
                              method: "PATCH", credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ overrideConfig: { ...(comp.overrideConfig ?? {}), pageOrder } }),
                            });
                            refetchComponents();
                          }}
                          onPopupTriggerChange={async (popupTrigger) => {
                            const r = await fetch(`/api/page-components/${comp.id}`, {
                              method: "PATCH", credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ overrideConfig: { ...(comp.overrideConfig ?? {}), popupTrigger } }),
                            });
                            if (!r.ok) {
                              toast({ title: "Failed to update trigger", variant: "destructive" });
                              return;
                            }
                            toast({ title: "Popup trigger updated" });
                            refetchComponents();
                          }}
                          onApplyToAll={async () => {
                            const otherPages = journeyPages.filter(p => p.id !== page?.id);
                            if (otherPages.length === 0) {
                              toast({ title: "No other pages in this journey" });
                              return;
                            }
                            try {
                              const existingLists = await Promise.all(otherPages.map(p =>
                                fetch(`/api/page-components?pageId=${p.id}`, { credentials: "include" })
                                  .then(r => r.ok ? r.json() as Promise<PageComponentRecord[]> : [])
                                  .catch(() => [] as PageComponentRecord[])
                              ));
                              let added = 0, skipped = 0, failed = 0;
                              await Promise.all(otherPages.map(async (p, idx) => {
                                const existing = existingLists[idx] ?? [];
                                const hasIt = existing.some(e =>
                                  e.componentType === comp.componentType &&
                                  e.componentId === comp.componentId &&
                                  e.position === comp.position
                                );
                                if (hasIt) { skipped++; return; }
                                const r = await fetch("/api/page-components", {
                                  method: "POST", credentials: "include",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    journeyPageId: p.id,
                                    componentType: comp.componentType,
                                    componentId: comp.componentId,
                                    position: comp.position,
                                    sortOrder: 99,
                                    overrideConfig: comp.overrideConfig ?? {},
                                  }),
                                });
                                if (r.ok) added++; else failed++;
                              }));
                              const parts: string[] = [];
                              if (added)   parts.push(`added to ${added} page${added === 1 ? "" : "s"}`);
                              if (skipped) parts.push(`${skipped} already had it`);
                              if (failed)  parts.push(`${failed} failed`);
                              toast({
                                title: added > 0 ? "Applied to all pages" : "Nothing to apply",
                                description: parts.join(" · ") || "No changes",
                                variant: failed > 0 && added === 0 ? "destructive" : "default",
                              });
                              qc.invalidateQueries({ queryKey: ["page-components"] });
                            } catch {
                              toast({ title: "Failed to apply to all pages", variant: "destructive" });
                            }
                          }}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
              </div>}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-center">
              <p className="text-xs text-muted-foreground">Save this page first, then add components to it.</p>
            </div>
          )}
        </div>

        {/* ── Live Preview ── */}
        <div className="border rounded-lg bg-muted/20">
          <div
            className="flex items-center justify-between p-3 cursor-pointer select-none"
            onClick={() => setPreviewOpen(v => !v)}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <EyeIcon className="w-4 h-4 text-indigo-500" />
              Live Preview
              <span className="text-xs font-normal text-muted-foreground ml-1">scaled ~30%</span>
            </div>
            <div className="flex items-center gap-1.5">
              {previewOpen && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setPreviewDark(v => !v); }}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border bg-background hover:bg-muted/50 transition-colors"
                  title="Toggle dark/light preview"
                >
                  {previewDark
                    ? <><Moon className="w-3 h-3" /> Dark</>
                    : <><Sun className="w-3 h-3" /> Light</>}
                </button>
              )}
              {previewOpen
                ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </div>
          </div>
          {previewOpen && (
            <div className="px-3 pb-3 border-t pt-3 flex justify-center">
              <PageMiniPreview
                form={form}
                localComps={localComps}
                banners={banners}
                ctaButtons={ctaButtons}
                isDark={previewDark}
              />
            </div>
          )}
        </div>

        <SheetFooter>
          <Button
            onClick={() => mutation.mutate(form)}
            disabled={!form.title.trim() || mutation.isPending}
            className="bg-indigo-600 hover:bg-indigo-700 w-full"
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {isEdit ? "Save Changes" : "Add Page"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>

    {/* ── Media Picker Dialog ── */}
    <Dialog open={mediaPickerOpen} onOpenChange={setMediaPickerOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose from Media Library</DialogTitle>
        </DialogHeader>
        {mediaAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground gap-2">
            <FolderOpen className="w-8 h-8 opacity-30" />
            <p className="text-sm">No media files yet. Upload files in the Media section.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 max-h-96 overflow-y-auto pr-1">
            {mediaAssets
              .filter(a => {
                if (mediaPickerField === "content") {
                  if (form.pageType === "pdf") return a.mimeType === "application/pdf";
                  if (form.pageType === "infographic") return a.mimeType.startsWith("image/");
                  return true;
                }
                return true;
              })
              .map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => {
                    setForm(f => ({
                      ...f,
                      [mediaPickerField]: asset.url,
                    }));
                    setMediaPickerOpen(false);
                  }}
                  className="flex flex-col items-start gap-1.5 p-2.5 rounded-lg border hover:border-indigo-500 hover:bg-indigo-50/50 text-left transition-all group"
                >
                  <div className="w-full aspect-video rounded bg-muted/50 flex items-center justify-center overflow-hidden">
                    {asset.mimeType.startsWith("image/") ? (
                      <img src={asset.url} alt={asset.name} className="w-full h-full object-cover rounded" />
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-muted-foreground">
                        {asset.mimeType === "application/pdf"
                          ? <FileText className="w-6 h-6 text-red-400" />
                          : asset.mimeType.startsWith("video/")
                            ? <Video className="w-6 h-6 text-blue-400" />
                            : <FileIcon className="w-6 h-6" />}
                        <span className="text-[10px]">{asset.format}</span>
                      </div>
                    )}
                  </div>
                  <span className="text-xs font-medium truncate w-full leading-tight group-hover:text-indigo-700" title={asset.name}>
                    {asset.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{asset.fileSizeLabel || asset.format}</span>
                </button>
              ))}
          </div>
        )}
      </DialogContent>
    </Dialog>

    {page && (
      <AddComponentModal
        open={addCompOpen}
        onClose={() => setAddCompOpen(false)}
        pageId={page.id}
        journeyPages={journeyPages}
        onAdded={() => refetchComponents()}
      />
    )}
    </>
  );
}

// ── ScheduleSheet ─────────────────────────────────────────────────────────────
function ScheduleSheet({
  open, journey, onClose, onSaved,
}: {
  open: boolean;
  journey: Journey;
  onClose: () => void;
  onSaved: (updated: Journey) => void;
}) {
  const { toast } = useToast();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    if (open) {
      setStartDate(toDateInput(journey.startDate));
      setEndDate(toDateInput(journey.endDate));
    }
  }, [open, journey]);

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/journeys/${journey.id}/schedule`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: startDate || null,
          endDate: endDate || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<Journey>;
    },
    onSuccess: (updated) => {
      toast({ title: "Schedule saved" });
      onSaved(updated);
      onClose();
    },
    onError: () => toast({ title: "Failed to save schedule", variant: "destructive" }),
  });

  const clearSchedule = () => {
    setStartDate("");
    setEndDate("");
  };

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-indigo-600" />
            Journey Schedule
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5 py-5">
          <p className="text-sm text-muted-foreground">
            Restrict when visitors can access this journey. Leave blank to always show it when published.
          </p>

          <div className="space-y-2">
            <Label>Start Date</Label>
            <Input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="block"
            />
            <p className="text-xs text-muted-foreground">Journey becomes accessible on this date</p>
          </div>

          <div className="space-y-2">
            <Label>End Date</Label>
            <Input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              min={startDate || undefined}
              className="block"
            />
            <p className="text-xs text-muted-foreground">Journey stops being accessible after this date</p>
          </div>

          {(startDate || endDate) && (
            <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-3 text-xs text-indigo-700 space-y-1">
              <div className="font-medium">Schedule preview</div>
              {startDate && <div>· Opens: {new Date(startDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>}
              {endDate && <div>· Closes: {new Date(endDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>}
            </div>
          )}

          {(startDate || endDate) && (
            <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5" onClick={clearSchedule}>
              <X className="w-3.5 h-3.5" /> Clear schedule
            </Button>
          )}
        </div>

        <SheetFooter>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="bg-indigo-600 hover:bg-indigo-700 w-full"
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Schedule
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── ScenarioVideosCard ────────────────────────────────────────────────────────
// Lets editors set a YouTube video URL per contest scenario (Airport / Support
// Floor / Home Office).  The contest page reads these on load and plays the
// correct video when a visitor selects that scenario.
function ScenarioVideosCard({
  journey, numId, qc,
}: {
  journey: Journey;
  numId: number;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const { toast } = useToast();

  const [videos, setVideos] = useState({
    airport: journey.scenarioVideos?.airport ?? "",
    support: journey.scenarioVideos?.support ?? "",
    home:    journey.scenarioVideos?.home    ?? "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVideos({
      airport: journey.scenarioVideos?.airport ?? "",
      support: journey.scenarioVideos?.support ?? "",
      home:    journey.scenarioVideos?.home    ?? "",
    });
  }, [journey.id]);

  // Accept a full YouTube URL or a bare 11-character video ID
  const parseYtId = (raw: string) => {
    const m = raw.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : raw.trim();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/journeys/${numId}/scenario-videos`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport: videos.airport.trim() || null,
          support: videos.support.trim() || null,
          home:    videos.home.trim()    || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const updated = await r.json();
      qc.setQueryData(["journeys", String(numId)], updated);
      toast({ title: "Scenario videos saved" });
    } catch {
      toast({ title: "Failed to save scenario videos", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const SCENARIOS = [
    { key: "airport" as const, label: "✈️  Airport Lounge" },
    { key: "support" as const, label: "🎧  Support Floor" },
    { key: "home"    as const, label: "🏠  Home Office" },
  ];

  return (
    <div className="border rounded-lg p-4 space-y-4 bg-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Youtube className="w-4 h-4 text-red-500" />
          Contest Scenario Videos
        </h3>
        <Button size="sm" onClick={handleSave} disabled={saving}
          className="bg-indigo-600 hover:bg-indigo-700 h-7 text-xs">
          {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Save className="w-3 h-3 mr-1.5" />}
          Save
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Paste a YouTube URL or video ID for each scenario. The connected 2-Minute Meeting Rescue
        contest page loads these settings when that scenario is selected. Leave blank to use the
        default animated photo scene.
      </p>
      <div className="space-y-3">
        {SCENARIOS.map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <Label className="text-xs">{label}</Label>
            <Input
              placeholder="https://www.youtube.com/watch?v=… or video ID"
              value={videos[key]}
              onChange={e => setVideos(v => ({ ...v, [key]: e.target.value }))}
              className="h-8 text-sm font-mono"
            />
            {videos[key] && (
              <p className="text-[10px] text-muted-foreground font-mono">
                ID: {parseYtId(videos[key])}
                {" · "}
                <a
                  href={`https://www.youtube.com/watch?v=${parseYtId(videos[key])}`}
                  target="_blank" rel="noreferrer"
                  className="text-indigo-500 hover:underline"
                >preview ↗</a>
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── HeaderConfigCard ──────────────────────────────────────────────────────────
function HeaderConfigCard({
  journey, numId, qc, pages,
}: {
  journey: Journey;
  numId: number;
  qc: ReturnType<typeof useQueryClient>;
  pages: JourneyPage[];
}) {
  const { toast } = useToast();
  const [config, setConfig] = useState({
    headerLogoUrl:    journey.headerLogoUrl    ?? "",
    headerLogoShowBg: journey.headerLogoShowBg ?? true,
    headerBtnText:    journey.headerBtnText    ?? "Book a Demo",
    headerBtnUrl:     journey.headerBtnUrl     ?? "",
    headerBtnType:    journey.headerBtnType    ?? "url",
    headerTagline:    journey.headerTagline    ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [assetUploading, setAssetUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);

  const { data: allForms = [] } = useQuery<JourneyFormRecord[]>({
    queryKey: ["journey-forms"],
    queryFn: () => fetch("/api/journey-forms", { credentials: "include" }).then(r => r.json()),
  });

  useEffect(() => {
    setConfig({
      headerLogoUrl:    journey.headerLogoUrl    ?? "",
      headerLogoShowBg: journey.headerLogoShowBg ?? true,
      headerBtnText:    journey.headerBtnText    ?? "Book a Demo",
      headerBtnUrl:     journey.headerBtnUrl     ?? "",
      headerBtnType:    journey.headerBtnType    ?? "url",
      headerTagline:    journey.headerTagline    ?? "",
    });
  }, [journey.id]);

  const uploadFile = async (file: File): Promise<string> => {
    const r1 = await fetch("/api/storage/uploads/request-url", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
    });
    if (!r1.ok) throw new Error("Failed to get upload URL");
    const { uploadURL, objectPath } = await r1.json();
    const r2 = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (!r2.ok) throw new Error("Failed to upload file");
    return `/api/storage/objects/${objectPath.slice("/objects/".length)}`;
  };

  const handleLogoUpload = async (file: File) => {
    setLogoUploading(true);
    try {
      const url = await uploadFile(file);
      setConfig(c => ({ ...c, headerLogoUrl: url }));
      toast({ title: "Logo uploaded", description: file.name });
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      setLogoUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleAssetUpload = async (file: File) => {
    setAssetUploading(true);
    try {
      const url = await uploadFile(file);
      setConfig(c => ({ ...c, headerBtnUrl: url }));
      toast({ title: "Asset uploaded", description: file.name });
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      setAssetUploading(false);
      if (assetInputRef.current) assetInputRef.current.value = "";
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/journeys/${numId}/header`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headerLogoUrl:    config.headerLogoUrl    || null,
          headerLogoShowBg: config.headerLogoShowBg,
          headerBtnText:    config.headerBtnText    || null,
          headerBtnUrl:     config.headerBtnUrl     || null,
          headerBtnType:    config.headerBtnType    || "url",
          headerTagline:    config.headerTagline    || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const updated = await r.json();
      qc.setQueryData(["journeys", String(numId)], updated);
      toast({ title: "Header settings saved" });
    } catch {
      toast({ title: "Failed to save header settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 space-y-4 bg-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-indigo-600" />
          Header Configuration
        </h3>
        <Button size="sm" onClick={handleSave} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700 h-7 text-xs">
          {saving ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Save className="w-3 h-3 mr-1.5" />}
          Save
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5 col-span-2">
          <Label className="text-xs">Logo</Label>
          <div className="flex gap-1.5 items-center">
            {config.headerLogoUrl && (
              <img src={config.headerLogoUrl} alt="" className="h-7 max-w-[60px] object-contain rounded border bg-white px-1" />
            )}
            <Input
              placeholder="https://… or upload an image"
              value={config.headerLogoUrl}
              onChange={e => setConfig(c => ({ ...c, headerLogoUrl: e.target.value }))}
              className="h-8 text-sm flex-1"
            />
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              disabled={logoUploading}
              className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              {logoUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Upload
            </button>
            {config.headerLogoUrl && (
              <button
                type="button"
                onClick={() => setConfig(c => ({ ...c, headerLogoUrl: "" }))}
                className="h-8 px-2 text-xs border rounded-lg hover:bg-destructive/10 text-destructive flex items-center shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); }}
          />
          <p className="text-[10px] text-muted-foreground">Leave blank to use the client logo from the journey settings.</p>
          <div className="flex items-center justify-between rounded-md border px-3 py-2 bg-muted/30">
            <label htmlFor="logo-show-bg" className="text-xs font-medium cursor-pointer select-none">
              Circular background behind logo
            </label>
            <Switch
              id="logo-show-bg"
              checked={config.headerLogoShowBg}
              onCheckedChange={v => setConfig(c => ({ ...c, headerLogoShowBg: v }))}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Tagline / Sub-heading</Label>
          <Input
            placeholder="e.g. Powered by Acme AI"
            value={config.headerTagline}
            onChange={e => setConfig(c => ({ ...c, headerTagline: e.target.value }))}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">CTA Button Text</Label>
          <Input
            placeholder="Book a Demo"
            value={config.headerBtnText}
            onChange={e => setConfig(c => ({ ...c, headerBtnText: e.target.value }))}
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Leave blank to hide the button</p>
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label className="text-xs">CTA Action</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {(["url", "download", "gated_download", "page"] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setConfig(c => ({ ...c, headerBtnType: t }))}
                className={cn(
                  "h-8 text-xs rounded-lg border px-2 font-medium transition-colors",
                  config.headerBtnType === t
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "hover:bg-muted/50"
                )}
              >
                {t === "url" ? "Open URL" : t === "download" ? "Download" : t === "gated_download" ? "Download + Form" : "Jump to Page"}
              </button>
            ))}
          </div>
        </div>
        {/* Action-specific input */}
        {config.headerBtnType === "url" && (
          <div className="space-y-1.5 col-span-2">
            <Label className="text-xs">URL</Label>
            <Input
              placeholder="https://…"
              value={config.headerBtnUrl}
              onChange={e => setConfig(c => ({ ...c, headerBtnUrl: e.target.value }))}
              className="h-8 text-sm"
            />
          </div>
        )}

        {config.headerBtnType === "download" && (
          <div className="space-y-1.5 col-span-2">
            <Label className="text-xs">Asset URL or Upload File</Label>
            <div className="flex gap-1.5 items-center">
              <Input
                placeholder="https://… or upload a file"
                value={config.headerBtnUrl}
                onChange={e => setConfig(c => ({ ...c, headerBtnUrl: e.target.value }))}
                className="h-8 text-sm flex-1"
              />
              <button
                type="button"
                onClick={() => assetInputRef.current?.click()}
                disabled={assetUploading}
                className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                {assetUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload
              </button>
            </div>
            <input ref={assetInputRef} type="file" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleAssetUpload(f); }} />
          </div>
        )}

        {config.headerBtnType === "gated_download" && (
          <>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">Form to collect lead info</Label>
              <Select
                value={config.headerBtnUrl.startsWith("form:") ? config.headerBtnUrl.slice(5) : ""}
                onValueChange={v => setConfig(c => ({ ...c, headerBtnUrl: `form:${v}` }))}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Select a form…" />
                </SelectTrigger>
                <SelectContent>
                  {allForms.map(f => (
                    <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">Asset to deliver after form (URL or upload)</Label>
              <div className="flex gap-1.5 items-center">
                <Input
                  placeholder="https://… or upload a file"
                  value={config.headerBtnUrl.startsWith("form:") ? "" : config.headerBtnUrl}
                  onChange={e => {
                    const formPart = config.headerBtnUrl.startsWith("form:") ? config.headerBtnUrl.split("|")[0] : "";
                    setConfig(c => ({ ...c, headerBtnUrl: formPart ? `${formPart}|${e.target.value}` : e.target.value }));
                  }}
                  className="h-8 text-sm flex-1"
                />
                <button
                  type="button"
                  onClick={() => assetInputRef.current?.click()}
                  disabled={assetUploading}
                  className="h-8 px-2.5 text-xs border rounded-lg hover:bg-muted/50 flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  {assetUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  Upload
                </button>
              </div>
              <input ref={assetInputRef} type="file" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleAssetUpload(f); }} />
            </div>
          </>
        )}

        {config.headerBtnType === "page" && (
          <div className="space-y-1.5 col-span-2">
            <Label className="text-xs">Jump to Page</Label>
            {pages.length > 0 ? (
              <Select
                value={config.headerBtnUrl}
                onValueChange={v => setConfig(c => ({ ...c, headerBtnUrl: v }))}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Select a page…" />
                </SelectTrigger>
                <SelectContent>
                  {pages.map((p, i) => (
                    <SelectItem key={p.id} value={String(i + 1)}>
                      {i + 1}. {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                placeholder="e.g. 3"
                value={config.headerBtnUrl}
                onChange={e => setConfig(c => ({ ...c, headerBtnUrl: e.target.value }))}
                className="h-8 text-sm"
              />
            )}
          </div>
        )}
      </div>

      {/* Live preview strip */}
      <div className="rounded-md border bg-gray-950 p-3 flex items-center gap-3">
        {/* LEFT: logo + tagline */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          {(config.headerLogoUrl || journey.clientLogoUrl) ? (
            <img src={config.headerLogoUrl || journey.clientLogoUrl!} alt="" className="h-5 object-contain max-w-[90px]" />
          ) : (
            <span className="text-xs font-semibold text-white truncate max-w-[90px]">{journey.clientName ?? "KABOOM"}</span>
          )}
          {config.headerTagline && (
            <span className="text-[9px] text-white/40 truncate">{config.headerTagline}</span>
          )}
        </div>
        {/* RIGHT: CTA button */}
        {config.headerBtnText !== "" && (
          <span className="text-[9px] font-semibold px-2 py-1 rounded-full bg-indigo-600 text-white shrink-0 leading-tight">
            {config.headerBtnText || "Book a Demo"}
          </span>
        )}
        <span className="text-[10px] text-white/20 italic shrink-0">preview</span>
      </div>
    </div>
  );
}

// ── Viewer Background Dialog ──────────────────────────────────────────────────
type OverlayStyle = "flat" | "vignette" | "bottom_fade" | "top_fade";
type ViewerBgOverlay = { color: string; opacity: number; style?: OverlayStyle } | null;
type ViewerBgValue = { type: "color" | "gradient" | "image"; value: string; imageBlur?: number | null; overlay?: ViewerBgOverlay | null } | null;

const OVERLAY_STYLES: { value: OverlayStyle; label: string }[] = [
  { value: "flat",        label: "Flat" },
  { value: "vignette",    label: "Vignette" },
  { value: "bottom_fade", label: "Bottom Fade" },
  { value: "top_fade",    label: "Top Fade" },
];

function overlayLayerStyle(
  color: string,
  opacity: number,
  style: OverlayStyle = "flat",
): React.CSSProperties {
  const op = Math.max(0, Math.min(1, opacity));
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const rgba = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
  if (style === "vignette") {
    return { background: `radial-gradient(ellipse at center, ${rgba(0)} 35%, ${rgba(op)} 100%)` };
  }
  if (style === "bottom_fade") {
    return { background: `linear-gradient(to top, ${rgba(op)} 0%, ${rgba(op * 0.6)} 35%, ${rgba(0)} 80%)` };
  }
  if (style === "top_fade") {
    return { background: `linear-gradient(to bottom, ${rgba(op)} 0%, ${rgba(op * 0.6)} 35%, ${rgba(0)} 80%)` };
  }
  return { backgroundColor: color, opacity: op };
}

const GRADIENT_PRESETS: { label: string; value: string }[] = [
  { label: "Indigo Night",   value: "linear-gradient(135deg, #4338ca 0%, #0d0d0d 100%)" },
  { label: "Sunset",         value: "linear-gradient(135deg, #f97316 0%, #db2777 100%)" },
  { label: "Aurora",         value: "linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)" },
  { label: "Mint Fade",      value: "linear-gradient(135deg, #d1fae5 0%, #f0fdfa 100%)" },
  { label: "Slate",          value: "linear-gradient(135deg, #1e293b 0%, #475569 100%)" },
  { label: "Rose Glow",      value: "linear-gradient(135deg, #fda4af 0%, #fef3c7 100%)" },
];

function previewStyleFor(bg: ViewerBgValue): React.CSSProperties {
  if (!bg || !bg.value) return { background: "#f5f5f7" };
  if (bg.type === "image") {
    return {
      backgroundImage: `url(${bg.value})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      filter: bg.imageBlur && bg.imageBlur > 0 ? `blur(${bg.imageBlur}px)` : undefined,
    };
  }
  return { background: bg.value };
}

function PreviewOverlay({ overlay }: { overlay: ViewerBgOverlay }) {
  if (!overlay || overlay.opacity <= 0) return null;
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none"
      style={overlayLayerStyle(overlay.color, overlay.opacity, overlay.style ?? "flat")}
    />
  );
}

function ViewerBgDialog({
  open, onOpenChange, journeyId, initial, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  journeyId: number;
  initial: ViewerBgValue;
  onSaved: (next: ViewerBgValue) => void;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"color" | "gradient" | "image">(initial?.type ?? "color");
  const [color, setColor] = useState<string>(initial?.type === "color" ? initial.value : "#0d0d0d");
  const [gradient, setGradient] = useState<string>(initial?.type === "gradient" ? initial.value : GRADIENT_PRESETS[0].value);
  const [imageUrl, setImageUrl] = useState<string>(initial?.type === "image" ? initial.value : "");
  const [imageBlur, setImageBlur] = useState<number>(initial?.type === "image" && initial.imageBlur ? initial.imageBlur : 0);
  const initialOverlay: ViewerBgOverlay =
    initial?.overlay ? initial.overlay : null;
  const [overlayMode, setOverlayMode] = useState<"none" | "dark" | "light">(
    initialOverlay ? (initialOverlay.color.toLowerCase() === "#ffffff" ? "light" : "dark") : "none"
  );
  const [overlayOpacity, setOverlayOpacity] = useState<number>(
    initialOverlay ? initialOverlay.opacity : 0.4
  );
  const [overlayStyle, setOverlayStyle] = useState<OverlayStyle>(
    initialOverlay?.style ?? "flat"
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTab(initial?.type ?? "color");
      setColor(initial?.type === "color" ? initial.value : "#0d0d0d");
      setGradient(initial?.type === "gradient" ? initial.value : GRADIENT_PRESETS[0].value);
      setImageUrl(initial?.type === "image" ? initial.value : "");
      setImageBlur(initial?.type === "image" && initial.imageBlur ? initial.imageBlur : 0);
      const ov = initial?.overlay ? initial.overlay : null;
      setOverlayMode(ov ? (ov.color.toLowerCase() === "#ffffff" ? "light" : "dark") : "none");
      setOverlayOpacity(ov ? ov.opacity : 0.4);
      setOverlayStyle(ov?.style ?? "flat");
    }
  }, [open, initial]);

  const overlay: ViewerBgOverlay =
    overlayMode === "none"
      ? null
      : { color: overlayMode === "dark" ? "#000000" : "#ffffff", opacity: overlayOpacity, style: overlayStyle };

  const current: ViewerBgValue =
    tab === "color"    ? { type: "color",    value: color, overlay } :
    tab === "gradient" ? { type: "gradient", value: gradient, overlay } :
                         (imageUrl ? { type: "image", value: imageUrl, imageBlur, overlay } : null);

  const save = async (next: ViewerBgValue) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/journeys/${journeyId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewerBg: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved(next);
      onOpenChange(false);
      toast({ title: next ? "Background updated" : "Background reset to default" });
    } catch {
      toast({ title: "Failed to update background", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Viewer background</DialogTitle>
          <DialogDescription>
            Customize the outer background that visitors see behind the journey content.
          </DialogDescription>
        </DialogHeader>

        <div
          className="relative rounded-lg border border-gray-200 overflow-hidden mb-2 aspect-[16/9] bg-black"
          aria-label="Viewer background preview"
        >
          <div className="absolute inset-0" style={previewStyleFor(current)} />
          <PreviewOverlay overlay={overlay} />
          <div className="absolute inset-0 flex flex-col">
            <div className="flex items-center gap-1.5 px-3 py-2 bg-black/30 backdrop-blur-sm border-b border-white/10">
              <div className="w-2 h-2 rounded-full bg-white/40" />
              <div className="w-2 h-2 rounded-full bg-white/40" />
              <div className="w-2 h-2 rounded-full bg-white/40" />
              <div className="ml-2 h-1.5 w-20 rounded-full bg-white/30" />
              <div className="ml-auto h-1.5 w-10 rounded-full bg-white/40" />
            </div>
            <div className="flex-1 flex items-center justify-center px-6">
              <div className="w-3/5 rounded-md bg-white/10 backdrop-blur-sm border border-white/15 px-4 py-3 space-y-1.5 shadow-lg">
                <div className="h-2 w-1/2 rounded-full bg-white/60" />
                <div className="h-1.5 w-3/4 rounded-full bg-white/40" />
                <div className="h-1.5 w-2/3 rounded-full bg-white/30" />
                <div className="mt-2 h-3 w-16 rounded-full bg-indigo-400/80" />
              </div>
            </div>
            <div className="flex items-center justify-center gap-1.5 py-2 px-3 bg-black/30 backdrop-blur-sm border-t border-white/10">
              {[0,1,2,3,4].map(i => (
                <div
                  key={i}
                  className={cn(
                    "h-6 w-10 rounded border",
                    i === 1 ? "border-white bg-white/20" : "border-white/30 bg-white/10",
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-1 mb-3">
          {(["color", "gradient", "image"] as const).map(t => (
            <Button
              key={t}
              variant={tab === t ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(t)}
              className="capitalize"
            >
              {t}
            </Button>
          ))}
        </div>

        {tab === "color" && (
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="h-10 w-14 rounded border border-gray-200 cursor-pointer"
              />
              <Input
                value={color}
                onChange={e => setColor(e.target.value)}
                placeholder="#0d0d0d"
                className="font-mono"
              />
            </div>
          </div>
        )}

        {tab === "gradient" && (
          <div className="space-y-2">
            <Label>Choose a gradient preset</Label>
            <div className="grid grid-cols-3 gap-2">
              {GRADIENT_PRESETS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setGradient(p.value)}
                  className={cn(
                    "h-16 rounded-md border-2 transition-all text-xs text-white font-medium px-2 text-left flex items-end",
                    gradient === p.value ? "border-indigo-600 ring-2 ring-indigo-200" : "border-gray-200 hover:border-gray-300",
                  )}
                  style={{ background: p.value }}
                >
                  <span className="drop-shadow">{p.label}</span>
                </button>
              ))}
            </div>
            <Label className="pt-2">Custom CSS gradient</Label>
            <Input
              value={gradient}
              onChange={e => setGradient(e.target.value)}
              placeholder="linear-gradient(135deg, #4338ca 0%, #0d0d0d 100%)"
              className="font-mono text-xs"
            />
          </div>
        )}

        {tab === "image" && (
          <div className="space-y-3">
            <AssetPicker
              value={imageUrl ? { assetId: 0, filename: "", sizeBytes: 0, url: imageUrl } : null}
              onChange={(asset) => setImageUrl(asset?.url ?? "")}
              accept="image/*"
              label="Background image"
            />
            <div className="space-y-1">
              <Label>Blur ({imageBlur}px)</Label>
              <input
                type="range"
                min={0}
                max={40}
                value={imageBlur}
                onChange={e => setImageBlur(parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}

        <div className="space-y-2 pt-3 mt-3 border-t border-gray-100">
          <Label>Overlay</Label>
          <div className="flex gap-1">
            {(["none", "dark", "light"] as const).map(m => (
              <Button
                key={m}
                type="button"
                variant={overlayMode === m ? "default" : "outline"}
                size="sm"
                onClick={() => setOverlayMode(m)}
                className="capitalize"
              >
                {m}
              </Button>
            ))}
          </div>
          {overlayMode !== "none" && (
            <>
              <div className="space-y-1">
                <Label>Style</Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {OVERLAY_STYLES.map(s => {
                    const baseColor = overlayMode === "dark" ? "#000000" : "#ffffff";
                    return (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setOverlayStyle(s.value)}
                        className={cn(
                          "relative h-12 rounded-md border-2 overflow-hidden transition-all text-[10px] font-medium",
                          overlayStyle === s.value
                            ? "border-indigo-600 ring-2 ring-indigo-200"
                            : "border-gray-200 hover:border-gray-300",
                        )}
                        style={{
                          backgroundImage:
                            "linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)",
                          backgroundSize: "8px 8px",
                          backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
                          backgroundColor: "#f9fafb",
                        }}
                      >
                        <div
                          aria-hidden="true"
                          className="absolute inset-0"
                          style={overlayLayerStyle(baseColor, Math.max(overlayOpacity, 0.5), s.value)}
                        />
                        <span
                          className={cn(
                            "absolute inset-x-0 bottom-0.5 text-center",
                            overlayMode === "dark" ? "text-white" : "text-gray-900",
                          )}
                        >
                          {s.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1">
                <Label>Opacity ({Math.round(overlayOpacity * 100)}%)</Label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(overlayOpacity * 100)}
                  onChange={e => setOverlayOpacity(parseInt(e.target.value) / 100)}
                  className="w-full"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between pt-4 border-t mt-4">
          <Button
            variant="ghost"
            onClick={() => save(null)}
            disabled={saving}
            className="text-gray-600"
          >
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button
              onClick={() => save(current)}
              disabled={saving || (tab === "image" && !imageUrl)}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              Save background
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── JourneyBuilder ────────────────────────────────────────────────────────────
interface JourneyBuilderProps { id: string; }

export default function JourneyBuilder({ id }: JourneyBuilderProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const numId = parseInt(id);

  const [pages, setPages] = useState<JourneyPage[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeDragComp, setActiveDragComp] = useState<PageComponentRecord | null>(null);
  const [editingPage, setEditingPage] = useState<JourneyPage | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<JourneyPage | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [linkPlayOpen, setLinkPlayOpen] = useState(false);
  const [visitorPreviewOpen, setVisitorPreviewOpen] = useState(false);
  const [previewContactId, setPreviewContactId]     = useState<number | null>(null);
  const [previewContactName, setPreviewContactName] = useState<string>("");
  const [previewContactSearch, setPreviewContactSearch] = useState("");
  const [previewContactOpen, setPreviewContactOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { data: allPlays = [] } = useQuery<PlayOption[]>({
    queryKey: ["plays"],
    queryFn: () => fetch("/api/plays", { credentials: "include" }).then(r => r.json()),
  });

  const { data: journey, isLoading: journeyLoading } = useQuery<Journey>({
    queryKey: ["journeys", id],
    queryFn: () => fetch(`/api/journeys/${numId}`, { credentials: "include" }).then(r => r.json()),
  });

  const { data: fetchedPages, isLoading: pagesLoading } = useQuery<JourneyPage[]>({
    queryKey: ["journeys", id, "pages"],
    queryFn: () => fetch(`/api/journeys/${numId}/pages`, { credentials: "include" }).then(r => r.json()),
  });

  const { data: stages = [] } = useQuery<StageConfig[]>({
    queryKey: ["stages"],
    queryFn: () => fetch("/api/stages", { credentials: "include" }).then(r => r.json()),
  });

  const { data: allJourneyComponents = [], refetch: refetchAllComponents } = useQuery<PageComponentRecord[]>({
    queryKey: ["journey-all-components", id],
    queryFn: () => fetch(`/api/page-components?journeyId=${numId}`, { credentials: "include" }).then(r => r.json()),
  });

  const pageComponentsMap = useMemo(() => {
    const map: Record<number, PageComponentRecord[]> = {};
    for (const comp of allJourneyComponents) {
      if (!map[comp.journeyPageId]) map[comp.journeyPageId] = [];
      map[comp.journeyPageId].push(comp);
    }
    return map;
  }, [allJourneyComponents]);

  const { data: builderForms = [] } = useQuery<JourneyFormRecord[]>({
    queryKey: ["journey-forms"],
    queryFn: () => fetch("/api/journey-forms", { credentials: "include" }).then(r => r.json()),
  });

  const formsById = useMemo(() => {
    const map: Record<number, JourneyFormRecord> = {};
    for (const f of builderForms) map[f.id] = f;
    return map;
  }, [builderForms]);

  useEffect(() => {
    if (fetchedPages) setPages([...fetchedPages].sort((a, b) => a.sortOrder - b.sortOrder));
  }, [fetchedPages]);

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      fetch(`/api/journeys/${numId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (updated) => {
      qc.setQueryData(["journeys", id], updated);
      qc.invalidateQueries({ queryKey: ["journeys"] });
      setEditingName(false);
    },
    onError: () => toast({ title: "Failed to rename journey", variant: "destructive" }),
  });

  function commitRename() {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === journey?.name) { setEditingName(false); return; }
    renameMutation.mutate(trimmed);
  }

  const statusMutation = useMutation({
    mutationFn: (status: JourneyStatus) =>
      fetch(`/api/journeys/${numId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (updated) => {
      qc.setQueryData(["journeys", id], updated);
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: `Journey ${updated.status}` });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const reorderMutation = useMutation({
    mutationFn: (pageIds: number[]) =>
      fetch(`/api/journeys/${numId}/pages/reorder`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageIds }),
      }).then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (pageId: number) =>
      fetch(`/api/journeys/pages/${pageId}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journeys", id, "pages"] });
      qc.invalidateQueries({ queryKey: ["journeys", id] });
      toast({ title: "Page deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete page", variant: "destructive" }),
  });

  const linkPlayMutation = useMutation({
    mutationFn: (playId: number) =>
      fetch(`/api/journeys/${numId}/plays`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playId }),
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (updated: Journey) => {
      qc.setQueryData(["journeys", id], updated);
      setLinkPlayOpen(false);
      toast({ title: "Play linked" });
    },
    onError: () => toast({ title: "Failed to link play", variant: "destructive" }),
  });

  const unlinkPlayMutation = useMutation({
    mutationFn: (playId: number) =>
      fetch(`/api/journeys/${numId}/plays/${playId}`, {
        method: "DELETE", credentials: "include",
      }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: (updated: Journey) => {
      qc.setQueryData(["journeys", id], updated);
      toast({ title: "Play unlinked" });
    },
    onError: () => toast({ title: "Failed to unlink play", variant: "destructive" }),
  });

  const [togglingPageId, setTogglingPageId] = useState<number | null>(null);

  const toggleVisibilityMutation = useMutation({
    mutationFn: async (page: JourneyPage) => {
      setTogglingPageId(page.id);
      const next = !page.isPublished;
      const r = await fetch(`/api/journeys/pages/${page.id}/settings`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      return { pageId: page.id, isPublished: next };
    },
    onSuccess: ({ pageId, isPublished }) => {
      setPages(prev => prev.map(p => p.id === pageId ? { ...p, isPublished } : p));
      toast({ title: isPublished ? "Page is now visible" : "Page is now hidden" });
    },
    onError: () => toast({ title: "Failed to update visibility", variant: "destructive" }),
    onSettled: () => setTogglingPageId(null),
  });

  const handleDragStart = (event: DragStartEvent) => {
    const activeIdStr = String(event.active.id);
    if (activeIdStr.startsWith("comp-")) {
      const data = event.active.data.current as CompDragData | undefined;
      setActiveDragComp(data?.comp ?? null);
    } else {
      setActiveId(event.active.id as number);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    const activeIdStr = String(active.id);

    // ── Component drag ──
    if (activeIdStr.startsWith("comp-")) {
      setActiveDragComp(null);
      if (!over) return;
      const overId = String(over.id);
      const dragData = active.data.current as CompDragData | undefined;
      const fromPageId = dragData?.fromPageId;
      const comp = dragData?.comp;
      if (!comp) return;

      // ── Drop onto another component ──
      if (overId.startsWith("comp-")) {
        const overCompId = parseInt(overId.slice(5));
        if (overCompId === comp.id) return;

        const overComp = allJourneyComponents.find(c => c.id === overCompId);
        const toPageId = overComp?.journeyPageId;
        if (!toPageId || !fromPageId) return;

        if (toPageId === fromPageId) {
          // ── Within-page reorder ──
          const pageComps = [...(pageComponentsMap[fromPageId] ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
          const oldIdx = pageComps.findIndex(c => c.id === comp.id);
          const newIdx = pageComps.findIndex(c => c.id === overCompId);
          if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;

          const reordered = arrayMove(pageComps, oldIdx, newIdx);
          const withNewOrders = reordered.map((c, i) => ({ ...c, sortOrder: i + 1 }));

          // Optimistic update
          qc.setQueryData<PageComponentRecord[]>(["journey-all-components", id], prev => {
            if (!prev) return prev;
            const others = prev.filter(c => c.journeyPageId !== fromPageId);
            return [...others, ...withNewOrders];
          });

          // Persist — check ok so silent 4xx/5xx don't desync client/server
          try {
            await Promise.all(
              withNewOrders.map(async c => {
                const r = await fetch(`/api/page-components/${c.id}`, {
                  method: "PATCH", credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sortOrder: c.sortOrder }),
                });
                if (!r.ok) throw new Error(`PATCH ${c.id}: ${r.status}`);
              })
            );
            refetchAllComponents();
          } catch {
            toast({ title: "Failed to reorder components", variant: "destructive" });
            refetchAllComponents();
          }
        } else {
          // ── Cross-page move (dropped onto a comp in another page) ──
          try {
            const r = await fetch(`/api/page-components/${comp.id}`, {
              method: "PATCH", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ journeyPageId: toPageId }),
            });
            if (!r.ok) throw new Error(await r.text());
            const targetPage = pages.find(p => p.id === toPageId);
            toast({ title: `Component moved to "${targetPage?.title ?? "page"}"` });
            refetchAllComponents();
            qc.invalidateQueries({ queryKey: ["page-components"] });
          } catch {
            toast({ title: "Failed to move component", variant: "destructive" });
          }
        }
        return;
      }

      // ── Drop onto a page drop zone (empty-page target) ──
      const targetPageId = overId.startsWith("pdrop-") ? parseInt(overId.slice(6)) : null;
      if (!targetPageId || targetPageId === fromPageId) return;

      try {
        const r = await fetch(`/api/page-components/${comp.id}`, {
          method: "PATCH", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ journeyPageId: targetPageId }),
        });
        if (!r.ok) throw new Error(await r.text());
        const targetPage = pages.find(p => p.id === targetPageId);
        toast({ title: `Component moved to "${targetPage?.title ?? "page"}"` });
        refetchAllComponents();
        qc.invalidateQueries({ queryKey: ["page-components"] });
      } catch {
        toast({ title: "Failed to move component", variant: "destructive" });
      }
      return;
    }

    // ── Page reorder ──
    setActiveId(null);
    if (!over || active.id === over.id) return;
    setPages(prev => {
      const oldIdx = prev.findIndex(p => p.id === active.id);
      const newIdx = prev.findIndex(p => p.id === over.id);
      const reordered = arrayMove(prev, oldIdx, newIdx);
      reorderMutation.mutate(reordered.map(p => p.id));
      return reordered;
    });
  };

  const [builderView, setBuilderView] = useState<"pages" | "contacts" | "routing" | "analytics">("pages");
  const [trendDays, setTrendDays] = useState<14 | 30>(30);
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState("");
  const [analyticsDateTo, setAnalyticsDateTo] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");

  const trendsParams = new URLSearchParams({ days: String(trendDays) });
  if (analyticsDateFrom) trendsParams.set("dateFrom", analyticsDateFrom);
  if (analyticsDateTo)   trendsParams.set("dateTo", analyticsDateTo);

  const { data: trendsData, isLoading: trendsLoading } = useQuery<{
    journeyId: number; journeyName: string; days: number;
    totalViews: number; totalCtaClicks: number; uniqueVisitors: number;
    trend: { date: string; pageViews: number; ctaClicks: number; uniqueVisitors: number }[];
  }>({
    queryKey: ["journeys", numId, "trends", trendDays, analyticsDateFrom, analyticsDateTo],
    queryFn: () =>
      fetch(`/api/analytics/journeys/${numId}/trends?${trendsParams.toString()}`, { credentials: "include" })
        .then(r => r.json()),
    enabled: builderView === "analytics",
  });

  const pageStatsParams = new URLSearchParams();
  if (analyticsDateFrom) pageStatsParams.set("dateFrom", analyticsDateFrom);
  if (analyticsDateTo)   pageStatsParams.set("dateTo", analyticsDateTo);
  const pageStatsQs = pageStatsParams.toString() ? `?${pageStatsParams.toString()}` : "";

  const { data: pageStatsData, isLoading: pageStatsLoading } = useQuery<{
    journeyId: number; journeyName: string;
    totalViews: number; totalCtaClicks: number; uniqueVisitors: number;
    pages: { pageId: number; title: string; sortOrder: number; views: number; ctaClicks: number; uniqueVisitors: number; ctr: number }[];
  }>({
    queryKey: ["journeys", numId, "page-stats", analyticsDateFrom, analyticsDateTo],
    queryFn: () =>
      fetch(`/api/analytics/journeys/${numId}/page-stats${pageStatsQs}`, { credentials: "include" })
        .then(r => r.json()),
    enabled: builderView === "analytics",
  });

  const eventsParams = new URLSearchParams({ limit: "100" });
  if (eventTypeFilter) eventsParams.set("eventType", eventTypeFilter);

  const { data: eventsData, isLoading: eventsLoading } = useQuery<{
    events: { id: number; eventType: string; visitorToken: string | null; pageUrl: string | null; props: Record<string, unknown> | null; createdAt: string; pageTitle: string | null }[];
    summary: { eventType: string; cnt: number }[];
  }>({
    queryKey: ["journeys", numId, "events", eventTypeFilter],
    queryFn: () =>
      fetch(`/api/analytics/journeys/${numId}/events?${eventsParams}`, { credentials: "include" })
        .then(r => r.json()),
    enabled: builderView === "analytics",
    refetchInterval: 30_000,
  });

  const openAdd = () => { setEditingPage(null); setSheetOpen(true); };
  const openEdit = (page: JourneyPage) => { setEditingPage(page); setSheetOpen(true); };

  const copyPublicLink = () => {
    const url = `${window.location.origin}/j/${journey!.slug}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Public link copied", description: url });
  };

  if (journeyLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!journey) return <div className="p-6 text-muted-foreground">Journey not found.</div>;

  const cfg = STATUS_CONFIG[journey.status];
  const activePageData = activeId ? pages.find(p => p.id === activeId) : null;
  const hiddenCount = pages.filter(p => p.isPublished === false).length;
  const dateRange = formatDateRange(journey.startDate, journey.endDate);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" className="mt-0.5" onClick={() => navigate("/journeys")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {editingName ? (
              <input
                autoFocus
                className="text-2xl font-semibold bg-transparent border-b-2 border-indigo-500 outline-none min-w-0 w-full max-w-xs"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
              />
            ) : (
              <button
                className="group flex items-center gap-1.5 text-left"
                onClick={() => { setNameInput(journey.name); setEditingName(true); }}
                title="Click to rename"
              >
                <h1 className="text-2xl font-semibold truncate">{journey.name}</h1>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
            <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border", cfg.classes)}>
              {cfg.label}
            </span>
          </div>
          {journey.clientName && (
            <p className="text-sm text-muted-foreground mt-0.5">{journey.clientName}</p>
          )}
          {dateRange && (
            <button
              onClick={() => setScheduleOpen(true)}
              className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-700 mt-1"
            >
              <Calendar className="w-3 h-3" />
              {dateRange}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            title={journey.theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            onClick={() => {
              const nextTheme = journey.theme === "light" ? "dark" : "light";
              fetch(`/api/journeys/${numId}`, {
                method: "PATCH", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ theme: nextTheme }),
              }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
              }).then(updated => {
                qc.setQueryData(["journeys", id], updated);
              }).catch(() => {
                toast({ title: "Failed to update theme", variant: "destructive" });
              });
            }}
          >
            {journey.theme === "light" ? <Moon className="w-3.5 h-3.5 mr-1.5" /> : <Sun className="w-3.5 h-3.5 mr-1.5" />}
            {journey.theme === "light" ? "Dark" : "Light"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBgOpen(true)}
            title="Customize the viewer background"
          >
            <Palette className="w-3.5 h-3.5 mr-1.5" />
            Background
          </Button>
          <Button
            variant={journey.navigationMode === "sequential" ? "default" : "outline"}
            size="sm"
            title={journey.navigationMode === "sequential" ? "Switch to free navigation (filmstrip)" : "Switch to sequential navigation (step-by-step)"}
            onClick={() => {
              const nextMode = journey.navigationMode === "sequential" ? "free" : "sequential";
              fetch(`/api/journeys/${numId}`, {
                method: "PATCH", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ navigationMode: nextMode }),
              }).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
              }).then(updated => {
                qc.setQueryData(["journeys", id], updated);
              }).catch(() => {
                toast({ title: "Failed to update navigation mode", variant: "destructive" });
              });
            }}
          >
            <Layers className="w-3.5 h-3.5 mr-1.5" />
            {journey.navigationMode === "sequential" ? "Sequential" : "Free"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setScheduleOpen(true)}
            className={cn(dateRange ? "border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100" : "")}
          >
            <Calendar className="w-3.5 h-3.5 mr-1.5" />
            {dateRange ? "Schedule" : "Set Schedule"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Preview as visitor — simulate the visitor experience including gate enforcement"
            onClick={() => setVisitorPreviewOpen(true)}
          >
            <Eye className="w-3.5 h-3.5 mr-1.5" />
            Preview as visitor
          </Button>
          {journey.status === "published" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/j/${journey.slug}`, "_blank")}
              >
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                Open
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Copy public link" onClick={copyPublicLink}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className={journey.status === "published" ? "bg-gray-600 hover:bg-gray-700" : "bg-indigo-600 hover:bg-indigo-700"}
                disabled={statusMutation.isPending}
              >
                {statusMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                {journey.status === "published" ? "Unpublish" : "Publish"}
                <ChevronDown className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {journey.status !== "draft" && (
                <DropdownMenuItem onClick={() => statusMutation.mutate("draft")}>Set to Draft</DropdownMenuItem>
              )}
              {journey.status !== "published" && (
                <DropdownMenuItem onClick={() => statusMutation.mutate("published")}>Publish</DropdownMenuItem>
              )}
              {journey.status !== "archived" && (
                <DropdownMenuItem onClick={() => statusMutation.mutate("archived")}>Archive</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Header Configuration ── */}
      <HeaderConfigCard journey={journey} numId={numId} qc={qc} pages={pages} />

      {/* ── Contest Scenario Videos ── */}
      <ScenarioVideosCard journey={journey} numId={numId} qc={qc} />

      {/* ── Linked Plays ── */}
      {(() => {
        const linkedPlays = journey.linkedPlays ?? [];
        const linkedIds = new Set(linkedPlays.map(p => p.id));
        const unlinkedPlays = allPlays.filter(p => !linkedIds.has(p.id));
        return (
          <div className="border rounded-lg p-4 space-y-3 bg-card">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-indigo-600" />
                Linked Plays
              </h3>
              <DropdownMenu open={linkPlayOpen} onOpenChange={setLinkPlayOpen}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                    <Link2 className="w-3.5 h-3.5" />
                    Link Play
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto w-56">
                  {unlinkedPlays.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {allPlays.length === 0 ? "No plays found" : "All plays already linked"}
                    </div>
                  ) : (
                    unlinkedPlays.map(play => (
                      <DropdownMenuItem
                        key={play.id}
                        onClick={() => linkPlayMutation.mutate(play.id)}
                        disabled={linkPlayMutation.isPending}
                      >
                        {play.name}
                        <span className="ml-auto text-[10px] text-muted-foreground capitalize">{play.status}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {linkedPlays.length === 0 ? (
              <p className="text-xs text-muted-foreground">No plays linked — use "Link Play" to associate this journey with a play.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {linkedPlays.map(play => (
                  <span
                    key={play.id}
                    className="inline-flex items-center gap-1 text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-full"
                  >
                    <button
                      type="button"
                      className="hover:underline focus:outline-none"
                      title={`Open play: ${play.name}`}
                      onClick={() => navigate(`/plays/${play.id}`)}
                    >
                      {play.name}
                    </button>
                    <ExternalLink className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                    <button
                      type="button"
                      className="ml-0.5 text-indigo-300 hover:text-destructive transition-colors"
                      title="Unlink"
                      onClick={() => unlinkPlayMutation.mutate(play.id)}
                      disabled={unlinkPlayMutation.isPending}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── View toggle ── */}
      <div className="flex items-center gap-0.5 p-0.5 bg-muted rounded-lg w-fit">
        {(["pages", "contacts", "routing", "analytics"] as const).map(view => {
          const labels = { pages: "Pages", contacts: "Contacts", routing: "Routing", analytics: "Analytics" };
          const icons  = { pages: FileText, contacts: Users, routing: GitBranch, analytics: BarChart2 } as const;
          const Icon   = icons[view];
          return (
            <button
              key={view}
              onClick={() => setBuilderView(view)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                builderView === view
                  ? "bg-white shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {labels[view]}
            </button>
          );
        })}
      </div>

      {/* ── Contacts view ── */}
      {builderView === "contacts" && (
        <div className="border rounded-lg bg-card overflow-hidden">
          <ContactsTab journeyId={numId} />
        </div>
      )}

      {/* ── Routing rules view ── */}
      {builderView === "routing" && (
        <div className="border rounded-lg bg-card overflow-hidden">
          <RoutingTab journeyId={numId} />
        </div>
      )}

      {/* ── Analytics view ── */}
      {builderView === "analytics" && (
        <div className="space-y-4">
          {/* Date range filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground shrink-0">Date range:</span>
            <Input
              type="date"
              value={analyticsDateFrom}
              onChange={e => setAnalyticsDateFrom(e.target.value)}
              className="h-8 text-xs w-36"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="date"
              value={analyticsDateTo}
              onChange={e => setAnalyticsDateTo(e.target.value)}
              className="h-8 text-xs w-36"
            />
            {(analyticsDateFrom || analyticsDateTo) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setAnalyticsDateFrom(""); setAnalyticsDateTo(""); }}
              >
                <X className="w-3.5 h-3.5 mr-1" />
                Clear
              </Button>
            )}
            {(analyticsDateFrom || analyticsDateTo) && (
              <span className="text-[11px] text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                Filtered
              </span>
            )}
          </div>

          {/* Day range toggle */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Visitor engagement over time</p>
            <div className="flex items-center gap-0.5 p-0.5 bg-muted rounded-lg">
              {([14, 30] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setTrendDays(d)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                    trendDays === d
                      ? "bg-white shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* KPI summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <Card className="shadow-xs">
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center gap-2 mb-1">
                  <EyeIcon className="w-3.5 h-3.5 text-indigo-500" />
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Page Views</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">
                  {trendsLoading ? "—" : (trendsData?.totalViews ?? 0).toLocaleString()}
                </p>
              </CardContent>
            </Card>
            <Card className="shadow-xs">
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-3.5 h-3.5 text-emerald-500" />
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Unique Visitors</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">
                  {trendsLoading ? "—" : (trendsData?.uniqueVisitors ?? 0).toLocaleString()}
                </p>
              </CardContent>
            </Card>
            <Card className="shadow-xs">
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center gap-2 mb-1">
                  <MousePointer2 className="w-3.5 h-3.5 text-amber-500" />
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">CTA Clicks</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">
                  {trendsLoading ? "—" : (trendsData?.totalCtaClicks ?? 0).toLocaleString()}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Visitor trends line chart */}
          <Card className="shadow-xs">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Visitor Trends ({trendDays} days)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {trendsLoading ? (
                <div className="flex items-center justify-center h-[200px]">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart
                    data={trendsData?.trend ?? []}
                    margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      tickFormatter={v => v.slice(5)}
                    />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="pageViews"
                      stroke="#6366f1"
                      dot={false}
                      strokeWidth={2}
                      name="Page Views"
                    />
                    <Line
                      type="monotone"
                      dataKey="uniqueVisitors"
                      stroke="#10b981"
                      dot={false}
                      strokeWidth={2}
                      name="Unique Visitors"
                    />
                    <Line
                      type="monotone"
                      dataKey="ctaClicks"
                      stroke="#f59e0b"
                      dot={false}
                      strokeWidth={1.5}
                      name="CTA Clicks"
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Per-page stats table */}
          <Card className="shadow-xs">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Page-by-Page Stats{(analyticsDateFrom || analyticsDateTo) ? " (filtered)" : ""}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              {pageStatsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : !pageStatsData?.pages?.length ? (
                <p className="text-sm text-muted-foreground text-center py-6">No page events recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground w-6">#</th>
                        <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Page</th>
                        <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Views</th>
                        <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Unique</th>
                        <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">CTA Clicks</th>
                        <th className="text-right py-1.5 font-medium text-muted-foreground">CTR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pageStatsData.pages.map((p, i) => (
                        <tr key={p.pageId} className="hover:bg-muted/20 transition-colors">
                          <td className="py-2 pr-3 text-muted-foreground">{i + 1}</td>
                          <td className="py-2 pr-3 font-medium text-foreground max-w-[180px] truncate">{p.title}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{p.views.toLocaleString()}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{p.uniqueVisitors.toLocaleString()}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{p.ctaClicks.toLocaleString()}</td>
                          <td className="py-2 text-right">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              p.ctr >= 20 ? "bg-emerald-50 text-emerald-700" :
                              p.ctr >= 10 ? "bg-amber-50 text-amber-700" :
                              p.ctr > 0   ? "bg-orange-50 text-orange-700" :
                                            "bg-gray-50 text-muted-foreground"
                            }`}>
                              {p.ctr}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Event Log — funnel summary + recent raw events */}
          <Card className="shadow-xs">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Event Log
                </CardTitle>
                <span className="text-[10px] text-muted-foreground">Live · last 100 events · auto-refreshes 30 s</span>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-3">
              {eventsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* Funnel summary chips — click to filter, click again (or All) to clear */}
                  {(eventsData?.summary?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <button
                        onClick={() => setEventTypeFilter("")}
                        className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors ${
                          !eventTypeFilter
                            ? "bg-slate-700 border-slate-700 text-white"
                            : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                        }`}
                      >
                        All
                      </button>
                      {(eventsData?.summary ?? []).map(s => (
                        <button
                          key={s.eventType}
                          onClick={() => setEventTypeFilter(f => f === s.eventType ? "" : s.eventType)}
                          title="Click to filter by this event type"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors ${
                            eventTypeFilter === s.eventType
                              ? "bg-indigo-600 border-indigo-600 text-white"
                              : "bg-indigo-50 border-indigo-100 text-indigo-700 hover:bg-indigo-100"
                          }`}
                        >
                          <span className="font-mono">{s.eventType}</span>
                          <span className="font-bold">{s.cnt.toLocaleString()}</span>
                        </button>
                      ))}
                      {eventTypeFilter && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          Showing <span className="font-mono font-medium text-indigo-700">{eventTypeFilter}</span> only
                        </span>
                      )}
                    </div>
                  )}

                  {/* Raw event rows */}
                  {(eventsData?.events?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">No events recorded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Time</th>
                            <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Event</th>
                            <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Page</th>
                            <th className="text-left py-1.5 font-medium text-muted-foreground">Props</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {(eventsData?.events ?? []).map(ev => (
                            <tr key={ev.id} className="hover:bg-muted/20 transition-colors">
                              <td className="py-1.5 pr-3 text-muted-foreground tabular-nums whitespace-nowrap">
                                {new Date(ev.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                              </td>
                              <td className="py-1.5 pr-3 font-mono font-medium text-indigo-700 whitespace-nowrap">
                                {ev.eventType}
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground max-w-[140px] truncate">
                                {ev.pageTitle ?? "—"}
                              </td>
                              <td className="py-1.5 text-muted-foreground max-w-[240px] truncate font-mono text-[10px]">
                                {ev.props ? JSON.stringify(ev.props) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Stats bar (only in pages view) ── */}
      {builderView === "pages" && (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{pages.length} {pages.length === 1 ? "page" : "pages"} · {journey.totalViews.toLocaleString()} total views</span>
          {hiddenCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600 text-xs font-medium">
              <EyeOff className="w-3 h-3" /> {hiddenCount} hidden
            </span>
          )}
        </div>
        <Button size="sm" onClick={openAdd} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4 mr-1.5" /> Add Page
        </Button>
      </div>
      )}

      {builderView === "pages" && (
        <div
          className="rounded-xl transition-all overflow-hidden"
          style={
            journey.viewerBg
              ? { ...previewStyleFor(journey.viewerBg as any), padding: "16px" }
              : journey.theme === "dark"
              ? { background: "#0f0f0f", padding: "16px" }
              : { padding: 0 }
          }
        >
        {pagesLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : pages.length === 0 ? (
          <div className="border-2 border-dashed rounded-xl p-16 text-center space-y-3"
            style={journey.theme === "dark" || journey.viewerBg ? { borderColor: "rgba(255,255,255,0.15)" } : {}}>
            <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mx-auto">
              <Plus className="w-5 h-5 text-indigo-600" />
            </div>
            <p className="font-medium" style={journey.theme === "dark" || journey.viewerBg ? { color: "#fff" } : {}}>No pages yet</p>
            <p className="text-sm text-muted-foreground">Add your first page to start building the journey</p>
            <Button size="sm" onClick={openAdd} className="bg-indigo-600 hover:bg-indigo-700 mt-2">
              Add First Page
            </Button>
          </div>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <SortableContext items={pages.map(p => p.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {pages.map((page, index) => (
                  <SortablePageCard
                    key={page.id}
                    page={page}
                    index={index}
                    stages={stages}
                    onEdit={openEdit}
                    onDelete={setDeleteTarget}
                    onToggleVisibility={p => toggleVisibilityMutation.mutate(p)}
                    isTogglingVisibility={togglingPageId === page.id}
                    pageComponents={pageComponentsMap[page.id] ?? []}
                    isCompDragging={!!activeDragComp}
                    formsById={formsById}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activePageData && (
                <div className="flex items-center gap-3 p-4 bg-card border rounded-lg shadow-xl opacity-90">
                  <GripVertical className="w-4 h-4 text-muted-foreground/40" />
                  <PageTypeIcon type={activePageData.pageType} className="w-5 h-5" />
                  <span className="text-sm font-medium">{activePageData.title}</span>
                </div>
              )}
              {activeDragComp && (
                <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-indigo-300 rounded-lg shadow-xl text-xs font-medium text-foreground opacity-95 max-w-[220px]">
                  {activeDragComp.componentType === "cta"
                    ? <MousePointerClick className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    : activeDragComp.componentType === "form"
                    ? <ClipboardList className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                    : <Megaphone className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                  <span className="truncate">
                    {activeDragComp.ctaLabel ?? activeDragComp.ctaName ?? activeDragComp.formName ?? activeDragComp.bannerName ?? `${activeDragComp.componentType} #${activeDragComp.componentId}`}
                  </span>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )
        }
        </div>
      )}

      <PageEditor
        open={sheetOpen}
        page={editingPage}
        journeyId={numId}
        stages={stages}
        journeySlug={journey.slug}
        clientSlug={slugify(journey.clientName ?? "")}
        pageIndex={editingPage
          ? pages.filter(p => p.isPublished !== false).findIndex(p => p.id === editingPage.id)
          : -1}
        isDarkTheme={journey.theme !== "light"}
        onClose={() => setSheetOpen(false)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["journeys", id, "pages"] });
          qc.invalidateQueries({ queryKey: ["journeys", id] });
        }}
      />

      {journey && (
        <ScheduleSheet
          open={scheduleOpen}
          journey={journey}
          onClose={() => setScheduleOpen(false)}
          onSaved={(updated) => {
            qc.setQueryData(["journeys", id], updated);
            qc.invalidateQueries({ queryKey: ["journeys"] });
          }}
        />
      )}

      {/* ── Viewer Background Dialog ── */}
      <ViewerBgDialog
        open={bgOpen}
        onOpenChange={setBgOpen}
        journeyId={numId}
        initial={journey?.viewerBg ?? null}
        onSaved={(next) => {
          qc.setQueryData<Journey>(["journeys", id], (prev) => prev ? { ...prev, viewerBg: next } : prev);
        }}
      />

      {/* ── Visitor Preview Dialog ── */}
      <Dialog open={visitorPreviewOpen} onOpenChange={open => {
        setVisitorPreviewOpen(open);
        if (!open) { setPreviewContactId(null); setPreviewContactName(""); setPreviewContactSearch(""); setPreviewContactOpen(false); }
      }}>
        <DialogContent className="max-w-5xl w-full p-0 overflow-hidden flex flex-col" style={{ height: "90vh" }}>
          <DialogTitle className="sr-only">Preview as visitor</DialogTitle>
          <DialogDescription className="sr-only">
            Simulated visitor view of the journey including gate enforcement.
          </DialogDescription>
          <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-200 shrink-0 flex-wrap">
            <Eye className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-sm font-semibold text-amber-800">Preview mode</span>
            <span className="text-xs text-amber-600 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
              Gates enforced · Not the live URL
            </span>
            {/* ── Preview as contact picker ── */}
            <div className="ml-auto relative">
              {previewContactId ? (
                <div className="flex items-center gap-1.5 text-xs bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-1">
                  <User className="w-3 h-3 text-indigo-500 shrink-0" />
                  <span className="font-medium text-indigo-700 max-w-[140px] truncate">{previewContactName}</span>
                  <button
                    type="button"
                    onClick={() => { setPreviewContactId(null); setPreviewContactName(""); setPreviewContactSearch(""); }}
                    className="text-indigo-400 hover:text-indigo-600 ml-0.5"
                    title="Clear contact"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <div className="flex items-center gap-1.5 border border-dashed border-amber-300 rounded-full px-2.5 py-1 bg-white/80">
                    <User className="w-3 h-3 text-amber-500 shrink-0" />
                    <input
                      type="text"
                      placeholder="Preview as contact…"
                      value={previewContactSearch}
                      onChange={e => { setPreviewContactSearch(e.target.value); setPreviewContactOpen(true); }}
                      onFocus={() => setPreviewContactOpen(true)}
                      className="text-xs bg-transparent outline-none w-36 placeholder:text-amber-400 text-foreground"
                    />
                    {previewContactSearch && (
                      <button type="button" onClick={() => { setPreviewContactSearch(""); setPreviewContactOpen(false); }}>
                        <X className="w-3 h-3 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  {previewContactOpen && previewContactSearch.length >= 1 && (
                    <PreviewContactDropdown
                      search={previewContactSearch}
                      onSelect={(id, name) => {
                        setPreviewContactId(id);
                        setPreviewContactName(name);
                        setPreviewContactSearch("");
                        setPreviewContactOpen(false);
                      }}
                      onClose={() => setPreviewContactOpen(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          {visitorPreviewOpen && journey && (
            <iframe
              key={`${journey.id}-${previewContactId ?? "anon"}`}
              src={`/j-preview/${journey.id}${previewContactId ? `?cid=${previewContactId}` : ""}`}
              title="Journey preview"
              className="flex-1 w-full border-0 min-h-0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete page?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title}" will be permanently deleted.
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
