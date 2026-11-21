import { useState, useEffect, useRef, useCallback, Fragment, type ReactElement } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { TopBanner, BottomBanner, PopupBanner, type ZoneBannerItem } from "@/components/banners/ZoneBanner";
import {
  Loader2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, CheckCircle2, Zap,
  Youtube, FileText, Globe, Code2, Image, X, ExternalLink,
  Download, ShieldCheck, Lock, Maximize2,
  Landmark, Compass, Cpu, Lightbulb, Layers, Target, Sparkles,
  BarChart3, BookOpen, Briefcase, Rocket, Map, LayoutTemplate,
} from "lucide-react";

const RAIL_ICONS = [
  Landmark, Compass, Lightbulb, Cpu, Target, Layers,
  Sparkles, BarChart3, Briefcase, BookOpen, Rocket, Map,
];
import { useToast } from "@/hooks/use-toast";

// ── Page slug helpers (exported so builder can generate matching preview URLs) ─
export function slugify(str: string): string {
  return (str ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
export function toPageSlug(title: string, sortOrder: number): string {
  return slugify(title) || `page-${sortOrder + 1}`;
}
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { setPublicJourneySeo } from "@/lib/seo";

// ── Types ────────────────────────────────────────────────────────────────────
type PageType = "youtube" | "pdf" | "iframe" | "html" | "infographic" | "blocks";

interface PageComponent {
  id: number;
  journeyPageId: number;
  componentType: "cta" | "form" | "banner";
  componentId: number;
  position: string;
  sortOrder: number;
  overrideConfig: Record<string, any>;
  ctaLabel?: string;
  ctaActionType?: string;
  ctaActionConfig?: Record<string, any>;
  ctaStyleConfig?: Record<string, any>;
  formName?: string;
  formConfig?: Record<string, any>;
  bannerName?: string;
  bannerConfig?: Record<string, any>;
  bannerDefaultPosition?: string | null;
}

/** Resolve `_default` position → banner's own stored position (fallback: `inline`). */
function resolvePosition(comp: PageComponent): string {
  if (comp.position !== "_default") return comp.position;
  return comp.bannerDefaultPosition ?? "inline";
}

interface BannerConfig {
  template: "slim-bar" | "card" | "hero";
  bgColor: string;
  textColor: string;
  heading: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaAction?: "url" | "download" | "gated_download" | "page";
  ctaPageIndex?: number;
  imageUrl?: string;
  targetTags?: string[];
  tagMatch?: "any" | "all";
  enablePersonalization?: boolean;
}


interface JourneyPage {
  id: number;
  title: string;
  pageType: PageType;
  content: string | null;
  ctaText: string | null;
  ctaEnabled: boolean;
  ctaType: string | null;
  ctaAssetUrl: string | null;
  viewCount: number;
  gatingAction?: string | null;
}

interface ZoneBanners {
  top: ZoneBannerItem[];
  bottom: ZoneBannerItem[];
  sidebar: ZoneBannerItem[];
}

interface ZoneSettings {
  rotationIntervalSeconds: number;
  mobileBehavior: "hide" | "show";
}

export type OverlayStyle = "flat" | "vignette" | "bottom_fade" | "top_fade";
export type ViewerBg = {
  type: "color" | "gradient" | "image";
  value: string;
  imageBlur?: number | null;
  overlay?: { color: string; opacity: number; style?: OverlayStyle } | null;
} | null;

// Build the CSS `background` value for the overlay layer based on style + color + opacity.
export function overlayBackground(
  color: string,
  opacity: number,
  style: OverlayStyle = "flat",
): { background?: string; backgroundColor?: string; opacity?: number } {
  const op = Math.max(0, Math.min(1, opacity));
  const rgba = (c: string, a: number) => {
    const hex = c.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };
  if (style === "vignette") {
    return {
      background: `radial-gradient(ellipse at center, ${rgba(color, 0)} 35%, ${rgba(color, op)} 100%)`,
    };
  }
  if (style === "bottom_fade") {
    return {
      background: `linear-gradient(to top, ${rgba(color, op)} 0%, ${rgba(color, op * 0.6)} 35%, ${rgba(color, 0)} 80%)`,
    };
  }
  if (style === "top_fade") {
    return {
      background: `linear-gradient(to bottom, ${rgba(color, op)} 0%, ${rgba(color, op * 0.6)} 35%, ${rgba(color, 0)} 80%)`,
    };
  }
  return { backgroundColor: color, opacity: op };
}

// Returns CSS for color/gradient backgrounds that can be applied directly to
// a container. Image backgrounds are rendered separately (see ViewerBgLayer)
// so an optional blur does not affect foreground content.
export function viewerBgToCss(bg: ViewerBg): React.CSSProperties {
  if (!bg || !bg.value) return {};
  if (bg.type === "color" || bg.type === "gradient") return { background: bg.value };
  return {};
}

// Renders an absolutely-positioned image background layer (with optional
// blur) behind the viewer content, plus an optional tint overlay above any
// background type (image, color, or gradient) but below the content
// (which lives at zIndex >= 1).
export function ViewerBgLayer({ bg }: { bg: ViewerBg }) {
  if (!bg) return null;
  const isImage = bg.type === "image" && !!bg.value;
  const blur = isImage && bg.imageBlur && bg.imageBlur > 0 ? bg.imageBlur : 0;
  const overlay = bg.overlay && bg.overlay.opacity > 0 ? bg.overlay : null;
  if (!isImage && !overlay) return null;
  return (
    <>
      {isImage && (
        <img
          aria-hidden="true"
          alt=""
          src={bg.value}
          decoding="async"
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            // Slightly scale up so blur edges don't reveal the container background.
            transform: blur > 0 ? "scale(1.05)" : undefined,
            zIndex: 0,
          }}
        />
      )}
      {overlay && (
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            ...overlayBackground(overlay.color, overlay.opacity, overlay.style ?? "flat"),
            zIndex: 0,
          }}
        />
      )}
    </>
  );
}

interface JourneyData {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  clientName: string | null;
  clientLogoUrl: string | null;
  theme: string;
  navigationMode: string;
  headerLogoUrl: string | null;
  headerLogoShowBg?: boolean | null;
  headerBtnText: string | null;
  headerBtnUrl: string | null;
  headerBtnType?: string | null;
  headerTagline: string | null;
  viewerBg?: ViewerBg;
  pages: JourneyPage[];
  zoneBanners?: ZoneBanners;
  zoneSettings?: Record<string, ZoneSettings>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getYouTubeId(url: string) {
  const match = url.match(/(?:youtu\.be\/|watch\?v=|embed\/)([^&?/]+)/);
  return match ? match[1] : url;
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const PAGE_TYPE_META: Record<PageType, { Icon: React.ComponentType<any>; darkGrad: string; lightGrad: string; color: string }> = {
  youtube:     { Icon: Youtube,   darkGrad: "from-rose-600 via-red-700 to-rose-900",       lightGrad: "from-rose-400 via-red-500 to-rose-600",       color: "text-red-400" },
  pdf:         { Icon: FileText,  darkGrad: "from-orange-500 via-amber-600 to-orange-800", lightGrad: "from-orange-400 via-amber-500 to-orange-600", color: "text-orange-400" },
  iframe:      { Icon: Globe,     darkGrad: "from-sky-500 via-blue-600 to-indigo-800",     lightGrad: "from-sky-400 via-blue-500 to-indigo-600",     color: "text-sky-400" },
  html:        { Icon: Code2,     darkGrad: "from-fuchsia-600 via-violet-700 to-purple-900",lightGrad: "from-fuchsia-500 via-violet-600 to-purple-700",color: "text-violet-400" },
  infographic: { Icon: Image,     darkGrad: "from-emerald-500 via-teal-600 to-cyan-800",   lightGrad: "from-emerald-400 via-teal-500 to-cyan-600",   color: "text-emerald-400" },
  blocks:      { Icon: LayoutTemplate, darkGrad: "from-indigo-600 via-violet-700 to-purple-900", lightGrad: "from-indigo-500 via-violet-500 to-purple-600", color: "text-indigo-400" },
};

// ── Blocks page type ──────────────────────────────────────────────────────────
type ButtonStyle = "primary" | "secondary" | "outline";
type BlockAlign = "left" | "center" | "right";
type ListStyle = "bullet" | "number";

type BlockLink =
  | { kind: "url"; url: string; newTab?: boolean }
  | { kind: "page"; pageIndex: number };

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

type HotspotItem = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  link: BlockLink;
};

interface BlocksContent {
  template?: string;
  header?: { show: boolean; title?: string; subtitle?: string };
  footer?: { show: boolean; text?: string };
  blocks: PageBlock[];
  hotspots?: HotspotItem[];
}

function applyBlockLink(
  b: { link?: BlockLink },
  inner: ReactElement,
  onGoToPage?: (idx: number) => void,
): ReactElement {
  const lnk = b.link;
  if (!lnk) return inner;
  if (lnk.kind === "url") {
    return (
      <a href={lnk.url} target={lnk.newTab ? "_blank" : "_self"} rel="noopener noreferrer"
        className="block cursor-pointer hover:opacity-80 transition-opacity">
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={() => onGoToPage?.(lnk.pageIndex)}
      className="block w-full text-left cursor-pointer hover:opacity-80 transition-opacity">
      {inner}
    </button>
  );
}

function parseBlocksContent(raw: string | null | undefined): BlocksContent {
  if (!raw) return { blocks: [] };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && Array.isArray(obj.blocks)) {
      return {
        template: obj.template,
        header: obj.header,
        footer: obj.footer,
        blocks: obj.blocks as PageBlock[],
        hotspots: Array.isArray(obj.hotspots) ? obj.hotspots : undefined,
      };
    }
  } catch { /* ignore */ }
  return { blocks: [] };
}

function parsePageContent(raw: string, pageType: string): { content: string; hotspots: HotspotItem[] } {
  if (pageType === "blocks") {
    const parsed = parseBlocksContent(raw);
    return { content: raw, hotspots: parsed.hotspots ?? [] };
  }
  if (!raw) return { content: "", hotspots: [] };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj) && ("url" in obj || "html" in obj)) {
      return {
        content: (obj.url ?? obj.html ?? raw) as string,
        hotspots: Array.isArray(obj.hotspots) ? obj.hotspots : [],
      };
    }
  } catch { /* ignore */ }
  return { content: raw, hotspots: [] };
}

// Content is authored HTML. Add inexpensive loading/accessibility defaults
// without changing explicit author-provided attributes.
function optimizeEmbeddedHtml(html: string, fallbackLabel: string): string {
  const documentFragment = new DOMParser().parseFromString(html, "text/html");
  documentFragment.querySelectorAll("iframe").forEach(frame => {
    if (!frame.hasAttribute("loading")) frame.setAttribute("loading", "lazy");
    if (!frame.hasAttribute("title")) frame.setAttribute("title", fallbackLabel);
  });
  documentFragment.querySelectorAll("img").forEach(image => {
    if (!image.hasAttribute("loading")) image.setAttribute("loading", "lazy");
    if (!image.hasAttribute("decoding")) image.setAttribute("decoding", "async");
    if (!image.hasAttribute("alt")) image.setAttribute("alt", fallbackLabel);
  });
  return documentFragment.body.innerHTML;
}

function HotspotOverlays({
  hotspots, onGoToPage,
}: { hotspots: HotspotItem[]; onGoToPage?: (i: number) => void }) {
  if (!hotspots.length) return null;
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
      {hotspots.map(h => {
        const style: React.CSSProperties = {
          position: "absolute",
          left: `${h.x}%`,
          top: `${h.y}%`,
          width: `${h.w}%`,
          height: `${h.h}%`,
          pointerEvents: "auto",
          cursor: "pointer",
        };
        if (h.link.kind === "url") {
          return (
            <a
              key={h.id}
              href={h.link.url}
              target={h.link.newTab !== false ? "_blank" : "_self"}
              rel="noopener noreferrer"
              style={style}
              aria-label={h.label}
              title={h.label}
            />
          );
        }
        return (
          <button
            key={h.id}
            type="button"
            style={style}
            aria-label={h.label}
            title={h.label}
            onClick={() => h.link.kind === "page" && onGoToPage?.(h.link.pageIndex)}
          />
        );
      })}
    </div>
  );
}

