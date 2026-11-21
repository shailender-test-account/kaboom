import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Save, Loader2, Type, ImageIcon, Link2,
  MousePointerClick, Tag, Settings2, Sun, Moon, Upload, X, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { CtaButtonPicker } from "@/components/CtaButtonPicker";
import { CtaButtonPreview } from "@/components/CtaButtonPreview";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CtaButton {
  id: number;
  name: string;
  label: string;
  actionType: string;
  actionConfig: Record<string, unknown>;
  styleConfig: Record<string, unknown>;
  usedIn: number;
}

export interface BannerConfig {
  type: "text" | "image";
  // Text
  bgColor: string;
  textColor: string;
  heading: string;
  body: string;
  fontFamily: string;
  headlineFontSize: number;
  subtextFontSize: number;
  padding: number;
  textAlignment: "left" | "center" | "right";
  // Image
  imageUrl: string;
  overlayText: string;
  overlaySubtext: string;
  textShadow: boolean;
  textVertical: "top" | "middle" | "bottom";
  // Click behavior
  clickBehavior: "none" | "url" | "cta";
  clickUrl: string;
  openInNewTab: boolean;
  ctaButtonId: number | null;
  ctaButtonPosition: "right" | "below";
  // Targeting
  tagTargeting: { mode: "everyone" | "with_tag" | "without_tag"; tag: string };
  // Display
  animationType: "none" | "slide_top" | "slide_bottom" | "fade";
  animationDelay: number;
  dismissButton: boolean;
  dismissDuration: "session" | "7d" | "30d" | "forever";
}

