import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Copy, Trash2, Loader2, MousePointerClick,
  Download, FileText, ArrowLeft, ChevronRight,
  Sun, Moon, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { AssetPicker, type PickedAsset } from "@/components/AssetPicker";
import { CtaButtonPreview } from "@/components/CtaButtonPreview";
import type { StyleConfig } from "@/components/CtaButtonPreview";

interface ActionConfig {
  url?: string;
  openInNewTab?: boolean;
  assetId?: number;
  assetFilename?: string;
  assetSizeBytes?: number;
  assetUrl?: string;
  formId?: number;
  deliveryAssetId?: number;
  deliveryAssetFilename?: string;
  deliveryAssetSizeBytes?: number;
  deliveryAssetUrl?: string;
}

type ActionType = "url" | "download" | "gated_form" | "jump_page" | "just_submit";

interface CtaButton {
  id: number;
  tenantId: number;
  name: string;
  label: string;
  actionType: ActionType;
  actionConfig: ActionConfig;
  styleConfig: StyleConfig;
  usedIn: number;
  createdAt: string;
}

// ── Action Badges ─────────────────────────────────────────────────────────────
const ACTION_LABELS: Record<string, string> = {
  url: "URL", download: "Download", gated_form: "Gated Form",
  jump_page: "Jump to Page", just_submit: "Collect Info",
};
const ACTION_COLORS: Record<string, string> = {
  url: "bg-blue-50 text-blue-700 border-blue-200",
  download: "bg-emerald-50 text-emerald-700 border-emerald-200",
  gated_form: "bg-violet-50 text-violet-700 border-violet-200",
  jump_page: "bg-amber-50 text-amber-700 border-amber-200",
  just_submit: "bg-teal-50 text-teal-700 border-teal-200",
};

// ── Color Picker ──────────────────────────────────────────────────────────────
const COLOR_PRESETS = [
  "#4f46e5", "#1d4ed8", "#0f172a", "#059669",
  "#dc2626", "#d97706", "#7c3aed", "#db2777",
  "#f8fafc", "#ffffff", "#6b7280", "#000000",
];

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {COLOR_PRESETS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                "w-5 h-5 rounded border-2 transition-transform hover:scale-110",
                value === c ? "border-indigo-500 scale-110" : "border-gray-200",
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <Input
          type="color"
          value={value || "#4f46e5"}
          onChange={e => onChange(e.target.value)}
          className="w-8 h-7 p-0.5 border rounded cursor-pointer"
        />
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          className="h-7 text-xs font-mono w-24"
          placeholder="#4f46e5"
        />
      </div>
    </div>
  );
}

// ── Default State ──────────────────────────────────────────────────────────────
function defaultStyle(): StyleConfig {
  return {
    bgColor: "#4f46e5", textColor: "#ffffff", borderColor: "#4f46e5",
    noBorder: false, fontSize: 14, fontWeight: "600",
    sizePreset: "medium", borderRadius: "slightly_rounded",
    icon: "none", iconPosition: "right",
  };
}

// ── Drawer ─────────────────────────────────────────────────────────────────────
const STEPS = ["Name", "Label", "Action", "Styling"];