function BlocksPageRenderer({
  page, isDark, journeyId, visitorToken, onGoToPage,
}: {
  page: JourneyPage; isDark: boolean; journeyId: number; visitorToken: string;
  onGoToPage?: (pageIndex: number) => void;
}) {
  const data = parseBlocksContent(page.content);
  const formIds = data.blocks.filter((b): b is Extract<PageBlock, { type: "form" }> => b.type === "form").map(b => b.formId).filter(Boolean);

  const { data: formMap = {} } = useQuery<Record<number, { id: number; name: string; config: Record<string, any> }>>({
    queryKey: ["public-blocks-forms", formIds.sort((a, b) => a - b).join(",")],
    enabled: formIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(formIds.map(async (id) => {
        try {
          const r = await fetch(`/api/public/journey-forms/${id}`);
          if (!r.ok) return [id, null] as const;
          return [id, await r.json()] as const;
        } catch { return [id, null] as const; }
      }));
      const m: Record<number, any> = {};
      for (const [id, v] of entries) if (v) m[id] = v;
      return m;
    },
  });

  const wrapBg = isDark ? "bg-zinc-950 text-zinc-100" : "bg-white text-zinc-900";
  const headerBorder = isDark ? "border-white/10" : "border-gray-200";
  const subtle = isDark ? "text-zinc-400" : "text-gray-500";

  return (
    <div className={cn("relative w-full h-full overflow-y-auto", wrapBg)}>
      {data.header?.show && (
        <header className={cn("px-8 sm:px-12 py-6 border-b", headerBorder)}>
          {data.header.title && <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{data.header.title}</h1>}
          {data.header.subtitle && <p className={cn("mt-1 text-sm sm:text-base", subtle)}>{data.header.subtitle}</p>}
        </header>
      )}

      <main className="px-6 sm:px-12 py-8 max-w-3xl mx-auto space-y-6">
        {data.blocks.length === 0 && (
          <div className={cn("py-20 text-center text-sm", subtle)}>This page has no blocks yet.</div>
        )}
        {data.blocks.map(b => {
          const alignCls = b.type === "headline" || b.type === "text"
            ? (b.align === "center" ? "text-center" : b.align === "right" ? "text-right" : "text-left")
            : "";
          if (b.type === "headline") {
            const cls = b.level === 1 ? "text-3xl sm:text-4xl font-bold tracking-tight"
                      : b.level === 2 ? "text-2xl sm:text-3xl font-semibold tracking-tight"
                      :                  "text-xl sm:text-2xl font-semibold";
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, b.level === 1
                  ? <h1 className={cn(cls, alignCls)}>{b.text}</h1>
                  : b.level === 2
                    ? <h2 className={cn(cls, alignCls)}>{b.text}</h2>
                    : <h3 className={cn(cls, alignCls)}>{b.text}</h3>, onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "text") {
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, <p className={cn("text-base leading-relaxed whitespace-pre-wrap", alignCls, isDark ? "text-zinc-200" : "text-gray-700")}>{b.text}</p>, onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "list") {
            const Tag = b.style === "number" ? "ol" : "ul";
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, (
                  <Tag className={cn("pl-6 space-y-1.5 text-base leading-relaxed",
                    b.style === "number" ? "list-decimal" : "list-disc",
                    isDark ? "text-zinc-200" : "text-gray-700")}>
                    {b.items.filter(i => i.trim()).map((it, i) => <li key={i}>{it}</li>)}
                  </Tag>
                ), onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "button") {
            const styleCls = b.style === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700"
                           : b.style === "secondary" ? (isDark ? "bg-white text-gray-900 hover:bg-gray-100" : "bg-gray-900 text-white hover:bg-gray-800")
                           :                           "border border-indigo-600 text-indigo-600 hover:bg-indigo-50";
            const wrapCls = b.align === "center" ? "justify-center" : b.align === "right" ? "justify-end" : "justify-start";
            const btnCls = cn("inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg font-medium text-sm transition-colors", styleCls);
            const lnk = b.link;
            const btnEl = lnk?.kind === "page"
              ? <button type="button" onClick={() => onGoToPage?.(lnk.pageIndex)} className={btnCls}>{b.text || "Button"}</button>
              : (lnk?.url || b.url)
                ? <a href={lnk?.url || b.url} target={lnk?.newTab !== false ? "_blank" : "_self"} rel="noopener noreferrer" className={btnCls}>{b.text || "Button"}</a>
                : <button type="button" disabled className={cn(btnCls, "cursor-not-allowed opacity-60")}>{b.text || "Button"}</button>;
            return (
              <Fragment key={b.id}>
                <div className={cn("flex", wrapCls)}>{btnEl}</div>
              </Fragment>
            );
          }
          if (b.type === "divider") {
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, <hr className={cn("border-t", isDark ? "border-white/10" : "border-gray-200")} />, onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "spacer") {
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, <div style={{ height: b.height }} />, onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "image") {
            if (!b.url) return (
              <Fragment key={b.id}>
                <div className={cn("h-40 rounded-lg border border-dashed flex items-center justify-center text-xs", subtle, headerBorder)}>Image placeholder</div>
              </Fragment>
            );
            return (
              <Fragment key={b.id}>
                {applyBlockLink(b, <img src={b.url} alt={b.alt || page.title} loading="lazy" decoding="async" className="w-full rounded-lg aspect-auto" />, onGoToPage)}
              </Fragment>
            );
          }
          if (b.type === "video") {
            const ytId = b.url ? getYouTubeId(b.url) : null;
            const isYt = ytId && /^[a-zA-Z0-9_-]{11}$/.test(ytId);
            if (isYt) {
              return (
                <div key={b.id} className="relative aspect-video rounded-lg overflow-hidden bg-black">
                  <iframe
                    src={`https://www.youtube.com/embed/${ytId}?rel=0&modestbranding=1`}
                    className="absolute inset-0 w-full h-full border-0"
                    title="Video"
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              );
            }
            if (!b.url) return <div key={b.id} className={cn("aspect-video rounded-lg border border-dashed flex items-center justify-center text-xs", subtle, headerBorder)}>Video placeholder</div>;
            return <video key={b.id} src={b.url} controls className="w-full aspect-video rounded-lg bg-black" />;
          }
          if (b.type === "youtube") {
            const id = getYouTubeId(b.url);
            if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return <div key={b.id} className={cn("aspect-video rounded-lg border border-dashed flex items-center justify-center text-xs", subtle, headerBorder)}>YouTube URL not set</div>;
            return (
              <div key={b.id} className="relative aspect-video rounded-lg overflow-hidden bg-black">
                <iframe
                  src={`https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`}
                  className="absolute inset-0 w-full h-full border-0"
                  title="YouTube video"
                    loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            );
          }
          if (b.type === "html") {
            const containsIframe = /<iframe[\s>]/i.test(b.html);
            if (containsIframe) {
              return (
                <div
                  key={b.id}
                  className="relative aspect-video rounded-lg overflow-hidden [&_iframe]:absolute [&_iframe]:inset-0 [&_iframe]:w-full [&_iframe]:h-full [&_iframe]:border-0"
                  dangerouslySetInnerHTML={{ __html: optimizeEmbeddedHtml(b.html, page.title) }}
                />
              );
            }
            return <div key={b.id} className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: b.html }} />;
          }
          if (b.type === "form") {
            const form = formMap[b.formId];
            if (!form) {
              return <div key={b.id} className={cn("rounded-lg border p-4 text-xs", subtle, headerBorder)}>Form not available.</div>;
            }
            return (
              <div key={b.id} className={cn("rounded-xl border p-4 sm:p-6", headerBorder, isDark ? "bg-zinc-900/40" : "bg-gray-50/60")}>
                <PublicFormRenderer
                  formId={form.id}
                  config={form.config}
                  journeyId={journeyId}
                  pageId={page.id}
                  visitorToken={visitorToken}
                  isDark={isDark}
                />
              </div>
            );
          }
          return null;
        })}
      </main>

      {data.footer?.show && (
        <footer className={cn("px-8 sm:px-12 py-5 border-t text-xs", headerBorder, subtle)}>
          {data.footer.text}
        </footer>
      )}
    </div>
  );
}

