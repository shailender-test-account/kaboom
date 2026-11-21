import { useState, useRef } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical, Trash2, Copy, ChevronUp, ChevronDown,
  Type, Image, Video, Square, Minus, AlignLeft,
  Mail, Megaphone, Plus, Upload, Columns2, Link,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { AssetPicker } from "@/components/AssetPicker";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BlockType =
  | "header" | "headline" | "text" | "image" | "video"
  | "button" | "button_pair" | "divider" | "spacer" | "banner" | "footer";

export interface EmailBlock {
  id: string;
  type: BlockType;
  data: Record<string, unknown>;
}

// ── ID generator ──────────────────────────────────────────────────────────────

const genId = () => Math.random().toString(36).slice(2, 10);

// ── Default data for each block type ─────────────────────────────────────────

export const BLOCK_DEFAULTS: Record<BlockType, Record<string, unknown>> = {
  header: {
    logoText: "Your Company",
    logoImageUrl: "",
    showBg: false,
    bgColor: "#4f46e5",
    textColor: "#ffffff",
    fontSize: 22,
    padding: 24,
    alignment: "center",
  },
  headline: {
    text: "Your Headline Here",
    fontSize: 26,
    color: "#111827",
    alignment: "left",
    fontWeight: "bold",
  },
  text: {
    content: "Hi {{firstName}},\n\nYour email body goes here. You can use merge tags like {{firstName}}, {{companyName}}, and {{journeyUrl}}.\n\nBest regards,\n{{senderName}}",
    color: "#374151",
    fontSize: 15,
    lineHeight: "1.7",
    alignment: "left",
  },
  image: {
    src: "",
    alt: "",
    link: "",
    alignment: "center",
    widthPct: 100,
    borderRadius: 0,
  },
  video: {
    thumbnailSrc: "",
    videoUrl: "",
    label: "▶ Watch Video",
    bgColor: "#1f2937",
    textColor: "#ffffff",
  },
  button: {
    label: "Get Started →",
    url: "{{journeyUrl}}",
    bgColor: "#4f46e5",
    textColor: "#ffffff",
    borderRadius: 6,
    alignment: "center",
    paddingV: 12,
    paddingH: 28,
  },
  button_pair: {
    btn1Label: "Get Started →",
    btn1Url: "{{journeyUrl}}",
    btn1BgColor: "#4f46e5",
    btn1TextColor: "#ffffff",
    btn2Label: "Learn More",
    btn2Url: "",
    btn2BgColor: "#ffffff",
    btn2TextColor: "#4f46e5",
    btn2Border: "#4f46e5",
    borderRadius: 6,
    alignment: "center",
    paddingV: 12,
    paddingH: 28,
    gap: 12,
  },
  divider: {
    color: "#e5e7eb",
    height: 1,
    marginTop: 16,
    marginBottom: 16,
  },
  spacer: { height: 32 },
  banner: {
    text: "🎉 Special offer just for you!",
    imageUrl: "",
    link: "",
    bgColor: "#fffbeb",
    textColor: "#92400e",
    alignment: "center",
    padding: 16,
  },
  footer: {
    address: "123 Main St, City, State 12345",
    unsubscribeText: "Unsubscribe",
    textColor: "#9ca3af",
  },
};

// ── Render blocks → email HTML ────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Ensure image/asset URLs are always absolute so email clients can load them.
// Relative paths like /api/storage/... are not resolvable by remote email clients.
function toAbsUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  return window.location.origin + (url.startsWith("/") ? url : `/${url}`);
}

