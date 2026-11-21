import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, closestCenter, PointerSensor, KeyboardSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft, Save, Loader2, Plus, Trash2, GripVertical, Copy,
  Monitor, Smartphone, Type, AlignLeft, Mail, Phone, CheckSquare,
  List, ChevronDown, FileText, Minus, ShieldCheck, Scroll, Lock,
  MousePointerClick, Settings2, Tag, ImageIcon, Upload, X, Check,
  Link2, MailOpen, RotateCcw, Bell, Eye, EyeOff, Share2, ArrowUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { CtaButtonPicker } from "@/components/CtaButtonPicker";
import { CtaButtonPreview } from "@/components/CtaButtonPreview";
import { AssetPicker, type PickedAsset } from "@/components/AssetPicker";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FormFieldType =
  | "short_text" | "long_text" | "email" | "phone"
  | "checkbox_group" | "radio_group" | "dropdown"
  | "consent" | "tnc" | "privacy_policy"
  | "section_heading" | "divider";

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  placeholder?: string;
  required: boolean;
  hidden?: boolean;
  mapToContactField?: string;
  mapToBiField?: string;
  options?: string[];
  rows?: number;
  consentText?: string;
  storeAsTag?: boolean;
  tncUrl?: string;
  privacyUrl?: string;
  dividerColor?: string;
  dividerStyle?: string;
}

export type LayoutPreset = "centered_card" | "full_width" | "two_column" | "minimal_inline";
export type TagMode = "everyone" | "with_tag" | "without_tag";
export type CtaPosition = "above_fields" | "below_submit" | "inline_bottom";

export interface SubmitButtonConfig {
  label: string;
  bgColor: string;
  textColor: string;
  sizePreset: "small" | "medium" | "large" | "full";
  borderRadius: "sharp" | "slightly_rounded" | "pill";
}

export interface OnSubmitConfig {
  thankYouTitle: string;
  thankYouBody: string;
  deliveryAssetId: number | null;
  deliveryMethod: "download_button" | "email";
  enrollSequenceId: number | null;
  redirectUrl: string;
  redirectDelay: number;
}

export interface ConfirmationEmailConfig {
  enabled: boolean;
  subject: string;
  body: string;
  attachAsset: boolean;
}

export interface FormStyling {
  fontFamily: string;
  formBg: string;
  fieldBg: string;
  labelColor: string;
  containerRadius: "sharp" | "slightly_rounded" | "rounded";
  inputRadius: "sharp" | "slightly_rounded" | "rounded";
}

export interface FormConfig {
  biLead?: boolean;
  layout: LayoutPreset;
  fields: FormField[];
  headerElements: {
    logoUrl?: string;
    logoAlignment?: "left" | "center" | "right";
    logoMaxWidth?: number;
    headerImageUrl?: string;
    headerImageHeight?: number;
  };
  submitButton: SubmitButtonConfig;
  textBelowSubmit: string;
  onSubmit: OnSubmitConfig;
  styling: FormStyling;
  tagTargeting: { mode: TagMode; tag: string };
  ctaButtonId: number | null;
  ctaPosition: CtaPosition;
  ctaEnabled: boolean;
  confirmationEmail: ConfirmationEmailConfig;
  notifyOnSubmit: boolean;
}

export interface JourneyFormRecord {
  id: number;
  tenantId: number;
  name: string;
  config: FormConfig;
  createdAt: string;
  submissionCount: number;
}

interface CtaButtonData {
  id: number;
  name: string;
  label: string;
  actionType: string;
  actionConfig: Record<string, unknown>;
  styleConfig: Record<string, unknown>;
  usedIn: number;
}