// ── PageRenderer ──────────────────────────────────────────────────────────────
function PageRenderer({
  page, isDark, journeySlug, visitorQs, journeyId, visitorToken, onGoToPage,
}: {
  page: JourneyPage; isDark: boolean;
  journeySlug?: string; visitorQs?: string;
  journeyId?: number; visitorToken?: string;
  onGoToPage?: (pageIndex: number) => void;
}) {
  const { content, hotspots } = parsePageContent(page.content ?? "", page.pageType);
  const ring = isDark ? "ring-1 ring-white/10" : "ring-1 ring-gray-200";
  const shadow = isDark ? "shadow-2xl shadow-black/60" : "shadow-xl shadow-gray-200/80";
  void ring; void shadow;

  function renderBody() {
    if (page.pageType === "blocks") {
      return (
        <BlocksPageRenderer
          page={page}
          isDark={isDark}
          journeyId={journeyId ?? 0}
          visitorToken={visitorToken ?? ""}
          onGoToPage={onGoToPage}
        />
      );
    }

    if (page.pageType === "youtube") {
      const videoId = getYouTubeId(content);
      return (
        <div className="w-full h-full flex items-center justify-center bg-black">
          <div className="w-full h-full">
            <iframe
              src={`https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&autoplay=0`}
              title={page.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="w-full h-full"
            />
          </div>
        </div>
      );
    }

    if (page.pageType === "pdf") {
      const handleDownload = async () => {
        if (journeySlug) {
          const sp = new URLSearchParams(visitorQs?.replace(/^\?/, "") ?? "");
          try {
            await fetch(`/api/public/journeys/${journeySlug}/track`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "asset_download",
                cid: sp.get("cid") ?? undefined,
                contact: sp.get("contact") ?? undefined,
              }),
            });
          } catch {}
        }
        const a = document.createElement("a");
        a.href = content;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.download = page.title || "document.pdf";
        a.click();
      };
      void handleDownload;
      const pdfSrc = `${content}${content.includes("#") ? "&" : "#"}toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
      return (
        <div className="w-full h-full overflow-hidden">
          <iframe
            src={pdfSrc}
            title={page.title}
            className="w-full h-full"
            style={{ border: 0, marginTop: -1 }}
          />
        </div>
      );
    }

    if (page.pageType === "iframe") {
      const trimmed = (content ?? "").trim();
      const isHtmlEmbed = /^<iframe[\s>]/i.test(trimmed);
      if (isHtmlEmbed) {
        return (
          <div
            className="w-full h-full flex items-center justify-center overflow-hidden [&_iframe]:max-w-full [&_iframe]:max-h-full [&_iframe]:border-0"
            dangerouslySetInnerHTML={{ __html: optimizeEmbeddedHtml(trimmed, page.title) }}
          />
        );
      }
      return (
        <iframe
          src={content}
          title={page.title}
          className="w-full h-full border-0 block"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
        />
      );
    }

    if (page.pageType === "infographic") {
      return (
        <div className="w-full h-full flex items-center justify-center overflow-hidden">
          <img
            src={content}
            alt={page.title}
            fetchPriority="high"
            decoding="async"
            className="w-full h-full object-contain"
          />
        </div>
      );
    }

    if (page.pageType === "html") {
      return (
        <div className={cn("w-full h-full overflow-y-auto", isDark ? "bg-[#0a0a0a]" : "bg-[#f8f8f8]")}>
          <div className={cn("max-w-3xl mx-auto px-8 py-12", isDark ? "bg-[#111]" : "bg-white")}>
            <div className="prose prose-sm sm:prose max-w-none" dangerouslySetInnerHTML={{ __html: optimizeEmbeddedHtml(content, page.title) }} />
          </div>
        </div>
      );
    }

    return (
      <div className={cn("w-full h-full flex items-center justify-center", isDark ? "text-white/40" : "text-gray-400")}>
        Content unavailable
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {renderBody()}
      <HotspotOverlays hotspots={hotspots} onGoToPage={onGoToPage} />
    </div>
  );
}

// ── InlineBannerStrip ─────────────────────────────────────────────────────────
function InlineBannerStrip({
  comp, isDark, onDismiss, onTrackClick, onTrackDismiss,
}: { comp: PageComponent; isDark: boolean; onDismiss: () => void; onTrackClick?: () => void; onTrackDismiss?: () => void }) {
  const [exiting, setExiting] = useState(false);

  const handleDismiss = () => {
    setExiting(true);
    onTrackDismiss?.();
    setTimeout(() => onDismiss(), 280);
  };

  const cfg = comp.bannerConfig ?? {};
  const bg = cfg.bgColor || (isDark ? "#1e1b4b" : "#eff6ff");
  const color = cfg.textColor || (isDark ? "#e0e7ff" : "#1e40af");
  const heading = cfg.heading || comp.bannerName || "";
  const body = cfg.body || "";
  const dismissible = cfg.dismissButton !== false;
  const clickUrl = cfg.clickUrl || cfg.clickBehavior === "url" ? cfg.clickUrl : undefined;
  const animationType = cfg.animationType as string | undefined;
  const animationDelay = Number(cfg.animationDelay ?? 0);

  const animClass =
    animationType === "slide" ? "animate-[slideDown_0.4s_ease-out_both]" :
    animationType === "fade"  ? "animate-[fadeIn_0.5s_ease-out_both]"  :
    animationType === "bounce"? "animate-[bounceIn_0.5s_ease-out_both]" : "";

  const isImageBanner = cfg.type === "image" && !!cfg.imageUrl;

  // Position-aware sizing: shrink proportionally when space is limited
  const resolvedPos = resolvePosition(comp);
  const imageStyle: React.CSSProperties =
    resolvedPos === "top_bar" || resolvedPos === "bottom_bar"
      ? { display: "block", maxHeight: 120, width: "auto", maxWidth: "100%" }
      : resolvedPos === "right"
      ? { display: "block", width: "100%", height: "auto" }
      : { display: "block", width: "100%" }; // inline — natural size

  const inner = isImageBanner ? (
    <div
      className={cn(
        "relative w-full shrink-0 overflow-hidden transition-all duration-280",
        animClass,
        exiting && "opacity-0 max-h-0 overflow-hidden pointer-events-none",
      )}
      style={{ animationDelay: animationDelay ? `${animationDelay}ms` : undefined }}
    >
      <img
        src={cfg.imageUrl as string}
        alt={heading || "Banner"}
          loading="lazy"
          decoding="async"
        style={imageStyle}
      />
      {(cfg.overlayText || cfg.overlaySubtext) && (
        <div
          className={cn(
            "absolute inset-0 flex flex-col px-6 py-4",
            cfg.textVertical === "top" ? "justify-start" : cfg.textVertical === "bottom" ? "justify-end" : "justify-center",
            cfg.textAlignment === "center" ? "items-center text-center" : cfg.textAlignment === "right" ? "items-end text-right" : "items-start text-left",
          )}
        >
          {cfg.overlayText && (
            <p
              className={cn("font-bold leading-snug", cfg.textShadow && "[text-shadow:0_1px_3px_rgba(0,0,0,0.6)]")}
              style={{ fontSize: cfg.headlineFontSize ?? 16, color: (cfg.textColor as string) || "#ffffff" }}
            >
              {cfg.overlayText as string}
            </p>
          )}
          {cfg.overlaySubtext && (
            <p
              className={cn("mt-1", cfg.textShadow && "[text-shadow:0_1px_3px_rgba(0,0,0,0.5)]")}
              style={{ fontSize: cfg.subtextFontSize ?? 13, color: (cfg.textColor as string) || "#ffffff" }}
            >
              {cfg.overlaySubtext as string}
            </p>
          )}
        </div>
      )}
      {dismissible && (
        <button
          type="button"
          aria-label="Dismiss banner"
          onClick={e => { e.preventDefault(); e.stopPropagation(); handleDismiss(); }}
          className="absolute top-2 right-2 bg-black/40 rounded-full p-0.5 opacity-70 hover:opacity-100 z-10">
          <X className="w-3.5 h-3.5 text-white" />
        </button>
      )}
    </div>
  ) : (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-2 text-xs shrink-0 w-full transition-all duration-280",
        animClass,
        exiting && "opacity-0 max-h-0 py-0 overflow-hidden pointer-events-none",
      )}
      style={{ backgroundColor: bg, color, animationDelay: animationDelay ? `${animationDelay}ms` : undefined }}
    >
      {heading && <span className="font-semibold flex-1 truncate">{heading}</span>}
      {body && <span className="opacity-70 hidden sm:block flex-shrink truncate">{body}</span>}
      {cfg.ctaText && cfg.ctaUrl && (
        <a href={cfg.ctaUrl} target="_blank" rel="noreferrer"
          onClick={e => e.stopPropagation()}
          className="shrink-0 px-2.5 py-1 rounded font-semibold text-[11px] transition-opacity hover:opacity-80"
          style={{ backgroundColor: color, color: bg }}>
          {cfg.ctaText}
        </a>
      )}
      {dismissible && (
        <button
          type="button"
          aria-label="Dismiss banner"
          onClick={e => { e.preventDefault(); e.stopPropagation(); handleDismiss(); }}
          className="shrink-0 opacity-50 hover:opacity-100 ml-1">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  if (clickUrl) {
    return (
      <a href={clickUrl} target="_blank" rel="noreferrer" className="block w-full no-underline"
        onClick={() => onTrackClick?.()}>
        {inner}
      </a>
    );
  }
  return inner;
}

// ── CtaButton ─────────────────────────────────────────────────────────────────
function CtaButton({ comp, onClick }: { comp: PageComponent; onClick: () => void }) {
  const style = comp.ctaStyleConfig ?? {};
  const radius = style.borderRadius === "pill" ? "9999px" : style.borderRadius === "sharp" ? "4px" : "8px";
  const bg = style.bgColor || "#4f46e5";
  const textColor = style.textColor || "#ffffff";
  const outline = !!style.outline;
  const shadow = !!style.shadow;
  const size = style.sizePreset ?? "medium";
  return (
    <button
      onClick={onClick}
      style={{
        backgroundColor: outline ? "transparent" : bg,
        color: outline ? bg : textColor,
        borderRadius: radius,
        border: outline ? `2px solid ${bg}` : "none",
        boxShadow: shadow ? "0 4px 14px rgba(0,0,0,0.25)" : undefined,
        fontWeight: style.fontWeight === "bold" ? 700 : style.fontWeight === "normal" ? 400 : 600,
      }}
      className={cn(
        "transition-opacity hover:opacity-90 focus:outline-none",
        size === "small" ? "px-3 py-1.5 text-xs" :
        size === "large" ? "px-6 py-3 text-base" :
        size === "full"  ? "w-full px-4 py-2.5 text-sm" : "px-4 py-2 text-sm",
      )}
    >
      {comp.ctaLabel || "Click"}
    </button>
  );
}

// ── FilmstripCard ─────────────────────────────────────────────────────────────
function FilmstripCard({
  page, index, active, onClick, cardRef, isDark,
}: {
  page: JourneyPage; index: number; active: boolean;
  onClick: () => void; cardRef?: React.Ref<HTMLButtonElement>; isDark: boolean;
}) {
  const meta = PAGE_TYPE_META[page.pageType];

  const renderThumbnail = () => {
    /* ── YouTube ── real thumbnail from YouTube API */
    if (page.pageType === "youtube" && page.content) {
      return (
        <>
          <img
            src={`https://img.youtube.com/vi/${getYouTubeId(page.content)}/mqdefault.jpg`}
            alt={page.title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
          {/* Play button badge */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-7 h-7 rounded-full bg-red-600/85 flex items-center justify-center shadow-lg">
              <div className="w-0 h-0 border-t-[5px] border-b-[5px] border-l-[8px] border-transparent border-l-white ml-0.5" />
            </div>
          </div>
        </>
      );
    }

    /* ── Infographic ── show the actual image */
    if (page.pageType === "infographic" && page.content) {
      return (
        <>
          <img
            src={page.content}
            alt={page.title}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
        </>
      );
    }

    /* ── PDF ── stylized document preview */
    if (page.pageType === "pdf") {
      return (
        <div className={cn("absolute inset-0 bg-gradient-to-br", isDark ? meta.darkGrad : meta.lightGrad)}>
          {/* Doc sheet with shadow */}
          <div className="absolute inset-[10px] rounded bg-white/90 shadow-xl flex flex-col overflow-hidden">
            {/* Red top bar */}
            <div className="h-2.5 bg-gradient-to-r from-orange-500 to-red-500 shrink-0" />
            {/* Content lines */}
            <div className="flex-1 p-1.5 flex flex-col gap-0.5 overflow-hidden">
              <div className="h-1.5 w-3/4 rounded-sm bg-gray-400/60 mb-0.5" />
              {[100, 85, 100, 72, 88, 95, 60].map((w, i) => (
                <div key={i} style={{ width: `${w}%` }} className="h-[3px] rounded-full bg-gray-300/80" />
              ))}
              <div className="mt-0.5 flex gap-0.5">
                <div className="flex-1 h-3 rounded-sm bg-gray-200/80" />
                <div className="flex-1 h-3 rounded-sm bg-gray-200/80" />
              </div>
            </div>
          </div>
          {/* PDF badge */}
          <div className="absolute bottom-2 right-2 flex items-center gap-0.5 bg-orange-500/90 rounded px-1 py-0.5">
            <FileText className="w-2 h-2 text-white" />
            <span className="text-[6px] font-bold text-white uppercase tracking-wide">PDF</span>
          </div>
        </div>
      );
    }

    /* ── Iframe ── mini browser window */
    if (page.pageType === "iframe" && page.content) {
      const domain = extractDomain(page.content);
      return (
        <div className={cn("absolute inset-0 bg-gradient-to-br", isDark ? meta.darkGrad : meta.lightGrad)}>
          {/* Browser chrome */}
          <div className="absolute inset-2 rounded-md overflow-hidden border border-white/10 shadow-lg flex flex-col">
            {/* Title bar */}
            <div className="flex items-center gap-1 px-1.5 py-1 bg-black/40 shrink-0">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400/80" />
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400/80" />
              <div className="w-1.5 h-1.5 rounded-full bg-green-400/80" />
              <div className="flex-1 mx-1 h-2.5 rounded-sm bg-white/10 flex items-center px-1 gap-1">
                <img
                  src={`https://www.google.com/s2/favicons?sz=32&domain=${domain}`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-1.5 h-1.5 shrink-0"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
                <span className="text-[4.5px] text-white/40 truncate">{domain}</span>
              </div>
            </div>
            {/* Page content simulation */}
            <div className="flex-1 bg-white/5 flex flex-col gap-0.5 p-1 overflow-hidden">
              <div className="h-2 w-3/4 rounded-sm bg-white/20" />
              <div className="h-1 w-full rounded-sm bg-white/10" />
              <div className="h-1 w-5/6 rounded-sm bg-white/10" />
              <div className="flex gap-0.5 mt-0.5">
                <div className="flex-1 h-4 rounded-sm bg-white/10" />
                <div className="flex-1 h-4 rounded-sm bg-white/10" />
              </div>
              <div className="h-1 w-2/3 rounded-sm bg-white/10 mt-0.5" />
              <div className="h-1 w-full rounded-sm bg-white/10" />
            </div>
          </div>
          {/* Domain badge bottom */}
          <div className="absolute bottom-[9px] left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-black/50 rounded-full px-1.5 py-0.5">
            <Globe className="w-1.5 h-1.5 text-white/50" />
            <span className="text-[5px] font-mono text-white/50 truncate max-w-[60px]">{domain}</span>
          </div>
        </div>
      );
    }

    /* ── HTML ── stylized code preview */
    if (page.pageType === "html") {
      return (
        <div className="absolute inset-0 bg-[#1a1a2e]">
          <div className="absolute top-1.5 left-1.5 right-1.5 h-[7px] bg-[#2d2d44] rounded-t flex items-center gap-[3px] px-1">
            {["#ff5f57","#ffbd2e","#28c840"].map(c => (
              <div key={c} style={{ background: c }} className="w-[4px] h-[4px] rounded-full" />
            ))}
          </div>
          <div className="absolute top-[22px] left-2 right-2 bottom-1.5 flex flex-col gap-0.5 font-mono overflow-hidden">
            {[
              { color: "#c678dd", text: "<section>" },
              { color: "#61afef", text: "  <h1>" },
              { color: "#98c379", text: "    ··· ···" },
              { color: "#61afef", text: "  </h1>" },
              { color: "#e06c75", text: "  <p>···</p>" },
              { color: "#c678dd", text: "</section>" },
            ].map((l, i) => (
              <div key={i} style={{ color: l.color }} className="text-[5.5px] leading-tight truncate opacity-80">{l.text}</div>
            ))}
          </div>
        </div>
      );
    }

    /* ── Fallback ── gradient + icon */
    const Icon = meta.Icon;
    return (
      <div className={cn("absolute inset-0 bg-gradient-to-br", isDark ? meta.darkGrad : meta.lightGrad)}>
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon className={cn("w-8 h-8 opacity-30", meta.color)} />
        </div>
      </div>
    );
  };

  // Color palettes per page type — vivid, distinct
  const CARD_PALETTES: Record<PageType, { from: string; via: string; to: string; accent: string }> = {
    youtube:     { from: "#e11d48", via: "#be123c", to: "#881337", accent: "#fda4af" },
    pdf:         { from: "#ea580c", via: "#c2410c", to: "#7c2d12", accent: "#fdba74" },
    iframe:      { from: "#2563eb", via: "#1d4ed8", to: "#1e3a8a", accent: "#93c5fd" },
    html:        { from: "#7c3aed", via: "#6d28d9", to: "#4c1d95", accent: "#c4b5fd" },
    infographic: { from: "#059669", via: "#047857", to: "#064e3b", accent: "#6ee7b7" },
    blocks:      { from: "#6366f1", via: "#4f46e5", to: "#312e81", accent: "#c7d2fe" },
  };
  const pal = CARD_PALETTES[page.pageType];

  return (
    <button
      ref={cardRef}
      onClick={onClick}
      style={{ scrollSnapAlign: "center", ["--ring-color" as string]: pal.accent }}
      className={cn(
        "group relative shrink-0 w-44 md:w-52 aspect-video rounded-xl overflow-hidden",
        "transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] focus:outline-none",
        active
          ? "ring-2 scale-[1.04] shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
          : "opacity-70 hover:opacity-100 scale-100 hover:scale-[1.02] shadow-[0_4px_16px_rgba(0,0,0,0.3)]",
      )}
    >
      {/* ── Base gradient background ── */}
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(135deg, ${pal.from}, ${pal.via} 55%, ${pal.to})` }}
      />

      {/* ── Noise grain for premium texture ── */}
      <div
        className="absolute inset-0 opacity-[0.1] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundSize: "128px 128px",
        }}
      />

      {/* ── Abstract light orb — top-right accent ── */}
      <div
        className="absolute -top-6 -right-6 w-20 h-20 rounded-full blur-2xl opacity-50 pointer-events-none"
        style={{ background: pal.accent }}
      />

      {/* ── YouTube: real thumbnail + play button ── */}
      {page.pageType === "youtube" && page.content && (
        <>
          <img
            src={`https://img.youtube.com/vi/${getYouTubeId(page.content)}/mqdefault.jpg`}
            alt={page.title}
            className="absolute inset-0 w-full h-full object-cover opacity-45 mix-blend-luminosity"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="w-8 h-8 rounded-full bg-white/25 backdrop-blur-md border border-white/30 flex items-center justify-center shadow-xl">
              <div className="w-0 h-0 border-t-[5px] border-b-[5px] border-l-[9px] border-transparent border-l-white ml-0.5" />
            </div>
          </div>
        </>
      )}

      {/* ── Infographic: real image layer ── */}
      {page.pageType === "infographic" && page.content && (
        <img
          src={page.content}
          alt={page.title}
          className="absolute inset-0 w-full h-full object-cover opacity-30 mix-blend-luminosity"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      )}

      {/* ── Decorative faded icon (non-youtube) ── */}
      {page.pageType !== "youtube" && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.08] pointer-events-none">
          {(() => { const Icon = meta.Icon; return <Icon className="w-10 h-10 text-white" />; })()}
        </div>
      )}

      {/* ── Bottom text strip ── */}
      <div className="absolute bottom-0 inset-x-0 px-3 pb-2.5 pt-8 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
        <div className="flex items-center gap-1 mb-0.5">
          <div className="w-1 h-1 rounded-full shrink-0" style={{ background: pal.accent }} />
          <span className="text-[8px] font-bold tracking-[0.12em] uppercase leading-none" style={{ color: pal.accent }}>
            {page.pageType === "iframe" ? "Web" : page.pageType}
          </span>
        </div>
        <p className="text-white text-[11px] font-semibold leading-tight line-clamp-2 tracking-tight">
          {page.title}
        </p>
      </div>

      {/* ── Active accent glow line at top ── */}
      {active && (
        <div
          className="absolute top-0 inset-x-0 h-[2px]"
          style={{ background: `linear-gradient(90deg, transparent, ${pal.accent}, transparent)` }}
        />
      )}

      {/* ── Index chip — top left ── */}
      <div className={cn(
        "absolute top-2 left-2 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold backdrop-blur-md border",
        active
          ? "bg-white text-gray-900 border-white/60 shadow"
          : "bg-black/50 text-white/80 border-white/20",
      )}>
        {index + 1}
      </div>
    </button>
  );
}