function blockToHtml(block: EmailBlock): string {
  const d = block.data as Record<string, any>;
  switch (block.type) {
    case "header": {
      const headerBg = d.showBg !== false ? (d.bgColor ?? "#4f46e5") : "transparent";
      const logoContent = d.logoImageUrl
        ? `<img src="${esc(toAbsUrl(d.logoImageUrl))}" alt="${esc(d.logoText ?? "Logo")}" style="max-height:48px;max-width:200px;height:auto;display:inline-block;" />`
        : `<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:${d.fontSize ?? 22}px;font-weight:700;color:${d.textColor ?? "#fff"};">${esc(d.logoText ?? "Your Company")}</span>`;
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${headerBg};"><tr><td align="${d.alignment ?? "center"}" style="padding:${d.padding ?? 24}px 24px;">${logoContent}</td></tr></table>`;
    }

    case "headline":
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${d.alignment ?? "left"}" style="padding:16px 24px 8px;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:${d.fontSize ?? 26}px;font-weight:${d.fontWeight ?? "bold"};color:${d.color ?? "#111827"};line-height:1.3;">${esc(d.text ?? "Headline")}</p></td></tr></table>`;

    case "text": {
      const raw = String(d.content ?? "");
      const escPart = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
      const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g;
      let html = "";
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(raw)) !== null) {
        html += escPart(raw.slice(last, m.index));
        html += `<a href="${esc(m[2])}" style="color:#4f46e5;text-decoration:underline;font-weight:600;">${esc(m[1])}</a>`;
        last = m.index + m[0].length;
      }
      html += escPart(raw.slice(last));
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${d.alignment ?? "left"}" style="padding:8px 24px;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:${d.fontSize ?? 15}px;color:${d.color ?? "#374151"};line-height:${d.lineHeight ?? "1.7"};">${html}</p></td></tr></table>`;
    }

    case "image": {
      if (!d.src) return `<!-- image block: no src set -->`;
      const pct = Number(d.widthPct ?? 100);
      const marginStyle = d.alignment === "center" ? "margin:0 auto;" : d.alignment === "right" ? "margin:0 0 0 auto;" : "";
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${d.alignment ?? "center"}" style="padding:16px 24px;">${d.link ? `<a href="${esc(d.link)}" style="text-decoration:none;">` : ""}<img src="${esc(toAbsUrl(d.src))}" alt="${esc(d.alt)}" style="width:${pct}%;max-width:100%;height:auto;display:block;${marginStyle}border-radius:${d.borderRadius ?? 0}px;" />${d.link ? "</a>" : ""}</td></tr></table>`;
    }

    case "video": {
      const thumb = d.thumbnailSrc
        ? `<img src="${esc(d.thumbnailSrc)}" alt="Video" style="max-width:500px;width:100%;border-radius:8px;display:block;margin:0 auto 12px;" />`
        : "";
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:16px 24px;"><a href="${esc(d.videoUrl ?? "#")}" style="text-decoration:none;display:block;">${thumb}<span style="display:inline-block;padding:12px 28px;background:${d.bgColor ?? "#1f2937"};color:${d.textColor ?? "#fff"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:600;border-radius:6px;">${esc(d.label ?? "▶ Watch Video")}</span></a></td></tr></table>`;
    }

    case "button":
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${d.alignment ?? "center"}" style="padding:16px 24px;"><a href="${esc(d.url ?? "#")}" style="display:inline-block;padding:${d.paddingV ?? 12}px ${d.paddingH ?? 28}px;background:${d.bgColor ?? "#4f46e5"};color:${d.textColor ?? "#fff"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:${d.borderRadius ?? 6}px;">${esc(d.label ?? "Click Here")}</a></td></tr></table>`;

    case "button_pair": {
      const br = d.borderRadius ?? 6;
      const pv = d.paddingV ?? 12; const ph = d.paddingH ?? 28;
      const gap = d.gap ?? 12;
      const btnStyle = (bg: string, fg: string, border?: string) =>
        `display:inline-block;padding:${pv}px ${ph}px;background:${bg};color:${fg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:${br}px;${border ? `border:2px solid ${border};` : ""}`;
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${d.alignment ?? "center"}" style="padding:16px 24px;"><table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;"><tr><td style="padding-right:${gap}px;"><a href="${esc(String(d.btn1Url ?? "#"))}" style="${btnStyle(String(d.btn1BgColor ?? "#4f46e5"), String(d.btn1TextColor ?? "#fff"))}">${esc(String(d.btn1Label ?? "Get Started →"))}</a></td><td><a href="${esc(String(d.btn2Url ?? "#"))}" style="${btnStyle(String(d.btn2BgColor ?? "#ffffff"), String(d.btn2TextColor ?? "#4f46e5"), String(d.btn2Border ?? "#4f46e5"))}">${esc(String(d.btn2Label ?? "Learn More"))}</a></td></tr></table></td></tr></table>`;
    }

    case "divider":
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:${d.marginTop ?? 16}px 24px ${d.marginBottom ?? 16}px;"><hr style="border:none;border-top:${d.height ?? 1}px solid ${d.color ?? "#e5e7eb"};margin:0;" /></td></tr></table>`;

    case "spacer":
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:${d.height ?? 32}px;font-size:1px;line-height:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr></table>`;

    case "banner": {
      const bannerInner = d.imageUrl
        ? `<img src="${esc(toAbsUrl(d.imageUrl))}" alt="${esc(String(d.text ?? "Banner"))}" style="max-width:100%;width:600px;height:auto;display:block;" />`
        : `<p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:600;color:${d.textColor ?? "#92400e"};">${esc(String(d.text ?? ""))}</p>`;
      const bannerCell = `<td align="${d.alignment ?? "center"}" style="padding:${d.imageUrl ? 0 : d.padding ?? 16}px ${d.imageUrl ? 0 : 24}px;background:${d.bgColor ?? "#fffbeb"};">${bannerInner}</td>`;
      const bannerRow = `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${bannerCell}</tr></table>`;
      return d.link ? `<a href="${esc(String(d.link))}" style="text-decoration:none;display:block;">${bannerRow}</a>` : bannerRow;
    }

    case "footer":
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px;border-top:1px solid #e5e7eb;"><p style="margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:${d.textColor ?? "#9ca3af"};">${esc(d.address ?? "")}</p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:${d.textColor ?? "#9ca3af"};"><a href="{{unsubscribeUrl}}" style="color:${d.textColor ?? "#9ca3af"};text-decoration:underline;">${esc(d.unsubscribeText ?? "Unsubscribe")}</a></p></td></tr></table>`;

    default: return "";
  }
}

export function blocksToHtml(blocks: EmailBlock[]): string {
  if (!blocks.length) return "";
  const inner = blocks.map(blockToHtml).filter(Boolean).join("\n");
  return `<div style="background:#f3f4f6;padding:20px 0;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:0 16px;"><table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;"><tr><td>${inner}</td></tr></table></td></tr></table></div>`;
}

// ── Layout starters ────────────────────────────────────────────────────────────

export function createLayoutBlocks(layout: string): EmailBlock[] {
  const mk = (type: BlockType, overrides?: Record<string, unknown>): EmailBlock => ({
    id: genId(), type,
    data: { ...BLOCK_DEFAULTS[type], ...overrides },
  });
  switch (layout) {
    case "cold-outreach":
      return [
        mk("header"),
        mk("headline", { text: "Quick question about {{companyName}}" }),
        mk("text", { content: "Hi {{firstName}},\n\nI noticed that {{companyName}} is growing fast and wanted to reach out.\n\nWould love to show you how we can help — would a quick 15-min call work?\n\nBest,\n{{senderName}}" }),
        mk("button", { label: "Book a 15-min call →" }),
        mk("spacer", { height: 16 }),
        mk("footer"),
      ];
    case "newsletter":
      return [
        mk("header"),
        mk("headline", { text: "Your Monthly Update, {{firstName}}" }),
        mk("image"),
        mk("text", { content: "Here's what's new this month at {{companyName}}...\n\nWe've been hard at work building things you'll love.\n\nBest,\n{{senderName}}" }),
        mk("divider"),
        mk("button", { label: "Read More →" }),
        mk("footer"),
      ];
    case "promotional":
      return [
        mk("header"),
        mk("banner", { text: "🎉 Limited time offer for {{companyName}}!" }),
        mk("headline", { text: "Don't miss out, {{firstName}}" }),
        mk("text", { content: "We have something special lined up just for you.\n\nThis offer expires soon — act now to secure your spot.\n\nBest,\n{{senderName}}" }),
        mk("button", { label: "Claim your offer →" }),
        mk("footer"),
      ];
    default:
      return [];
  }
}