export interface BannerRecord {
  id: number;
  tenantId: number;
  name: string;
  position: string;
  config: BannerConfig;
  createdAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: BannerConfig = {
  type: "text",
  bgColor: "#4f46e5",
  textColor: "#ffffff",
  heading: "Hi {{firstName}}, welcome to {{companyName}}",
  body: "",
  fontFamily: "inherit",
  headlineFontSize: 16,
  subtextFontSize: 13,
  padding: 16,
  textAlignment: "left",
  imageUrl: "",
  overlayText: "",
  overlaySubtext: "",
  textShadow: false,
  textVertical: "middle",
  clickBehavior: "none",
  clickUrl: "",
  openInNewTab: true,
  ctaButtonId: null,
  ctaButtonPosition: "right",
  tagTargeting: { mode: "everyone", tag: "" },
  animationType: "none",
  animationDelay: 0,
  dismissButton: false,
  dismissDuration: "session",
};

const BG_PRESETS = [
  "#4f46e5", "#1d4ed8", "#0f172a", "#059669",
  "#dc2626", "#d97706", "#7c3aed", "#db2777",
  "#f8fafc", "#ffffff", "#6b7280", "#000000",
];

const TOKENS = [
  { key: "firstName",   label: "First name", mock: "Sarah"    },
  { key: "lastName",    label: "Last name",  mock: "Chen"     },
  { key: "companyName", label: "Company",    mock: "TechNova" },
  { key: "jobTitle",    label: "Job title",  mock: "Director" },
] as const;

function renderPersonalized(text: string, useMock: boolean): string {
  if (!useMock) return text;
  // Supports both {{token}} and {{token|fallback}} syntax
  return text.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key: string, fallback?: string) => {
    const t = TOKENS.find(t => t.key === key);
    if (t) return t.mock;
    if (fallback !== undefined) return fallback;
    return `{{${key}}}`;
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ColorField({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1">
          {BG_PRESETS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                "w-5 h-5 rounded border-2 transition-transform hover:scale-110",
                value === c ? "border-indigo-500 scale-110" : "border-transparent hover:border-gray-300",
              )}
              style={{ backgroundColor: c, boxShadow: c === "#ffffff" || c === "#f8fafc" ? "inset 0 0 0 1px #e5e7eb" : undefined }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value || "#4f46e5"}
            onChange={e => onChange(e.target.value)}
            className="w-8 h-7 p-0.5 border rounded cursor-pointer shrink-0"
          />
          <Input
            value={value}
            onChange={e => onChange(e.target.value)}
            className="h-7 text-xs font-mono flex-1"
            placeholder="#4f46e5"
          />
        </div>
      </div>
    </div>
  );
}

function TokenInserter({
  onInsert,
}: { onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
        >
          <Wand2 className="w-2.5 h-2.5" />
          Insert token
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="start">
        <p className="text-[10px] text-muted-foreground mb-2">Click to insert at cursor</p>
        <div className="space-y-1">
          {TOKENS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => { onInsert(`{{${t.key}}}`); setOpen(false); }}
              className="w-full flex items-center justify-between text-left px-2 py-1 rounded hover:bg-gray-50 transition-colors"
            >
              <span className="text-xs font-mono text-indigo-700">{`{{${t.key}}}`}</span>
              <span className="text-[10px] text-muted-foreground">{t.mock}</span>
            </button>
          ))}
          <p className="text-[10px] text-muted-foreground/60 mt-1 border-t pt-1">
            Optional fallback: <span className="font-mono">{"{{firstName|Friend}}"}</span>
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ImageUpload({
  value, onChange,
}: { value: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const r1 = await fetch("/api/storage/uploads/request-url", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "image/*" }),
      });
      if (!r1.ok) throw new Error();
      const { uploadURL, objectPath } = await r1.json();
      const r2 = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!r2.ok) throw new Error();
      await fetch("/api/media", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, objectPath, mimeType: file.type, fileSize: file.size }),
      });
      onChange(`/api/storage${objectPath}`);
      toast({ title: "Image uploaded" });
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  if (value) {
    return (
      <div className="relative group rounded-lg overflow-hidden border bg-gray-50">
        <img src={value} alt="Banner" className="w-full h-28 object-cover" />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />}
            Replace
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs text-destructive" onClick={() => onChange("")}>
            <X className="w-3 h-3 mr-1" /> Remove
          </Button>
        </div>
        <input ref={inputRef} type="file" accept="image/*,.gif" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
      </div>
    );
  }

  return (
    <div>
      <div
        className={cn(
          "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all",
          dragOver ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50/50",
          uploading && "pointer-events-none opacity-60",
        )}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-indigo-500 mb-1" />
        ) : (
          <ImageIcon className="w-6 h-6 mx-auto text-gray-400 mb-1" />
        )}
        <p className="text-xs font-medium text-muted-foreground">
          {uploading ? "Uploading…" : "Drop image or GIF here, or click to browse"}
        </p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">PNG, JPG, GIF, WebP · max 10 MB</p>
      </div>
      <input ref={inputRef} type="file" accept="image/*,.gif" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
    </div>
  );
}