// ── BannerCtaButton ───────────────────────────────────────────────────────────
// Renders the CTA button/link for a banner, wiring up the correct action.
function BannerCtaButton({
  config, className, onGatedClick, onPageJump,
}: {
  config: BannerConfig;
  className?: string;
  onGatedClick?: (assetUrl: string) => void;
  onPageJump?: (index: number) => void;
}) {
  const action = config.ctaAction ?? "url";
  const sharedStyle = { backgroundColor: config.textColor, color: config.bgColor };

  const handleDownload = () => {
    if (!config.ctaUrl) return;
    const a = document.createElement("a");
    a.href = config.ctaUrl;
    a.download = "download";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); }, 500);
  };

  if (action === "download") {
    return (
      <button onClick={handleDownload} className={className} style={sharedStyle}>
        {config.ctaText} <Download className="inline w-3 h-3 ml-0.5" />
      </button>
    );
  }
  if (action === "gated_download") {
    return (
      <button
        onClick={() => config.ctaUrl && onGatedClick?.(config.ctaUrl)}
        className={className}
        style={sharedStyle}
      >
        {config.ctaText}
      </button>
    );
  }
  if (action === "page") {
    return (
      <button
        onClick={() => onPageJump?.((config.ctaPageIndex ?? 1) - 1)}
        className={className}
        style={sharedStyle}
      >
        {config.ctaText}
      </button>
    );
  }
  // default: url
  if (!config.ctaUrl) {
    return <button type="button" disabled className={className} style={sharedStyle}>{config.ctaText}</button>;
  }
  return (
    <a href={config.ctaUrl} target="_blank" rel="noreferrer" className={className} style={sharedStyle}>
      {config.ctaText} <ExternalLink className="inline w-3 h-3 ml-0.5" />
    </a>
  );
}

// ── HeaderCtaButton ───────────────────────────────────────────────────────────
// Renders the topbar CTA with correct action: url / download / gated_download / page
function RailCtaButton({
  journey, goTo,
}: {
  journey: JourneyData;
  goTo: (i: number) => void;
}) {
  const btnType = journey.headerBtnType ?? "url";
  const btnUrl  = journey.headerBtnUrl ?? "";
  const label   = journey.headerBtnText!;
  const cls = "w-full text-center text-[13px] font-medium px-3 py-2.5 rounded-full bg-white text-[#1D1D1F] transition-all hover:bg-[#FAFAFA] hover:-translate-y-[1px] inline-flex items-center justify-center gap-1.5 border border-[rgba(0,0,0,0.08)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] leading-tight";

  if (btnType === "download") {
    return (
      <button
        className={cls}
        onClick={() => {
          if (!btnUrl) return;
          const a = document.createElement("a");
          a.href = btnUrl; a.download = label; a.target = "_blank";
          document.body.appendChild(a); a.click();
          setTimeout(() => document.body.removeChild(a), 500);
        }}
      >
        {label} <Download className="inline w-3 h-3 ml-0.5" />
      </button>
    );
  }
  if (btnType === "page") {
    const targetIdx = btnUrl ? parseInt(btnUrl, 10) - 1 : 0;
    return (
      <button className={cls} onClick={() => goTo(Math.max(0, targetIdx))}>
        {label}
      </button>
    );
  }
  // default: url
  if (!btnUrl) return <button type="button" disabled className={cls}>{label}</button>;
  return <a href={btnUrl} target="_blank" rel="noreferrer" className={cls}>{label}</a>;
}

// ── ConsentGate ───────────────────────────────────────────────────────────────
function ConsentGate({
  slug, isDark, onAccept,
}: { slug: string; isDark: boolean; onAccept: () => void }) {
  const [checked, setChecked] = useState(false);

  const accept = () => {
    try { localStorage.setItem(`kaboom_consent_${slug}`, "1"); } catch {}
    onAccept();
  };

  const cardBg   = isDark ? "bg-[#1a1a1a] border-white/10" : "bg-white border-gray-200";
  const textMain = isDark ? "text-white" : "text-gray-900";
  const textSub  = isDark ? "text-white/50" : "text-gray-500";
  const checkBg  = isDark ? "bg-white/5 border-white/20 text-white/80" : "bg-gray-50 border-gray-200 text-gray-700";
  const btnEn    = "bg-indigo-600 hover:bg-indigo-500 text-white";
  const btnDis   = isDark ? "bg-white/10 text-white/30 cursor-not-allowed" : "bg-gray-100 text-gray-400 cursor-not-allowed";

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center", isDark ? "bg-[#0d0d0d]" : "bg-gray-50")}>
      <motion.div
        className={cn("w-full max-w-sm mx-4 rounded-2xl border p-8 shadow-2xl space-y-6", cardBg)}
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-indigo-500/15 ring-1 ring-indigo-500/30 flex items-center justify-center">
            <ShieldCheck className="w-7 h-7 text-indigo-500" />
          </div>
          <div>
            <h2 className={cn("text-lg font-semibold", textMain)}>Before you continue</h2>
            <p className={cn("text-sm mt-1 leading-relaxed", textSub)}>
              By accessing this content, you agree to how we collect and use your information.
            </p>
          </div>
        </div>

        <label className={cn("flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors", checkBg)}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer shrink-0"
          />
          <span className="text-xs leading-relaxed">
            I agree to the{" "}
            <span className="text-indigo-500 font-medium">Terms &amp; Conditions</span>
            {" "}and{" "}
            <span className="text-indigo-500 font-medium">Privacy Policy</span>
          </span>
        </label>

        <button
          onClick={accept}
          disabled={!checked}
          className={cn("w-full py-2.5 rounded-xl text-sm font-semibold transition-all", checked ? btnEn : btnDis)}
        >
          Continue to content
        </button>
      </motion.div>
    </div>
  );
}

