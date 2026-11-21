import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Megaphone, Plus, Pencil, Copy, Trash2, Loader2, Search,
  Filter, Globe, ArrowDown, Sidebar, Settings2, ChevronDown,
  ChevronUp, ExternalLink, CalendarRange, ImageIcon, Type,
  Tag, Clock, LayoutPanelTop, BarChart3, Zap, Save, X,
  UploadCloud, CheckCircle2, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BannerPreviewWidget, type BannerConfig, type BannerRecord as BaseBannerRecord } from "./banner-editor";
import { AssetPicker, type PickedAsset } from "@/components/AssetPicker";

// ── Extended BannerRecord type ─────────────────────────────────────────────────
export interface BannerRecord extends BaseBannerRecord {
  zone?: "top" | "bottom" | "sidebar" | null;
  status?: "active" | "inactive" | "scheduled";
  startDate?: string | null;
  endDate?: string | null;
  originalWidth?: number | null;
  originalHeight?: number | null;
  fileSize?: number | null;
  originalFilename?: string | null;
  usedInCount?: number;
  usedInJourneys?: Array<{ id: number; name: string }>;
  usedInPlays?: Array<{ id: number; name: string }>;
}

interface UsageItem {
  componentId: number;
  pageId: number;
  pageTitle: string;
  pageOrder: number;
  journeyId: number;
  journeyName: string;
  journeySlug: string;
  journeyStatus: string;
}

interface PlayUsageItem {
  playId: number;
  playName: string;
  playStatus: string;
}

interface UsageResponse {
  journeys: UsageItem[];
  plays: PlayUsageItem[];
}

// ── Badge helpers ──────────────────────────────────────────────────────────────
const POSITION_LABELS: Record<string, string> = {
  top: "Top bar", top_bar: "Top bar",
  bottom: "Bottom bar", bottom_bar: "Bottom bar",
  right: "Sidebar", inline: "Inline",
};
const POSITION_COLORS: Record<string, string> = {
  top: "bg-blue-50 text-blue-700 border-blue-200",
  top_bar: "bg-blue-50 text-blue-700 border-blue-200",
  bottom: "bg-slate-50 text-slate-700 border-slate-200",
  bottom_bar: "bg-slate-50 text-slate-700 border-slate-200",
  right: "bg-violet-50 text-violet-700 border-violet-200",
  inline: "bg-emerald-50 text-emerald-700 border-emerald-200",
};
const TYPE_LABELS: Record<string, string> = { text: "Text", image: "Image" };
const TYPE_COLORS: Record<string, string> = {
  text: "bg-gray-50 text-gray-700 border-gray-200",
  image: "bg-amber-50 text-amber-700 border-amber-200",
};
const ZONE_LABELS: Record<string, string> = {
  top: "Top Zone", bottom: "Bottom Zone", sidebar: "Sidebar Zone",
};
const ZONE_COLORS: Record<string, string> = {
  top: "bg-indigo-50 text-indigo-700 border-indigo-200",
  bottom: "bg-orange-50 text-orange-700 border-orange-200",
  sidebar: "bg-violet-50 text-violet-700 border-violet-200",
};
const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  inactive: "bg-gray-50 text-gray-500 border-gray-200",
  scheduled: "bg-amber-50 text-amber-700 border-amber-200",
};
const PLAY_STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
  draft: "bg-gray-50 text-gray-500 border-gray-200",
};

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isoDate(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toISOString().substring(0, 10);
}

// ── Scaled mini-preview (card grid thumbnails) ─────────────────────────────────
const SCALE = 0.28;
const PREVIEW_HEIGHT = 52;

function BannerCardPreview({ position, config }: { position: string; config: Partial<BannerConfig> }) {
  return (
    <div className="overflow-hidden rounded-t-xl bg-gray-50" style={{ height: PREVIEW_HEIGHT }}>
      <div style={{ transform: `scale(${SCALE})`, transformOrigin: "top left", width: `${(100 / SCALE).toFixed(0)}%`, pointerEvents: "none", userSelect: "none" }}>
        <BannerPreviewWidget position={position} config={config} personalized />
      </div>
    </div>
  );
}

// ── Full-size preview (detail drawer) ─────────────────────────────────────────
function BannerFullPreview({ position, config }: { position: string; config: Partial<BannerConfig> }) {
  return (
    <div className="rounded-xl overflow-hidden border bg-gray-50">
      <div style={{ pointerEvents: "none", userSelect: "none" }}>
        <BannerPreviewWidget position={position} config={config} personalized />
      </div>
    </div>
  );
}

// ── Zone Settings Panel ────────────────────────────────────────────────────────
type ZoneSettingsMap = Record<string, { rotationIntervalSeconds: number; mobileBehavior: string }>;

const ZONE_DEFS = [
  { id: "top",     label: "Top Zone",     icon: LayoutPanelTop, desc: "Full-width banner above the viewer topbar",              iconColor: "text-indigo-600" },
  { id: "bottom",  label: "Bottom Zone",  icon: ArrowDown,      desc: "Full-width banner below the content area",              iconColor: "text-orange-600" },
  { id: "sidebar", label: "Sidebar Zone", icon: Sidebar,        desc: "300px-wide banner alongside content (desktop only)",    iconColor: "text-violet-600" },
] as const;

function ZoneSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<string | null>(null);
  const [localSettings, setLocalSettings] = useState<ZoneSettingsMap>({});

  const { data: settings, isLoading } = useQuery<ZoneSettingsMap>({
    queryKey: ["banner-zone-settings"],
    queryFn: () => fetch("/api/banners/zone-settings", { credentials: "include" }).then(r => r.json()),
  });

  const saveZone = useMutation({
    mutationFn: async ({ zone, rotation_interval_seconds, mobile_behavior }: {
      zone: string; rotation_interval_seconds: number; mobile_behavior: string;
    }) => {
      const r = await fetch(`/api/banners/zone-settings/${zone}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation_interval_seconds, mobile_behavior }),
      });
      if (!r.ok) throw new Error("Save failed");
      return r.json() as Promise<{ ok: boolean; zone: string }>;
    },
    onSuccess: (_data, { zone, rotation_interval_seconds, mobile_behavior }) => {
      setLocalSettings(prev => ({
        ...prev,
        [zone]: { rotationIntervalSeconds: rotation_interval_seconds, mobileBehavior: mobile_behavior },
      }));
      qc.invalidateQueries({ queryKey: ["banner-zone-settings"] });
      toast({ title: `${zone} zone settings saved` });
      setEditingZone(null);
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const handleSave = (zone: string) => {
    const s = localSettings[zone] ?? settings?.[zone];
    if (!s) return;
    const clampedRotation = Math.min(300, Math.max(1, s.rotationIntervalSeconds || 5));
    saveZone.mutate({
      zone,
      rotation_interval_seconds: clampedRotation,
      mobile_behavior: s.mobileBehavior,
    });
  };

  return (
    <div className={cn("rounded-xl border transition-all", open ? "border-indigo-200 bg-indigo-50/40" : "border-gray-200 bg-white")}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Zone Settings</span>
          <span className="text-xs text-muted-foreground">— rotation interval &amp; mobile behavior per zone</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          {ZONE_DEFS.map(z => {
            const current = localSettings[z.id] ?? settings?.[z.id] ?? { rotationIntervalSeconds: 5, mobileBehavior: "hide" };
            const isEditing = editingZone === z.id;
            const isSaving = saveZone.isPending && saveZone.variables?.zone === z.id;
            return (
              <div key={z.id} className="rounded-lg border bg-white p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <z.icon className={cn("w-4 h-4", z.iconColor)} />
                  <span className="text-sm font-medium">{z.label}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{z.desc}</p>

                {isEditing ? (
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground font-medium">Rotation (sec)</label>
                      <Input
                        type="number" min={1} max={300}
                        value={current.rotationIntervalSeconds}
                        onChange={e => setLocalSettings(prev => ({
                          ...prev,
                          [z.id]: { ...current, rotationIntervalSeconds: parseInt(e.target.value) || 1 },
                        }))}
                        className="h-7 text-xs mt-0.5"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground font-medium">Mobile</label>
                      <Select
                        value={current.mobileBehavior}
                        onValueChange={v => setLocalSettings(prev => ({ ...prev, [z.id]: { ...current, mobileBehavior: v } }))}
                      >
                        <SelectTrigger className="h-7 text-xs mt-0.5"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hide">Hide on mobile</SelectItem>
                          <SelectItem value="show">Show on mobile</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => handleSave(z.id)} disabled={isSaving}>
                        {isSaving ? <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" /> : <Save className="w-2.5 h-2.5 mr-1" />} Save
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => {
                        setEditingZone(null);
                        setLocalSettings(prev => { const p = { ...prev }; delete p[z.id]; return p; });
                      }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {isLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <p className="text-xs"><span className="text-muted-foreground">Rotation: </span>{current.rotationIntervalSeconds}s</p>
                        <p className="text-xs"><span className="text-muted-foreground">Mobile: </span>{current.mobileBehavior === "hide" ? "Hide" : "Show"}</p>
                      </>
                    )}
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 -ml-1" onClick={() => setEditingZone(z.id)}>
                      <Pencil className="w-2.5 h-2.5 mr-1" /> Edit
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Create Banner Drawer ───────────────────────────────────────────────────────
interface BatchFileState {
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  progress: number;
  errorMsg?: string;
}

function fileNameToTitle(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function CreateBannerDrawer({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [drawerTab, setDrawerTab] = useState<"single" | "batch">("single");
  const [name, setName] = useState("");
  const [zone, setZone] = useState<string>("none");
  const [status, setStatus] = useState("active");
  const [position, setPosition] = useState("top_bar");
  const [type, setType] = useState<"text" | "image">("text");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [bgColor, setBgColor] = useState("#4f46e5");
  const [textColor, setTextColor] = useState("#ffffff");
  const [imageUrl, setImageUrl] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [tagMode, setTagMode] = useState("everyone");
  const [tagValue, setTagValue] = useState("");
  const [originalWidth, setOriginalWidth] = useState<number | null>(null);
  const [originalHeight, setOriginalHeight] = useState<number | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [originalFilename, setOriginalFilename] = useState<string | null>(null);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // Animation & dismiss state
  const [animationType, setAnimationType] = useState<"none" | "slide_top" | "slide_bottom" | "fade">("none");
  const [dismissButton, setDismissButton] = useState(false);
  const [dismissDuration, setDismissDuration] = useState<"session" | "7d" | "30d" | "forever">("session");

  // Batch upload state
  const [batchZone, setBatchZone] = useState<string>("none");
  const [batchStatus, setBatchStatus] = useState("active");
  const [batchFiles, setBatchFiles] = useState<BatchFileState[]>([]);
  const [batchUploading, setBatchUploading] = useState(false);
  const batchInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setName(""); setZone("none"); setStatus("active"); setPosition("top_bar");
    setType("text"); setHeading(""); setBody(""); setBgColor("#4f46e5"); setTextColor("#ffffff");
    setImageUrl(""); setStartDate(""); setEndDate(""); setTagMode("everyone"); setTagValue("");
    setOriginalWidth(null); setOriginalHeight(null); setFileSize(null); setOriginalFilename(null);
    setAnimationType("none"); setDismissButton(false); setDismissDuration("session");
    setBatchFiles([]); setBatchZone("none"); setBatchStatus("active");
    setDrawerTab("single");
  }

  function handleBatchFilesSelected(files: FileList | null) {
    if (!files) return;
    const arr = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (arr.length === 0) { toast({ title: "No image files selected", variant: "destructive" }); return; }
    setBatchFiles(arr.map(file => ({ file, status: "pending", progress: 0 })));
  }

  async function uploadSingleBatchFile(file: File, idx: number): Promise<"done" | "error"> {
    const updateFile = (patch: Partial<BatchFileState>) =>
      setBatchFiles(prev => prev.map((f, i) => i === idx ? { ...f, ...patch } : f));

    updateFile({ status: "uploading", progress: 10 });
    try {
      const r1 = await fetch("/api/storage/uploads/request-url", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!r1.ok) throw new Error("Could not get upload URL");
      const { uploadURL, objectPath } = await r1.json();
      updateFile({ progress: 30 });

      const r2 = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!r2.ok) throw new Error("Upload failed");
      updateFile({ progress: 60 });

      const r3 = await fetch("/api/media", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type, fileSize: file.size }),
      });
      if (!r3.ok) throw new Error("Failed to save media");
      const media = await r3.json();
      updateFile({ progress: 80 });

      const dims = await new Promise<{ w: number; h: number }>(resolve => {
        const img = new window.Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = media.url;
      });

      const bannerName = fileNameToTitle(file.name);
      const r4 = await fetch("/api/banners", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: bannerName,
          position: "top_bar",
          zone: batchZone === "none" ? null : batchZone,
          status: batchStatus,
          original_width: dims.w || null,
          original_height: dims.h || null,
          file_size: file.size,
          original_filename: file.name,
          config: { type: "image", imageUrl: media.url },
        }),
      });
      if (!r4.ok) throw new Error("Failed to create banner");
      updateFile({ status: "done", progress: 100 });
      return "done";
    } catch (err: any) {
      updateFile({ status: "error", progress: 0, errorMsg: err.message ?? "Upload failed" });
      return "error";
    }
  }

  async function handleBatchUpload() {
    if (batchFiles.length === 0) return;
    setBatchUploading(true);
    const results = await Promise.all(batchFiles.map((f, idx) => uploadSingleBatchFile(f.file, idx)));
    setBatchUploading(false);
    const done = results.filter(r => r === "done").length;
    const failed = results.filter(r => r === "error").length;
    if (done > 0) {
      onCreated();
      toast({ title: `${done} banner${done > 1 ? "s" : ""} created`, description: failed > 0 ? `${failed} failed` : undefined });
    }
    if (failed === 0) { reset(); onClose(); }
  }

  function handlePickedAsset(asset: PickedAsset) {
    setImageUrl(asset.url);
    setFileSize(asset.sizeBytes);
    setOriginalFilename(asset.filename);
    const img = new Image();
    img.onload = () => { setOriginalWidth(img.naturalWidth); setOriginalHeight(img.naturalHeight); };
    img.src = asset.url;
    setShowAssetPicker(false);
  }

  const previewConfig: Partial<BannerConfig> = {
    type,
    bgColor, textColor,
    heading: type === "text" ? heading : undefined,
    body: type === "text" ? body : undefined,
    imageUrl: type === "image" ? imageUrl : undefined,
    animationType,
    dismissButton,
    dismissDuration,
  };

  async function handleSave() {
    if (!name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        position,
        zone: zone === "none" ? null : zone,
        status,
        start_date: startDate || null,
        end_date: endDate || null,
        original_width: originalWidth,
        original_height: originalHeight,
        file_size: fileSize,
        original_filename: originalFilename,
        config: {
          type,
          bgColor, textColor, heading, body,
          imageUrl: type === "image" ? imageUrl : undefined,
          animationType,
          animationDelay: 0,
          dismissButton,
          dismissDuration: dismissButton ? dismissDuration : "session",
          tagTargeting: tagMode === "everyone" ? { mode: "everyone", tag: "" } : { mode: tagMode, tag: tagValue },
        },
      };
      const r = await fetch("/api/banners", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error();
      toast({ title: "Banner created", description: name.trim() });
      reset();
      onCreated();
      onClose();
    } catch {
      toast({ title: "Create failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={o => { if (!o) { reset(); onClose(); } }}>
      <SheetContent className="w-[460px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4 text-indigo-600" /> New Banner
          </SheetTitle>
          <SheetDescription className="text-xs">
            Configure your banner and assign it to a zone for delivery in journeys.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={drawerTab} onValueChange={v => setDrawerTab(v as "single" | "batch")} className="mt-5">
          <TabsList className="w-full h-8 text-xs mb-5">
            <TabsTrigger value="single" className="flex-1 text-xs">Single Banner</TabsTrigger>
            <TabsTrigger value="batch" className="flex-1 text-xs">
              <UploadCloud className="w-3.5 h-3.5 mr-1.5" /> Batch Upload Images
            </TabsTrigger>
          </TabsList>

          {/* ── Batch Upload tab ── */}
          <TabsContent value="batch" className="space-y-4 mt-0">
            <p className="text-xs text-muted-foreground">
              Select multiple images to create one banner per image automatically. Each banner's name is derived from the filename.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Assign zone</Label>
                <Select value={batchZone} onValueChange={setBatchZone}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No zone</SelectItem>
                    <SelectItem value="top">Top zone</SelectItem>
                    <SelectItem value="bottom">Bottom zone</SelectItem>
                    <SelectItem value="sidebar">Sidebar zone</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Status</Label>
                <Select value={batchStatus} onValueChange={setBatchStatus}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* File picker / dropzone */}
            <div
              className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50 transition-colors"
              onClick={() => batchInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={e => { e.preventDefault(); e.stopPropagation(); handleBatchFilesSelected(e.dataTransfer.files); }}
            >
              <UploadCloud className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm font-medium">Drop images here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">PNG, JPG, GIF, WebP — one banner per file</p>
              <input
                ref={batchInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => handleBatchFilesSelected(e.target.files)}
              />
            </div>

            {/* File list with progress */}
            {batchFiles.length > 0 && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {batchFiles.map((f, idx) => (
                  <div key={idx} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
                    <ImageIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{fileNameToTitle(f.file.name)}</p>
                      <p className="text-[10px] text-muted-foreground">{f.file.name} · {formatBytes(f.file.size)}</p>
                      {f.status === "uploading" && <Progress value={f.progress} className="h-1 mt-1" />}
                      {f.status === "error" && <p className="text-[10px] text-destructive mt-0.5">{f.errorMsg}</p>}
                    </div>
                    {f.status === "pending" && <span className="text-[10px] text-muted-foreground flex-shrink-0">Pending</span>}
                    {f.status === "uploading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 flex-shrink-0" />}
                    {f.status === "done" && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />}
                    {f.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-1 border-t">
              <Button
                className="flex-1 gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                onClick={handleBatchUpload}
                disabled={batchFiles.length === 0 || batchUploading}
              >
                {batchUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                Upload {batchFiles.length > 0 ? `${batchFiles.length} Image${batchFiles.length > 1 ? "s" : ""}` : "Images"}
              </Button>
              <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            </div>
          </TabsContent>

          {/* ── Single banner tab ── */}
          <TabsContent value="single" className="mt-0">
        <div className="space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q3 Launch — Top Zone" className="h-8 text-sm" />
          </div>

          {/* Zone + Position row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Zone</Label>
              <Select value={zone} onValueChange={setZone}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No zone</SelectItem>
                  <SelectItem value="top">Top zone</SelectItem>
                  <SelectItem value="bottom">Bottom zone</SelectItem>
                  <SelectItem value="sidebar">Sidebar zone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Position</Label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="top_bar">Top bar</SelectItem>
                  <SelectItem value="bottom_bar">Bottom bar</SelectItem>
                  <SelectItem value="inline">Inline</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Status + schedule */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Start date</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">End date</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-8 text-xs" />
            </div>
          </div>

          <Separator />

          {/* Type */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Type</Label>
            <div className="flex gap-2">
              <button
                onClick={() => setType("text")}
                className={cn("flex-1 flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium transition-all",
                  type === "text" ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 text-muted-foreground hover:border-gray-300")}
              >
                <Type className="w-3.5 h-3.5" /> Text
              </button>
              <button
                onClick={() => setType("image")}
                className={cn("flex-1 flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium transition-all",
                  type === "image" ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 text-muted-foreground hover:border-gray-300")}
              >
                <ImageIcon className="w-3.5 h-3.5" /> Image
              </button>
            </div>
          </div>

          {type === "text" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Headline</Label>
                <Input value={heading} onChange={e => setHeading(e.target.value)} placeholder="e.g. Limited seats available" className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Body text</Label>
                <Input value={body} onChange={e => setBody(e.target.value)} placeholder="Optional subtext" className="h-8 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Background</Label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                    <Input value={bgColor} onChange={e => setBgColor(e.target.value)} className="h-8 text-xs font-mono" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Text color</Label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                    <Input value={textColor} onChange={e => setTextColor(e.target.value)} className="h-8 text-xs font-mono" />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {imageUrl ? (
                <div className="space-y-2">
                  <div className="rounded-lg border overflow-hidden">
                    <img src={imageUrl} alt="Banner preview" className="w-full object-contain max-h-32" />
                  </div>
                  <div className="flex items-center gap-2">
                    {originalWidth && originalHeight && (
                      <span className="text-[10px] text-muted-foreground">{originalWidth}×{originalHeight}px</span>
                    )}
                    {fileSize && <span className="text-[10px] text-muted-foreground">{formatBytes(fileSize)}</span>}
                    <Button variant="ghost" size="sm" className="h-6 text-[10px] ml-auto" onClick={() => { setImageUrl(""); setOriginalWidth(null); setOriginalHeight(null); }}>
                      <X className="w-2.5 h-2.5 mr-1" /> Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" className="w-full gap-2 h-20 border-dashed" onClick={() => setShowAssetPicker(true)}>
                  <ImageIcon className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Upload or pick from media library</span>
                </Button>
              )}
              {showAssetPicker && (
                <div className="rounded-xl border bg-white shadow-sm">
                  <div className="flex items-center justify-between p-2 border-b">
                    <span className="text-xs font-medium">Pick an image</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowAssetPicker(false)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                  <div className="p-2">
                    <AssetPicker onChange={a => { if (a) handlePickedAsset(a); }} accept="image/*" />
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Background color (if no image)</Label>
                <div className="flex items-center gap-2">
                  <input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer border" />
                  <Input value={bgColor} onChange={e => setBgColor(e.target.value)} className="h-8 text-xs font-mono" />
                </div>
              </div>
            </div>
          )}

          <Separator />

          {/* Tag targeting */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1">
              <Tag className="w-3 h-3" /> Tag targeting
            </Label>
            <Select value={tagMode} onValueChange={setTagMode}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">Everyone</SelectItem>
                <SelectItem value="with_tag">Visitors with tag</SelectItem>
                <SelectItem value="without_tag">Visitors without tag</SelectItem>
              </SelectContent>
            </Select>
            {tagMode !== "everyone" && (
              <Input value={tagValue} onChange={e => setTagValue(e.target.value)} placeholder="Tag name" className="h-8 text-sm mt-1.5" />
            )}
          </div>

          <Separator />

          {/* Animation & dismiss */}
          <div className="space-y-3">
            <Label className="text-xs font-medium flex items-center gap-1">
              <Zap className="w-3 h-3" /> Animation &amp; Dismiss
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[10px] text-muted-foreground font-medium">Entrance animation</label>
                <Select value={animationType} onValueChange={v => setAnimationType(v as typeof animationType)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No animation</SelectItem>
                    <SelectItem value="fade">Fade in</SelectItem>
                    <SelectItem value="slide_top">Slide from top</SelectItem>
                    <SelectItem value="slide_bottom">Slide from bottom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] text-muted-foreground font-medium">Dismiss button</label>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => setDismissButton(true)}
                    className={cn("flex-1 rounded-md border py-1.5 text-xs font-medium transition-all",
                      dismissButton ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 text-muted-foreground hover:border-gray-300")}
                  >
                    Show
                  </button>
                  <button
                    onClick={() => setDismissButton(false)}
                    className={cn("flex-1 rounded-md border py-1.5 text-xs font-medium transition-all",
                      !dismissButton ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 text-muted-foreground hover:border-gray-300")}
                  >
                    Hide
                  </button>
                </div>
              </div>
            </div>
            {dismissButton && (
              <div className="space-y-1.5">
                <label className="text-[10px] text-muted-foreground font-medium">Remember dismiss for</label>
                <Select value={dismissDuration} onValueChange={v => setDismissDuration(v as typeof dismissDuration)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="session">This session only</SelectItem>
                    <SelectItem value="7d">7 days</SelectItem>
                    <SelectItem value="30d">30 days</SelectItem>
                    <SelectItem value="forever">Forever</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <Separator />

          {/* Live preview */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Preview</Label>
            <BannerFullPreview position={position} config={previewConfig} />
          </div>

          {/* Save */}
          <div className="flex gap-2 pt-1">
            <Button className="flex-1 gap-1.5 bg-indigo-600 hover:bg-indigo-700" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Create Banner
            </Button>
            <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          </div>
        </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ── Detail Drawer ───────────────────────────────────────────────────────────────
function DetailDrawer({
  banner,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  banner: BannerRecord | null;
  onClose: () => void;
  onEdit: (b: BannerRecord) => void;
  onDuplicate: (b: BannerRecord) => void;
  onDelete: (b: BannerRecord) => void;
}) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Zone + schedule editing state
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaZone, setMetaZone] = useState<string>("none");
  const [metaStartDate, setMetaStartDate] = useState("");
  const [metaEndDate, setMetaEndDate] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);

  useEffect(() => {
    if (banner) {
      setMetaZone(banner.zone ?? "none");
      setMetaStartDate(isoDate(banner.startDate));
      setMetaEndDate(isoDate(banner.endDate));
      setEditingMeta(false);
    }
  }, [banner?.id]);

  const { data: usageData, isLoading: usageLoading } = useQuery<UsageResponse>({
    queryKey: ["banner-usage", banner?.id],
    queryFn: () => fetch(`/api/banners/${banner!.id}/usage`, { credentials: "include" }).then(r => r.json()),
    enabled: !!banner,
  });

  interface BannerAnalytics { impressions: number; clicks: number; dismissals: number; uniqueVisitors: number; ctr: number; }
  const { data: analytics, isLoading: analyticsLoading } = useQuery<BannerAnalytics>({
    queryKey: ["banner-analytics", banner?.id],
    queryFn: () => fetch(`/api/banners/${banner!.id}/analytics`, { credentials: "include" }).then(r => r.json()),
    enabled: !!banner,
    refetchInterval: 30000,
  });

  const { data: zoneSettingsMap } = useQuery<ZoneSettingsMap>({
    queryKey: ["banner-zone-settings"],
    queryFn: () => fetch("/api/banners/zone-settings", { credentials: "include" }).then(r => r.json()),
  });

  const usage = usageData?.journeys ?? [];
  const playUsage = usageData?.plays ?? [];

  const updateStatus = useMutation({
    mutationFn: async (status: string) => {
      const r = await fetch(`/api/banners/${banner!.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error();
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast({ title: "Status updated" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  async function handleSaveMeta() {
    if (!banner) return;
    setSavingMeta(true);
    try {
      const r = await fetch(`/api/banners/${banner.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zone: metaZone === "none" ? null : metaZone,
          start_date: metaStartDate || null,
          end_date: metaEndDate || null,
        }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast({ title: "Zone & schedule saved" });
      setEditingMeta(false);
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSavingMeta(false);
    }
  }

  if (!banner) return null;
  const cfg = banner.config ?? ({} as BannerConfig);
  const type = cfg.type ?? "text";
  const status = banner.status ?? "active";

  return (
    <Sheet open={!!banner} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent className="w-[440px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">{banner.name}</SheetTitle>
          <SheetDescription className="text-xs">
            Created {new Date(banner.createdAt).toLocaleDateString()}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 mt-4">
          {/* Full-size natural preview */}
          <BannerFullPreview position={banner.position} config={cfg} />

          {/* Metadata badges */}
          <div className="flex flex-wrap gap-1.5">
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", TYPE_COLORS[type] ?? "bg-gray-50 text-gray-700 border-gray-200")}>
              {type === "image" ? <ImageIcon className="inline w-2.5 h-2.5 mr-0.5" /> : <Type className="inline w-2.5 h-2.5 mr-0.5" />}
              {TYPE_LABELS[type] ?? type}
            </span>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", POSITION_COLORS[banner.position] ?? "bg-gray-50 text-gray-700 border-gray-200")}>
              {POSITION_LABELS[banner.position] ?? banner.position}
            </span>
            {(banner.zone || metaZone !== "none") && banner.zone && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", ZONE_COLORS[banner.zone] ?? "")}>
                <Globe className="inline w-2.5 h-2.5 mr-0.5" />
                {ZONE_LABELS[banner.zone] ?? banner.zone}
              </span>
            )}
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", STATUS_COLORS[status] ?? STATUS_COLORS.active)}>
              {status}
            </span>
          </div>

          {/* Image metadata */}
          {(banner.originalWidth || banner.fileSize || banner.originalFilename) && (
            <div className="rounded-lg border bg-gray-50 p-3 space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Image</p>
              {banner.originalFilename && <p className="text-xs text-foreground truncate">{banner.originalFilename}</p>}
              {banner.originalWidth && banner.originalHeight && (
                <p className="text-xs text-muted-foreground">{banner.originalWidth} × {banner.originalHeight} px</p>
              )}
              {banner.fileSize && <p className="text-xs text-muted-foreground">{formatBytes(banner.fileSize)}</p>}
            </div>
          )}

          {/* Zone & Schedule — editable */}
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Globe className="w-3 h-3" /> Zone &amp; Schedule
              </p>
              {!editingMeta ? (
                <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setEditingMeta(true)}>
                  <Pencil className="w-2.5 h-2.5 mr-1" /> Edit
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button size="sm" className="h-6 text-[10px] px-2" onClick={handleSaveMeta} disabled={savingMeta}>
                    {savingMeta ? <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" /> : <Save className="w-2.5 h-2.5 mr-1" />} Save
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => {
                    setMetaZone(banner.zone ?? "none");
                    setMetaStartDate(isoDate(banner.startDate));
                    setMetaEndDate(isoDate(banner.endDate));
                    setEditingMeta(false);
                  }}>Cancel</Button>
                </div>
              )}
            </div>
            {editingMeta ? (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Zone</label>
                  <Select value={metaZone} onValueChange={setMetaZone}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No zone</SelectItem>
                      <SelectItem value="top">Top zone</SelectItem>
                      <SelectItem value="bottom">Bottom zone</SelectItem>
                      <SelectItem value="sidebar">Sidebar zone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">Start date</label>
                    <Input type="date" value={metaStartDate} onChange={e => setMetaStartDate(e.target.value)} className="h-7 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground">End date</label>
                    <Input type="date" value={metaEndDate} onChange={e => setMetaEndDate(e.target.value)} className="h-7 text-xs" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">Zone:</span>{" "}
                  {banner.zone ? ZONE_LABELS[banner.zone] ?? banner.zone : "Not assigned"}
                </p>
                {banner.zone && zoneSettingsMap?.[banner.zone] && (
                  <p className="text-xs text-muted-foreground">
                    <span className="text-foreground">Rotation interval:</span>{" "}
                    {zoneSettingsMap[banner.zone].rotationIntervalSeconds}s
                    {" · "}Mobile: {zoneSettingsMap[banner.zone].mobileBehavior}
                  </p>
                )}
                {(banner.startDate || banner.endDate) ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <CalendarRange className="w-3 h-3" />
                    {banner.startDate && <>Start: {new Date(banner.startDate).toLocaleDateString()}</>}
                    {banner.startDate && banner.endDate && " · "}
                    {banner.endDate && <>End: {new Date(banner.endDate).toLocaleDateString()}</>}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No schedule — runs indefinitely</p>
                )}
              </div>
            )}
          </div>

          {/* Tag targeting */}
          {cfg.tagTargeting && cfg.tagTargeting.mode !== "everyone" && (
            <div className="rounded-lg border bg-violet-50 p-3 space-y-1">
              <p className="text-[10px] font-semibold text-violet-600 uppercase tracking-wide flex items-center gap-1">
                <Tag className="w-3 h-3" /> Tag Targeting
              </p>
              <p className="text-xs text-violet-700">
                {cfg.tagTargeting.mode === "with_tag" ? "Shown to visitors with" : "Shown to visitors without"} tag: <strong>{cfg.tagTargeting.tag}</strong>
              </p>
            </div>
          )}

          {/* Status change */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Status</p>
            <div className="flex gap-1.5">
              {(["active", "inactive", "scheduled"] as const).map(s => (
                <Button
                  key={s}
                  variant={status === s ? "default" : "outline"}
                  size="sm"
                  className={cn("h-7 text-xs capitalize", status === s && "bg-indigo-600 hover:bg-indigo-700")}
                  onClick={() => updateStatus.mutate(s)}
                  disabled={updateStatus.isPending}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>

          {/* Analytics */}
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <BarChart3 className="w-3 h-3" /> Campaign Performance
            </p>
            {analyticsLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md bg-indigo-50 border border-indigo-100 p-2 text-center">
                  <p className="text-lg font-bold text-indigo-700">{(analytics?.impressions ?? 0).toLocaleString()}</p>
                  <p className="text-[10px] text-indigo-500 mt-0.5">Impressions</p>
                </div>
                <div className="rounded-md bg-emerald-50 border border-emerald-100 p-2 text-center">
                  <p className="text-lg font-bold text-emerald-700">{(analytics?.clicks ?? 0).toLocaleString()}</p>
                  <p className="text-[10px] text-emerald-500 mt-0.5">Clicks</p>
                </div>
                <div className="rounded-md bg-amber-50 border border-amber-100 p-2 text-center">
                  <p className="text-lg font-bold text-amber-700">{(analytics?.dismissals ?? 0).toLocaleString()}</p>
                  <p className="text-[10px] text-amber-500 mt-0.5">Dismissals</p>
                </div>
                <div className="rounded-md bg-sky-50 border border-sky-100 p-2 text-center">
                  <p className="text-lg font-bold text-sky-700">{(analytics?.ctr ?? 0).toFixed(2)}%</p>
                  <p className="text-[10px] text-sky-500 mt-0.5">Click-through rate</p>
                </div>
              </div>
            )}
          </div>

          {/* Used in journeys */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <BarChart3 className="w-3.5 h-3.5" />
              Used in {(banner.usedInCount ?? 0)} journey{(banner.usedInCount ?? 0) !== 1 ? "s" : ""}
            </p>
            {usageLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            ) : usage.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not attached to any journey pages yet</p>
            ) : (
              <div className="space-y-1">
                {usage.map(u => (
                  <div key={u.componentId} className="flex items-center justify-between rounded-md border bg-gray-50 px-2.5 py-1.5 text-xs">
                    <div>
                      <p className="font-medium">{u.journeyName}</p>
                      <p className="text-muted-foreground">Page {u.pageOrder}: {u.pageTitle}</p>
                    </div>
                    <a
                      href={`/journeys/${u.journeyId}`}
                      className="text-indigo-600 hover:text-indigo-700"
                      title="Open in builder"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Used in plays */}
          {!usageLoading && playUsage.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Zap className="w-3.5 h-3.5" />
                Linked to {playUsage.length} play{playUsage.length !== 1 ? "s" : ""}
              </p>
              <div className="space-y-1">
                {playUsage.map(p => (
                  <div key={p.playId} className="flex items-center justify-between rounded-md border bg-gray-50 px-2.5 py-1.5 text-xs">
                    <p className="font-medium">{p.playName}</p>
                    <div className="flex items-center gap-1.5">
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded border capitalize", PLAY_STATUS_COLORS[p.playStatus] ?? PLAY_STATUS_COLORS.draft)}>
                        {p.playStatus}
                      </span>
                      <a href={`/plays/${p.playId}`} className="text-indigo-600 hover:text-indigo-700">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 border-t pt-4">
            <Button className="flex-1 gap-1.5 bg-indigo-600 hover:bg-indigo-700" onClick={() => { onClose(); onEdit(banner); }}>
              <Pencil className="w-3.5 h-3.5" /> Edit banner
            </Button>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => { onClose(); onDuplicate(banner); }}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:border-destructive/30" onClick={() => { onClose(); onDelete(banner); }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function BannersLibraryPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<BannerRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailBanner, setDetailBanner] = useState<BannerRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [usedInFilter, setUsedInFilter] = useState("");

  const { data: banners = [], isLoading } = useQuery<BannerRecord[]>({
    queryKey: ["banners"],
    queryFn: () => fetch("/api/banners", { credentials: "include" }).then(r => r.json()),
  });

  const filtered = useMemo(() => {
    const usedInQ = usedInFilter.toLowerCase().trim();
    return banners.filter(b => {
      const cfg = b.config ?? {};
      const type = cfg.type ?? "text";
      if (search && !b.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (zoneFilter !== "all") {
        if (zoneFilter === "no-zone" && b.zone) return false;
        if (zoneFilter !== "no-zone" && b.zone !== zoneFilter) return false;
      }
      if (statusFilter === "not-in-use") {
        if ((b.usedInCount ?? 0) > 0) return false;
      } else if (statusFilter !== "all" && (b.status ?? "active") !== statusFilter) return false;
      if (typeFilter !== "all" && type !== typeFilter) return false;
      if (usedInQ) {
        const journeyMatch = (b.usedInJourneys ?? []).some(j => j.name.toLowerCase().includes(usedInQ));
        const playMatch = (b.usedInPlays ?? []).some(p => p.name.toLowerCase().includes(usedInQ));
        if (!journeyMatch && !playMatch) return false;
      }
      return true;
    });
  }, [banners, search, zoneFilter, statusFilter, typeFilter, usedInFilter]);

  async function handleDuplicate(b: BannerRecord) {
    try {
      const r = await fetch("/api/banners", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${b.name} (copy)`,
          position: b.position,
          zone: b.zone ?? undefined,
          status: "inactive",
          config: b.config,
        }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast({ title: "Duplicated", description: `${b.name} (copy)` });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/banners/${deleteTarget.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast({ title: "Deleted", description: deleteTarget.name });
      setDeleteTarget(null);
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  const activeCount = banners.filter(b => (b.status ?? "active") === "active").length;
  const zoneCount = banners.filter(b => !!b.zone).length;
  const scheduledCount = banners.filter(b => b.status === "scheduled").length;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center">
            <Megaphone className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Banner Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {banners.length} banner{banners.length !== 1 ? "s" : ""} · {activeCount} active
              {scheduledCount > 0 && ` · ${scheduledCount} scheduled`}
              · {zoneCount} zone-assigned
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
          <Plus className="w-4 h-4" /> Create Banner
        </Button>
      </div>

      {/* Zone Settings */}
      <ZoneSettingsPanel />

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search banners…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="relative min-w-[180px]">
          <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Used in journey / play…"
            value={usedInFilter}
            onChange={e => setUsedInFilter(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Select value={zoneFilter} onValueChange={setZoneFilter}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <Filter className="w-3 h-3 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Zone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All zones</SelectItem>
            <SelectItem value="top">Top zone</SelectItem>
            <SelectItem value="bottom">Bottom zone</SelectItem>
            <SelectItem value="sidebar">Sidebar zone</SelectItem>
            <SelectItem value="no-zone">No zone</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <Clock className="w-3 h-3 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="not-in-use">Not in use</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-28 h-8 text-xs">
            <ImageIcon className="w-3 h-3 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="text">Text</SelectItem>
            <SelectItem value="image">Image</SelectItem>
          </SelectContent>
        </Select>
        {(search || usedInFilter || zoneFilter !== "all" || statusFilter !== "all" || typeFilter !== "all") && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setSearch(""); setUsedInFilter(""); setZoneFilter("all"); setStatusFilter("all"); setTypeFilter("all"); }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : banners.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl py-20 text-center space-y-3">
          <Megaphone className="w-10 h-10 mx-auto opacity-20" />
          <div>
            <p className="font-medium text-sm">No banners yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create personalized banners for your journey pages</p>
          </div>
          <Button variant="outline" onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="w-4 h-4" /> Create your first banner
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl py-14 text-center space-y-2">
          <Search className="w-8 h-8 mx-auto opacity-20" />
          <p className="text-sm font-medium">No banners match your filters</p>
          <p className="text-xs text-muted-foreground">Try adjusting or clearing the filters above</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(b => {
            const cfg = b.config ?? {};
            const type = cfg.type ?? "text";
            const status = b.status ?? "active";
            return (
              <div
                key={b.id}
                className="bg-card border rounded-xl overflow-hidden hover:border-amber-300 hover:shadow-sm transition-all group cursor-pointer"
                onClick={() => setDetailBanner(b)}
              >
                {/* Scaled preview thumbnail */}
                <BannerCardPreview position={b.position} config={cfg} />

                {/* Info */}
                <div className="p-3.5 space-y-2.5 border-t">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{b.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(b.createdAt).toLocaleDateString()}
                        {b.originalWidth && b.originalHeight && ` · ${b.originalWidth}×${b.originalHeight}`}
                        {b.fileSize ? ` · ${formatBytes(b.fileSize)}` : ""}
                      </p>
                    </div>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border shrink-0", STATUS_COLORS[status])}>
                      {status}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", TYPE_COLORS[type] ?? TYPE_COLORS.text)}>
                      {TYPE_LABELS[type] ?? type}
                    </span>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", POSITION_COLORS[b.position] ?? "bg-gray-50 text-gray-700 border-gray-200")}>
                      {POSITION_LABELS[b.position] ?? b.position}
                    </span>
                    {b.zone && (
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", ZONE_COLORS[b.zone])}>
                        <Globe className="inline w-2.5 h-2.5 mr-0.5" />
                        {ZONE_LABELS[b.zone]}
                      </span>
                    )}
                    {(b.startDate || b.endDate) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200">
                        <CalendarRange className="inline w-2.5 h-2.5 mr-0.5" />
                        {b.startDate && !b.endDate ? "Starts " + new Date(b.startDate).toLocaleDateString() : ""}
                        {!b.startDate && b.endDate ? "Ends " + new Date(b.endDate).toLocaleDateString() : ""}
                        {b.startDate && b.endDate ? "Scheduled" : ""}
                      </span>
                    )}
                    {(b.usedInCount ?? 0) > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border bg-sky-50 text-sky-700 border-sky-200">
                        {b.usedInCount} journey{(b.usedInCount ?? 0) !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 pt-0.5 border-t opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 flex-1"
                      onClick={e => { e.stopPropagation(); navigate(`/library/banners/${b.id}/edit`); }}>
                      <Pencil className="w-3 h-3" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 flex-1"
                      onClick={e => { e.stopPropagation(); handleDuplicate(b); }}>
                      <Copy className="w-3 h-3" /> Copy
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={e => { e.stopPropagation(); setDeleteTarget(b); }}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Banner Drawer */}
      <CreateBannerDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["banners"] })}
      />

      {/* Detail Drawer */}
      <DetailDrawer
        banner={detailBanner}
        onClose={() => setDetailBanner(null)}
        onEdit={b => navigate(`/library/banners/${b.id}/edit`)}
        onDuplicate={handleDuplicate}
        onDelete={b => { setDeleteTarget(b); }}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete banner?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> will be permanently deleted. Journey pages already using this banner will keep their cached content but the banner cannot be edited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive hover:bg-destructive/90">
              {deleting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