interface Sequence {
  id: number;
  name: string;
  status: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FormConfig = {
  layout: "centered_card",
  fields: [],
  headerElements: { logoAlignment: "left", logoMaxWidth: 120, headerImageHeight: 180 },
  submitButton: { label: "Submit", bgColor: "#4f46e5", textColor: "#ffffff", sizePreset: "full", borderRadius: "slightly_rounded" },
  textBelowSubmit: "",
  onSubmit: { thankYouTitle: "Thank you!", thankYouBody: "We'll be in touch shortly.", deliveryAssetId: null, deliveryMethod: "download_button", enrollSequenceId: null, redirectUrl: "", redirectDelay: 0 },
  styling: { fontFamily: "inherit", formBg: "#ffffff", fieldBg: "#f9fafb", labelColor: "#111827", containerRadius: "slightly_rounded", inputRadius: "slightly_rounded" },
  tagTargeting: { mode: "everyone", tag: "" },
  ctaButtonId: null,
  ctaPosition: "below_submit",
  ctaEnabled: false,
  confirmationEmail: { enabled: false, subject: "", body: "", attachAsset: false },
  notifyOnSubmit: false,
};

const CONTACT_FIELDS = [
  { value: "firstName", label: "First Name" },
  { value: "lastName",  label: "Last Name" },
  { value: "email",     label: "Email" },
  { value: "phone",     label: "Phone" },
  { value: "jobTitle",  label: "Job Title" },
  { value: "company",   label: "Company" },
  { value: "city",      label: "City" },
  { value: "country",   label: "Country" },
  { value: "linkedinUrl", label: "LinkedIn URL" },
];

type PaletteItem = { type: FormFieldType; label: string; icon: React.ElementType; defaultLabel: string };

const PALETTE_GROUPS: { group: string; items: PaletteItem[] }[] = [
  {
    group: "Layout",
    items: [
      { type: "section_heading", label: "Section Heading", icon: Type,         defaultLabel: "Section Title" },
      { type: "divider",         label: "Divider",         icon: Minus,        defaultLabel: "" },
    ],
  },
  {
    group: "Fields",
    items: [
      { type: "short_text",    label: "Short Text",      icon: AlignLeft,    defaultLabel: "Your name" },
      { type: "long_text",     label: "Long Text",       icon: FileText,     defaultLabel: "Your message" },
      { type: "email",         label: "Email",           icon: Mail,         defaultLabel: "Email address" },
      { type: "phone",         label: "Phone",           icon: Phone,        defaultLabel: "Phone number" },
      { type: "checkbox_group",label: "Checkbox Group",  icon: CheckSquare,  defaultLabel: "Select all that apply" },
      { type: "radio_group",   label: "Radio Group",     icon: List,         defaultLabel: "Choose one" },
      { type: "dropdown",      label: "Dropdown",        icon: ChevronDown,  defaultLabel: "Select option" },
    ],
  },
  {
    group: "Consent & Legal",
    items: [
      { type: "consent",       label: "Consent Checkbox", icon: ShieldCheck,  defaultLabel: "I agree to receive marketing communications" },
      { type: "tnc",           label: "T&C Checkbox",     icon: Scroll,       defaultLabel: "I accept the Terms & Conditions" },
      { type: "privacy_policy",label: "Privacy Policy",   icon: Lock,         defaultLabel: "I accept the Privacy Policy" },
    ],
  },
];

const LAYOUT_PRESETS: { key: LayoutPreset; label: string; desc: string }[] = [
  { key: "centered_card",    label: "Centered Card",    desc: "White card, centered, max-w-md" },
  { key: "full_width",       label: "Full Width Panel", desc: "Edge-to-edge form, no card" },
  { key: "two_column",       label: "Two Column",       desc: "Fields left, image/content right" },
  { key: "minimal_inline",   label: "Minimal Inline",   desc: "Bare fields, no background" },
];

const BG_PRESETS = [
  "#ffffff", "#f9fafb", "#f0f4ff", "#f0fdf4",
  "#fefce8", "#fdf2f8", "#1e1b4b", "#0f172a",
];

function generateId() { return `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

function makeField(type: FormFieldType, defaultLabel: string): FormField {
  const base: FormField = { id: generateId(), type, label: defaultLabel, required: false };
  if (["checkbox_group", "radio_group", "dropdown"].includes(type))
    return { ...base, options: ["Option 1", "Option 2", "Option 3"] };
  if (type === "section_heading") return { ...base, label: "Section Title" };
  if (type === "divider") return { ...base, label: "", dividerColor: "#e5e7eb", dividerStyle: "solid" };
  if (type === "consent") return { ...base, consentText: "I agree to receive marketing communications.", storeAsTag: false };
  if (type === "tnc") return { ...base, tncUrl: "" };
  if (type === "privacy_policy") return { ...base, privacyUrl: "" };
  return base;
}

// ── Small shared sub-components ───────────────────────────────────────────────

function SectionHeader({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2 pb-1 border-b mb-3">
      <Icon className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
      <span className="text-[11px] font-semibold text-foreground uppercase tracking-wide">{label}</span>
    </div>
  );
}

function ColorField({ label, value, onChange, presets = BG_PRESETS }: {
  label: string; value: string; onChange: (v: string) => void; presets?: string[];
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {presets.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              style={{ backgroundColor: c }}
              className={cn("w-5 h-5 rounded-full border transition-all", value === c ? "ring-2 ring-indigo-500 ring-offset-1" : "border-gray-300 hover:scale-110")}
            />
          ))}
        </div>
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border border-gray-300 p-0 bg-transparent shrink-0" />
      </div>
    </div>
  );
}

function SmallImageUpload({ value, onChange, label }: { value: string; onChange: (url: string) => void; label: string }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  async function handleFile(file: File) {
    setUploading(true);
    try {
      const r1 = await fetch("/api/storage/uploads/request-url", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }) });
      if (!r1.ok) throw new Error();
      const { uploadURL, objectPath } = await r1.json() as { uploadURL: string; objectPath: string };
      await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      onChange(`/api/storage${objectPath}`);
      toast({ title: "Image uploaded" });
    } catch { toast({ title: "Upload failed", variant: "destructive" }); }
    finally { setUploading(false); }
  }
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {value ? (
        <div className="relative group rounded overflow-hidden border bg-muted/30 h-16">
          <img src={value} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
            <button type="button" onClick={() => inputRef.current?.click()} className="text-white text-[10px] bg-white/20 px-2 py-1 rounded hover:bg-white/30">Replace</button>
            <button type="button" onClick={() => onChange("")} className="text-white text-[10px] bg-white/20 px-2 py-1 rounded hover:bg-white/30"><X className="w-3 h-3" /></button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}
          className="w-full h-12 border-2 border-dashed rounded flex items-center justify-center gap-1.5 text-muted-foreground hover:border-indigo-300 hover:bg-indigo-50/30 transition-all text-xs disabled:opacity-50">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploading ? "Uploading…" : "Upload"}
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
    </div>
  );
}

function OptionsList({ options = [], onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Options</Label>
      <div className="space-y-1">
        {options.map((opt, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input value={opt} onChange={e => { const next = [...options]; next[i] = e.target.value; onChange(next); }} className="h-7 text-xs flex-1" />
            <button type="button" onClick={() => onChange(options.filter((_, j) => j !== i))} className="shrink-0 text-muted-foreground hover:text-destructive"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...options, `Option ${options.length + 1}`])}
        className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
        <Plus className="w-3 h-3" /> Add option
      </button>
    </div>
  );
}

// ── FormPreviewCanvas (exported for list page mini-preview) ───────────────────

function renderFieldPreview(field: FormField, styling: FormStyling, submitBtn: SubmitButtonConfig, compact = false) {
  const inputCls = cn("w-full border px-2 text-xs text-gray-400 flex items-center",
    compact ? "h-5 text-[9px]" : "h-8",
    styling.inputRadius === "sharp" ? "rounded-none" : styling.inputRadius === "rounded" ? "rounded-lg" : "rounded-md",
  );
  const labelCls = cn("font-medium text-foreground mb-0.5", compact ? "text-[8px]" : "text-[10px]");
  const style = { backgroundColor: styling.fieldBg };

  if (field.type === "section_heading") return (
    <div className={cn("font-semibold text-foreground", compact ? "text-[9px]" : "text-sm")}>{field.label}</div>
  );
  if (field.type === "divider") return (
    <hr style={{ borderColor: field.dividerColor ?? "#e5e7eb", borderStyle: (field.dividerStyle ?? "solid") as React.CSSProperties["borderStyle"] }} />
  );
  if (field.type === "consent" || field.type === "tnc" || field.type === "privacy_policy") return (
    <label className="flex items-start gap-1.5 cursor-pointer">
      <div className={cn("border rounded shrink-0 mt-0.5", compact ? "w-2.5 h-2.5" : "w-3.5 h-3.5")} style={style} />
      <span className={cn("text-muted-foreground leading-snug", compact ? "text-[7px]" : "text-[10px]")}>
        {field.type === "consent" ? (field.consentText ?? field.label) : field.label}
      </span>
    </label>
  );
  if (field.type === "checkbox_group" || field.type === "radio_group") return (
    <div className="space-y-0.5">
      <div className={labelCls} style={{ color: styling.labelColor }}>{field.label}{field.required && " *"}</div>
      {(field.options ?? []).slice(0, compact ? 2 : 3).map((opt, i) => (
        <label key={i} className="flex items-center gap-1.5">
          <div className={cn("border shrink-0", compact ? "w-2 h-2" : "w-3 h-3", field.type === "radio_group" ? "rounded-full" : "rounded")} style={style} />
          <span className={cn("text-muted-foreground", compact ? "text-[7px]" : "text-[10px]")}>{opt}</span>
        </label>
      ))}
    </div>
  );
  if (field.type === "long_text") return (
    <div>
      <div className={labelCls} style={{ color: styling.labelColor }}>{field.label}{field.required && " *"}</div>
      <div className={cn(inputCls, "items-start pt-1", compact ? "h-8" : "h-16")} style={style}>{field.placeholder ?? ""}</div>
    </div>
  );
  return (
    <div>
      <div className={labelCls} style={{ color: styling.labelColor }}>{field.label}{field.required && " *"}</div>
      <div className={inputCls} style={style}>{field.placeholder ?? ""}</div>
    </div>
  );
}

const radiusMap: Record<string, string> = { sharp: "rounded-none", slightly_rounded: "rounded-lg", rounded: "rounded-2xl" };

export function FormPreviewCanvas({ config, compact = false, selectedId, onSelect }: {
  config: FormConfig;
  compact?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const layout = config.layout ?? "centered_card";
  const fields = config.fields ?? [];
  const styling: FormStyling = { ...DEFAULT_CONFIG.styling, ...config.styling };
  const submitButton: SubmitButtonConfig = { ...DEFAULT_CONFIG.submitButton, ...config.submitButton };
  const headerElements = config.headerElements ?? DEFAULT_CONFIG.headerElements;
  const containerRadius = radiusMap[styling.containerRadius] ?? "rounded-lg";

  const inner = (
    <div className={cn("space-y-3", compact && "space-y-1.5")}>
      {fields.filter(f => !f.hidden).map(f => (
        <div key={f.id}
          onClick={() => onSelect?.(f.id)}
          className={cn(onSelect && "cursor-pointer rounded transition-all", selectedId === f.id && "ring-2 ring-indigo-500 ring-offset-1")}
        >
          {renderFieldPreview(f, styling, submitButton, compact)}
        </div>
      ))}
      {fields.length === 0 && !compact && (
        <div className="border-2 border-dashed rounded-lg py-10 text-center text-xs text-muted-foreground">
          Add fields from the left panel
        </div>
      )}
    </div>
  );

  const submitBtnRadius = { sharp: "rounded-none", slightly_rounded: "rounded-md", pill: "rounded-full" }[submitButton.borderRadius] ?? "rounded-md";
  const submitSizeCls = { small: "px-3 py-1 text-xs", medium: "px-4 py-1.5 text-sm", large: "px-6 py-2 text-base", full: "w-full py-2 text-sm" }[submitButton.sizePreset] ?? "w-full py-2 text-sm";

  const submitEl = (
    <div className={cn("font-semibold text-center", submitSizeCls, submitBtnRadius, compact && "text-[8px] py-0.5")}
      style={{ backgroundColor: submitButton.bgColor, color: submitButton.textColor }}>
      {submitButton.label}
    </div>
  );

  if (layout === "centered_card") return (
    <div className={cn("bg-white shadow-sm border mx-auto", containerRadius, compact ? "max-w-full p-2" : "max-w-md p-6")} style={{ backgroundColor: styling.formBg }}>
      {!compact && headerElements.headerImageUrl && <img src={headerElements.headerImageUrl} alt="" className="w-full object-cover rounded-md mb-4" style={{ height: headerElements.headerImageHeight ?? 180 }} />}
      {inner}
      {submitEl}
    </div>
  );

  if (layout === "full_width") return (
    <div className="bg-white border w-full p-6" style={{ backgroundColor: styling.formBg }}>
      {!compact && headerElements.headerImageUrl && <img src={headerElements.headerImageUrl} alt="" className="w-full object-cover mb-4" style={{ height: headerElements.headerImageHeight ?? 180 }} />}
      {inner}
      {submitEl}
    </div>
  );

  if (layout === "two_column") return (
    <div className={cn("bg-white border", containerRadius)} style={{ backgroundColor: styling.formBg }}>
      <div className="flex min-h-48">
        <div className={cn("flex-1 p-6", compact && "p-2 space-y-1")}>
          {inner}
          {submitEl}
        </div>
        {!compact && (
          <div className="w-48 bg-gray-100 flex items-center justify-center text-xs text-gray-400 rounded-r-lg">Header Image</div>
        )}
      </div>
    </div>
  );

  return (
    <div className={cn("p-4 space-y-3", compact && "p-1 space-y-1")}>
      {inner}
      {submitEl}
    </div>
  );
}

// ── CanvasDropZone ────────────────────────────────────────────────────────────

function CanvasDropZone({ children, isEmpty }: { children: React.ReactNode; isEmpty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas-drop" });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "space-y-4 min-h-[80px] rounded-lg transition-all",
        isOver && "ring-2 ring-indigo-400 ring-dashed bg-indigo-50/30",
        isEmpty && isOver && "py-6",
      )}
    >
      {children}
    </div>
  );
}

// ── Sortable field canvas item ────────────────────────────────────────────────

function SortableFieldItem({ field, isSelected, onSelect, onDuplicate, onDelete, onHide, onMoveTo, position, totalFields, config }: {
  field: FormField;
  isSelected: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onHide: () => void;
  onMoveTo: (newPos: number) => void;
  position: number;
  totalFields: number;
  config: FormConfig;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const [editingPos, setEditingPos] = useState(false);
  const [posInput, setPosInput] = useState("");
  const posInputRef = useRef<HTMLInputElement>(null);

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  function commitPos() {
    const n = parseInt(posInput, 10);
    if (!isNaN(n) && n >= 1 && n <= totalFields) onMoveTo(n);
    setEditingPos(false);
  }

  return (
    <div ref={setNodeRef} style={style} className={cn("group relative border rounded-lg transition-all", field.hidden ? "opacity-40" : "", isSelected ? "border-indigo-400 bg-indigo-50/30 ring-1 ring-indigo-300" : "border-transparent hover:border-gray-200 hover:bg-gray-50/50")}>
      {/* Hover toolbar */}
      <div className="absolute -top-6 right-0 hidden group-hover:flex items-center gap-0.5 z-10">
        {/* Drag handle */}
        <div {...attributes} {...listeners} className="cursor-grab p-1 text-muted-foreground hover:text-foreground bg-white border rounded shadow-sm" title="Drag to reorder">
          <GripVertical className="w-3 h-3" />
        </div>
        {/* Move to position */}
        {editingPos ? (
          <div className="flex items-center bg-white border rounded shadow-sm overflow-hidden">
            <input
              ref={posInputRef}
              autoFocus
              type="number"
              min={1}
              max={totalFields}
              value={posInput}
              onChange={e => setPosInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commitPos(); if (e.key === "Escape") setEditingPos(false); }}
              onBlur={commitPos}
              className="w-10 text-[11px] text-center outline-none px-1 py-0.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              placeholder={String(position)}
            />
          </div>
        ) : (
          <button
            type="button"
            title={`Position ${position} of ${totalFields} — click to move`}
            onClick={() => { setPosInput(String(position)); setEditingPos(true); }}
            className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground bg-white border rounded shadow-sm"
          >
            <ArrowUpDown className="w-2.5 h-2.5" />
            {position}/{totalFields}
          </button>
        )}
        {/* Hide / show */}
        <button
          type="button"
          onClick={onHide}
          title={field.hidden ? "Show field" : "Hide field"}
          className={cn("p-1 bg-white border rounded shadow-sm transition-colors", field.hidden ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground hover:text-foreground")}
        >
          {field.hidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        {/* Duplicate */}
        <button type="button" onClick={onDuplicate} title="Duplicate" className="p-1 text-muted-foreground hover:text-foreground bg-white border rounded shadow-sm"><Copy className="w-3 h-3" /></button>
        {/* Delete */}
        <button type="button" onClick={onDelete} title="Delete" className="p-1 text-muted-foreground hover:text-destructive bg-white border rounded shadow-sm"><Trash2 className="w-3 h-3" /></button>
      </div>
      {/* Hidden badge */}
      {field.hidden && (
        <div className="absolute top-1 right-1 flex items-center gap-0.5 text-[9px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 pointer-events-none">
          <EyeOff className="w-2.5 h-2.5" /> Hidden
        </div>
      )}
      <div className="p-2 cursor-pointer" onClick={onSelect}>
        {renderFieldPreview(field, config.styling, config.submitButton, false)}
      </div>
    </div>
  );
}

// ── FieldPropertiesPanel (right 280px) ────────────────────────────────────────

function FieldPropertiesPanel({ field, onChange }: {
  field: FormField;
  onChange: (updated: FormField) => void;
}) {
  const p = <K extends keyof FormField>(key: K, value: FormField[K]) => onChange({ ...field, [key]: value });
  const isLayoutEl = field.type === "section_heading" || field.type === "divider";
  const hasOptions = ["checkbox_group", "radio_group", "dropdown"].includes(field.type);
  const isConsent = ["consent", "tnc", "privacy_policy"].includes(field.type);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="text-xs font-semibold text-foreground uppercase tracking-wide text-muted-foreground mb-1">Field Properties</div>

      {/* Label */}
      {field.type !== "divider" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Label</Label>
          <Input value={field.label} onChange={e => p("label", e.target.value)} className="h-7 text-xs" />
        </div>
      )}

      {/* Placeholder */}
      {!isLayoutEl && !isConsent && (
        <div className="space-y-1.5">
          <Label className="text-xs">Placeholder</Label>
          <Input value={field.placeholder ?? ""} onChange={e => p("placeholder", e.target.value)} className="h-7 text-xs" />
        </div>
      )}

      {/* Required toggle */}
      {!isLayoutEl && (
        <div className="flex items-center justify-between">
          <Label className="text-xs">Required</Label>
          <Switch checked={field.required} onCheckedChange={v => p("required", v)} />
        </div>
      )}

      {/* Map to contact field */}
      {!isLayoutEl && !isConsent && (
        <div className="space-y-1.5">
          <Label className="text-xs">Map to contact field</Label>
          <Select
            value={field.mapToContactField ?? "_none"}
            onValueChange={v => p("mapToContactField", v === "_none" ? undefined : v)}
          >
            <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">None</SelectItem>
              {CONTACT_FIELDS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {!isLayoutEl && !isConsent && (
        <div className="space-y-1.5">
          <Label className="text-xs">HP BI field</Label>
          <Select value={field.mapToBiField ?? "_none"} onValueChange={v => p("mapToBiField", v === "_none" ? undefined : v)}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">Not mapped</SelectItem>
              <SelectItem value="companyName">Company / account name</SelectItem>
              <SelectItem value="hpId">Stable HP account ID</SelectItem>
              <SelectItem value="productInterest">Product / service</SelectItem>
              <SelectItem value="category">Reporting category</SelectItem>
              <SelectItem value="horizonMonths">Purchase horizon (months)</SelectItem>
              <SelectItem value="orderValue">Total Order Value (prospective)</SelectItem>
              <SelectItem value="currency">Currency (three-letter code)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">Captures declared HP lead context; value is not an opportunity or booked order.</p>
        </div>
      )}

      {/* Options list */}
      {hasOptions && (
        <OptionsList options={field.options ?? []} onChange={opts => p("options", opts)} />
      )}

      {/* Textarea rows */}
      {field.type === "long_text" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Rows</Label>
          <Input type="number" min={2} max={12} value={field.rows ?? 4} onChange={e => p("rows", parseInt(e.target.value) || 4)} className="h-7 text-xs" />
        </div>
      )}

      {/* Consent text */}
      {field.type === "consent" && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">Consent text</Label>
            <Textarea value={field.consentText ?? ""} onChange={e => p("consentText", e.target.value)} className="text-xs min-h-[60px]" />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Store as contact tag</Label>
            <Switch checked={field.storeAsTag ?? false} onCheckedChange={v => p("storeAsTag", v)} />
          </div>
        </>
      )}

      {/* T&C URL */}
      {field.type === "tnc" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Terms URL</Label>
          <Input value={field.tncUrl ?? ""} onChange={e => p("tncUrl", e.target.value)} placeholder="https://…" className="h-7 text-xs" />
        </div>
      )}

      {/* Privacy URL */}
      {field.type === "privacy_policy" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Privacy Policy URL</Label>
          <Input value={field.privacyUrl ?? ""} onChange={e => p("privacyUrl", e.target.value)} placeholder="https://…" className="h-7 text-xs" />
        </div>
      )}

      {/* Divider style */}
      {field.type === "divider" && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">Color</Label>
            <input type="color" value={field.dividerColor ?? "#e5e7eb"} onChange={e => p("dividerColor", e.target.value)} className="w-8 h-6 rounded cursor-pointer border" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Style</Label>
            <Select value={field.dividerStyle ?? "solid"} onValueChange={v => p("dividerStyle", v)}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="solid">Solid</SelectItem>
                <SelectItem value="dashed">Dashed</SelectItem>
                <SelectItem value="dotted">Dotted</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </div>
  );
}

// ── PaletteDragItem ───────────────────────────────────────────────────────────

function PaletteDragItem({ item, onAddField }: { item: PaletteItem; onAddField: (f: FormField) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${item.type}`,
    data: { paletteItem: item },
  });
  const Icon = item.icon;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onAddField(makeField(item.type, item.defaultLabel))}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-gray-200 text-left hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-grab active:cursor-grabbing select-none"
    >
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-foreground">{item.label}</span>
      <Plus className="w-3 h-3 text-muted-foreground ml-auto shrink-0" />
    </div>
  );
}