// ── Block icon + label map ─────────────────────────────────────────────────────

const BLOCK_META: Record<BlockType, { icon: React.ComponentType<any>; label: string; desc: string }> = {
  header:   { icon: Mail,      label: "Header",      desc: "Logo / company name" },
  headline: { icon: Type,      label: "Headline",    desc: "H1/H2 bold text" },
  text:     { icon: AlignLeft, label: "Text",        desc: "Paragraph with merge tags" },
  image:    { icon: Image,     label: "Image",       desc: "Photo or graphic" },
  video:    { icon: Video,     label: "Video",       desc: "Play button with thumbnail" },
  button:      { icon: Square,   label: "Button",       desc: "Single call to action" },
  button_pair: { icon: Columns2, label: "Two Buttons",  desc: "Two CTAs side by side" },
  banner:      { icon: Megaphone, label: "Banner",      desc: "Announcement strip" },
  footer:   { icon: Mail,      label: "Footer",      desc: "Address + unsubscribe" },
  divider:  { icon: Minus,     label: "Divider",     desc: "Horizontal rule" },
  spacer:   { icon: Minus,     label: "Spacer",      desc: "Empty vertical space" },
};

const PALETTE_GROUPS: { label: string; types: BlockType[] }[] = [
  { label: "Content",  types: ["header", "headline", "text", "image", "video", "button", "button_pair", "banner", "footer"] },
  { label: "Layout",   types: ["divider", "spacer"] },
];

// ── Merge tags for text fields ─────────────────────────────────────────────────

const MERGE_TAGS = [
  { label: "First Name",   tag: "{{firstName}}" },
  { label: "Last Name",    tag: "{{lastName}}" },
  { label: "Company Name", tag: "{{companyName}}" },
  { label: "Journey URL",  tag: "{{journeyUrl}}" },
  { label: "Play Name",    tag: "{{playName}}" },
  { label: "Sender Name",  tag: "{{senderName}}" },
  { label: "Unsubscribe",  tag: "{{unsubscribeUrl}}" },
];

// ── Reusable field sub-components ─────────────────────────────────────────────

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color" value={value}
          onChange={e => onChange(e.target.value)}
          className="h-7 w-7 rounded border border-input cursor-pointer p-0.5 shrink-0"
        />
        <Input value={value} onChange={e => onChange(e.target.value)} className="flex-1 h-7 text-xs font-mono" />
      </div>
    </div>
  );
}