// ── CompletedScreen ──────────────────────────────────────────────────────────
function CompletedScreen({ journey, onRestart }: { journey: JourneyData; onRestart: () => void }) {
  const isDark = (journey.theme ?? "dark") !== "light";
  return (
    <motion.div
      className={cn(
        "fixed inset-0 flex flex-col items-center justify-center gap-6 z-50",
        isDark ? "bg-[#0d0d0d]" : "bg-white",
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
        className="w-20 h-20 rounded-full bg-emerald-500/20 ring-2 ring-emerald-500/50 flex items-center justify-center"
      >
        <CheckCircle2 className="w-10 h-10 text-emerald-400" />
      </motion.div>
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-center space-y-2"
      >
        <h1 className={cn("text-3xl font-bold", isDark ? "text-white" : "text-gray-900")}>Journey complete!</h1>
        <p className={isDark ? "text-white/50" : "text-gray-500"}>{journey.name}</p>
        {journey.clientName && (
          <p className={cn("text-sm", isDark ? "text-white/30" : "text-gray-400")}>Presented by {journey.clientName}</p>
        )}
      </motion.div>
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        onClick={onRestart}
        className={cn(
          "mt-4 px-5 py-2 rounded-full border text-sm transition-colors",
          isDark
            ? "border-white/20 text-white/70 hover:text-white hover:border-white/40"
            : "border-gray-200 text-gray-500 hover:text-gray-900 hover:border-gray-400",
        )}
      >
        Start over
      </motion.button>
    </motion.div>
  );
}

// ── PublicFormRenderer ────────────────────────────────────────────────────────
export function PublicFormRenderer({
  formId, config, journeyId, pageId, visitorToken, isDark, deliveryAssetId, componentId, onClose, onSubmitSuccess, previewOnly,
}: {
  formId: number;
  config: Record<string, any>;
  journeyId: number;
  pageId: number;
  visitorToken: string;
  isDark: boolean;
  deliveryAssetId?: number | null;
  componentId?: number;
  onClose?: () => void;
  onSubmitSuccess?: () => void;
  previewOnly?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const formStartFired = useRef(false);

  const trackFormStart = useCallback(() => {
    if (formStartFired.current) return;
    formStartFired.current = true;
    if (previewOnly) return;
    fetch("/api/public/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journeyId,
        pageId,
        componentId: componentId ?? undefined,
        eventType: "form_start",
        visitorToken,
      }),
    }).catch(() => {});
  }, [journeyId, pageId, componentId, visitorToken]);
  const [result, setResult] = useState<{
    thankYouTitle: string; thankYouBody: string;
    downloadUrl?: string; downloadFilename?: string;
    redirectUrl?: string; redirectDelay?: number;
  } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const fields: any[] = (config.fields ?? []).filter((f: any) => !f.hidden);
  const submitBtn = config.submitButton ?? {};
  const textCls = isDark ? "text-white" : "text-gray-900";
  const subCls  = isDark ? "text-white/60" : "text-gray-500";
  const inputCls = isDark
    ? "w-full border border-white/15 rounded-lg px-3 py-2 text-sm bg-white/5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    : "w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (previewOnly) return;
    setSubmitting(true);
    try {
      const data: Record<string, any> = {};
      fields.forEach((f: any) => { data[f.id] = values[f.id] ?? ""; });
      const r = await fetch(`/api/public/forms/${formId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, pageId, journeyId, visitorToken, deliveryAssetId }),
      });
      const res = await r.json();
      setResult(res);
      if (r.ok) onSubmitSuccess?.();
      if (res.downloadUrl) {
        setTimeout(() => {
          const a = document.createElement("a");
          a.href = res.downloadUrl;
          a.download = res.downloadFilename ?? "download";
          a.target = "_blank";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 500);
        }, 1200);
      }
      if (res.redirectUrl) {
        const delay = res.redirectDelay ?? 3;
        let c = delay;
        setCountdown(c);
        const iv = setInterval(() => {
          c -= 1;
          if (c <= 0) { clearInterval(iv); setCountdown(null); }
          else setCountdown(c);
        }, 1000);
        setTimeout(() => { window.location.href = res.redirectUrl; }, delay * 1000);
      }
    } catch {
      // silent fail
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="flex flex-col items-center justify-center gap-4 p-4 text-center"
      >
        <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
        <div>
          <h3 className={cn("text-base font-semibold", textCls)}>{result.thankYouTitle || "Thank you!"}</h3>
          {result.thankYouBody && <p className={cn("text-sm mt-1", subCls)}>{result.thankYouBody}</p>}
        </div>
        {result.downloadUrl && (
          <a href={result.downloadUrl} download={result.downloadFilename} target="_blank" rel="noreferrer"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors">
            <Download className="w-4 h-4" /> {result.downloadFilename ?? "Download File"}
          </a>
        )}
        {result.redirectUrl && countdown !== null && (
          <p className={cn("text-xs", subCls)}>Redirecting in {countdown}s…</p>
        )}
        {onClose && (
          <button onClick={onClose} className={cn("text-xs hover:underline mt-1", subCls)}>Close</button>
        )}
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {fields.map((field: any) => {
        if (field.type === "section_heading") {
          return <div key={field.id} className={cn("text-sm font-semibold pt-2", textCls)}>{field.label}</div>;
        }
        if (field.type === "consent" || field.type === "tnc" || field.type === "privacy_policy" || field.type === "checkbox") {
          const displayText = field.type === "consent" ? (field.consentText ?? field.label) : field.label;
          return (
            <label key={field.id} className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={!!values[field.id]}
                onChange={e => { trackFormStart(); setValues(v => ({ ...v, [field.id]: e.target.checked })); }}
                required={field.required} className="mt-1 accent-indigo-600 shrink-0" />
              <span className={cn("text-xs leading-snug", subCls)}>{displayText}{field.required && " *"}</span>
            </label>
          );
        }
        if (field.type === "long_text") {
          return (
            <div key={field.id}>
              <label className={cn("block text-xs font-medium mb-1", subCls)}>{field.label}{field.required && " *"}</label>
              <textarea required={field.required} placeholder={field.placeholder} rows={3}
                value={(values[field.id] as string) ?? ""}
                onFocus={trackFormStart}
                onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))}
                className={inputCls + " resize-none"} />
            </div>
          );
        }
        if (field.type === "dropdown" || field.type === "select") {
          return (
            <div key={field.id}>
              <label className={cn("block text-xs font-medium mb-1", subCls)}>{field.label}{field.required && " *"}</label>
              <select required={field.required} value={(values[field.id] as string) ?? ""}
                onFocus={trackFormStart}
                onChange={e => { trackFormStart(); setValues(v => ({ ...v, [field.id]: e.target.value })); }}
                className={inputCls}>
                <option value="">{field.placeholder || "Select…"}</option>
                {(field.options ?? []).map((o: string) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          );
        }
        if (field.type === "radio_group") {
          return (
            <div key={field.id} className="space-y-1.5">
              <label className={cn("block text-xs font-medium", subCls)}>{field.label}{field.required && " *"}</label>
              {(field.options ?? []).map((o: string) => (
                <label key={o} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name={field.id} value={o}
                    checked={(values[field.id] as string) === o}
                    onChange={() => { trackFormStart(); setValues(v => ({ ...v, [field.id]: o })); }}
                    required={field.required} className="accent-indigo-600" />
                  <span className={cn("text-xs", subCls)}>{o}</span>
                </label>
              ))}
            </div>
          );
        }
        if (field.type === "checkbox_group") {
          const selected: string[] = Array.isArray(values[field.id]) ? (values[field.id] as unknown as string[]) : [];
          return (
            <div key={field.id} className="space-y-1.5">
              <label className={cn("block text-xs font-medium", subCls)}>{field.label}{field.required && " *"}</label>
              {(field.options ?? []).map((o: string) => (
                <label key={o} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={selected.includes(o)}
                    onChange={e => {
                      trackFormStart();
                      setValues(v => ({
                        ...v,
                        [field.id]: e.target.checked ? [...selected, o] : selected.filter(x => x !== o),
                      }));
                    }}
                    className="accent-indigo-600" />
                  <span className={cn("text-xs", subCls)}>{o}</span>
                </label>
              ))}
            </div>
          );
        }
        if (field.type === "divider") {
          return <hr key={field.id} style={{ borderColor: field.dividerColor ?? "#e5e7eb", borderStyle: field.dividerStyle ?? "solid" }} />;
        }
        const inputType = field.type === "email" ? "email" : field.type === "phone" ? "tel" : field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
        return (
          <div key={field.id}>
            <label className={cn("block text-xs font-medium mb-1", subCls)}>{field.label}{field.required && " *"}</label>
            <input type={inputType} required={field.required} placeholder={field.placeholder}
              value={(values[field.id] as string) ?? ""}
              onFocus={trackFormStart}
              onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))}
              className={inputCls} />
          </div>
        );
      })}
      <button type="submit" disabled={submitting || previewOnly}
        style={{
          backgroundColor: submitBtn.bgColor || "#4f46e5",
          color: submitBtn.textColor || "#ffffff",
          borderRadius: submitBtn.borderRadius === "pill" ? "9999px" : submitBtn.borderRadius === "sharp" ? "4px" : "8px",
        }}
        className={cn(
          "w-full py-2.5 text-sm font-semibold transition-opacity",
          submitBtn.sizePreset === "small" ? "py-1.5 text-xs" : submitBtn.sizePreset === "large" ? "py-3" : "",
          submitting || previewOnly ? "opacity-50 cursor-not-allowed" : "hover:opacity-90"
        )}>
        {submitting ? "Submitting…" : submitBtn.label || "Submit"}
      </button>
      {previewOnly && (
        <p className={cn("text-[11px] text-center mt-1", subCls)}>
          Preview only — submissions are disabled
        </p>
      )}
    </form>
  );
}

// ── JourneyViewer ─────────────────────────────────────────────────────────────
interface JourneyViewerProps {
  slug?: string;
  /** The page slug from the URL — /play/:journeySlug/:pageSlug */
  pageSlug?: string;
  /** When set, fetches from the authenticated builder-preview endpoint instead of the public one. */
  previewJourneyId?: number;
}

export default function JourneyViewer({ slug, pageSlug, previewJourneyId }: JourneyViewerProps) {
  const isPreviewMode = previewJourneyId !== undefined;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [currentIndex, setCurrentIndex] = useState(() => {
    // If a page slug is in the URL, defer to the init effect (can't resolve without pages yet)
    if (pageSlug) return 0;
    // URL param ?p=N (1-based) from legacy builder "Preview in viewer" button
    try {
      const params = new URLSearchParams(window.location.search);
      const p = params.get("p");
      if (p !== null) {
        const n = parseInt(p, 10);
        if (!isNaN(n) && n >= 1) return n - 1;
      }
    } catch { /* ignore */ }
    // Fall back to saved localStorage progress (not in preview mode)
    if (!isPreviewMode) {
      try {
        const saved = localStorage.getItem(`pf_journey_progress_${slug}`);
        if (saved !== null) { const n = parseInt(saved, 10); if (!isNaN(n) && n >= 0) return n; }
      } catch { /* ignore */ }
    }
    return 0;
  });
  // Ref to ensure pageSlug → index resolution only runs once on initial load
  const pageSlugInitDone = useRef(false);
  // Gate for the URL sync effect: false until the pageSlug prop has been resolved to
  // the correct currentIndex.  Without this, the URL sync fires in the same React tick
  // as the pageSlug init (both trigger on pages.length change), but the URL sync still
  // sees currentIndex=0 in its closure because React hasn't applied setCurrentIndex yet.
  // That causes a flash-redirect to page 0 the moment pages load, even when the contact
  // arrived directly at e.g. /exclusive-access.
  const [pageSlugResolved, setPageSlugResolved] = useState(!pageSlug);
  const [direction, setDirection] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [pageComponents, setPageComponents] = useState<PageComponent[]>([]);
  const [activeModalFormId, setActiveModalFormId] = useState<number | null>(null);
  const [modalDeliveryAssetId, setModalDeliveryAssetId] = useState<number | null>(null);
  const [activePopupCompId, setActivePopupCompId] = useState<number | null>(null);
  const [firedPopupComps, setFiredPopupComps] = useState<Set<number>>(new Set());
  const [dismissedBanners, setDismissedBanners] = useState<Set<number>>(() => {
    const s = new Set<number>();
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("banner_dismissed_")) { const id = parseInt(key.slice(17)); if (!isNaN(id)) s.add(id); }
      }
    } catch { /* ignore */ }
    return s;
  });
  const [pageUnlocked, setPageUnlocked] = useState(false);
  const [visitedPages, setVisitedPages] = useState<Set<number>>(() => new Set([0]));
  const [embedLoading, setEmbedLoading] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const embedRef = useRef<HTMLDivElement>(null);

  const [visitorToken] = useState<string>(() => {
    try {
      const match = document.cookie.match(/(?:^|;\s*)pf_vt=([^;]+)/);
      let vt = match ? decodeURIComponent(match[1]) : null;
      if (!vt) {
        vt = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const maxAge = 365 * 24 * 60 * 60; // 1 year
        document.cookie = `pf_vt=${encodeURIComponent(vt)}; max-age=${maxAge}; path=/; SameSite=Lax`;
      }
      return vt;
    } catch { return Math.random().toString(36).slice(2); }
  });
  const [consented, setConsented] = useState<boolean>(() => {
    // Skip consent gate entirely in builder preview mode
    if (isPreviewMode) return true;
    try {
      if (new URLSearchParams(window.location.search).get("preview") === "1") return true;
      return localStorage.getItem(`kaboom_consent_${slug}`) === "1";
    } catch { return false; }
  });

  const filmstripRef = useRef<HTMLDivElement>(null);
  const activeCardRef = useRef<HTMLButtonElement>(null);
  const firedDepths = useRef<Record<number, Set<number>>>({});
  const dragState = useRef({ dragging: false, startX: 0, scrollLeft: 0 });

  // Forward visitor identifier from URL params (or cookie fallback) to the API
  // for tag targeting + personalisation.
  // Cookie fallback: set by /api/public/click/:token when corporate email proxies
  // strip ?cid= query params from email links (Safe Links, Proofpoint, etc.).
  //
  // IMPORTANT: useState initializer (not a plain IIFE) so this value is captured
  // exactly once on mount. A plain IIFE re-runs on every render, causing the
  // kaboom_cid cookie to be gone by the second render (the mount effect clears it
  // after reading), which means the page_view track POST fires without cid and
  // the visitor_token is never linked to the contact.
  const [visitorQs] = useState<string>(() => {
    const sp = new URLSearchParams(window.location.search);
    const qs = new URLSearchParams();
    if (sp.get("cid"))     qs.set("cid",     sp.get("cid")!);
    if (sp.get("contact")) qs.set("contact", sp.get("contact")!);
    // Cookie fallback — only when URL params are absent
    if (!qs.has("cid") && !qs.has("contact")) {
      const cookieCid = document.cookie
        .split(";")
        .map(c => c.trim())
        .find(c => c.startsWith("kaboom_cid="))
        ?.split("=")?.[1];
      if (cookieCid) qs.set("cid", cookieCid);
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  });

  // In preview mode, forward ?cid from the iframe URL so token resolution is triggered.
  const previewCid = isPreviewMode
    ? (new URLSearchParams(window.location.search).get("cid") ?? null)
    : null;

  const { data: journey, isLoading, error } = useQuery<JourneyData>({
    queryKey: isPreviewMode
      ? ["builder-preview-journey", previewJourneyId, previewCid]
      : ["public-journey", slug, visitorQs],
    queryFn: () => isPreviewMode
      ? fetch(
          `/api/journeys/${previewJourneyId}/builder-preview${previewCid ? `?cid=${encodeURIComponent(previewCid)}` : ""}`,
          { credentials: "include" },
        ).then(async r => {
          if (!r.ok) throw new Error("Journey not found");
          return r.json();
        })
      : fetch(`/api/public/journeys/${slug}${visitorQs}`, {
          headers: { "x-visitor-token": visitorToken },
        }).then(async r => {
          if (!r.ok) throw new Error("Not found");
          return r.json();
        }),
    retry: false,
  });

  // Auto-scroll filmstrip to active card
  useEffect(() => {
    activeCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIndex]);

  // Track visited pages for completion indicator
  useEffect(() => {
    setVisitedPages(prev => {
      if (prev.has(currentIndex)) return prev;
      return new Set([...prev, currentIndex]);
    });
  }, [currentIndex]);

  // Embed loading skeleton — show shimmer briefly on every page change
  useEffect(() => {
    setEmbedLoading(true);
    const t = setTimeout(() => setEmbedLoading(false), 500);
    return () => clearTimeout(t);
  }, [currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        const gating = journey?.pages?.[currentIndex]?.gatingAction ?? "none";
        if (isSequential && gating !== "none" && !pageUnlocked) return;
        goNext();
      } else if (e.key === "ArrowLeft") goPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const pages = journey?.pages ?? [];
  const currentPage = pages[currentIndex] ?? null;

  // Public journeys are indexable; builder previews are explicitly not. Re-run
  // whenever the viewer changes page so deep links and in-view navigation retain
  // accurate canonical, social, and structured metadata.
  useEffect(() => {
    if (!journey) return;
    setPublicJourneySeo({
      journeyName: journey.name,
      description: journey.description,
      pageTitle: currentPage?.title,
      imageUrl: journey.headerLogoUrl ?? journey.clientLogoUrl,
      canonicalPath: !isPreviewMode && slug && currentPage
        ? `/play/${encodeURIComponent(slug)}/${toPageSlug(currentPage.title, currentIndex)}`
        : window.location.pathname,
      noIndex: isPreviewMode,
    });
  }, [journey, currentPage, currentIndex, isPreviewMode, slug]);

  // Clamp saved progress index to valid range once pages are known
  useEffect(() => {
    if (pages.length > 0 && currentIndex >= pages.length) {
      setCurrentIndex(pages.length - 1);
    }
  }, [pages.length, currentIndex]);

  // Resolve pageSlug → currentIndex once on initial load (fires when pages arrive from API).
  // setPageSlugResolved(true) is called in the SAME batched update as setCurrentIndex so that
  // the URL sync effect sees the correct index on its first run (not index 0).
  useEffect(() => {
    if (!pageSlug || pages.length === 0 || pageSlugInitDone.current) return;
    pageSlugInitDone.current = true;
    const idx = pages.findIndex((p: any) =>
      toPageSlug(p.title ?? "", p.sortOrder ?? 0) === pageSlug
    );
    if (idx >= 0 && idx !== currentIndex) setCurrentIndex(idx);
    setPageSlugResolved(true); // open the URL-sync gate after the correct index is set
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSlug, pages.length]);

  // Sync URL to /:clientSlug/play/:journeySlug/:pageSlug whenever the active page changes.
  // Rules:
  //  1. Use window.history.replaceState directly (NOT wouter's navigate) so the router does NOT
  //     re-evaluate routes — calling navigate() caused the <Switch> to switch from the no-pageSlug
  //     route to the with-pageSlug route, unmounting and remounting this component and losing state.
  //  2. Gate on pageSlugResolved so we don't fire with currentIndex=0 before the pageSlug init
  //     effect has had a chance to set the correct index.  Both effects fire in the same React tick
  //     when pages first load; without the gate, this effect sees the pre-update currentIndex=0 and
  //     briefly redirects to page 0, even when the user arrived directly at e.g. /exclusive-access.
  useEffect(() => {
    if (!pageSlugResolved) return;
    if (!slug || !pages.length || isPreviewMode) return;
    const page = pages[currentIndex] as any;
    if (!page) return;
    const ps = toPageSlug(page.title ?? "", page.sortOrder ?? currentIndex);
    const clientSl = slugify(journey?.clientName ?? "");
    const base = clientSl ? `/${clientSl}/play/${slug}/${ps}` : `/play/${slug}/${ps}`;
    const search = window.location.search; // preserve ?cid= and other params
    window.history.replaceState(null, "", `${base}${search}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, slug, journey?.clientName, pages.length, isPreviewMode, pageSlugResolved]);


  // Persist banner dismissals to localStorage
  useEffect(() => {
    try {
      Object.keys(localStorage).filter(k => k.startsWith("banner_dismissed_")).forEach(k => localStorage.removeItem(k));
      dismissedBanners.forEach(id => localStorage.setItem(`banner_dismissed_${id}`, "1"));
    } catch { /* ignore */ }
  }, [dismissedBanners]);

  // Fetch page components when page changes
  useEffect(() => {
    // Clear components immediately so the popup trigger effect's cleanup runs
    // before new components arrive, tearing down any lingering timers/listeners.
    setPageComponents([]);
    setActiveModalFormId(null);
    setModalDeliveryAssetId(null);
    setActivePopupCompId(null);
    setFiredPopupComps(new Set());
    if (!journey?.id || !currentPage?.id) return;
    fetch(`/api/public/journey/${journey.id}/page/${currentPage.id}/components${visitorQs}`, {
      headers: { "x-visitor-token": visitorToken },
    })
      .then(r => r.ok ? r.json() : [])
      .then((data: PageComponent[] | { components: PageComponent[] }) =>
        setPageComponents(Array.isArray(data) ? data : (data.components ?? [])))
      .catch(() => setPageComponents([]));
  }, [journey?.id, currentPage?.id, visitorQs]);

  // On first arrival via email link: bind the browser's persistent visitor token
  // to this contact so future visits (without cid) are still recognised.
  // Reads from URL params first; falls back to cookie set by the click-redirect
  // endpoint (corporate email proxies may strip query params but never cookies).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    let cid = sp.get("cid");
    let contact = sp.get("contact");

    // Cookie fallback — same logic as visitorQs above
    if (!cid && !contact) {
      const cookieCid = document.cookie
        .split(";")
        .map(c => c.trim())
        .find(c => c.startsWith("kaboom_cid="))
        ?.split("=")?.[1];
      if (cookieCid) {
        cid = cookieCid;
        // Clear after reading so return visits are not mis-attributed
        document.cookie = "kaboom_cid=; Max-Age=0; Path=/";
        document.cookie = "kaboom_tid=; Max-Age=0; Path=/";
      }
    }

    if ((cid || contact) && visitorToken) {
      fetch("/api/public/visitor-identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorToken, cid: cid ?? undefined, contact: contact ?? undefined }),
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // Track time-on-page: record entry time, send duration when leaving
  const pageEntryRef = useRef<{ pageId: number; startAt: number } | null>(null);

  // Fire page_view event on each page change.
  // Also gated on pageSlugResolved: when a pageSlug prop is provided (e.g. /exclusive-access),
  // currentPage starts at index 0 until the init effect resolves the correct index.
  // Without this gate, a false page_view fires for page 0 in the same React tick,
  // creating a wrong activity_event and a wrong journey_event before the real page is known.
  useEffect(() => {
    if (!pageSlugResolved) return;
    if (!journey?.id || !currentPage?.id) return;

    // Send duration for the PREVIOUS page before tracking the new one
    const prev = pageEntryRef.current;
    if (prev && prev.pageId !== currentPage.id && slug) {
      const durationSec = Math.round((Date.now() - prev.startAt) / 1000);
      if (durationSec > 0) {
        fetch(`/api/public/journeys/${slug}/track`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "time_spent",
            pageId: prev.pageId,
            visitorToken,
            duration: durationSec,
          }),
        }).catch(() => {});
      }
    }

    // Record entry time for this page
    pageEntryRef.current = { pageId: currentPage.id, startAt: Date.now() };

    // Journey analytics — stores in journey_events table
    fetch("/api/public/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journeyId: journey.id,
        pageId: currentPage.id,
        eventType: "page_view",
        visitorToken,
        pageUrl: window.location.href,
      }),
    }).catch(() => {});
    // Contact scoring — updates lead_score + stage tags via hierarchy
    // visitorToken alone is enough after the initial identity association above
    if (slug) {
      const sp = new URLSearchParams(visitorQs.replace(/^\?/, ""));
      fetch(`/api/public/journeys/${slug}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "page_view",
          pageId: currentPage.id,
          visitorToken,
          cid: sp.get("cid") ?? undefined,
          contact: sp.get("contact") ?? undefined,
          referrer: document.referrer || undefined,
          utmSource: new URLSearchParams(window.location.search).get("utm_source") ?? undefined,
          pageUrl: window.location.href,
        }),
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey?.id, currentPage?.id, pageSlugResolved]);

  // On tab close / navigation away: send duration for the current page (fallback for desktop)
  useEffect(() => {
    const handleUnload = () => {
      const entry = pageEntryRef.current;
      if (!entry || !slug) return;
      const durationSec = Math.round((Date.now() - entry.startAt) / 1000);
      if (durationSec > 0) {
        const payload = JSON.stringify({
          event: "time_spent",
          pageId: entry.pageId,
          visitorToken,
          duration: durationSec,
        });
        navigator.sendBeacon(`/api/public/journeys/${slug}/track`, new Blob([payload], { type: "application/json" }));
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, visitorToken]);

  // Heartbeat: increment duration every 15 s — works in mobile WebViews where
  // beforeunload / sendBeacon are unreliable (Gmail app, Outlook app, etc.)
  useEffect(() => {
    if (!journey?.id || !currentPage?.id || !slug) return;
    const DELTA = 15;
    const id = setInterval(() => {
      fetch(`/api/public/journeys/${slug}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "heartbeat",
          pageId: currentPage.id,
          visitorToken,
          delta: DELTA,
        }),
      }).catch(() => {});
    }, DELTA * 1000);

    return () => {
      clearInterval(id);
      // On page-change / unmount: flush the sub-15 s remainder via sendBeacon
      const entry = pageEntryRef.current;
      if (!entry || entry.pageId !== currentPage.id) return;
      const elapsed  = Math.round((Date.now() - entry.startAt) / 1000);
      const remainder = elapsed % DELTA;
      if (remainder > 1) {
        navigator.sendBeacon(
          `/api/public/journeys/${slug}/track`,
          new Blob([JSON.stringify({
            event: "heartbeat",
            pageId: currentPage.id,
            visitorToken,
            delta: remainder,
          })], { type: "application/json" }),
        );
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey?.id, currentPage?.id, slug, visitorToken]);


  // Popup form auto-trigger — fires the first unfired popup form on this page
  useEffect((): (() => void) | void => {
    const popupComps = pageComponents
      .filter(c => c.componentType === "form" && c.position === "popup" && c.formConfig)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Find first component that hasn't been fired yet
    const target = popupComps.find(c => !firedPopupComps.has(c.id));
    if (!target) return undefined;

    const trigger = (target.overrideConfig?.popupTrigger ?? { type: "load" }) as {
      type?: "load" | "delay" | "scroll";
      delaySec?: number;
      scrollPct?: number;
    };

    const fire = () => {
      setFiredPopupComps(prev => new Set([...prev, target.id]));
      setActivePopupCompId(target.id);
      setActiveModalFormId(target.componentId);
      setModalDeliveryAssetId(target.formConfig?.onSubmit?.deliveryAssetId ?? null);
    };

    if (trigger.type === "delay") {
      const ms = Math.max(1, (trigger.delaySec ?? 5)) * 1000;
      const t = setTimeout(fire, ms);
      return () => clearTimeout(t);
    }

    if (trigger.type === "scroll") {
      const pct = trigger.scrollPct ?? 50;

      // Defer the DOM query so that PageRenderer has had a chance to mount
      // its inner content (e.g. the overflow-y-auto div for HTML pages).
      let listenerCleanup: (() => void) | undefined;
      const attachTimerId = setTimeout(() => {
        const embedEl = embedRef.current;
        if (!embedEl) { fire(); return; }

        // Find the first scrollable descendant within the embed frame.
        // PageRenderer wraps HTML content in an overflow-y-auto div; other
        // page types (youtube/pdf/iframe/infographic) are not scrollable —
        // treat those as "immediately reached" and fire right away.
        const scrollEl = Array.from(embedEl.querySelectorAll("*")).find(el => {
          const style = window.getComputedStyle(el);
          return (
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight
          );
        }) as HTMLElement | undefined;

        if (!scrollEl) {
          // No scrollable content — fire immediately as a sensible default.
          fire();
          return;
        }

        const onScroll = () => {
          const { scrollTop, scrollHeight, clientHeight } = scrollEl;
          const scrolled =
            scrollHeight <= clientHeight
              ? 100
              : (scrollTop / (scrollHeight - clientHeight)) * 100;
          if (scrolled >= pct) {
            scrollEl.removeEventListener("scroll", onScroll);
            listenerCleanup = undefined;
            fire();
          }
        };
        scrollEl.addEventListener("scroll", onScroll, { passive: true });
        listenerCleanup = () => scrollEl.removeEventListener("scroll", onScroll);
        // Check once immediately in case the element is already scrolled past the threshold.
        onScroll();
      }, 150);

      return () => {
        clearTimeout(attachTimerId);
        listenerCleanup?.();
      };
    }

    // Default: "load" — fire immediately
    fire();
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageComponents]);

  // Scroll depth — time-on-page milestones per page (25% @ 1.5s, 50% @ 10s, 75% @ 30s, 100% @ 60s)
  useEffect(() => {
    if (!currentPage?.id || !journey?.id) return;
    const pageId   = currentPage.id;
    const journeyId = journey.id;
    const pageTitle = currentPage.title;
    const vt = visitorToken;

    const fire = (depth: 25 | 50 | 75 | 100) => {
      if (!firedDepths.current[pageId]) firedDepths.current[pageId] = new Set();
      if (firedDepths.current[pageId].has(depth)) return;
      firedDepths.current[pageId].add(depth);
      fetch("/api/public/track/scroll-depth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journeyId, pageId, pageTitle, depth, visitorToken: vt }),
      }).catch(() => {});
    };

    const timers = [
      setTimeout(() => fire(25),  1_500),
      setTimeout(() => fire(50),  10_000),
      setTimeout(() => fire(75),  30_000),
      setTimeout(() => fire(100), 60_000),
    ];
    return () => timers.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage?.id]);

  // Persist progress per journey slug (skip in preview mode)
  useEffect(() => {
    if (isPreviewMode) return;
    try { localStorage.setItem(`pf_journey_progress_${slug}`, String(currentIndex)); } catch { /* ignore */ }
  }, [isPreviewMode, slug, currentIndex]);

  // Reset gate when navigating to a new page
  useEffect(() => {
    setPageUnlocked(false);
  }, [currentIndex]);

  const goTo = useCallback((newIdx: number) => {
    // Block ALL forward navigation when sequential gate is active on the current page
    if (newIdx > currentIndex) {
      const sequential = (journey?.navigationMode ?? "free") === "sequential";
      const gating = (pages[currentIndex]?.gatingAction ?? "none") as string;
      if (sequential && gating !== "none" && !pageUnlocked) return;
    }
    setDirection(newIdx > currentIndex ? 1 : -1);
    setCurrentIndex(newIdx);
    setMobileNavOpen(false);
  }, [currentIndex, journey, pages, pageUnlocked]);

  const goNext = useCallback(() => {
    if (currentIndex < pages.length - 1) goTo(currentIndex + 1);
    else setCompleted(true);
  }, [currentIndex, pages.length, goTo]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) goTo(currentIndex - 1);
  }, [currentIndex, goTo]);

  const trackBannerClick = useCallback((compId: number) => {
    if (!journey?.id || !currentPage?.id) return;
    fetch("/api/public/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journeyId: journey.id, pageId: currentPage.id, componentId: compId, eventType: "banner_click", visitorToken }),
    }).catch(() => {});
  }, [journey?.id, currentPage?.id, visitorToken]);

  const trackBannerDismiss = useCallback((compId: number) => {
    if (!journey?.id || !currentPage?.id) return;
    fetch("/api/public/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journeyId: journey.id,
        pageId: currentPage.id,
        componentId: compId,
        eventType: "banner_dismiss",
        visitorToken,
      }),
    }).catch(() => {});
  }, [journey?.id, currentPage?.id, visitorToken]);

  const handleCtaClick = useCallback((comp: PageComponent) => {
    const actionType = comp.ctaActionType ?? "";
    const config = comp.ctaActionConfig ?? {};
    const override = comp.overrideConfig ?? {};

    // Unlock gate on CTA click (sequential mode)
    if (currentPage?.gatingAction === "cta_click") {
      setPageUnlocked(true);
    }

    // Fire cta_click analytics event (fire-and-forget)
    if (journey?.id && currentPage?.id) {
      fetch("/api/public/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journeyId: journey.id,
          pageId: currentPage.id,
          componentId: comp.id,
          eventType: "cta_click",
          visitorToken,
          pageUrl: window.location.href,
          ctaUrl: actionType === "url" ? (config.url ?? undefined) : undefined,
        }),
      }).catch(() => {});
    }

    if (actionType === "url") {
      const url = config.url ?? "";
      if (config.openInNewTab !== false) window.open(url, "_blank", "noreferrer");
      else window.location.href = url;
    } else if (actionType === "download") {
      const assetId = config.assetId;
      if (!assetId || !journey) return;
      toast({ title: "Preparing download…", description: "Your file will download shortly." });
      fetch(`/api/public/assets/${assetId}/request-download?journeyId=${journey.id}&visitorToken=${visitorToken}`)
        .then(r => r.json())
        .then(({ signedUrl, filename }: { signedUrl: string; filename: string }) => {
          const a = document.createElement("a");
          a.href = signedUrl; a.download = filename ?? "download"; a.target = "_blank";
          document.body.appendChild(a); a.click(); setTimeout(() => document.body.removeChild(a), 500);
          toast({ title: `Downloading: ${filename ?? "file"}` });
        }).catch(() => { toast({ title: "Download failed", variant: "destructive" }); });
    } else if (actionType === "gated_form") {
      setActiveModalFormId(config.formId ?? null);
      setModalDeliveryAssetId(config.deliveryAssetId ?? null);
    } else if (actionType === "just_submit") {
      setActiveModalFormId(config.formId ?? null);
      setModalDeliveryAssetId(null);
    } else if (actionType === "jump_page") {
      const pageOrder = override.pageOrder ?? config.pageOrder ?? 1;
      goTo(pageOrder - 1);
    }
  }, [journey, visitorToken, goTo]);

  // ── Loading / error states ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-[#0d0d0d] flex items-center justify-center">
        <Loader2 className="w-7 h-7 animate-spin text-white/30" />
      </div>
    );
  }

  if (error || !journey) {
    return (
      <div className="fixed inset-0 bg-[#0d0d0d] flex flex-col items-center justify-center gap-5 text-white">
        <div className="text-5xl">🔒</div>
        <h1 className="text-2xl font-semibold">Journey not found</h1>
        <p className="text-white/40 text-center max-w-xs text-sm">
          This journey may not exist or hasn't been published yet.
        </p>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="fixed inset-0 bg-[#0d0d0d] flex flex-col items-center justify-center gap-4 text-white">
        <div className="text-5xl">📭</div>
        <h1 className="text-xl font-semibold">No pages in this journey</h1>
      </div>
    );
  }

  if (completed) {
    return <CompletedScreen journey={journey} onRestart={() => { setCompleted(false); goTo(0); }} />;
  }

  // ── Theme & navigation mode ────────────────────────────────────────────────
  const isDark = (journey.theme ?? "dark") !== "light";
  const isSequential = (journey.navigationMode ?? "free") === "sequential";

  // ── Consent gate — shown before any journey content ───────────────────────
  if (!consented) {
    return (
      <ConsentGate
        slug={slug ?? ""}
        isDark={isDark}
        onAccept={() => setConsented(true)}
      />
    );
  }

  const isFirst = currentIndex === 0;
  const isLast  = currentIndex === pages.length - 1;
  const progress = ((currentIndex + 1) / pages.length) * 100;

  // ── Theme helpers ──────────────────────────────────────────────────────────
  const t = {
    root:       isDark ? "bg-black text-white"             : "bg-[#f8f8f8] text-gray-900",
    topbar:     isDark ? "border-white/[0.06] bg-black/50 backdrop-blur-xl" : "border-black/[0.05] bg-white/70 backdrop-blur-xl shadow-sm",
    topbarSide: isDark ? "border-white/[0.06]"            : "border-black/[0.05]",
    nameText:   isDark ? "text-white/50"                  : "text-gray-500",
    dot:        {
      active:   isDark ? "bg-white"                       : "bg-indigo-600",
      done:     isDark ? "bg-white/40"                    : "bg-indigo-300",
      todo:     isDark ? "bg-white/15"                    : "bg-gray-200",
    },
    progress:   isDark ? "bg-white/[0.04]"                : "bg-gray-100",
    navBtn:     isDark ? "bg-white/10 hover:bg-white/20"  : "bg-black/5 hover:bg-black/10",
    navIcon:    isDark ? "text-white"                     : "text-gray-700",
    titleGrad:  isDark ? "from-black/50 to-transparent"   : "from-white/70 to-transparent",
    titleText:  isDark ? "text-white"                     : "text-gray-800",
    filmstrip:  isDark ? "bg-black/50 border-white/5"     : "bg-white border-gray-100",
  };

  const zb = journey.zoneBanners ?? { top: [], bottom: [], sidebar: [] };
  const zoneBanners = {
    top: zb.top ?? [],
    bottom: zb.bottom ?? [],
    sidebar: zb.sidebar ?? [],
    popup: (zb as { popup?: ZoneBannerItem[] }).popup ?? [],
  };
  const zoneSettings = journey.zoneSettings ?? {};
  const topZoneSettings = zoneSettings.top ?? { rotationIntervalSeconds: 5, mobileBehavior: "hide" as const };
  const bottomZoneSettings = zoneSettings.bottom ?? { rotationIntervalSeconds: 5, mobileBehavior: "hide" as const };
  const sidebarZoneSettings = zoneSettings.sidebar ?? { rotationIntervalSeconds: 5, mobileBehavior: "hide" as const };

  // ── Apple-tier design tokens ──────────────────────────────────────────────
  const APPLE = {
    bg:       "#FBFBFD",
    surface:  "#FFFFFF",
    rail:     "#F5F5F7",
    text:     "#1D1D1F",
    secondary:"#6E6E73",
    accent:   "#0071E3",
    border:   "rgba(0,0,0,0.06)",
  } as const;

  const CARD_TINTS = [
    { bg: "#FFE4E1", accent: "#FF3B30", from: "#FFE4E1", to: "#FFF6F5" },  // blush / coral
    { bg: "#E3F0FF", accent: "#0071E3", from: "#E3F0FF", to: "#F5FAFF" },  // mist / blue
    { bg: "#E8F3EC", accent: "#34A853", from: "#E8F3EC", to: "#F6FBF7" },  // sage / green
    { bg: "#FBF1E4", accent: "#FF9500", from: "#FBF1E4", to: "#FEF9F1" },  // sand / amber
    { bg: "#EFE9FB", accent: "#8E44AD", from: "#EFE9FB", to: "#F8F5FD" },  // lavender / purple
  ] as const;

  const PAGE_EYEBROW: Record<string, string> = {
    youtube: "VIDEO", pdf: "DOCUMENT", iframe: "WEB PAGE",
    html: "CONTENT", infographic: "VISUAL",
  };

  const getPageIcon = (type: string) =>
    ({ youtube: Youtube, pdf: FileText, iframe: Globe, html: Code2, infographic: Image } as Record<string, React.ElementType>)[type] ?? FileText;

  const activeTint = CARD_TINTS[currentIndex % CARD_TINTS.length];
  const allVisited = pages.length > 0 && visitedPages.size >= pages.length;

  // ── Main viewer layout — Apple ABM journey ────────────────────────────────
  return (
    <div
      className="fixed inset-0 mx-auto overflow-hidden select-none max-w-[1440px] shadow-[0_0_0_1px_rgba(0,0,0,0.04)]"
      style={{
        background: APPLE.bg,
        color: APPLE.text,
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
        isolation: "isolate",
        ...viewerBgToCss(journey.viewerBg ?? null),
      }}
    >
      <ViewerBgLayer bg={journey.viewerBg ?? null} />
      <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ zIndex: 1 }}>
      <style>{`
        html, body { background: #F5F5F7 !important; overflow: hidden !important; height: 100% !important; margin: 0 !important; }
        iframe { border: 0 !important; scrollbar-width: none; }
        iframe::-webkit-scrollbar { display: none; width: 0; height: 0; }
        .pf-rail-scroll::-webkit-scrollbar { width: 4px; }
        .pf-rail-scroll::-webkit-scrollbar-track { background: transparent; }
        .pf-rail-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0); border-radius: 4px; transition: background 0.2s; }
        .pf-rail-scroll:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); }
        @keyframes pfShimmer {
          0%   { background-position: -800px 0; }
          100% { background-position:  800px 0; }
        }
        .pf-shimmer {
          background-image: linear-gradient(90deg, #F5F5F7 0%, #FAFAFA 50%, #F5F5F7 100%);
          background-size: 800px 100%;
          animation: pfShimmer 1.6s linear infinite;
        }
      `}</style>

      {/* ════════════════════════════════════════════════════════════
          TOP BAR — frosted glass, logo · identity · progress + CTA
      ════════════════════════════════════════════════════════════ */}
      {/* Optional top_bar banner — only renders when configured */}
      {(() => {
        const topBarComp = pageComponents.find(
          c => c.componentType === "banner" && resolvePosition(c) === "top_bar" && !dismissedBanners.has(c.id),
        );
        if (!topBarComp) return null;
        return (
          <div className="shrink-0 z-30" style={{ background: APPLE.surface, borderBottom: `1px solid ${APPLE.border}` }}>
            <InlineBannerStrip
              comp={topBarComp} isDark={false}
              onDismiss={() => setDismissedBanners(s => new Set([...s, topBarComp.id]))}
              onTrackClick={() => trackBannerClick(topBarComp.id)}
              onTrackDismiss={() => trackBannerDismiss(topBarComp.id)}
            />
          </div>
        );
      })()}

      {/* Zone: top banner strip (full-width, below top bar) */}
      {zoneBanners.top.length > 0 && (
        <TopBanner
          banners={zoneBanners.top}
          rotationIntervalSeconds={topZoneSettings.rotationIntervalSeconds}
          mobileBehavior={topZoneSettings.mobileBehavior}
          journeyId={journey?.id}
          visitorToken={visitorToken}
        />
      )}

      {/* ════════════════════════════════════════════════════════════
          MAIN AREA — left card rail + center canvas
      ════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex overflow-hidden">

        {/* ─── LEFT RAIL — editorial document-style nav (desktop only) ─── */}
        <div
          role="tablist"
          aria-label="Journey pages"
          className="hidden md:flex w-[240px] shrink-0 flex-col overflow-hidden"
          style={{ background: APPLE.surface, borderRight: `1px solid ${APPLE.border}` }}
        >
          {/* Rail header — logo chip + CTA */}
          <div className="shrink-0 flex flex-col items-stretch gap-4 px-5 pt-7 pb-5">
            <div className="flex justify-center">
              {(journey.headerLogoUrl ?? journey.clientLogoUrl) ? (
                <div
                  className="flex items-center justify-center shrink-0"
                  style={{
                    width: journey.headerLogoShowBg !== false ? 56 : undefined,
                    height: journey.headerLogoShowBg !== false ? 56 : undefined,
                    borderRadius: journey.headerLogoShowBg !== false ? 28 : undefined,
                    background: journey.headerLogoShowBg !== false ? "#F2F2F4" : undefined,
                  }}
                >
                  <img
                    src={journey.headerLogoUrl ?? journey.clientLogoUrl!}
                    alt={`${journey.clientName ?? journey.name} logo`}
                    width={112}
                    height={112}
                    decoding="async"
                    className="max-h-9 max-w-10 object-contain"
                  />
                </div>
              ) : (
                <div
                  className="flex items-center justify-center shrink-0"
                  style={{ width: 56, height: 56, borderRadius: 28, background: APPLE.text }}
                >
                  <Zap className="w-6 h-6 text-white" />
                </div>
              )}
            </div>
            {!!journey.headerBtnText && (
              <div
                className="w-full"
                style={allVisited ? { borderRadius: 999, outline: `2px solid ${APPLE.accent}`, outlineOffset: 2 } : {}}
              >
                <RailCtaButton journey={journey} goTo={goTo} />
              </div>
            )}
          </div>

          {/* Editorial nav list */}
          <div className="px-2.5 pb-6 pt-1 flex-1 overflow-y-auto pf-rail-scroll flex flex-col gap-0.5">
            {pages.map((page, idx) => {
              const isActive  = idx === currentIndex;
              const isLocked  = isSequential && idx > currentIndex && (currentPage?.gatingAction ?? "none") !== "none" && !pageUnlocked;
              const CardIcon  = RAIL_ICONS[idx % RAIL_ICONS.length];

              return (
                <button
                  key={page.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => { if (!isLocked) goTo(idx); }}
                  disabled={isLocked}
                  className="group relative w-full text-left rounded-xl transition-colors px-3 py-2.5 flex items-start gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{
                    background: isActive ? "#F2F2F4" : "transparent",
                    cursor: isLocked ? "not-allowed" : "pointer",
                  }}
                  onMouseEnter={e => { if (!isActive && !isLocked) e.currentTarget.style.background = "rgba(0,0,0,0.025)"; }}
                  onMouseLeave={e => { if (!isActive && !isLocked) e.currentTarget.style.background = "transparent"; }}
                >
                  <CardIcon
                    style={{
                      width: 16, height: 16, marginTop: 2, flexShrink: 0,
                      color: isLocked ? "rgba(0,0,0,0.25)" : isActive ? APPLE.text : APPLE.secondary,
                    }}
                  />
                  <span
                    className="flex-1 min-w-0 leading-snug"
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                      color: isLocked ? "rgba(0,0,0,0.3)" : isActive ? APPLE.text : "#3A3A3C",
                    }}
                  >
                    {page.title}
                  </span>
                  {isLocked && (
                    <Lock style={{ width: 12, height: 12, marginTop: 4, color: "rgba(0,0,0,0.3)", flexShrink: 0 }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── CENTER CANVAS ─── */}
        <div
          role="tabpanel"
          aria-live="polite"
          className="flex-1 flex flex-col overflow-hidden relative"
          style={{ background: APPLE.bg }}
        >
          {/* Top-strip page banners / CTAs */}
          {(() => {
            const stripComps = pageComponents.filter(c => resolvePosition(c) === "top_strip" && !dismissedBanners.has(c.id));
            if (!stripComps.length) return null;
            return (
              <div className="shrink-0 flex flex-col z-10">
                {stripComps.map(comp =>
                  comp.componentType === "banner" ? (
                    <InlineBannerStrip key={comp.id} comp={comp} isDark={isDark}
                      onDismiss={() => setDismissedBanners(s => new Set([...s, comp.id]))}
                      onTrackClick={() => trackBannerClick(comp.id)}
                      onTrackDismiss={() => trackBannerDismiss(comp.id)} />
                  ) : comp.componentType === "cta" ? (
                    <div key={comp.id} className="flex items-center justify-center gap-3 px-4 py-2 border-b shrink-0 z-10" style={{ borderColor: APPLE.border }}>
                      <CtaButton comp={comp} onClick={() => handleCtaClick(comp)} />
                    </div>
                  ) : null
                )}
              </div>
            );
          })()}

          {/* Content + optional sidebar banner */}
          <div className={cn(
            "flex-1 flex overflow-hidden relative z-10",
            zoneBanners.sidebar.length > 0 && sidebarZoneSettings.mobileBehavior === "show" ? "flex-col md:flex-row" : "",
          )}>

            {/* Padded content stage — floating rounded window */}
            <div className="flex-1 relative overflow-hidden p-5 md:p-8">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={currentPage?.id}
                  custom={direction}
                  variants={{
                    enter:  (dir: number) => ({
                      opacity: 0,
                      scale: 0.97,
                      x: dir > 0 ? 18 : dir < 0 ? -18 : 0,
                      filter: "blur(6px)",
                    }),
                    center: {
                      opacity: 1,
                      scale: 1,
                      x: 0,
                      filter: "blur(0px)",
                      transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
                    },
                    exit:   (dir: number) => ({
                      opacity: 0,
                      scale: 1.02,
                      x: dir > 0 ? -12 : dir < 0 ? 12 : 0,
                      filter: "blur(4px)",
                      transition: { duration: 0.32, ease: [0.4, 0, 1, 1] },
                    }),
                  }}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  className="absolute top-6 left-6 right-6 bottom-[80px] md:inset-8"
                  style={{ willChange: "transform, opacity, filter", transformOrigin: "center center" }}
                >
                  {/* Framed embed card — embed shows its own chrome */}
                  <div
                    ref={embedRef}
                    className="w-full h-full overflow-hidden relative"
                    style={{
                      borderRadius: 20,
                      background:   APPLE.surface,
                      border:       `1px solid ${APPLE.border}`,
                      boxShadow:    "0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.06)",
                    }}
                  >
                    {currentPage && (
                      <PageRenderer
                        page={currentPage}
                        isDark={isDark}
                        journeySlug={slug}
                        visitorQs={visitorQs}
                        journeyId={journey?.id}
                        visitorToken={visitorToken}
                        onGoToPage={goTo}
                      />
                    )}
                    <AnimatePresence>
                      {embedLoading && (
                        <motion.div
                          key="skeleton"
                          initial={{ opacity: 1 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                          className="absolute inset-0 pointer-events-none pf-shimmer"
                          style={{ background: "#F5F5F7" }}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              </AnimatePresence>

              {/* CTA overlay — suppressed when floating page-component CTAs are present */}
              {currentPage?.ctaEnabled && currentPage.ctaText &&
                !pageComponents.some(c => c.componentType === "cta" && resolvePosition(c) === "floating") && (
                <div className="absolute bottom-[88px] right-6 z-20 md:bottom-14 md:right-14">
                  <button
                    onClick={async () => {
                      if (currentPage.gatingAction === "cta_click") setPageUnlocked(true);
                      const type = currentPage.ctaType ?? "next";
                      if (type === "download" && currentPage.ctaAssetUrl) {
                        const assetHref = currentPage.ctaAssetUrl;
                        try {
                          const resp = await fetch(assetHref);
                          const blob = await resp.blob();
                          const blobUrl = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = blobUrl;
                          a.download = currentPage.title || "download";
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                        } catch {
                          window.open(assetHref, "_blank", "noreferrer noopener");
                        }
                      } else if (type === "gated_download" && currentPage.ctaAssetUrl) {
                        window.open(currentPage.ctaAssetUrl, "_blank", "noreferrer noopener");
                      } else if (type === "url" && currentPage.ctaAssetUrl) {
                        window.open(currentPage.ctaAssetUrl, "_blank", "noreferrer noopener");
                      } else if (type === "page" && currentPage.ctaAssetUrl) {
                        const targetId = parseInt(currentPage.ctaAssetUrl, 10);
                        const idx = pages.findIndex(p => p.id === targetId);
                        if (idx >= 0) goTo(idx); else goNext();
                      } else {
                        goNext();
                      }
                    }}
                    onMouseDown={e => { e.currentTarget.style.transform = "scale(0.97)"; }}
                    onMouseUp={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    onMouseEnter={e => { e.currentTarget.style.background = "#000"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.background = "#1D1D1F"; }}
                    style={{
                      padding:      "10px 22px",
                      borderRadius: 999,
                      background:   "#1D1D1F",
                      color:        "white",
                      fontSize:     14,
                      fontWeight:   500,
                      border:       "none",
                      cursor:       "pointer",
                      boxShadow:    "0 8px 24px rgba(0,0,0,0.18)",
                      transition:   "transform 0.15s cubic-bezier(0.4,0,0.2,1), background 0.15s",
                      display:      "inline-flex",
                      alignItems:   "center",
                      gap:          8,
                    }}
                  >
                    {currentPage.ctaText}
                    <span style={{ fontSize: 16, lineHeight: 1 }}>→</span>
                  </button>
                </div>
              )}

              {/* Default "Next →" pill — when no per-page CTA and not on last page */}
              {!currentPage?.ctaEnabled && currentIndex < pages.length - 1 &&
                !pageComponents.some(c => c.componentType === "cta" && resolvePosition(c) === "floating") && (
                <div className="absolute bottom-[88px] right-6 z-20 md:bottom-14 md:right-14">
                  <button
                    onClick={() => goNext()}
                    onMouseDown={e => { e.currentTarget.style.transform = "scale(0.97)"; }}
                    onMouseUp={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    onMouseEnter={e => { e.currentTarget.style.background = "#000"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.background = "#1D1D1F"; }}
                    style={{
                      padding:      "10px 22px",
                      borderRadius: 999,
                      background:   "#1D1D1F",
                      color:        "white",
                      fontSize:     14,
                      fontWeight:   500,
                      border:       "none",
                      cursor:       "pointer",
                      boxShadow:    "0 8px 24px rgba(0,0,0,0.18)",
                      transition:   "transform 0.15s cubic-bezier(0.4,0,0.2,1), background 0.15s",
                      display:      "inline-flex",
                      alignItems:   "center",
                      gap:          8,
                    }}
                  >
                    Next
                    <span style={{ fontSize: 16, lineHeight: 1 }}>→</span>
                  </button>
                </div>
              )}
            </div>

            {/* Zone: Sidebar banner */}
            {/* Sidebar zone removed — popup banners are used instead to avoid shrinking the hero */}
          </div>

          {/* Inline components (banners / CTAs / forms below the content) */}
          {(() => {
            const inlineComps = pageComponents.filter(c => resolvePosition(c) === "inline" && !dismissedBanners.has(c.id));
            if (!inlineComps.length) return null;
            return (
              <div
                className="shrink-0 flex flex-col gap-2 px-5 py-3 border-t overflow-y-auto max-h-40 md:max-h-52 z-10"
                style={{ borderColor: APPLE.border, background: "#FAFAFA" }}
              >
                {inlineComps.map(comp =>
                  comp.componentType === "banner" ? (
                    <InlineBannerStrip key={comp.id} comp={comp} isDark={isDark}
                      onDismiss={() => setDismissedBanners(s => new Set([...s, comp.id]))}
                      onTrackClick={() => trackBannerClick(comp.id)}
                      onTrackDismiss={() => trackBannerDismiss(comp.id)} />
                  ) : comp.componentType === "cta" ? (
                    <div key={comp.id} className="flex justify-center py-1">
                      <CtaButton comp={comp} onClick={() => handleCtaClick(comp)} />
                    </div>
                  ) : comp.componentType === "form" && comp.formConfig ? (
                    <div key={comp.id} className="rounded-2xl border p-4 bg-white" style={{ borderColor: APPLE.border }}>
                      <PublicFormRenderer
                        formId={comp.componentId} config={comp.formConfig}
                        journeyId={journey.id} pageId={currentPage!.id}
                        visitorToken={visitorToken} isDark={isDark}
                        deliveryAssetId={comp.formConfig?.onSubmit?.deliveryAssetId}
                        componentId={comp.id}
                        onSubmitSuccess={currentPage?.gatingAction === "form_submit" ? () => setPageUnlocked(true) : undefined}
                      />
                    </div>
                  ) : null
                )}
              </div>
            );
          })()}

          {/* Floating CTAs */}
          {pageComponents.filter(c => c.componentType === "cta" && resolvePosition(c) === "floating").map(comp => (
            <div key={comp.id} className="fixed bottom-20 md:bottom-8 right-6 z-50">
              <CtaButton comp={comp} onClick={() => handleCtaClick(comp)} />
            </div>
          ))}

          {/* Bottom bar components */}
          {pageComponents.filter(c => resolvePosition(c) === "bottom_bar" && !dismissedBanners.has(c.id)).map(comp =>
            comp.componentType === "banner" ? (
              <InlineBannerStrip key={comp.id} comp={comp} isDark={isDark}
                onDismiss={() => setDismissedBanners(s => new Set([...s, comp.id]))}
                onTrackClick={() => trackBannerClick(comp.id)}
                onTrackDismiss={() => trackBannerDismiss(comp.id)} />
            ) : comp.componentType === "cta" ? (
              <div key={comp.id} className="shrink-0 flex items-center justify-center px-4 py-2 z-10" style={{ background: "#FAFAFA" }}>
                <CtaButton comp={comp} onClick={() => handleCtaClick(comp)} />
              </div>
            ) : null
          )}

          {/* Zone: Bottom banner */}
          {zoneBanners.popup.length > 0 && (
            <PopupBanner
              banners={zoneBanners.popup}
              journeyId={journey?.id}
              visitorToken={visitorToken}
            />
          )}

          {zoneBanners.bottom.length > 0 && (
            <BottomBanner
              banners={zoneBanners.bottom}
              rotationIntervalSeconds={bottomZoneSettings.rotationIntervalSeconds}
              mobileBehavior={bottomZoneSettings.mobileBehavior}
              journeyId={journey?.id}
              visitorToken={visitorToken}
            />
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════
          MOBILE BOTTOM NAV BAR — visible only on < md screens
      ══════════════════════════════════════════════════════════════ */}
      <div
        className="flex md:hidden shrink-0 items-center z-40"
        style={{
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: `1px solid ${APPLE.border}`,
          height: 56,
        }}
      >
        {/* Prev */}
        <button
          onClick={() => goPrev()}
          disabled={currentIndex === 0}
          style={{
            width: 48, height: 56, display: "flex", alignItems: "center", justifyContent: "center",
            background: "none", border: "none", cursor: currentIndex === 0 ? "default" : "pointer",
            color: currentIndex === 0 ? "rgba(0,0,0,0.2)" : APPLE.text,
            flexShrink: 0,
          }}
        >
          <ChevronLeft style={{ width: 20, height: 20 }} />
        </button>

        {/* Page counter — tappable to open drawer */}
        <button
          onClick={() => setMobileNavOpen(o => !o)}
          style={{
            flex: 1, height: 56, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 1,
            background: "none", border: "none", cursor: "pointer",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: APPLE.text, lineHeight: 1.2 }}>
            {currentIndex + 1} / {pages.length}
          </span>
          <span style={{ fontSize: 11, color: APPLE.secondary, lineHeight: 1.2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {pages[currentIndex]?.title ?? ""}
          </span>
        </button>

        {/* Next / Done */}
        {currentIndex >= pages.length - 1 ? (
          <button
            onClick={() => goNext()}
            style={{
              width: 48, height: 56, display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: APPLE.accent, flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.02em" }}>Done</span>
          </button>
        ) : (
          <button
            onClick={() => goNext()}
            style={{
              width: 48, height: 56, display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              color: APPLE.text, flexShrink: 0,
            }}
          >
            <ChevronRight style={{ width: 20, height: 20 }} />
          </button>
        )}
      </div>

      {/* ── Mobile page-list drawer ── */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div
            key="mobile-nav-drawer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[55] md:hidden"
            style={{ background: "rgba(0,0,0,0.35)" }}
            onClick={() => setMobileNavOpen(false)}
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="absolute bottom-0 left-0 right-0 overflow-hidden"
              style={{
                background: APPLE.surface,
                borderRadius: "20px 20px 0 0",
                maxHeight: "70vh",
              }}
              onClick={e => e.stopPropagation()}
            >
              {/* Handle */}
              <div style={{ display: "flex", justifyContent: "center", paddingTop: 10, paddingBottom: 4 }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(0,0,0,0.15)" }} />
              </div>
              {/* Header */}
              <div style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 10, borderBottom: `1px solid ${APPLE.border}` }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: APPLE.secondary, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  Contents
                </span>
              </div>
              {/* Page list */}
              <div className="overflow-y-auto pf-rail-scroll" style={{ padding: "8px 12px 24px" }}>
                {pages.map((page, idx) => {
                  const isActive = idx === currentIndex;
                  const isLocked = isSequential && idx > currentIndex && (currentPage?.gatingAction ?? "none") !== "none" && !pageUnlocked;
                  const CardIcon = RAIL_ICONS[idx % RAIL_ICONS.length];
                  return (
                    <button
                      key={page.id}
                      onClick={() => { if (!isLocked) goTo(idx); }}
                      disabled={isLocked}
                      style={{
                        width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 12,
                        padding: "10px 12px", borderRadius: 12, border: "none",
                        background: isActive ? "#F2F2F4" : "transparent",
                        cursor: isLocked ? "not-allowed" : "pointer",
                        marginBottom: 2,
                      }}
                    >
                      <CardIcon style={{ width: 16, height: 16, flexShrink: 0, color: isLocked ? "rgba(0,0,0,0.2)" : isActive ? APPLE.text : APPLE.secondary }} />
                      <span style={{ flex: 1, fontSize: 14, fontWeight: isActive ? 600 : 500, color: isLocked ? "rgba(0,0,0,0.3)" : isActive ? APPLE.text : "#3A3A3C" }}>
                        {page.title}
                      </span>
                      {isLocked && <Lock style={{ width: 12, height: 12, color: "rgba(0,0,0,0.25)", flexShrink: 0 }} />}
                      {isActive && <div style={{ width: 6, height: 6, borderRadius: 3, background: APPLE.accent, flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Modal form (triggered by gated_form CTAs) ── */}
      <AnimatePresence>
        {activeModalFormId !== null && currentPage && (() => {
          const formComp = pageComponents.find(c => c.componentType === "form" && c.componentId === activeModalFormId);
          const cfg = formComp?.formConfig ?? {};
          return (
            <motion.div
              key="comp-modal-form"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40"
              onClick={e => { if (e.target === e.currentTarget) setActiveModalFormId(null); }}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="w-full max-w-md mx-4 overflow-hidden bg-white"
                style={{ borderRadius: 20, boxShadow: "0 24px 64px rgba(0,0,0,0.15)" }}
              >
                <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b" style={{ borderColor: APPLE.border }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: APPLE.text }}>
                    {cfg.heading || "Get in touch"}
                  </h3>
                  <button onClick={() => setActiveModalFormId(null)} style={{ color: APPLE.secondary, background: "none", border: "none", cursor: "pointer" }}>
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="px-5 pb-5 pt-4 max-h-[70vh] overflow-y-auto">
                  <PublicFormRenderer
                    formId={activeModalFormId}
                    config={cfg}
                    journeyId={journey.id}
                    pageId={currentPage.id}
                    visitorToken={visitorToken}
                    isDark={false}
                    deliveryAssetId={modalDeliveryAssetId ?? undefined}
                    componentId={formComp?.id}
                    onClose={() => setActiveModalFormId(null)}
                    onSubmitSuccess={currentPage.gatingAction === "form_submit" ? () => setPageUnlocked(true) : undefined}
                  />
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      <Toaster />
      </div>
    </div>
  );
}