function CtaDrawer({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial?: CtaButton | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initial?.name ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [actionType, setActionType] = useState<ActionType>(initial?.actionType ?? "url");
  const [actionConfig, setActionConfig] = useState<ActionConfig>(initial?.actionConfig ?? {});
  const [styleConfig, setStyleConfig] = useState<StyleConfig>(initial?.styleConfig ?? defaultStyle());
  const [previewDark, setPreviewDark] = useState(false);
  const [saving, setSaving] = useState(false);

  const isEdit = !!initial;

  function patchStyle(patch: Partial<StyleConfig>) {
    setStyleConfig(s => ({ ...s, ...patch }));
  }

  function patchAction(patch: Partial<ActionConfig>) {
    setActionConfig(c => ({ ...c, ...patch }));
  }

  const canNext = useMemo(() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return label.trim().length > 0;
    return true;
  }, [step, name, label]);

  async function handleSave() {
    setSaving(true);
    try {
      const body = {
        name, label, actionType,
        actionConfig, styleConfig,
      };
      const url = isEdit ? `/api/cta-buttons/${initial!.id}` : "/api/cta-buttons";
      const method = isEdit ? "PATCH" : "POST";
      const r = await fetch(url, {
        method, credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: isEdit ? "Updated" : "Created", description: name });
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const { data: forms = [] } = useQuery<Array<{ id: number; name: string; config: any }>>({
    queryKey: ["journey-forms"],
    queryFn: () => fetch("/api/journey-forms", { credentials: "include" }).then(r => r.json()),
    enabled: actionType === "gated_form" || actionType === "just_submit",
  });

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent className="w-[480px] sm:max-w-[480px] flex flex-col p-0 gap-0 overflow-hidden">
        <SheetHeader className="px-6 pt-5 pb-4 border-b shrink-0">
          <SheetTitle className="text-base">{isEdit ? "Edit CTA Button" : "Create CTA Button"}</SheetTitle>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-2">
            {STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => i < step && setStep(i)}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-colors",
                  i === step ? "text-indigo-600 font-semibold" : i < step ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/40 cursor-default",
                )}
              >
                <span className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border",
                  i === step ? "bg-indigo-600 text-white border-indigo-600" : i < step ? "bg-emerald-500 text-white border-emerald-500" : "border-gray-200 text-gray-300",
                )}>
                  {i < step ? <Check className="w-2.5 h-2.5" /> : i + 1}
                </span>
                {s}
                {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-gray-300" />}
              </button>
            ))}
          </div>
        </SheetHeader>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 pb-40">
          {step === 0 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Internal name <span className="text-destructive">*</span></Label>
                <Input
                  autoFocus
                  placeholder="e.g. Q3 Demo Request CTA"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && canNext && setStep(1)}
                />
                <p className="text-xs text-muted-foreground">This is only visible to your team</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Button label <span className="text-destructive">*</span></Label>
                <Input
                  autoFocus
                  placeholder="e.g. Download the Guide"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && canNext && setStep(2)}
                />
                <p className="text-xs text-muted-foreground">This is what visitors see on the button</p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs">Action type</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(["url", "download", "gated_form", "jump_page", "just_submit"] as ActionType[]).map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setActionType(type)}
                      className={cn(
                        "p-3 rounded-lg border text-left transition-all",
                        actionType === type ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className={cn(
                          "w-3.5 h-3.5 rounded-full border-2",
                          actionType === type ? "border-indigo-600 bg-indigo-600" : "border-gray-300",
                        )} />
                        <span className="text-xs font-semibold">{ACTION_LABELS[type]}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground pl-5">
                        {type === "url" && "Opens a URL in the browser"}
                        {type === "download" && "Downloads a file directly"}
                        {type === "gated_form" && "Shows a form before downloading"}
                        {type === "jump_page" && "Scrolls to a page section"}
                        {type === "just_submit" && "Collects info — no download or redirect"}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Sub-config per action type */}
              {actionType === "url" && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Destination URL</Label>
                    <Input
                      placeholder="https://example.com/page"
                      value={actionConfig.url ?? ""}
                      onChange={e => patchAction({ url: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="new-tab"
                      checked={actionConfig.openInNewTab ?? false}
                      onCheckedChange={v => patchAction({ openInNewTab: v })}
                    />
                    <Label htmlFor="new-tab" className="text-xs cursor-pointer">Open in new tab</Label>
                  </div>
                </div>
              )}

              {actionType === "download" && (
                <div className="space-y-2 pt-1">
                  <Label className="text-xs">Asset to download</Label>
                  <AssetPicker
                    value={actionConfig.assetId ? {
                      assetId: actionConfig.assetId,
                      filename: actionConfig.assetFilename ?? "",
                      sizeBytes: actionConfig.assetSizeBytes ?? 0,
                      url: actionConfig.assetUrl ?? "",
                    } : null}
                    onChange={asset => patchAction(asset ? {
                      assetId: asset.assetId,
                      assetFilename: asset.filename,
                      assetSizeBytes: asset.sizeBytes,
                      assetUrl: asset.url,
                    } : { assetId: undefined, assetFilename: undefined })}
                  />
                </div>
              )}

              {actionType === "gated_form" && (
                <div className="space-y-4 pt-1">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Form</Label>
                      <Select
                        value={actionConfig.formId ? String(actionConfig.formId) : ""}
                        onValueChange={v => patchAction({ formId: parseInt(v) })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Choose form…" />
                        </SelectTrigger>
                        <SelectContent>
                          {forms.map(f => (
                            <SelectItem key={f.id} value={String(f.id)} className="text-xs">
                              {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {actionConfig.formId && (
                        <div className="flex items-center gap-1 mt-1">
                          <Check className="w-3 h-3 text-emerald-500" />
                          <span className="text-[10px] text-emerald-700">Form selected</span>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Delivery asset (optional)</Label>
                      <AssetPicker
                        value={actionConfig.deliveryAssetId ? {
                          assetId: actionConfig.deliveryAssetId,
                          filename: actionConfig.deliveryAssetFilename ?? "",
                          sizeBytes: actionConfig.deliveryAssetSizeBytes ?? 0,
                          url: actionConfig.deliveryAssetUrl ?? "",
                        } : null}
                        onChange={asset => patchAction(asset ? {
                          deliveryAssetId: asset.assetId,
                          deliveryAssetFilename: asset.filename,
                          deliveryAssetSizeBytes: asset.sizeBytes,
                          deliveryAssetUrl: asset.url,
                        } : { deliveryAssetId: undefined })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {actionType === "jump_page" && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs text-amber-800 font-medium">Jump to Page</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    The destination page is set when you place this button on a journey. No configuration needed here.
                  </p>
                </div>
              )}

              {actionType === "just_submit" && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Form to display</Label>
                    <Select
                      value={actionConfig.formId ? String(actionConfig.formId) : ""}
                      onValueChange={v => patchAction({ formId: parseInt(v) })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Choose form…" />
                      </SelectTrigger>
                      <SelectContent>
                        {forms.map(f => (
                          <SelectItem key={f.id} value={String(f.id)} className="text-xs">
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {actionConfig.formId && (
                      <div className="flex items-center gap-1 mt-1">
                        <Check className="w-3 h-3 text-emerald-500" />
                        <span className="text-[10px] text-emerald-700">Form selected — submissions stored in database</span>
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-teal-200 bg-teal-50 p-3">
                    <p className="text-xs text-teal-800 font-medium">Collect Information</p>
                    <p className="text-xs text-teal-700 mt-0.5">
                      Visitor submits the form and data is saved as a lead. No file is delivered.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              {/* Font */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5 col-span-1">
                  <Label className="text-xs">Font size</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min={10} max={24} value={styleConfig.fontSize ?? 14}
                      onChange={e => patchStyle({ fontSize: parseInt(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-xs w-8 text-right">{styleConfig.fontSize ?? 14}px</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Weight</Label>
                  <Select
                    value={styleConfig.fontWeight ?? "600"}
                    onValueChange={v => patchStyle({ fontWeight: v })}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["400", "500", "600", "700", "800"].map(w => (
                        <SelectItem key={w} value={w} className="text-xs" style={{ fontWeight: w }}>
                          {w === "400" ? "Normal" : w === "500" ? "Medium" : w === "600" ? "SemiBold" : w === "700" ? "Bold" : "ExtraBold"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Font family</Label>
                  <Select
                    value={styleConfig.fontFamily ?? "inherit"}
                    onValueChange={v => patchStyle({ fontFamily: v })}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        { v: "inherit", l: "Inherit" },
                        { v: "Inter, sans-serif", l: "Inter" },
                        { v: "Georgia, serif", l: "Georgia" },
                        { v: "monospace", l: "Mono" },
                      ].map(f => (
                        <SelectItem key={f.v} value={f.v} className="text-xs">{f.l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Colors */}
              <ColorField
                label="Background color"
                value={styleConfig.bgColor ?? "#4f46e5"}
                onChange={v => patchStyle({ bgColor: v })}
              />
              <ColorField
                label="Text color"
                value={styleConfig.textColor ?? "#ffffff"}
                onChange={v => patchStyle({ textColor: v })}
              />

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Border color</Label>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        id="no-border"
                        checked={styleConfig.noBorder ?? false}
                        onCheckedChange={v => patchStyle({ noBorder: v })}
                        className="h-4 w-7"
                      />
                      <Label htmlFor="no-border" className="text-[10px] text-muted-foreground cursor-pointer">None</Label>
                    </div>
                  </div>
                  {!styleConfig.noBorder && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="color"
                        value={styleConfig.borderColor || styleConfig.bgColor || "#4f46e5"}
                        onChange={e => patchStyle({ borderColor: e.target.value })}
                        className="w-8 h-7 p-0.5 border rounded cursor-pointer"
                      />
                      <Input
                        value={styleConfig.borderColor ?? ""}
                        onChange={e => patchStyle({ borderColor: e.target.value })}
                        className="h-7 text-xs font-mono flex-1"
                        placeholder="#4f46e5"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Size preset */}
              <div className="space-y-1.5">
                <Label className="text-xs">Size</Label>
                <div className="flex gap-2">
                  {(["small", "medium", "large", "full"] as const).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => patchStyle({ sizePreset: s })}
                      className={cn(
                        "flex-1 text-xs py-1.5 rounded border font-medium capitalize transition-all",
                        styleConfig.sizePreset === s ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300",
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Border radius */}
              <div className="space-y-1.5">
                <Label className="text-xs">Border radius</Label>
                <div className="flex gap-2">
                  {([
                    { v: "sharp", l: "Sharp" },
                    { v: "slightly_rounded", l: "Rounded" },
                    { v: "pill", l: "Pill" },
                  ] as const).map(r => (
                    <button
                      key={r.v}
                      type="button"
                      onClick={() => patchStyle({ borderRadius: r.v })}
                      className={cn(
                        "flex-1 text-xs py-1.5 border font-medium transition-all",
                        r.v === "sharp" ? "rounded-none" : r.v === "slightly_rounded" ? "rounded-md" : "rounded-full",
                        styleConfig.borderRadius === r.v ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300",
                      )}
                    >
                      {r.l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Icon */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Icon</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {([
                      { v: "none", l: "None" },
                      { v: "arrow", l: "→" },
                      { v: "download", l: "↓" },
                      { v: "external", l: "↗" },
                      { v: "form", l: "📋" },
                      { v: "auto", l: "Auto" },
                    ]).map(ic => (
                      <button
                        key={ic.v}
                        type="button"
                        onClick={() => patchStyle({ icon: ic.v })}
                        className={cn(
                          "text-xs px-2.5 py-1 rounded border transition-all",
                          styleConfig.icon === ic.v ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300",
                        )}
                      >
                        {ic.l}
                      </button>
                    ))}
                  </div>
                </div>
                {styleConfig.icon && styleConfig.icon !== "none" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Icon position</Label>
                    <div className="flex gap-2">
                      {(["left", "right"] as const).map(pos => (
                        <button
                          key={pos}
                          type="button"
                          onClick={() => patchStyle({ iconPosition: pos })}
                          className={cn(
                            "flex-1 text-xs py-1.5 rounded border font-medium capitalize transition-all",
                            styleConfig.iconPosition === pos ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-gray-200 hover:border-gray-300",
                          )}
                        >
                          {pos}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sticky preview + footer */}
        <div className="absolute bottom-0 left-0 right-0 border-t bg-card">
          {/* Live preview strip */}
          {(step >= 1 || label) && (
            <div className={cn(
              "px-6 py-3 border-b flex items-center justify-between gap-3",
              previewDark ? "bg-gray-900" : "bg-gray-50",
            )}>
              <div className="flex items-center gap-2 flex-1 justify-center">
                <CtaButtonPreview label={label || "Button"} styleConfig={styleConfig} dark={previewDark} />
              </div>
              <button
                type="button"
                onClick={() => setPreviewDark(d => !d)}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Toggle preview background"
              >
                {previewDark ? <Sun className="w-3.5 h-3.5 text-yellow-400" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          {/* Navigation */}
          <div className="px-6 py-3 flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => step > 0 ? setStep(s => s - 1) : onClose()}
              className="gap-1"
            >
              {step > 0 && <ArrowLeft className="w-3.5 h-3.5" />}
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                size="sm"
                onClick={() => setStep(s => s + 1)}
                disabled={!canNext}
                className="gap-1"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isEdit ? "Save changes" : "Create button"}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function CtaButtonsLibraryPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CtaButton | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CtaButton | null>(null);

  const { data: ctaButtons = [], isLoading } = useQuery<CtaButton[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
  });

  // Auto-open create drawer from URL param (?create=1)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("create") === "1") {
      setDrawerOpen(true);
    }
  }, []);

  function openCreate() {
    setEditTarget(null);
    setDrawerOpen(true);
  }

  function openEdit(btn: CtaButton) {
    setEditTarget(btn);
    setDrawerOpen(true);
  }

  async function handleDuplicate(btn: CtaButton) {
    try {
      const r = await fetch("/api/cta-buttons", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${btn.name} (copy)`,
          label: btn.label,
          actionType: btn.actionType,
          actionConfig: btn.actionConfig,
          styleConfig: btn.styleConfig,
        }),
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["cta-buttons"] });
      toast({ title: "Duplicated", description: btn.name });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    }
  }

  async function handleDelete(btn: CtaButton) {
    try {
      const r = await fetch(`/api/cta-buttons/${btn.id}`, {
        method: "DELETE", credentials: "include",
      });
      if (!r.ok) throw new Error();
      qc.invalidateQueries({ queryKey: ["cta-buttons"] });
      toast({ title: "Deleted", description: btn.name });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
    setDeleteTarget(null);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-100 rounded-lg flex items-center justify-center">
            <MousePointerClick className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">CTA Buttons</h1>
            <p className="text-sm text-muted-foreground">
              Reusable call-to-action buttons for journeys
            </p>
          </div>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="w-4 h-4" />
          Create CTA Button
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : ctaButtons.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl py-20 text-center space-y-3">
          <MousePointerClick className="w-10 h-10 mx-auto opacity-20" />
          <div>
            <p className="font-medium text-sm">No CTA buttons yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create reusable buttons for your journey pages</p>
          </div>
          <Button variant="outline" onClick={openCreate} className="gap-2">
            <Plus className="w-4 h-4" /> Create your first button
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {ctaButtons.map(btn => (
            <div
              key={btn.id}
              className="bg-card border rounded-xl p-4 space-y-3 hover:border-indigo-200 transition-colors"
            >
              {/* Preview */}
              <div className="h-16 rounded-lg bg-gray-50 border flex items-center justify-center">
                <CtaButtonPreview label={btn.label} styleConfig={btn.styleConfig} />
              </div>

              {/* Info */}
              <div>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{btn.name}</p>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded border shrink-0",
                    ACTION_COLORS[btn.actionType] ?? "bg-gray-50 text-gray-700 border-gray-200",
                  )}>
                    {ACTION_LABELS[btn.actionType] ?? btn.actionType}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">"{btn.label}"</p>
              </div>

              {/* Asset / form chips */}
              {btn.actionType === "download" && btn.actionConfig.assetFilename && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">
                    <Download className="w-2.5 h-2.5" />
                    {btn.actionConfig.assetFilename}
                  </span>
                </div>
              )}
              {btn.actionType === "gated_form" && (btn.actionConfig.formId || btn.actionConfig.deliveryAssetFilename) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {btn.actionConfig.formId && (
                    <span className="inline-flex items-center gap-1 text-[10px] bg-violet-50 text-violet-700 border border-violet-200 rounded px-1.5 py-0.5">
                      <FileText className="w-2.5 h-2.5" />
                      Form #{btn.actionConfig.formId}
                    </span>
                  )}
                  {btn.actionConfig.deliveryAssetFilename && (
                    <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">
                      <Download className="w-2.5 h-2.5" />
                      {btn.actionConfig.deliveryAssetFilename}
                    </span>
                  )}
                </div>
              )}
              {btn.actionType === "just_submit" && btn.actionConfig.formId && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-[10px] bg-teal-50 text-teal-700 border border-teal-200 rounded px-1.5 py-0.5">
                    <FileText className="w-2.5 h-2.5" />
                    Form #{btn.actionConfig.formId} — saves to DB
                  </span>
                </div>
              )}
              {btn.actionType === "url" && btn.actionConfig.url && (
                <span className="text-[10px] text-muted-foreground truncate block" title={btn.actionConfig.url}>
                  → {btn.actionConfig.url}
                </span>
              )}

              {/* Used in */}
              {btn.usedIn > 0 ? (
                <Badge variant="secondary" className="text-xs">
                  Used in {btn.usedIn} {btn.usedIn === 1 ? "place" : "places"}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground/60">Not used yet</span>
              )}

              {/* Actions */}
              <div className="flex items-center gap-1 pt-1 border-t">
                <Button
                  variant="ghost" size="sm" className="h-7 text-xs gap-1 flex-1"
                  onClick={() => openEdit(btn)}
                >
                  <Pencil className="w-3 h-3" /> Edit
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-7 text-xs gap-1 flex-1"
                  onClick={() => handleDuplicate(btn)}
                >
                  <Copy className="w-3 h-3" /> Duplicate
                </Button>
                <Button
                  variant="ghost" size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteTarget(btn)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drawer */}
      {drawerOpen && (
        <CtaDrawer
          open={drawerOpen}
          initial={editTarget}
          onClose={() => { setDrawerOpen(false); setEditTarget(null); }}
          onSaved={() => qc.invalidateQueries({ queryKey: ["cta-buttons"] })}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.usedIn
                ? `This button is used in ${deleteTarget.usedIn} place${deleteTarget.usedIn > 1 ? "s" : ""}. Deleting it may affect those components.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