function AlignField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">Alignment</Label>
      <div className="flex gap-1">
        {["left", "center", "right"].map(a => (
          <button
            key={a}
            onClick={() => onChange(a)}
            className={cn(
              "flex-1 py-1 text-xs rounded border capitalize transition-colors",
              value === a ? "bg-indigo-600 text-white border-indigo-600" : "border-input text-muted-foreground hover:bg-muted",
            )}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeField({ label, value, min, max, step = 1, unit = "px", onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <span className="text-xs font-mono text-muted-foreground">{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-indigo-600 h-1.5"
      />
    </div>
  );
}

function TagTextField({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  const insertTag = (tag: string) => {
    const el = (multiline ? taRef.current : inRef.current) as HTMLTextAreaElement | HTMLInputElement | null;
    if (!el) { onChange(value + tag); return; }
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    const next = value.substring(0, s) + tag + value.substring(e);
    onChange(next);
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = s + tag.length; }, 0);
  };

  const insertLink = () => {
    const text = linkText.trim() || linkUrl.trim();
    const url = linkUrl.trim();
    if (!text || !url) return;
    insertTag(`[${text}](${url})`);
    setLinkFormOpen(false);
    setLinkText("");
    setLinkUrl("");
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-1">
          {multiline && (
            <button
              type="button"
              onClick={() => setLinkFormOpen(v => !v)}
              className={cn(
                "flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors",
                linkFormOpen
                  ? "bg-indigo-100 text-indigo-700"
                  : "text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
              )}
            >
              <Link className="w-2.5 h-2.5" /> Insert link
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="text-[10px] font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-1.5 py-0.5 rounded">
                Insert tag
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs w-48">
              {MERGE_TAGS.map(t => (
                <DropdownMenuItem key={t.tag} onClick={() => insertTag(t.tag)}>
                  <span className="font-mono text-[10px] text-muted-foreground mr-2">{t.tag}</span>
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {multiline && linkFormOpen && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-2 space-y-1.5">
          <Input
            placeholder="Link text (e.g. Click here)"
            value={linkText}
            onChange={e => setLinkText(e.target.value)}
            className="h-7 text-xs"
            autoFocus
          />
          <Input
            placeholder="URL (e.g. https://example.com)"
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            className="h-7 text-xs"
            onKeyDown={e => { if (e.key === "Enter") insertLink(); if (e.key === "Escape") setLinkFormOpen(false); }}
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-6 text-xs px-2.5 bg-indigo-600 hover:bg-indigo-700"
              disabled={!linkText.trim() || !linkUrl.trim()}
              onClick={insertLink}
            >
              Insert
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-xs px-2"
              onClick={() => setLinkFormOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {multiline
        ? <Textarea ref={taRef} value={value} onChange={e => onChange(e.target.value)} className="text-sm min-h-[80px] resize-y" />
        : <Input ref={inRef} value={value} onChange={e => onChange(e.target.value)} className="h-8 text-sm" />
      }
    </div>
  );
}

// ── Block preview (canvas rendering) ─────────────────────────────────────────

function BlockPreview({ block }: { block: EmailBlock }) {
  const d = block.data as Record<string, any>;
  switch (block.type) {
    case "header": {
      const previewBg = d.showBg !== false ? (String(d.bgColor ?? "#4f46e5")) : "transparent";
      return (
        <div style={{ background: previewBg, padding: "14px 16px", textAlign: d.alignment ?? "center" }}>
          {d.logoImageUrl
            ? <img src={String(d.logoImageUrl)} alt={String(d.logoText || "Logo")} style={{ maxHeight: "40px", maxWidth: "180px", height: "auto", display: "inline-block" }} />
            : <span style={{ color: d.textColor ?? "#fff", fontWeight: 700, fontSize: Math.min(Number(d.fontSize ?? 22), 20) + "px" }}>
                {String(d.logoText || "Your Company")}
              </span>
          }
        </div>
      );
    }
    case "headline":
      return (
        <div style={{ padding: "10px 16px", textAlign: d.alignment ?? "left" }}>
          <p style={{ margin: 0, fontSize: Math.min(Number(d.fontSize ?? 26), 22) + "px", fontWeight: d.fontWeight ?? "bold", color: d.color ?? "#111827", lineHeight: 1.3, overflow: "hidden", maxHeight: "60px" }}>
            {String(d.text || "Headline")}
          </p>
        </div>
      );
    case "text": {
      const previewText = String(d.content ?? "").replace(/\{\{[\w]+\}\}/g, "…");
      const linkRePrev = /\[([^\]]*)\]\(([^)]*)\)/g;
      const previewParts: React.ReactNode[] = [];
      let prevLast = 0; let pm: RegExpExecArray | null; let pi = 0;
      while ((pm = linkRePrev.exec(previewText)) !== null) {
        if (pm.index > prevLast) previewParts.push(previewText.slice(prevLast, pm.index));
        previewParts.push(<span key={pi++} style={{ color: "#4f46e5", textDecoration: "underline", fontWeight: 600 }}>{pm[1]}</span>);
        prevLast = pm.index + pm[0].length;
      }
      if (prevLast < previewText.length) previewParts.push(previewText.slice(prevLast));
      return (
        <div style={{ padding: "8px 16px", color: d.color ?? "#374151", fontSize: "13px", lineHeight: 1.5 }}>
          <p style={{ margin: 0, whiteSpace: "pre-line", overflow: "hidden", maxHeight: "56px" }}>
            {previewParts.length ? previewParts : previewText}
          </p>
        </div>
      );
    }
    case "image":
      return (
        <div style={{ padding: "10px 16px", textAlign: d.alignment ?? "center" }}>
          {d.src
            ? <img src={String(d.src)} alt={String(d.alt ?? "")} style={{ maxWidth: "100%", maxHeight: "80px", objectFit: "cover", borderRadius: (d.borderRadius ?? 0) + "px", display: "block", margin: d.alignment === "center" ? "0 auto" : undefined }} />
            : <div style={{ width: "100%", height: "56px", background: "#f3f4f6", border: "2px dashed #e5e7eb", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: "12px" }}>No image URL set</div>
          }
        </div>
      );
    case "video":
      return (
        <div style={{ padding: "10px 16px", textAlign: "center" }}>
          <span style={{ display: "inline-block", background: d.bgColor ?? "#1f2937", color: d.textColor ?? "#fff", padding: "8px 18px", borderRadius: "6px", fontSize: "13px", fontWeight: 600 }}>
            {String(d.label ?? "▶ Watch Video")}
          </span>
        </div>
      );
    case "button":
      return (
        <div style={{ padding: "10px 16px", textAlign: d.alignment ?? "center" }}>
          <span style={{ display: "inline-block", background: d.bgColor ?? "#4f46e5", color: d.textColor ?? "#fff", padding: `${Math.min(Number(d.paddingV ?? 12), 10)}px ${Math.min(Number(d.paddingH ?? 28), 22)}px`, borderRadius: (d.borderRadius ?? 6) + "px", fontSize: "13px", fontWeight: 600 }}>
            {String(d.label ?? "Click Here")}
          </span>
        </div>
      );
    case "button_pair":
      return (
        <div style={{ padding: "10px 16px", textAlign: (d.alignment as React.CSSProperties["textAlign"]) ?? "center", display: "flex", justifyContent: d.alignment === "left" ? "flex-start" : d.alignment === "right" ? "flex-end" : "center", gap: `${d.gap ?? 12}px`, flexWrap: "wrap" }}>
          <span style={{ display: "inline-block", background: String(d.btn1BgColor ?? "#4f46e5"), color: String(d.btn1TextColor ?? "#fff"), padding: `${Math.min(Number(d.paddingV ?? 12), 10)}px ${Math.min(Number(d.paddingH ?? 28), 22)}px`, borderRadius: (d.borderRadius ?? 6) + "px", fontSize: "13px", fontWeight: 600 }}>
            {String(d.btn1Label ?? "Get Started →")}
          </span>
          <span style={{ display: "inline-block", background: String(d.btn2BgColor ?? "#ffffff"), color: String(d.btn2TextColor ?? "#4f46e5"), padding: `${Math.min(Number(d.paddingV ?? 12), 10)}px ${Math.min(Number(d.paddingH ?? 28), 22)}px`, borderRadius: (d.borderRadius ?? 6) + "px", fontSize: "13px", fontWeight: 600, border: `2px solid ${String(d.btn2Border ?? "#4f46e5")}` }}>
            {String(d.btn2Label ?? "Learn More")}
          </span>
        </div>
      );
    case "divider":
      return (
        <div style={{ padding: `${Math.min(Number(d.marginTop ?? 16), 12)}px 16px ${Math.min(Number(d.marginBottom ?? 16), 12)}px` }}>
          <hr style={{ border: "none", borderTop: `${d.height ?? 1}px solid ${d.color ?? "#e5e7eb"}`, margin: 0 }} />
        </div>
      );
    case "spacer":
      return (
        <div style={{ height: Math.min(Number(d.height ?? 32), 40) + "px", background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: "11px", color: "#9ca3af" }}>{d.height ?? 32}px spacer</span>
        </div>
      );
    case "banner":
      return (
        <div style={{ background: d.bgColor ?? "#fffbeb", textAlign: d.alignment ?? "center", overflow: "hidden" }}>
          {d.imageUrl
            ? <img src={String(d.imageUrl)} alt={String(d.text ?? "Banner")} style={{ maxWidth: "100%", maxHeight: "80px", objectFit: "cover", display: "block", width: "100%" }} />
            : <p style={{ margin: 0, padding: `${Math.min(Number(d.padding ?? 16), 14)}px 16px`, color: d.textColor ?? "#92400e", fontSize: "13px", fontWeight: 600, overflow: "hidden", maxHeight: "40px" }}>
                {String(d.text ?? "Banner text").replace(/\{\{[\w]+\}\}/g, "…")}
              </p>
          }
        </div>
      );
    case "footer":
      return (
        <div style={{ padding: "10px 16px", borderTop: "1px solid #e5e7eb", textAlign: "center" }}>
          <p style={{ margin: 0, color: d.textColor ?? "#9ca3af", fontSize: "11px", overflow: "hidden" }}>
            {String(d.address ?? "Company address")} · <span style={{ textDecoration: "underline" }}>{String(d.unsubscribeText ?? "Unsubscribe")}</span>
          </p>
        </div>
      );
    default: return null;
  }
}

// ── Block config panel ────────────────────────────────────────────────────────

function BlockConfigPanel({ block, onUpdate }: {
  block: EmailBlock;
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const d = block.data as Record<string, any>;
  const set = (key: string, val: unknown) => onUpdate({ ...d, [key]: val });
  const [logoPickerOpen, setLogoPickerOpen] = useState(false);
  const [bannerPickerOpen, setBannerPickerOpen] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [thumbnailPickerOpen, setThumbnailPickerOpen] = useState(false);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b bg-muted/30 shrink-0">
        <p className="text-sm font-semibold capitalize">{block.type} Block</p>
        <p className="text-xs text-muted-foreground mt-0.5">Configure this block's content and style</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {block.type === "header" && <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Logo Image</Label>
            <div className="flex gap-1.5">
              <Input value={String(d.logoImageUrl ?? "")} onChange={e => set("logoImageUrl", e.target.value)} placeholder="Paste URL or upload →" className="h-8 text-sm flex-1 min-w-0" />
              <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" title="Upload or pick from library" onClick={() => setLogoPickerOpen(true)}>
                <Upload className="w-3.5 h-3.5" />
              </Button>
            </div>
            {d.logoImageUrl && (
              <div className="mt-1 rounded border border-input overflow-hidden bg-gray-50 flex items-center justify-center p-2">
                <img src={String(d.logoImageUrl)} alt="Logo preview" className="max-h-12 max-w-full object-contain" />
              </div>
            )}
          </div>
          <Dialog open={logoPickerOpen} onOpenChange={setLogoPickerOpen}>
            <DialogContent className="max-w-md" onClick={e => e.stopPropagation()}>
              <DialogHeader>
                <DialogTitle>Choose Logo Image</DialogTitle>
              </DialogHeader>
              <AssetPicker
                accept="image/*"
                onChange={asset => {
                  if (asset) set("logoImageUrl", asset.url);
                  setLogoPickerOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
          <TagTextField label="Logo / Company Name (fallback text)" value={String(d.logoText ?? "")} onChange={v => set("logoText", v)} />
          <AlignField value={String(d.alignment ?? "center")} onChange={v => set("alignment", v)} />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Background</Label>
              <button
                type="button"
                role="switch"
                aria-checked={d.showBg !== false}
                onClick={() => set("showBg", d.showBg === false ? true : false)}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none",
                  d.showBg !== false ? "bg-indigo-600" : "bg-gray-200"
                )}
              >
                <span className={cn(
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                  d.showBg !== false ? "translate-x-4" : "translate-x-0"
                )} />
              </button>
            </div>
            {d.showBg !== false && (
              <div className="grid grid-cols-2 gap-3">
                <ColorField label="Bg Color" value={String(d.bgColor ?? "#4f46e5")} onChange={v => set("bgColor", v)} />
                <ColorField label="Text Color" value={String(d.textColor ?? "#ffffff")} onChange={v => set("textColor", v)} />
              </div>
            )}
          </div>
          <RangeField label="Font Size" value={Number(d.fontSize ?? 22)} min={14} max={40} onChange={v => set("fontSize", v)} />
          <RangeField label="Padding" value={Number(d.padding ?? 24)} min={8} max={64} onChange={v => set("padding", v)} />
        </>}

        {block.type === "headline" && <>
          <TagTextField label="Headline Text" value={String(d.text ?? "")} onChange={v => set("text", v)} />
          <AlignField value={String(d.alignment ?? "left")} onChange={v => set("alignment", v)} />
          <ColorField label="Text Color" value={String(d.color ?? "#111827")} onChange={v => set("color", v)} />
          <RangeField label="Font Size" value={Number(d.fontSize ?? 26)} min={16} max={48} onChange={v => set("fontSize", v)} />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Font Weight</Label>
            <Select value={String(d.fontWeight ?? "bold")} onValueChange={v => set("fontWeight", v)}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="600">Semi-bold</SelectItem>
                <SelectItem value="bold">Bold</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>}

        {block.type === "text" && <>
          <TagTextField label="Content" value={String(d.content ?? "")} onChange={v => set("content", v)} multiline />
          <AlignField value={String(d.alignment ?? "left")} onChange={v => set("alignment", v)} />
          <ColorField label="Text Color" value={String(d.color ?? "#374151")} onChange={v => set("color", v)} />
          <RangeField label="Font Size" value={Number(d.fontSize ?? 15)} min={12} max={24} onChange={v => set("fontSize", v)} />
        </>}

        {block.type === "image" && <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Image URL</Label>
            <div className="flex gap-1.5">
              <Input value={String(d.src ?? "")} onChange={e => set("src", e.target.value)} placeholder="Paste URL or upload →" className="h-8 text-sm flex-1 min-w-0" />
              <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" title="Upload or pick from library" onClick={() => setImagePickerOpen(true)}>
                <Upload className="w-3.5 h-3.5" />
              </Button>
            </div>
            {d.src && (
              <div className="mt-1 rounded-md overflow-hidden border border-input bg-muted/30">
                <img
                  src={String(d.src)}
                  alt=""
                  style={{ width: `${Number(d.widthPct ?? 100)}%`, display: "block", ...(String(d.alignment ?? "center") === "center" ? { margin: "0 auto" } : String(d.alignment ?? "center") === "right" ? { marginLeft: "auto" } : {}) }}
                  className="max-h-40 object-contain"
                />
              </div>
            )}
          </div>
          <Dialog open={imagePickerOpen} onOpenChange={setImagePickerOpen}>
            <DialogContent className="max-w-md" onClick={e => e.stopPropagation()}>
              <DialogHeader>
                <DialogTitle>Choose Image</DialogTitle>
              </DialogHeader>
              <AssetPicker
                accept="image/*"
                onChange={asset => {
                  if (asset) set("src", asset.url);
                  setImagePickerOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
          <AlignField value={String(d.alignment ?? "center")} onChange={v => set("alignment", v)} />
          <RangeField label="Scale" value={Number(d.widthPct ?? 100)} min={10} max={100} step={5} unit="%" onChange={v => set("widthPct", v)} />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Alt Text</Label>
            <Input value={String(d.alt ?? "")} onChange={e => set("alt", e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Link URL (optional)</Label>
            <Input value={String(d.link ?? "")} onChange={e => set("link", e.target.value)} placeholder="https://..." className="h-8 text-sm" />
          </div>
          <RangeField label="Border Radius" value={Number(d.borderRadius ?? 0)} min={0} max={24} unit="px" onChange={v => set("borderRadius", v)} />
        </>}

        {block.type === "video" && <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Video URL</Label>
            <Input value={String(d.videoUrl ?? "")} onChange={e => set("videoUrl", e.target.value)} placeholder="https://youtube.com/..." className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Thumbnail URL (optional)</Label>
            <div className="flex gap-1.5">
              <Input value={String(d.thumbnailSrc ?? "")} onChange={e => set("thumbnailSrc", e.target.value)} placeholder="Paste URL or upload →" className="h-8 text-sm flex-1 min-w-0" />
              <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" title="Upload or pick from library" onClick={() => setThumbnailPickerOpen(true)}>
                <Upload className="w-3.5 h-3.5" />
              </Button>
            </div>
            {d.thumbnailSrc && (
              <div className="mt-1 rounded border border-input overflow-hidden">
                <img src={String(d.thumbnailSrc)} alt="Thumbnail preview" className="w-full max-h-24 object-cover" />
              </div>
            )}
          </div>
          <Dialog open={thumbnailPickerOpen} onOpenChange={setThumbnailPickerOpen}>
            <DialogContent className="max-w-md" onClick={e => e.stopPropagation()}>
              <DialogHeader>
                <DialogTitle>Choose Thumbnail Image</DialogTitle>
              </DialogHeader>
              <AssetPicker
                accept="image/*"
                onChange={asset => {
                  if (asset) set("thumbnailSrc", asset.url);
                  setThumbnailPickerOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Button Label</Label>
            <Input value={String(d.label ?? "▶ Watch Video")} onChange={e => set("label", e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ColorField label="Button BG" value={String(d.bgColor ?? "#1f2937")} onChange={v => set("bgColor", v)} />
            <ColorField label="Button Text" value={String(d.textColor ?? "#ffffff")} onChange={v => set("textColor", v)} />
          </div>
        </>}

        {block.type === "button" && <>
          <TagTextField label="Button Label" value={String(d.label ?? "")} onChange={v => set("label", v)} />
          <TagTextField label="URL" value={String(d.url ?? "")} onChange={v => set("url", v)} />
          <AlignField value={String(d.alignment ?? "center")} onChange={v => set("alignment", v)} />
          <div className="grid grid-cols-2 gap-3">
            <ColorField label="Background" value={String(d.bgColor ?? "#4f46e5")} onChange={v => set("bgColor", v)} />
            <ColorField label="Text Color" value={String(d.textColor ?? "#ffffff")} onChange={v => set("textColor", v)} />
          </div>
          <RangeField label="Border Radius" value={Number(d.borderRadius ?? 6)} min={0} max={32} onChange={v => set("borderRadius", v)} />
          <div className="grid grid-cols-2 gap-3">
            <RangeField label="Padding V" value={Number(d.paddingV ?? 12)} min={4} max={32} onChange={v => set("paddingV", v)} />
            <RangeField label="Padding H" value={Number(d.paddingH ?? 28)} min={8} max={64} onChange={v => set("paddingH", v)} />
          </div>
        </>}

        {block.type === "button_pair" && <>
          {/* Button 1 */}
          <div className="space-y-2 pb-2 border-b border-dashed border-border">
            <p className="text-xs font-semibold text-foreground">Button 1 (primary)</p>
            <TagTextField label="Label" value={String(d.btn1Label ?? "")} onChange={v => set("btn1Label", v)} />
            <TagTextField label="URL" value={String(d.btn1Url ?? "")} onChange={v => set("btn1Url", v)} />
            <div className="grid grid-cols-2 gap-3">
              <ColorField label="Background" value={String(d.btn1BgColor ?? "#4f46e5")} onChange={v => set("btn1BgColor", v)} />
              <ColorField label="Text Color" value={String(d.btn1TextColor ?? "#ffffff")} onChange={v => set("btn1TextColor", v)} />
            </div>
          </div>
          {/* Button 2 */}
          <div className="space-y-2 pb-2 border-b border-dashed border-border">
            <p className="text-xs font-semibold text-foreground">Button 2 (secondary)</p>
            <TagTextField label="Label" value={String(d.btn2Label ?? "")} onChange={v => set("btn2Label", v)} />
            <TagTextField label="URL" value={String(d.btn2Url ?? "")} onChange={v => set("btn2Url", v)} />
            <div className="grid grid-cols-2 gap-3">
              <ColorField label="Background" value={String(d.btn2BgColor ?? "#ffffff")} onChange={v => set("btn2BgColor", v)} />
              <ColorField label="Text Color" value={String(d.btn2TextColor ?? "#4f46e5")} onChange={v => set("btn2TextColor", v)} />
            </div>
            <ColorField label="Border Color" value={String(d.btn2Border ?? "#4f46e5")} onChange={v => set("btn2Border", v)} />
          </div>
          {/* Shared */}
          <AlignField value={String(d.alignment ?? "center")} onChange={v => set("alignment", v)} />
          <RangeField label="Border Radius" value={Number(d.borderRadius ?? 6)} min={0} max={32} onChange={v => set("borderRadius", v)} />
          <RangeField label="Gap between buttons" value={Number(d.gap ?? 12)} min={4} max={48} unit="px" onChange={v => set("gap", v)} />
          <div className="grid grid-cols-2 gap-3">
            <RangeField label="Padding V" value={Number(d.paddingV ?? 12)} min={4} max={32} onChange={v => set("paddingV", v)} />
            <RangeField label="Padding H" value={Number(d.paddingH ?? 28)} min={8} max={64} onChange={v => set("paddingH", v)} />
          </div>
        </>}

        {block.type === "divider" && <>
          <ColorField label="Color" value={String(d.color ?? "#e5e7eb")} onChange={v => set("color", v)} />
          <RangeField label="Thickness" value={Number(d.height ?? 1)} min={1} max={8} onChange={v => set("height", v)} />
          <div className="grid grid-cols-2 gap-3">
            <RangeField label="Top Margin" value={Number(d.marginTop ?? 16)} min={0} max={64} onChange={v => set("marginTop", v)} />
            <RangeField label="Bottom Margin" value={Number(d.marginBottom ?? 16)} min={0} max={64} onChange={v => set("marginBottom", v)} />
          </div>
        </>}

        {block.type === "spacer" && (
          <RangeField label="Height" value={Number(d.height ?? 32)} min={4} max={120} onChange={v => set("height", v)} />
        )}

        {block.type === "banner" && <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Banner Image <span className="text-gray-400">(optional — replaces text)</span></Label>
            <div className="flex gap-1.5">
              <Input value={String(d.imageUrl ?? "")} onChange={e => set("imageUrl", e.target.value)} placeholder="Paste URL or upload →" className="h-8 text-sm flex-1 min-w-0" />
              <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" title="Upload or pick from library" onClick={() => setBannerPickerOpen(true)}>
                <Upload className="w-3.5 h-3.5" />
              </Button>
            </div>
            {d.imageUrl && (
              <div className="mt-1 rounded border border-input overflow-hidden">
                <img src={String(d.imageUrl)} alt="Banner preview" className="w-full max-h-24 object-cover" />
              </div>
            )}
          </div>
          <Dialog open={bannerPickerOpen} onOpenChange={setBannerPickerOpen}>
            <DialogContent className="max-w-md" onClick={e => e.stopPropagation()}>
              <DialogHeader>
                <DialogTitle>Choose Banner Image</DialogTitle>
              </DialogHeader>
              <AssetPicker
                accept="image/*"
                onChange={asset => {
                  if (asset) set("imageUrl", asset.url);
                  setBannerPickerOpen(false);
                }}
              />
            </DialogContent>
          </Dialog>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Click URL <span className="text-gray-400">(optional)</span></Label>
            <Input value={String(d.link ?? "")} onChange={e => set("link", e.target.value)} placeholder="https://..." className="h-8 text-sm" />
          </div>
          <TagTextField label="Banner Text (shown when no image)" value={String(d.text ?? "")} onChange={v => set("text", v)} multiline />
          <AlignField value={String(d.alignment ?? "center")} onChange={v => set("alignment", v)} />
          <div className="grid grid-cols-2 gap-3">
            <ColorField label="Background" value={String(d.bgColor ?? "#fffbeb")} onChange={v => set("bgColor", v)} />
            <ColorField label="Text Color" value={String(d.textColor ?? "#92400e")} onChange={v => set("textColor", v)} />
          </div>
          <RangeField label="Padding" value={Number(d.padding ?? 16)} min={8} max={48} onChange={v => set("padding", v)} />
        </>}

        {block.type === "footer" && <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Company Address</Label>
            <Textarea value={String(d.address ?? "")} onChange={e => set("address", e.target.value)} className="text-sm min-h-[56px] resize-y" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Unsubscribe Link Text</Label>
            <Input value={String(d.unsubscribeText ?? "Unsubscribe")} onChange={e => set("unsubscribeText", e.target.value)} className="h-8 text-sm" />
          </div>
          <ColorField label="Text Color" value={String(d.textColor ?? "#9ca3af")} onChange={v => set("textColor", v)} />
        </>}

      </div>
    </div>
  );
}

// ── Sortable block item ────────────────────────────────────────────────────────

function SortableBlock({
  block, isSelected, onSelect, onDelete, onDuplicate, onMoveUp, onMoveDown, canMoveUp, canMoveDown,
}: {
  block: EmailBlock; isSelected: boolean;
  onSelect: () => void; onDelete: () => void; onDuplicate: () => void;
  onMoveUp: () => void; onMoveDown: () => void; canMoveUp: boolean; canMoveDown: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const { icon: Icon, label } = BLOCK_META[block.type];

  return (
    <div
      ref={setNodeRef} style={style}
      data-block="true"
      className={cn(
        "group relative border rounded-lg bg-white mb-2 cursor-pointer overflow-hidden transition-all",
        isSelected ? "border-indigo-400 ring-2 ring-indigo-100 shadow-sm" : "border-gray-200 hover:border-gray-300",
        isDragging ? "shadow-lg z-50" : "",
      )}
      onClick={e => { e.stopPropagation(); onSelect(); }}
    >
      <div className="flex items-center px-2 py-1.5 bg-gray-50 border-b border-gray-100 gap-1">
        <button
          {...attributes} {...listeners}
          className="p-1 text-gray-400 hover:text-gray-600 cursor-grab active:cursor-grabbing shrink-0"
          onClick={e => e.stopPropagation()}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500 flex-1 min-w-0">
          <Icon className="w-3 h-3 shrink-0" />
          {label}
        </span>
        <div className="flex items-center gap-0.5">
          <button onClick={e => { e.stopPropagation(); onMoveUp(); }} disabled={!canMoveUp}
            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed" title="Move up">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={e => { e.stopPropagation(); onMoveDown(); }} disabled={!canMoveDown}
            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed" title="Move down">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button onClick={e => { e.stopPropagation(); onDuplicate(); }}
            className="p-1 text-gray-400 hover:text-gray-700" title="Duplicate">
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-red-400 hover:text-red-600" title="Delete block">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <BlockPreview block={block} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface EmailBlockEditorProps {
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
}

export default function EmailBlockEditor({ blocks, onChange }: EmailBlockEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedBlock = blocks.find(b => b.id === selectedId) ?? null;

  function addBlock(type: BlockType) {
    const b: EmailBlock = { id: genId(), type, data: { ...BLOCK_DEFAULTS[type] } };
    onChange([...blocks, b]);
    setSelectedId(b.id);
  }

  function updateBlock(id: string, data: Record<string, unknown>) {
    onChange(blocks.map(b => b.id === id ? { ...b, data } : b));
  }

  function deleteBlock(id: string) {
    onChange(blocks.filter(b => b.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function duplicateBlock(id: string) {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx < 0) return;
    const copy: EmailBlock = { ...blocks[idx], id: genId(), data: { ...blocks[idx].data } };
    const next = [...blocks];
    next.splice(idx + 1, 0, copy);
    onChange(next);
    setSelectedId(copy.id);
  }

  function moveBlock(id: string, dir: "up" | "down") {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx < 0) return;
    if (dir === "up" && idx === 0) return;
    if (dir === "down" && idx === blocks.length - 1) return;
    const next = [...blocks];
    const swap = dir === "up" ? idx - 1 : idx + 1;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onChange(next);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const o = blocks.findIndex(b => b.id === active.id);
      const n = blocks.findIndex(b => b.id === over.id);
      onChange(arrayMove(blocks, o, n));
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: palette */}
      <div className="w-48 border-r bg-gray-50 flex flex-col overflow-hidden shrink-0">
        <div className="px-3 py-2.5 border-b shrink-0">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Blocks</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {PALETTE_GROUPS.map(group => (
            <div key={group.label}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase px-1 mb-1.5 tracking-wider">{group.label}</p>
              <div className="space-y-0.5">
                {group.types.map(type => {
                  const { icon: Icon, label, desc } = BLOCK_META[type];
                  return (
                    <button
                      key={type}
                      onClick={() => addBlock(type)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white hover:shadow-sm border border-transparent hover:border-gray-200 transition-all text-left group"
                    >
                      <div className="w-6 h-6 rounded-md bg-white shadow-sm border border-gray-200 flex items-center justify-center group-hover:border-indigo-200 group-hover:bg-indigo-50 transition-colors shrink-0">
                        <Icon className="w-3 h-3 text-gray-500 group-hover:text-indigo-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-700 leading-none">{label}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5 leading-none truncate">{desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Center: sortable canvas */}
      <div
        className="flex-1 bg-gray-100 overflow-y-auto"
        onClick={e => {
          if (!(e.target as Element).closest("[data-block]")) setSelectedId(null);
        }}
      >
        <div className="max-w-2xl mx-auto py-6 px-4">
          {blocks.length === 0 ? (
            <div className="border-2 border-dashed border-indigo-200 rounded-xl p-14 text-center bg-white">
              <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center mx-auto mb-3">
                <Plus className="w-5 h-5 text-indigo-400" />
              </div>
              <p className="text-sm font-semibold text-gray-700">Start building your email</p>
              <p className="text-xs text-gray-400 mt-1.5 leading-relaxed max-w-xs mx-auto">
                Click any block type in the left panel — Header, Text, Button etc. — to add it here.
              </p>
              <p className="text-xs text-indigo-500 mt-3 font-medium">← Choose a block from the left panel to begin</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
                {blocks.map((block, idx) => (
                  <SortableBlock
                    key={block.id}
                    block={block}
                    isSelected={selectedId === block.id}
                    onSelect={() => setSelectedId(block.id)}
                    onDelete={() => deleteBlock(block.id)}
                    onDuplicate={() => duplicateBlock(block.id)}
                    onMoveUp={() => moveBlock(block.id, "up")}
                    onMoveDown={() => moveBlock(block.id, "down")}
                    canMoveUp={idx > 0}
                    canMoveDown={idx < blocks.length - 1}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
          {blocks.length > 0 && (
            <p className="text-center text-xs text-gray-400 mt-2">← Click blocks in the left panel to add more</p>
          )}
        </div>
      </div>

      {/* Right: config panel */}
      <div className="w-72 border-l bg-card flex flex-col overflow-hidden shrink-0">
        {selectedBlock ? (
          <BlockConfigPanel
            key={selectedBlock.id}
            block={selectedBlock}
            onUpdate={data => updateBlock(selectedBlock.id, data)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mx-auto mb-2">
                <AlignLeft className="w-5 h-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No block selected</p>
              <p className="text-xs text-muted-foreground mt-1">Click a block on the canvas<br />to edit its properties</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