// ── BannerPreviewWidget (exported for list page) ──────────────────────────────
export function BannerPreviewWidget({
  position,
  config,
  personalized = false,
  selectedCtaButton = null,
}: {
  position: string;
  config: Partial<BannerConfig>;
  personalized?: boolean;
  selectedCtaButton?: CtaButton | null;
}) {
  const c = { ...DEFAULT_CONFIG, ...config };
  const h = (text: string) => renderPersonalized(text, personalized);

  const showCta = c.clickBehavior === "cta" && selectedCtaButton;
  const ctaEl = showCta ? (
    <CtaButtonPreview label={selectedCtaButton.label} styleConfig={selectedCtaButton.styleConfig} />
  ) : null;

  const clickable = c.clickBehavior === "url" && c.clickUrl;
  const wrapClickable = (inner: React.ReactNode) =>
    clickable ? (
      <a
        href={c.clickUrl || "#"}
        onClick={e => e.preventDefault()}
        target={c.openInNewTab ? "_blank" : "_self"}
        rel={c.openInNewTab ? "noopener noreferrer" : undefined}
        style={{ display: "block", cursor: "pointer", textDecoration: "none" }}
        title={`→ ${c.clickUrl}${c.openInNewTab ? " (new tab)" : ""}`}
      >
        {inner}
      </a>
    ) : (
      <>{inner}</>
    );

  if (c.type === "image") {
    // Derive max constraints from position so the preview matches live rendering
    const imgStyle: React.CSSProperties =
      position === "top" || position === "bottom"
        ? { display: "block", maxHeight: 56, width: "auto", maxWidth: "100%" }
        : position === "popup"
        ? { display: "block", width: "100%", height: "auto", maxWidth: 560, maxHeight: 360 }
        : { display: "block", width: "100%" };

    const inner = (
      <div className="relative w-full overflow-hidden" style={{ minHeight: 40 }}>
        {c.imageUrl ? (
          <img src={c.imageUrl} alt="Banner" style={imgStyle} />
        ) : (
          <div className="w-full flex items-center justify-center bg-gray-200" style={{ height: 120 }}>
            <ImageIcon className="w-8 h-8 text-gray-400" />
          </div>
        )}
        {(c.overlayText || c.overlaySubtext) && (
          <div
            className={cn(
              "absolute inset-0 flex flex-col px-6 py-4",
              c.textVertical === "top" ? "justify-start" : c.textVertical === "bottom" ? "justify-end" : "justify-center",
              c.textAlignment === "center" ? "items-center text-center" : c.textAlignment === "right" ? "items-end text-right" : "items-start text-left",
            )}
          >
            {c.overlayText && (
              <p
                className={cn("font-bold leading-snug", c.textShadow && "[text-shadow:0_1px_3px_rgba(0,0,0,0.6)]")}
                style={{ fontSize: c.headlineFontSize, color: c.textColor || "#ffffff" }}
              >
                {h(c.overlayText)}
              </p>
            )}
            {c.overlaySubtext && (
              <p
                className={cn("mt-1", c.textShadow && "[text-shadow:0_1px_3px_rgba(0,0,0,0.5)]")}
                style={{ fontSize: c.subtextFontSize, color: c.textColor || "#ffffff" }}
              >
                {h(c.overlaySubtext)}
              </p>
            )}
          </div>
        )}
        {showCta && (
          <div className={cn(
            "absolute left-0 right-0 flex",
            c.ctaButtonPosition === "below" ? "bottom-3 justify-center" : "bottom-3 right-4 justify-end",
          )}>
            {ctaEl}
          </div>
        )}
        {c.dismissButton && (
          <button
            type="button"
            className="absolute top-2 right-2 bg-black/40 rounded-full p-0.5 opacity-70 hover:opacity-100"
            style={{ color: c.textColor || "#ffffff" }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {clickable && (
          <div className="absolute top-2 right-2 bg-black/40 rounded px-1.5 py-0.5 text-[10px] text-white">
            clickable ↗
          </div>
        )}
      </div>
    );
    return wrapClickable(inner);
  }

  // Text banner
  const inner = (
    <div
      className="w-full flex flex-wrap gap-3 relative"
      style={{
        backgroundColor: c.bgColor || "#4f46e5",
        color: c.textColor || "#ffffff",
        padding: c.padding || 16,
        fontFamily: c.fontFamily || "inherit",
        textAlign: c.textAlignment || "left",
        alignItems: showCta && c.ctaButtonPosition === "right" ? "center" : "flex-start",
        flexDirection: showCta && c.ctaButtonPosition === "below" ? "column" : "row",
        justifyContent: c.textAlignment === "center" ? "center" : c.textAlignment === "right" ? "flex-end" : "flex-start",
      }}
    >
      <div className={cn("flex-1 min-w-0", c.ctaButtonPosition === "right" && showCta ? "" : "w-full")}>
        {c.heading && (
          <p style={{ fontSize: c.headlineFontSize || 16, fontWeight: 600, lineHeight: 1.3 }}>
            {h(c.heading)}
          </p>
        )}
        {c.body && (
          <p style={{ fontSize: c.subtextFontSize || 13, opacity: 0.85, marginTop: 2 }}>
            {h(c.body)}
          </p>
        )}
      </div>
      {showCta && c.ctaButtonPosition === "right" && (
        <div className="shrink-0 flex items-center">{ctaEl}</div>
      )}
      {showCta && c.ctaButtonPosition === "below" && (
        <div className="mt-1">{ctaEl}</div>
      )}
      {c.dismissButton && (
        <button
          type="button"
          className="absolute top-1 right-2 opacity-60 hover:opacity-100"
          style={{ color: c.textColor || "#ffffff" }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {clickable && (
        <div className="absolute top-1 right-2 text-[10px] opacity-60">↗</div>
      )}
    </div>
  );
  return wrapClickable(inner);
}

// ── SectionHeader ─────────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2 pb-1 border-b">
      <Icon className="w-3.5 h-3.5 text-indigo-500" />
      <span className="text-xs font-semibold text-foreground">{label}</span>
    </div>
  );
}

// ── Main Editor Page ──────────────────────────────────────────────────────────
export default function BannerEditorPage({ id }: { id?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isEdit = Boolean(id);

  const [name, setName] = useState("");
  const [position, setPosition] = useState<"top" | "bottom" | "popup">("top");
  const [config, setConfig] = useState<BannerConfig>({ ...DEFAULT_CONFIG });
  const [personalized, setPersonalized] = useState(true);
  const [darkBg, setDarkBg] = useState(false);
  const [saving, setSaving] = useState(false);

  const headingRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const overlayTextRef = useRef<HTMLTextAreaElement>(null);
  const overlaySubRef = useRef<HTMLTextAreaElement>(null);

  const { data: existing, isLoading: loadingExisting } = useQuery<BannerRecord>({
    queryKey: ["banners", id],
    queryFn: () => fetch(`/api/banners/${id}`, { credentials: "include" }).then(r => r.json()),
    enabled: isEdit,
  });

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      const pos = existing.position;
      setPosition(
        pos === "popup" ? "popup"
        : (pos === "bottom" || pos === "bottom_bar") ? "bottom"
        : "top",
      );
      setConfig({ ...DEFAULT_CONFIG, ...existing.config });
    }
  }, [existing]);

  const { data: ctaButtons = [] } = useQuery<CtaButton[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
  });

  const selectedCta = config.ctaButtonId
    ? ctaButtons.find(b => b.id === config.ctaButtonId) ?? null
    : null;

  function patch(p: Partial<BannerConfig>) {
    setConfig(c => ({ ...c, ...p }));
  }

  function insertToken(
    ref: React.RefObject<HTMLTextAreaElement | null>,
    field: keyof BannerConfig,
    token: string,
  ) {
    const el = ref.current;
    const cur = (config[field] as string) || "";
    if (!el) { patch({ [field]: cur + token }); return; }
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    patch({ [field]: next });
    setTimeout(() => {
      el.setSelectionRange(start + token.length, start + token.length);
      el.focus();
    }, 0);
  }

  async function handleSave() {
    if (!name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const url = isEdit ? `/api/banners/${id}` : "/api/banners";
      const method = isEdit ? "PATCH" : "POST";
      const r = await fetch(url, {
        method, credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, position, config }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast({ title: isEdit ? "Banner saved" : "Banner created" });
      navigate("/library/banners");
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const POSITION_OPTIONS = [
    { value: "top",    label: "Top banner",    desc: "Thin strip at the top of the journey page (capped at 7% of viewport height)" },
    { value: "bottom", label: "Bottom banner", desc: "Thin strip at the bottom of the journey page (capped at 7% of viewport height)" },
    { value: "popup",  label: "Pop-up banner", desc: "Centered modal overlay — doesn't take any space away from the hero content" },
  ] as const;

  const CLICK_OPTIONS = [
    { value: "none", label: "No action", desc: "Display only — no click interaction" },
    { value: "url", label: "Simple URL link", desc: "Entire banner becomes a clickable link" },
    { value: "cta", label: "Add a CTA Button", desc: "Attach a reusable CTA button to the banner" },
  ] as const;

  const TAG_OPTIONS = [
    { value: "everyone", label: "Everyone", desc: "Show to all visitors" },
    { value: "with_tag", label: "Only contacts with tag…", desc: "Show only if visitor has this tag" },
    { value: "without_tag", label: "Only contacts without tag…", desc: "Hide if visitor has this tag" },
  ] as const;

  if (isEdit && loadingExisting) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Left Panel ─────────────────────────────────────────────────────── */}
      <div className="w-[400px] shrink-0 border-r flex flex-col overflow-hidden bg-card">
        {/* Sticky header */}
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate("/library/banners")}>
            <ArrowLeft className="w-3.5 h-3.5" />
          </Button>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground truncate">
              {isEdit ? "Edit Banner" : "Create Banner"}
            </p>
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs gap-1">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save
          </Button>
        </div>

        {/* Scrollable config */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {/* Internal name */}
          <div className="space-y-1.5">
            <Label className="text-xs">Internal name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Q3 Launch – Top Bar"
              className="h-8 text-sm"
            />
            <p className="text-[10px] text-muted-foreground">Only visible to your team</p>
          </div>

          {/* Banner type toggle */}
          <div className="space-y-2">
            <SectionHeader icon={ImageIcon} label="Banner type" />
            <div className="grid grid-cols-2 gap-2">
              {([
                { v: "text", l: "Text", icon: Type },
                { v: "image", l: "Image / GIF", icon: ImageIcon },
              ] as const).map(({ v, l, icon: Icon }) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => patch({ type: v })}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border text-left transition-all",
                    config.type === v ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                  )}
                >
                  <div className={cn(
                    "w-3 h-3 rounded-full border-2 shrink-0",
                    config.type === v ? "border-indigo-600 bg-indigo-600" : "border-gray-300",
                  )} />
                  <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium">{l}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Text banner config ── */}
          {config.type === "text" && (
            <div className="space-y-4">
              <SectionHeader icon={Type} label="Text content" />

              <ColorField label="Background color" value={config.bgColor} onChange={v => patch({ bgColor: v })} />
              <ColorField label="Text color" value={config.textColor} onChange={v => patch({ textColor: v })} />

              {/* Heading */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Headline</Label>
                  <TokenInserter onInsert={t => insertToken(headingRef, "heading", t)} />
                </div>
                <Textarea
                  ref={headingRef}
                  value={config.heading}
                  onChange={e => patch({ heading: e.target.value })}
                  placeholder="Hi {{firstName}}, welcome to {{companyName}}"
                  className="text-xs h-16 resize-none"
                />
              </div>

              {/* Body */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Subtext</Label>
                  <TokenInserter onInsert={t => insertToken(bodyRef, "body", t)} />
                </div>
                <Textarea
                  ref={bodyRef}
                  value={config.body}
                  onChange={e => patch({ body: e.target.value })}
                  placeholder="Optional supporting text…"
                  className="text-xs h-12 resize-none"
                />
              </div>

              {/* Font controls */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Font family</Label>
                  <Select value={config.fontFamily || "inherit"} onValueChange={v => patch({ fontFamily: v })}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit" className="text-xs">Default (inherit)</SelectItem>
                      <SelectItem value="Inter, sans-serif" className="text-xs">Inter</SelectItem>
                      <SelectItem value="Georgia, serif" className="text-xs">Georgia</SelectItem>
                      <SelectItem value="'Courier New', monospace" className="text-xs">Courier</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Alignment</Label>
                  <div className="flex gap-1">
                    {(["left", "center", "right"] as const).map(a => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => patch({ textAlignment: a })}
                        className={cn(
                          "flex-1 text-xs py-1 border rounded capitalize transition-all",
                          config.textAlignment === a ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300",
                        )}
                      >
                        {a[0].toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Size sliders */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Headline size</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{config.headlineFontSize}px</span>
                  </div>
                  <input
                    type="range" min={16} max={48} value={config.headlineFontSize}
                    onChange={e => patch({ headlineFontSize: parseInt(e.target.value) })}
                    className="w-full h-1.5 accent-indigo-600"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Subtext size</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{config.subtextFontSize}px</span>
                  </div>
                  <input
                    type="range" min={12} max={24} value={config.subtextFontSize}
                    onChange={e => patch({ subtextFontSize: parseInt(e.target.value) })}
                    className="w-full h-1.5 accent-indigo-600"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Padding</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{config.padding}px</span>
                  </div>
                  <input
                    type="range" min={12} max={64} value={config.padding}
                    onChange={e => patch({ padding: parseInt(e.target.value) })}
                    className="w-full h-1.5 accent-indigo-600"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Image/GIF banner config ── */}
          {config.type === "image" && (
            <div className="space-y-4">
              <SectionHeader icon={ImageIcon} label="Image / GIF" />

              <ImageUpload value={config.imageUrl} onChange={v => patch({ imageUrl: v })} />

              {/* Position hint — dynamic based on selected position */}
              <p className="text-[10px] text-muted-foreground bg-blue-50 border border-blue-100 rounded px-2.5 py-1.5">
                {position === "popup"
                  ? <>Recommended size: <strong>560×360px</strong> — centered modal overlay</>
                  : <>Recommended width: <strong>1200px</strong> · height <strong>≤ 56px</strong> (capped at 7% of viewport)</>}
              </p>

              {/* Overlay text */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Overlay headline (optional)</Label>
                  <TokenInserter onInsert={t => insertToken(overlayTextRef, "overlayText", t)} />
                </div>
                <Textarea
                  ref={overlayTextRef}
                  value={config.overlayText}
                  onChange={e => patch({ overlayText: e.target.value })}
                  placeholder="Hi {{first_name}}…"
                  className="text-xs h-12 resize-none"
                />
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Overlay subtext (optional)</Label>
                  <TokenInserter onInsert={t => insertToken(overlaySubRef, "overlaySubtext", t)} />
                </div>
                <Textarea
                  ref={overlaySubRef}
                  value={config.overlaySubtext}
                  onChange={e => patch({ overlaySubtext: e.target.value })}
                  placeholder="Supporting copy…"
                  className="text-xs h-10 resize-none"
                />
              </div>

              {/* Overlay controls */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Text color</Label>
                  <div className="flex items-center gap-1.5">
                    <input type="color" value={config.textColor || "#ffffff"} onChange={e => patch({ textColor: e.target.value })} className="w-7 h-7 p-0.5 border rounded" />
                    <Input value={config.textColor} onChange={e => patch({ textColor: e.target.value })} className="h-7 text-xs font-mono flex-1" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Vertical align</Label>
                  <div className="flex gap-1">
                    {(["top", "middle", "bottom"] as const).map(v => (
                      <button key={v} type="button" onClick={() => patch({ textVertical: v })}
                        className={cn("flex-1 text-[10px] py-1.5 border rounded capitalize transition-all", config.textVertical === v ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300")}>
                        {v[0].toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Alignment</Label>
                  <div className="flex gap-1">
                    {(["left", "center", "right"] as const).map(a => (
                      <button key={a} type="button" onClick={() => patch({ textAlignment: a })}
                        className={cn("flex-1 text-xs py-1 border rounded capitalize transition-all", config.textAlignment === a ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300")}>
                        {a[0].toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Text shadow</Label>
                  <div className="flex items-center gap-2 pt-1">
                    <Switch checked={config.textShadow} onCheckedChange={v => patch({ textShadow: v })} />
                    <span className="text-xs text-muted-foreground">{config.textShadow ? "On" : "Off"}</span>
                  </div>
                </div>
              </div>

              {/* Headline/subtext size sliders for image overlay */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Headline size</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{config.headlineFontSize}px</span>
                  </div>
                  <input type="range" min={16} max={48} value={config.headlineFontSize} onChange={e => patch({ headlineFontSize: parseInt(e.target.value) })} className="w-full h-1.5 accent-indigo-600" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Subtext size</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{config.subtextFontSize}px</span>
                  </div>
                  <input type="range" min={12} max={24} value={config.subtextFontSize} onChange={e => patch({ subtextFontSize: parseInt(e.target.value) })} className="w-full h-1.5 accent-indigo-600" />
                </div>
              </div>
            </div>
          )}

          {/* ── Click behavior ── */}
          <div className="space-y-3">
            <SectionHeader icon={Link2} label="Click behavior" />
            <div className="space-y-2">
              {CLICK_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patch({ clickBehavior: opt.value })}
                  className={cn(
                    "w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-all",
                    config.clickBehavior === opt.value
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                  )}
                >
                  <div className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 shrink-0 mt-0.5",
                    config.clickBehavior === opt.value ? "border-indigo-600 bg-indigo-600" : "border-gray-300",
                  )} />
                  <div>
                    <p className="text-xs font-semibold">{opt.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>

            {config.clickBehavior === "url" && (
              <div className="space-y-2 pl-1">
                <Input
                  value={config.clickUrl}
                  onChange={e => patch({ clickUrl: e.target.value })}
                  placeholder="https://…"
                  className="h-8 text-sm"
                />
                <div className="flex items-center gap-2">
                  <Switch checked={config.openInNewTab} onCheckedChange={v => patch({ openInNewTab: v })} />
                  <Label className="text-xs">Open in new tab</Label>
                </div>
              </div>
            )}

            {config.clickBehavior === "cta" && (
              <div className="space-y-3 pl-1">
                <CtaButtonPicker value={config.ctaButtonId} onChange={id => patch({ ctaButtonId: id })} />
                {config.ctaButtonId && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Button position</Label>
                    <div className="flex gap-2">
                      {([
                        { v: "right", l: "Right of text" },
                        { v: "below", l: "Below text" },
                      ] as const).map(({ v, l }) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => patch({ ctaButtonPosition: v })}
                          className={cn(
                            "flex-1 text-xs py-1.5 border rounded transition-all",
                            config.ctaButtonPosition === v
                              ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                              : "border-gray-200 hover:border-gray-300",
                          )}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Tag targeting ── */}
          <div className="space-y-3">
            <SectionHeader icon={Tag} label="Tag targeting" />
            <div className="space-y-2">
              {TAG_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patch({ tagTargeting: { ...config.tagTargeting, mode: opt.value } })}
                  className={cn(
                    "w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-all",
                    config.tagTargeting.mode === opt.value
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                  )}
                >
                  <div className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 shrink-0 mt-0.5",
                    config.tagTargeting.mode === opt.value ? "border-indigo-600 bg-indigo-600" : "border-gray-300",
                  )} />
                  <div>
                    <p className="text-xs font-semibold">{opt.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>
            {(config.tagTargeting.mode === "with_tag" || config.tagTargeting.mode === "without_tag") && (
              <Input
                value={config.tagTargeting.tag}
                onChange={e => patch({ tagTargeting: { ...config.tagTargeting, tag: e.target.value } })}
                placeholder="e.g. champion"
                className="h-8 text-sm"
              />
            )}
          </div>

          {/* ── Display settings ── */}
          <div className="space-y-4">
            <SectionHeader icon={Settings2} label="Display settings" />

            {/* Position */}
            <div className="space-y-1.5">
              <Label className="text-xs">Position</Label>
              <div className="space-y-1.5">
                {POSITION_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPosition(opt.value)}
                    className={cn(
                      "w-full flex items-start gap-3 px-3 py-2 rounded-lg border text-left transition-all",
                      position === opt.value
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                    )}
                  >
                    <div className={cn(
                      "w-3 h-3 rounded-full border-2 shrink-0 mt-0.5",
                      position === opt.value ? "border-indigo-600 bg-indigo-600" : "border-gray-300",
                    )} />
                    <div>
                      <p className="text-xs font-medium">{opt.label}</p>
                      <p className="text-[10px] text-muted-foreground">{opt.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Animation */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Animation</Label>
                <Select value={config.animationType} onValueChange={v => patch({ animationType: v as BannerConfig["animationType"] })}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs">None</SelectItem>
                    <SelectItem value="slide_top" className="text-xs">Slide from top</SelectItem>
                    <SelectItem value="slide_bottom" className="text-xs">Slide from bottom</SelectItem>
                    <SelectItem value="fade" className="text-xs">Fade in</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Delay</Label>
                <Select value={String(config.animationDelay)} onValueChange={v => patch({ animationDelay: parseInt(v) })}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 2, 3].map(d => (
                      <SelectItem key={d} value={String(d)} className="text-xs">{d === 0 ? "Immediately" : `${d}s delay`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Dismiss */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch checked={config.dismissButton} onCheckedChange={v => patch({ dismissButton: v })} />
                <Label className="text-xs">Show dismiss button</Label>
              </div>
              {config.dismissButton && (
                <div className="space-y-1.5 pl-7">
                  <Label className="text-xs">Hide duration</Label>
                  <Select value={config.dismissDuration} onValueChange={v => patch({ dismissDuration: v as BannerConfig["dismissDuration"] })}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="session" className="text-xs">Until session ends</SelectItem>
                      <SelectItem value="7d" className="text-xs">7 days</SelectItem>
                      <SelectItem value="30d" className="text-xs">30 days</SelectItem>
                      <SelectItem value="forever" className="text-xs">Forever (until cookies cleared)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── Right Panel — Live Preview ────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Preview toolbar */}
        <div className="border-b bg-card px-4 py-2 flex items-center justify-between gap-3 shrink-0">
          <p className="text-xs font-medium text-muted-foreground">Live preview</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Switch
                checked={personalized}
                onCheckedChange={setPersonalized}
                className="scale-75"
              />
              <Label className="text-xs cursor-pointer" onClick={() => setPersonalized(v => !v)}>
                Mock data
              </Label>
            </div>
            <button
              type="button"
              onClick={() => setDarkBg(d => !d)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Toggle page background"
            >
              {darkBg ? <Sun className="w-4 h-4 text-yellow-400" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Preview area */}
        <div className={cn("flex-1 overflow-auto p-6 md:p-10 transition-colors", darkBg ? "bg-gray-900" : "bg-gray-100")}>
          <div className="max-w-3xl mx-auto space-y-3">

            {/* Banner position: top */}
            {position === "top" && (
              <div className="rounded-lg overflow-hidden shadow-sm">
                <BannerPreviewWidget
                  position={position}
                  config={config}
                  personalized={personalized}
                  selectedCtaButton={selectedCta}
                />
              </div>
            )}

            {/* Mock page content */}
            <div className={cn(
              "rounded-xl border p-8 flex flex-col items-center justify-center gap-3 text-muted-foreground",
              darkBg ? "bg-gray-800 border-gray-700 text-gray-500" : "bg-white border-gray-200",
            )} style={{ minHeight: 280 }}>
              <div className={cn("w-3/4 h-3 rounded", darkBg ? "bg-gray-700" : "bg-gray-100")} />
              <div className={cn("w-full h-2 rounded", darkBg ? "bg-gray-700" : "bg-gray-100")} />
              <div className={cn("w-5/6 h-2 rounded", darkBg ? "bg-gray-700" : "bg-gray-100")} />
              <div className={cn("w-full h-2 rounded", darkBg ? "bg-gray-700" : "bg-gray-100")} />
              <div className={cn("w-2/3 h-2 rounded mt-2", darkBg ? "bg-gray-700" : "bg-gray-100")} />
              <p className="text-[10px] mt-2">Journey page content</p>
            </div>

            {/* Pop-up banner — preview as a centered card */}
            {position === "popup" && (
              <div className="rounded-lg overflow-hidden shadow-lg max-w-md mx-auto">
                <BannerPreviewWidget
                  position={position}
                  config={config}
                  personalized={personalized}
                  selectedCtaButton={selectedCta}
                />
              </div>
            )}

            {/* Bottom banner */}
            {position === "bottom" && (
              <div className="rounded-lg overflow-hidden shadow-sm">
                <BannerPreviewWidget
                  position={position}
                  config={config}
                  personalized={personalized}
                  selectedCtaButton={selectedCta}
                />
              </div>
            )}

            {/* Position label */}
            <p className="text-center text-[10px] text-muted-foreground">
              Position: <strong>{position.replace("_", " ")}</strong>
              {config.animationType !== "none" && ` · ${config.animationType.replace("_", " ")} animation`}
              {config.dismissButton && " · dismissable"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