// ── ElementsPaletteTab ────────────────────────────────────────────────────────

function ElementsPaletteTab({ onAddField, config, patchConfig, ctaButtons, onCtaButtonChange }: {
  onAddField: (f: FormField) => void;
  config: FormConfig;
  patchConfig: (partial: Partial<FormConfig>) => void;
  ctaButtons: CtaButtonData[];
  onCtaButtonChange: (id: number | null) => void;
}) {
  const selectedCta = ctaButtons.find(b => b.id === config.ctaButtonId);

  return (
    <div className="p-3 space-y-4 overflow-y-auto h-full">
      {PALETTE_GROUPS.map(group => (
        <div key={group.group}>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{group.group}</div>
          <div className="space-y-1">
            {group.items.map(item => (
              <PaletteDragItem key={item.type} item={item} onAddField={onAddField} />
            ))}
          </div>
        </div>
      ))}

      {/* CTA Button toggle */}
      <div className="border-t pt-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-medium text-foreground flex items-center gap-1.5"><MousePointerClick className="w-3.5 h-3.5 text-violet-500" /> CTA Button</div>
            <div className="text-[10px] text-muted-foreground">Optional button in the form</div>
          </div>
          <Switch checked={config.ctaEnabled} onCheckedChange={v => patchConfig({ ctaEnabled: v })} />
        </div>
        {config.ctaEnabled && (
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Position</Label>
              <div className="grid grid-cols-1 gap-1">
                {([
                  ["above_fields",  "Above fields",   "Floats above the form card"],
                  ["below_submit",  "Below submit",   "Outside the card, below submit"],
                  ["inline_bottom", "Inline bottom",  "Inside the card, below submit"],
                ] as [CtaPosition, string, string][]).map(([val, lbl, desc]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => patchConfig({ ctaPosition: val })}
                    className={cn("text-xs px-2.5 py-1.5 rounded border text-left transition-all", config.ctaPosition === val ? "border-violet-400 bg-violet-50 text-violet-700" : "border-gray-200 hover:border-violet-300")}
                  >
                    <span className="font-medium">{lbl}</span>
                    <span className={cn("block text-[10px] mt-0.5", config.ctaPosition === val ? "text-violet-600" : "text-muted-foreground")}>{desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <CtaButtonPicker value={config.ctaButtonId} onChange={onCtaButtonChange} />
            {selectedCta?.actionType === "gated_form" && (
              <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                <span className="font-semibold shrink-0">⚠</span>
                <span>This CTA opens another form — visitors may see a nested form experience.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── FormSettingsPanel ─────────────────────────────────────────────────────────

const CONFIRMATION_EMAIL_TOKENS = [
  ["{{firstName}}", "First name"],
  ["{{lastName}}", "Last name"],
  ["{{email}}", "Email address"],
  ["{{formName}}", "Form name"],
  ["{{thankYouTitle}}", "Thank-you title"],
];

// ── SendTestEmailButton ────────────────────────────────────────────────────────

function SendTestEmailButton({
  formId,
  subject,
  body,
  deliveryAssetId,
}: {
  formId?: number;
  subject?: string;
  body?: string;
  deliveryAssetId?: number | null;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [toEmail, setToEmail] = useState("");
  const [emailError, setEmailError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  if (!formId) return null;

  const handleCopyPreviewLink = async () => {
    setCopyingLink(true);
    setLinkCopied(false);
    try {
      const res = await fetch(`/api/journey-forms/${formId}/generate-preview-token`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Could not generate preview link", description: data.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      const base = window.location.origin;
      const url = `${base}/api/public/journey-forms/${formId}/preview-confirmation-email?token=${encodeURIComponent(data.token)}`;
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      toast({ title: "Preview link copied!", description: "Valid for 24 hours — paste it into Slack, email, etc." });
      setTimeout(() => setLinkCopied(false), 3000);
    } catch {
      toast({ title: "Could not copy link", description: "Check browser clipboard permissions.", variant: "destructive" });
    } finally {
      setCopyingLink(false);
    }
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleSend = async () => {
    const trimmed = toEmail.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      setEmailError(true);
      return;
    }
    setEmailError(false);
    setSending(true);
    try {
      const payload: Record<string, unknown> = { subject, body, deliveryAssetId };
      if (trimmed) payload.to = trimmed;
      const res = await fetch(`/api/journey-forms/${formId}/test-confirmation-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Could not send test email", description: data.error ?? "Unknown error", variant: "destructive" });
      } else {
        toast({ title: "Test email sent!", description: `Sent to ${data.sentTo}` });
      }
    } catch {
      toast({ title: "Network error", description: "Failed to reach the server.", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="space-y-1.5">
        {/* Preview full email button */}
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="text-[11px] text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
        >
          <Eye className="w-3 h-3" />
          Preview full email
        </button>
        <div className="flex items-center gap-1.5">
          <Input
            type="email"
            value={toEmail}
            onChange={e => { setToEmail(e.target.value); setEmailError(false); }}
            placeholder="Your email (default)"
            className={cn("h-7 text-xs flex-1", emailError && "border-destructive focus-visible:ring-destructive")}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="text-[11px] text-indigo-600 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50 shrink-0 whitespace-nowrap"
          >
            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <MailOpen className="w-3 h-3" />}
            {sending ? "Sending…" : "Send test email"}
          </button>
        </div>
        {emailError && (
          <p className="text-[10px] text-destructive">Please enter a valid email address.</p>
        )}
      </div>

      {/* Full email preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl w-full p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="text-sm font-medium flex items-center gap-2">
                <Eye className="w-4 h-4 text-indigo-500" />
                Full email preview
              </DialogTitle>
              <button
                type="button"
                onClick={handleCopyPreviewLink}
                disabled={copyingLink}
                className="text-[11px] text-indigo-600 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50 shrink-0 whitespace-nowrap"
                title="Copy a shareable link valid for 24 hours"
              >
                {copyingLink ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : linkCopied ? (
                  <Check className="w-3 h-3 text-green-600" />
                ) : (
                  <Share2 className="w-3 h-3" />
                )}
                {copyingLink ? "Generating…" : linkCopied ? "Link copied!" : "Copy preview link"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Rendered with placeholder tokens — exactly as it will appear in the inbox.
            </p>
          </DialogHeader>
          <div className="h-[520px] overflow-hidden">
            <iframe
              key={previewOpen ? "open" : "closed"}
              src={`/api/journey-forms/${formId}/preview-confirmation-email`}
              className="w-full h-full border-0"
              title="Confirmation email preview"
              sandbox="allow-same-origin"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FormSettingsPanel({ config, patchConfig, formId }: {
  config: FormConfig;
  patchConfig: (partial: Partial<FormConfig>) => void;
  formId?: number;
}) {
  const patchOnSubmit = (p: Partial<OnSubmitConfig>) => patchConfig({ onSubmit: { ...config.onSubmit, ...p } });
  const patchStyling = (p: Partial<FormStyling>) => patchConfig({ styling: { ...config.styling, ...p } });
  const patchHeader = (p: Partial<typeof config.headerElements>) => patchConfig({ headerElements: { ...config.headerElements, ...p } });
  const patchSubmit = (p: Partial<SubmitButtonConfig>) => patchConfig({ submitButton: { ...config.submitButton, ...p } });
  const patchConfirmEmail = (p: Partial<ConfirmationEmailConfig>) =>
    patchConfig({ confirmationEmail: { ...config.confirmationEmail, ...p } });

  const [deliverAsset, setDeliverAsset] = useState(config.onSubmit.deliveryAssetId !== null);
  const [enrollSeq, setEnrollSeq] = useState(config.onSubmit.enrollSequenceId !== null);
  const [redirect, setRedirect] = useState(!!config.onSubmit.redirectUrl);
  const [showEmailPreview, setShowEmailPreview] = useState(false);

  const { data: sequences = [] } = useQuery<Sequence[]>({
    queryKey: ["sequences"],
    queryFn: () => fetch("/api/sequences", { credentials: "include" }).then(r => r.json()),
  });

  return (
    <div className="p-3 space-y-5 overflow-y-auto h-full">
      <div className="rounded border p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs">HP: this is a lead / demo / contact-request form</Label>
          <Switch checked={Boolean(config.biLead)} onCheckedChange={v => patchConfig({ biLead: v })} />
        </div>
        <p className="text-[11px] text-muted-foreground">Use for actual inquiries, not attendance or feedback alone. Mapped product interest also qualifies as a lead. Product/service + 0–3 months is Hot; over 3 through 6 months is Warm. Over 6 months, no clear horizon, or no product/service is Cold.</p>
      </div>
      {/* Layout */}
      <div>
        <SectionHeader icon={Settings2} label="Layout" />
        <div className="grid grid-cols-2 gap-2">
          {LAYOUT_PRESETS.map(preset => (
            <button
              key={preset.key}
              type="button"
              onClick={() => patchConfig({ layout: preset.key })}
              className={cn("border rounded-lg p-2 text-left transition-all space-y-1", config.layout === preset.key ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:border-indigo-300")}
            >
              <div className="w-full h-10 bg-gray-100 rounded overflow-hidden">
                <div style={{ transform: "scale(0.3)", transformOrigin: "top left", width: "333%", height: "333%" }}>
                  <FormPreviewCanvas config={{ ...config, layout: preset.key, fields: config.fields.length > 0 ? config.fields.slice(0, 2) : [{ id: "demo1", type: "short_text", label: "Name", required: false }, { id: "demo2", type: "email", label: "Email", required: true }] }} compact />
                </div>
              </div>
              <div className="text-[10px] font-medium">{preset.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Tag targeting */}
      <div>
        <SectionHeader icon={Tag} label="Tag Targeting" />
        <div className="space-y-2">
          {([["everyone", "Everyone"], ["with_tag", "Visitors WITH tag"], ["without_tag", "Visitors WITHOUT tag"]] as [TagMode, string][]).map(([mode, lbl]) => (
            <button
              key={mode}
              type="button"
              onClick={() => patchConfig({ tagTargeting: { ...config.tagTargeting, mode } })}
              className={cn("w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-all", config.tagTargeting.mode === mode ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-indigo-300")}
            >
              {lbl}
              {config.tagTargeting.mode === mode && <Check className="w-3.5 h-3.5" />}
            </button>
          ))}
          {config.tagTargeting.mode !== "everyone" && (
            <Input value={config.tagTargeting.tag} onChange={e => patchConfig({ tagTargeting: { ...config.tagTargeting, tag: e.target.value } })}
              placeholder="Tag name (e.g. champion)" className="h-7 text-xs" />
          )}
        </div>
      </div>

      {/* Header elements */}
      <div>
        <SectionHeader icon={ImageIcon} label="Header Elements" />
        <div className="space-y-3">
          <SmallImageUpload label="Logo" value={config.headerElements.logoUrl ?? ""} onChange={url => patchHeader({ logoUrl: url })} />
          {config.headerElements.logoUrl && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Logo alignment</Label>
                <div className="flex gap-1">
                  {(["left", "center", "right"] as const).map(a => (
                    <button key={a} type="button" onClick={() => patchHeader({ logoAlignment: a })}
                      className={cn("flex-1 text-xs py-1 rounded border capitalize transition-all", config.headerElements.logoAlignment === a ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-indigo-300")}>{a}</button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Logo max width: {config.headerElements.logoMaxWidth ?? 120}px</Label>
                <input type="range" min={40} max={300} step={10}
                  value={config.headerElements.logoMaxWidth ?? 120}
                  onChange={e => patchHeader({ logoMaxWidth: parseInt(e.target.value) })}
                  className="w-full h-1.5 accent-indigo-600" />
              </div>
            </>
          )}
          <SmallImageUpload label="Header Image" value={config.headerElements.headerImageUrl ?? ""} onChange={url => patchHeader({ headerImageUrl: url })} />
          {config.headerElements.headerImageUrl && (
            <div className="space-y-1.5">
              <Label className="text-xs">Image height: {config.headerElements.headerImageHeight ?? 180}px</Label>
              <input type="range" min={80} max={400} value={config.headerElements.headerImageHeight ?? 180} onChange={e => patchHeader({ headerImageHeight: parseInt(e.target.value) })} className="w-full h-1.5 accent-indigo-600" />
            </div>
          )}
        </div>
      </div>

      {/* Submit button */}
      <div>
        <SectionHeader icon={MousePointerClick} label="Submit Button" />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input value={config.submitButton.label} onChange={e => patchSubmit({ label: e.target.value })} className="h-7 text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ColorField label="Background" value={config.submitButton.bgColor} onChange={v => patchSubmit({ bgColor: v })} presets={["#4f46e5","#059669","#dc2626","#d97706","#0ea5e9","#000000","#ffffff","#6b7280"]} />
            <ColorField label="Text" value={config.submitButton.textColor} onChange={v => patchSubmit({ textColor: v })} presets={["#ffffff","#000000","#111827","#4f46e5","#059669","#dc2626","#d97706","#6b7280"]} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Size</Label>
            <Select value={config.submitButton.sizePreset} onValueChange={v => patchSubmit({ sizePreset: v as SubmitButtonConfig["sizePreset"] })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
                <SelectItem value="full">Full width</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Border radius</Label>
            <Select value={config.submitButton.borderRadius} onValueChange={v => patchSubmit({ borderRadius: v as SubmitButtonConfig["borderRadius"] })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sharp">Sharp</SelectItem>
                <SelectItem value="slightly_rounded">Slightly rounded</SelectItem>
                <SelectItem value="pill">Pill</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Text below submit */}
      <div>
        <Label className="text-xs">Text below submit</Label>
        <Textarea value={config.textBelowSubmit} onChange={e => patchConfig({ textBelowSubmit: e.target.value })} placeholder="e.g. No spam, unsubscribe any time." className="text-xs min-h-[48px] mt-1.5" />
      </div>

      {/* On-submit actions */}
      <div>
        <SectionHeader icon={MailOpen} label="On Submit" />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Thank-you title</Label>
            <Input value={config.onSubmit.thankYouTitle} onChange={e => patchOnSubmit({ thankYouTitle: e.target.value })} className="h-7 text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Thank-you body</Label>
            <Textarea value={config.onSubmit.thankYouBody} onChange={e => patchOnSubmit({ thankYouBody: e.target.value })} className="text-xs min-h-[48px]" />
          </div>

          {/* Deliver asset */}
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium">Deliver asset after submit</div>
              <Switch checked={deliverAsset} onCheckedChange={v => { setDeliverAsset(v); if (!v) patchOnSubmit({ deliveryAssetId: null }); }} />
            </div>
            {deliverAsset && (
              <div className="space-y-2">
                <AssetPicker
                  value={config.onSubmit.deliveryAssetId ? { assetId: config.onSubmit.deliveryAssetId, filename: "Asset", sizeBytes: 0, url: "" } : null}
                  onChange={(a: PickedAsset | null) => patchOnSubmit({ deliveryAssetId: a?.assetId ?? null })}
                />
                <div className="space-y-1.5">
                  <Label className="text-xs">Delivery method</Label>
                  <Select value={config.onSubmit.deliveryMethod} onValueChange={v => patchOnSubmit({ deliveryMethod: v as OnSubmitConfig["deliveryMethod"] })}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="download_button">Download button on screen</SelectItem>
                      <SelectItem value="email">Also email via Resend</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Enroll in sequence */}
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium">Enroll in sequence</div>
              <Switch checked={enrollSeq} onCheckedChange={v => { setEnrollSeq(v); if (!v) patchOnSubmit({ enrollSequenceId: null }); }} />
            </div>
            {enrollSeq && (
              <Select value={config.onSubmit.enrollSequenceId?.toString() ?? ""} onValueChange={v => patchOnSubmit({ enrollSequenceId: v ? parseInt(v) : null })}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Choose sequence…" /></SelectTrigger>
                <SelectContent>
                  {sequences.filter(s => s.status === "active" || s.status === "Active").map(s => <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>)}
                  {sequences.length === 0 && <SelectItem value="none" disabled>No sequences</SelectItem>}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Redirect */}
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium">Redirect after submit</div>
              <Switch checked={redirect} onCheckedChange={v => { setRedirect(v); if (!v) patchOnSubmit({ redirectUrl: "" }); }} />
            </div>
            {redirect && (
              <div className="space-y-2">
                <Input value={config.onSubmit.redirectUrl} onChange={e => patchOnSubmit({ redirectUrl: e.target.value })} placeholder="https://…" className="h-7 text-xs" />
                <div className="space-y-1">
                  <Label className="text-xs">Delay: {config.onSubmit.redirectDelay}s</Label>
                  <input type="range" min={0} max={10} step={1} value={config.onSubmit.redirectDelay} onChange={e => patchOnSubmit({ redirectDelay: parseInt(e.target.value) })} className="w-full h-1.5 accent-indigo-600" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Email */}
      <div>
        <SectionHeader icon={Mail} label="Confirmation Email" />
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium">Send confirmation email</div>
              <div className="text-[10px] text-muted-foreground">Sent to the visitor's email on submit</div>
            </div>
            <Switch
              checked={config.confirmationEmail.enabled}
              onCheckedChange={v => patchConfirmEmail({ enabled: v })}
            />
          </div>
          {config.confirmationEmail.enabled && config.onSubmit.deliveryAssetId !== null && (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium">Include asset as email attachment</div>
                <div className="text-[10px] text-muted-foreground">Attaches the delivery file directly to the email (signed-URL link still included as fallback)</div>
              </div>
              <Switch
                checked={config.confirmationEmail.attachAsset}
                onCheckedChange={v => patchConfirmEmail({ attachAsset: v })}
              />
            </div>
          )}
          {config.confirmationEmail.enabled && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Subject</Label>
                <Input
                  value={config.confirmationEmail.subject}
                  onChange={e => patchConfirmEmail({ subject: e.target.value })}
                  placeholder="e.g. Thanks for your submission!"
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Body (supports HTML)</Label>
                <Textarea
                  value={config.confirmationEmail.body}
                  onChange={e => patchConfirmEmail({ body: e.target.value })}
                  placeholder={`Hi {{firstName|there}},\n\nThank you for filling out {{formName}}. We'll be in touch shortly.`}
                  className="text-xs min-h-[96px] font-mono"
                />
              </div>
              {/* Merge tokens reference */}
              <div className="bg-muted/40 rounded-md p-2.5 space-y-1.5">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Available tokens</div>
                <div className="flex flex-wrap gap-1">
                  {CONFIRMATION_EMAIL_TOKENS.map(([token, desc]) => (
                    <button
                      key={token}
                      type="button"
                      title={desc}
                      onClick={() => patchConfirmEmail({ body: (config.confirmationEmail.body || "") + token })}
                      className="text-[10px] font-mono bg-indigo-50 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 rounded hover:bg-indigo-100 transition-colors"
                    >
                      {token}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-muted-foreground">Click a token to insert it. Use <span className="font-mono">{"{{firstName|there}}"}</span> for a fallback.</div>
              </div>
              {/* Preview toggle */}
              <button
                type="button"
                onClick={() => setShowEmailPreview(p => !p)}
                className="text-[11px] text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                {showEmailPreview ? "Hide preview" : "Show email preview"}
              </button>
              {showEmailPreview && (() => {
                const previewTokens: Record<string, string> = {
                  firstName: "Alex", lastName: "Smith", email: "alex@example.com",
                  phone: "+1 555 0100", formName: "Demo Request", thankYouTitle: "You're booked in!",
                  thankYouBody: "We'll be in touch shortly.",
                };
                const resolvePreview = (text: string) =>
                  text.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_: string, key: string, fallback?: string) =>
                    previewTokens[key] || fallback || "");
                const bodyText = config.confirmationEmail.body.trim() ||
                  `Hi {{firstName|there}},\n\nThank you for submitting {{formName}}. We'll be in touch shortly.`;
                const bodyHtml = bodyText.includes("<")
                  ? resolvePreview(bodyText)
                  : resolvePreview(bodyText).replace(/\n/g, "<br/>");
                return (
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-3 py-2 border-b">
                      <div className="text-[10px] text-muted-foreground">Subject:</div>
                      <div className="text-xs font-medium text-foreground">
                        {resolvePreview(config.confirmationEmail.subject.trim() || "Demo Request: submission confirmed")}
                      </div>
                    </div>
                    <div
                      className="p-3 text-xs text-foreground leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: bodyHtml }}
                    />
                  </div>
                );
              })()}
            </div>
          )}
          {/* Send test email — always visible on saved forms so admins can preview before enabling */}
          <SendTestEmailButton
            formId={formId}
            subject={config.confirmationEmail.subject}
            body={config.confirmationEmail.body}
            deliveryAssetId={config.onSubmit.deliveryAssetId}
          />
        </div>
      </div>

      {/* Team Notifications */}
      <div>
        <SectionHeader icon={Bell} label="Team Notifications" />
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium">Notify team on submission</div>
              <div className="text-[10px] text-muted-foreground">Creates an in-app notification for all team members when this form is submitted</div>
            </div>
            <Switch
              checked={config.notifyOnSubmit ?? false}
              onCheckedChange={v => patchConfig({ notifyOnSubmit: v })}
            />
          </div>
          {config.notifyOnSubmit && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-md px-3 py-2 flex items-start gap-2">
              <Bell className="w-3.5 h-3.5 text-indigo-600 mt-0.5 shrink-0" />
              <p className="text-[11px] text-indigo-700 leading-relaxed">
                A notification will appear in the bell icon for all team members whenever a contact submits this form.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Styling */}
      <div>
        <SectionHeader icon={Settings2} label="Styling" />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Font family</Label>
            <Select value={config.styling.fontFamily} onValueChange={v => patchStyling({ fontFamily: v })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[["inherit","System default"],["Inter, sans-serif","Inter"],["Georgia, serif","Georgia"],["'Courier New', monospace","Courier New"]].map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <ColorField label="Form background" value={config.styling.formBg} onChange={v => patchStyling({ formBg: v })} />
          <ColorField label="Field background" value={config.styling.fieldBg} onChange={v => patchStyling({ fieldBg: v })} presets={["#f9fafb","#f3f4f6","#ffffff","#f0f4ff","#fef9c3","#f0fdf4","#1f2937","#111827"]} />
          <ColorField label="Label color" value={config.styling.labelColor} onChange={v => patchStyling({ labelColor: v })} presets={["#111827","#374151","#6b7280","#4f46e5","#000000","#1e3a5f","#065f46","#7c3aed"]} />
          <div className="space-y-1.5">
            <Label className="text-xs">Container corners</Label>
            <Select value={config.styling.containerRadius} onValueChange={v => patchStyling({ containerRadius: v as FormStyling["containerRadius"] })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sharp">Sharp</SelectItem>
                <SelectItem value="slightly_rounded">Slightly rounded</SelectItem>
                <SelectItem value="rounded">Rounded</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Input corners</Label>
            <Select value={config.styling.inputRadius} onValueChange={v => patchStyling({ inputRadius: v as FormStyling["inputRadius"] })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sharp">Sharp</SelectItem>
                <SelectItem value="slightly_rounded">Slightly rounded</SelectItem>
                <SelectItem value="rounded">Rounded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── FormEditorPage ─────────────────────────────────────────────────────────────

export default function FormEditorPage({ id }: { id?: string }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState("Untitled Form");
  const [config, setConfig] = useState<FormConfig>(DEFAULT_CONFIG);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [saving, setSaving] = useState(false);
  const [activeDragPaletteItem, setActiveDragPaletteItem] = useState<PaletteItem | null>(null);
  const [gatedFormDialogOpen, setGatedFormDialogOpen] = useState(false);
  const [pendingCtaId, setPendingCtaId] = useState<number | null>(null);

  const isEdit = !!id;

  const { data: existing } = useQuery<JourneyFormRecord>({
    queryKey: ["journey-forms", id],
    queryFn: async () => {
      const r = await fetch(`/api/journey-forms/${id}`, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load form: ${r.status}`);
      return r.json();
    },
    enabled: isEdit,
  });

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      const c = existing.config;
      setConfig({
        ...DEFAULT_CONFIG,
        ...c,
        styling:            { ...DEFAULT_CONFIG.styling,            ...c.styling },
        submitButton:       { ...DEFAULT_CONFIG.submitButton,       ...c.submitButton },
        headerElements:     { ...DEFAULT_CONFIG.headerElements,     ...c.headerElements },
        onSubmit:           { ...DEFAULT_CONFIG.onSubmit,           ...c.onSubmit },
        biLead: Boolean(c.biLead),
        tagTargeting:       { ...DEFAULT_CONFIG.tagTargeting,       ...c.tagTargeting },
        confirmationEmail:  { ...DEFAULT_CONFIG.confirmationEmail,  ...c.confirmationEmail },
        fields: c.fields ?? [],
      });
    }
  }, [existing]);

  const { data: ctaButtons = [] } = useQuery<CtaButtonData[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
  });
  const selectedCta = ctaButtons.find(b => b.id === config.ctaButtonId);

  const patchConfig = (partial: Partial<FormConfig>) => setConfig(prev => ({ ...prev, ...partial }));

  const addField = (field: FormField) => {
    setConfig(prev => ({ ...prev, fields: [...prev.fields, field] }));
    setSelectedFieldId(field.id);
  };

  const updateField = (updated: FormField) => {
    setConfig(prev => ({ ...prev, fields: prev.fields.map(f => f.id === updated.id ? updated : f) }));
  };

  const duplicateField = (fieldId: string) => {
    const idx = config.fields.findIndex(f => f.id === fieldId);
    if (idx < 0) return;
    const copy = { ...config.fields[idx], id: generateId() };
    const next = [...config.fields];
    next.splice(idx + 1, 0, copy);
    setConfig(prev => ({ ...prev, fields: next }));
    setSelectedFieldId(copy.id);
  };

  const deleteField = (fieldId: string) => {
    setConfig(prev => ({ ...prev, fields: prev.fields.filter(f => f.id !== fieldId) }));
    if (selectedFieldId === fieldId) setSelectedFieldId(null);
  };

  const hideField = (fieldId: string) => {
    setConfig(prev => ({
      ...prev,
      fields: prev.fields.map(f => f.id === fieldId ? { ...f, hidden: !f.hidden } : f),
    }));
  };

  const moveFieldTo = (fieldId: string, newPos: number) => {
    const oldIdx = config.fields.findIndex(f => f.id === fieldId);
    if (oldIdx < 0) return;
    const newIdx = Math.max(0, Math.min(newPos - 1, config.fields.length - 1));
    if (oldIdx === newIdx) return;
    setConfig(prev => ({ ...prev, fields: arrayMove(prev.fields, oldIdx, newIdx) }));
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    if (activeId.startsWith("palette:")) {
      setActiveDragPaletteItem(event.active.data.current?.paletteItem ?? null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragPaletteItem(null);
    if (!over) return;
    const activeId = String(active.id);

    // Palette → Canvas drop
    if (activeId.startsWith("palette:")) {
      const paletteItem = active.data.current?.paletteItem as PaletteItem | undefined;
      if (!paletteItem) return;
      const newField = makeField(paletteItem.type, paletteItem.defaultLabel);
      const overId = String(over.id);
      if (overId === "canvas-drop") {
        // Dropped on empty zone → append
        setConfig(prev => ({ ...prev, fields: [...prev.fields, newField] }));
      } else {
        // Dropped on existing field → insert before it
        setConfig(prev => {
          const idx = prev.fields.findIndex(f => f.id === overId);
          const next = [...prev.fields];
          next.splice(idx >= 0 ? idx : next.length, 0, newField);
          return { ...prev, fields: next };
        });
      }
      setSelectedFieldId(newField.id);
      return;
    }

    // Canvas → Canvas reorder
    if (active.id !== over.id) {
      const oldIdx = config.fields.findIndex(f => f.id === active.id);
      const newIdx = config.fields.findIndex(f => f.id === over.id);
      if (oldIdx >= 0 && newIdx >= 0) {
        setConfig(prev => ({ ...prev, fields: arrayMove(prev.fields, oldIdx, newIdx) }));
      }
    }
  };

  // Gated-form CTA guard
  const handleCtaButtonChange = (id: number | null) => {
    const cta = ctaButtons.find(b => b.id === id);
    if (cta?.actionType === "gated_form") {
      setPendingCtaId(id);
      setGatedFormDialogOpen(true);
    } else {
      patchConfig({ ctaButtonId: id });
    }
  };

  async function handleSave() {
    if (!name.trim()) { toast({ title: "Form name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const payload = { name: name.trim(), config };
      const r = await fetch(isEdit ? `/api/journey-forms/${id}` : "/api/journey-forms", {
        method: isEdit ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast({ title: "Save failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      qc.invalidateQueries({ queryKey: ["journey-forms"] });
      toast({ title: isEdit ? "Form updated" : "Form created" });
      navigate("/library/forms");
    } catch (err) { toast({ title: "Save failed", description: String(err), variant: "destructive" }); }
    finally { setSaving(false); }
  }

  const selectedField = config.fields.find(f => f.id === selectedFieldId) ?? null;

  const ctaEl = config.ctaEnabled && selectedCta ? (
    <div className="mt-3 flex justify-center">
      <CtaButtonPreview label={selectedCta.label} styleConfig={selectedCta.styleConfig as Parameters<typeof CtaButtonPreview>[0]["styleConfig"]} />
    </div>
  ) : null;

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Top bar */}
      <header className="h-12 border-b bg-card flex items-center justify-between px-4 shrink-0 gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate("/library/forms")} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-7 text-sm font-medium border-transparent bg-transparent hover:border-input focus:border-input w-56"
            placeholder="Form name…"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border rounded-md overflow-hidden">
            <button type="button" onClick={() => setViewport("desktop")} className={cn("px-2.5 py-1.5 transition-colors", viewport === "desktop" ? "bg-muted" : "hover:bg-muted/50")}>
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setViewport("mobile")} className={cn("px-2.5 py-1.5 transition-colors", viewport === "mobile" ? "bg-muted" : "hover:bg-muted/50")}>
              <Smartphone className="w-3.5 h-3.5" />
            </button>
          </div>
          <Button size="sm" className="h-7 bg-indigo-600 hover:bg-indigo-700 gap-1.5" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {isEdit ? "Update" : "Save"}
          </Button>
        </div>
      </header>

      {/* Three-panel body — single DndContext wrapping all panels */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 overflow-hidden">
          {/* LEFT PANEL — 260px */}
          <aside className="w-[260px] border-r bg-card flex flex-col overflow-hidden shrink-0">
            <Tabs defaultValue="elements" className="flex flex-col h-full">
              <TabsList className="h-8 rounded-none border-b shrink-0 w-full">
                <TabsTrigger value="elements" className="flex-1 text-xs h-7">Elements</TabsTrigger>
                <TabsTrigger value="settings" className="flex-1 text-xs h-7">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="elements" className="flex-1 overflow-hidden mt-0">
                <ElementsPaletteTab
                  onAddField={addField}
                  config={config}
                  patchConfig={patchConfig}
                  ctaButtons={ctaButtons}
                  onCtaButtonChange={handleCtaButtonChange}
                />
              </TabsContent>
              <TabsContent value="settings" className="flex-1 overflow-hidden mt-0">
                <FormSettingsPanel key={existing?.id ?? "new"} config={config} patchConfig={patchConfig} formId={existing?.id} />
              </TabsContent>
            </Tabs>
          </aside>

          {/* CENTER PANEL — flex-1 */}
          <main className="flex-1 overflow-auto bg-gray-100 flex flex-col items-center py-8 px-4 gap-4">
            {/* above_fields CTA — outside and above the form card */}
            {config.ctaEnabled && config.ctaPosition === "above_fields" && ctaEl && (
              <div className={cn(viewport === "mobile" ? "w-[375px]" : "w-full max-w-2xl")}>{ctaEl}</div>
            )}

            {/* Layout-aware canvas — shared inner blocks */}
            {(() => {
              const radiusCls = config.styling.containerRadius === "sharp" ? "rounded-none"
                : config.styling.containerRadius === "rounded" ? "rounded-2xl" : "rounded-xl";
              const containerStyle = { fontFamily: config.styling.fontFamily, backgroundColor: config.styling.formBg };
              const pad = cn("p-6", viewport === "mobile" && "p-4");

              const headerEls = (
                <>
                  {config.headerElements.headerImageUrl && (
                    <img src={config.headerElements.headerImageUrl} alt="" className="w-full object-cover" style={{ height: config.headerElements.headerImageHeight ?? 180 }} />
                  )}
                  {config.headerElements.logoUrl && (
                    <div className={cn("px-6 pt-4 flex", config.headerElements.logoAlignment === "center" ? "justify-center" : config.headerElements.logoAlignment === "right" ? "justify-end" : "justify-start")}>
                      <img src={config.headerElements.logoUrl} alt="Logo" style={{ maxWidth: config.headerElements.logoMaxWidth ?? 120, height: "auto", maxHeight: 56, objectFit: "contain" }} />
                    </div>
                  )}
                </>
              );

              const fieldList = (
                <SortableContext items={config.fields.map(f => f.id)} strategy={verticalListSortingStrategy}>
                  <CanvasDropZone isEmpty={config.fields.length === 0}>
                    {config.fields.length === 0 && (
                      <div className="border-2 border-dashed border-gray-200 rounded-lg py-12 text-center">
                        <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">Click or drag a field type from the left panel</p>
                      </div>
                    )}
                    {config.fields.map((field, idx) => (
                      <SortableFieldItem
                        key={field.id}
                        field={field}
                        isSelected={selectedFieldId === field.id}
                        onSelect={() => setSelectedFieldId(field.id)}
                        onDuplicate={() => duplicateField(field.id)}
                        onDelete={() => deleteField(field.id)}
                        onHide={() => hideField(field.id)}
                        onMoveTo={(newPos) => moveFieldTo(field.id, newPos)}
                        position={idx + 1}
                        totalFields={config.fields.length}
                        config={config}
                      />
                    ))}
                  </CanvasDropZone>
                </SortableContext>
              );

              const submitBlock = (
                <div className="mt-4">
                  <div
                    className={cn("font-semibold text-center cursor-default",
                      { small: "px-3 py-1 text-xs", medium: "px-4 py-1.5 text-sm", large: "px-6 py-2 text-base", full: "w-full py-2 text-sm" }[config.submitButton.sizePreset],
                      { sharp: "rounded-none", slightly_rounded: "rounded-md", pill: "rounded-full" }[config.submitButton.borderRadius],
                    )}
                    style={{ backgroundColor: config.submitButton.bgColor, color: config.submitButton.textColor }}
                  >
                    {config.submitButton.label}
                  </div>
                  {config.textBelowSubmit && (
                    <p className="text-center text-[11px] text-muted-foreground mt-1.5">{config.textBelowSubmit}</p>
                  )}
                  {config.ctaEnabled && config.ctaPosition === "inline_bottom" && ctaEl}
                </div>
              );

              const vpCls = cn("w-full transition-all", viewport === "mobile" ? "max-w-[375px]" : "max-w-2xl");

              if (config.layout === "full_width") return (
                <div className={vpCls}>
                  <div className="border-y w-full" style={containerStyle}>
                    {headerEls}
                    <div className={pad}>{fieldList}{submitBlock}</div>
                  </div>
                </div>
              );

              if (config.layout === "two_column") return (
                <div className={vpCls}>
                  <div className={cn("border overflow-hidden", radiusCls)} style={containerStyle}>
                    {headerEls}
                    <div className="flex min-h-48">
                      <div className={cn("flex-1", pad)}>{fieldList}{submitBlock}</div>
                      <div className="w-48 bg-gray-100 flex items-center justify-center text-xs text-gray-400 rounded-r-lg shrink-0">
                        <span className="text-center px-2">Image / content right column</span>
                      </div>
                    </div>
                  </div>
                </div>
              );

              if (config.layout === "minimal_inline") return (
                <div className={vpCls}>
                  <div className={pad} style={{ fontFamily: config.styling.fontFamily }}>
                    {fieldList}{submitBlock}
                  </div>
                </div>
              );

              // centered_card (default)
              return (
                <div className={vpCls}>
                  <div className={cn("bg-white shadow-md overflow-hidden mx-auto max-w-md", radiusCls)} style={containerStyle}>
                    {headerEls}
                    <div className={pad}>{fieldList}{submitBlock}</div>
                  </div>
                </div>
              );
            })()}

            {/* below_submit CTA — outside the card, gap below it */}
            {config.ctaEnabled && config.ctaPosition === "below_submit" && ctaEl && (
              <div className={cn(viewport === "mobile" ? "w-[375px]" : "w-full max-w-2xl")}>{ctaEl}</div>
            )}
          </main>

          {/* RIGHT PANEL — 280px */}
          <aside className="w-[280px] border-l bg-card shrink-0 overflow-hidden flex flex-col">
            {selectedField ? (
              <FieldPropertiesPanel field={selectedField} onChange={updateField} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-2">
                <Settings2 className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">Click a field in the canvas to edit its properties</p>
              </div>
            )}
          </aside>
        </div>

        {/* Drag overlay — shows ghost while dragging palette item */}
        <DragOverlay>
          {activeDragPaletteItem && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-indigo-300 bg-indigo-50 shadow-lg text-xs text-indigo-700 font-medium">
              <activeDragPaletteItem.icon className="w-3.5 h-3.5" />
              {activeDragPaletteItem.label}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Gated form CTA confirmation dialog */}
      <AlertDialog open={gatedFormDialogOpen} onOpenChange={setGatedFormDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Nested form experience</AlertDialogTitle>
            <AlertDialogDescription>
              This CTA button opens another form. Visitors who see this form will also be shown a second form when they click the button — creating a nested form experience. Are you sure you want to use this button?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingCtaId(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                patchConfig({ ctaButtonId: pendingCtaId });
                setPendingCtaId(null);
                setGatedFormDialogOpen(false);
              }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Use it anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
