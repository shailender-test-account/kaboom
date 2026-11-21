import { useState, useEffect, useRef } from "react";

export interface ZoneBannerItem {
  id: number;
  name: string;
  config: Record<string, any>;
  originalWidth?: number | null;
  originalHeight?: number | null;
  fileSize?: number | null;
  imageUrl?: string | null;
}

interface ZoneBannerProps {
  banners: ZoneBannerItem[];
  rotationIntervalSeconds?: number;
  zone: "top" | "bottom" | "sidebar";
  mobileBehavior?: "hide" | "show";
  onBannerClick?: (banner: ZoneBannerItem) => void;
  journeyId?: number;
  visitorToken?: string;
}

function fireBannerEvent(
  bannerId: number,
  eventType: "impression" | "click" | "dismiss",
  opts?: { journeyId?: number; visitorToken?: string },
) {
  fetch(`/api/public/banners/${bannerId}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: eventType,
      journey_id: opts?.journeyId ?? null,
      visitor_token: opts?.visitorToken ?? null,
    }),
  }).catch(() => {});
}

// Cap to ~7% of typical viewport height so the hero content never loses
// more than 7% of vertical space to a banner.
const ZONE_HEIGHTS: Record<string, number> = {
  top: 56,
  bottom: 56,
  popup: 0,
  sidebar: 0,
};

interface BannerSlideProps {
  banner: ZoneBannerItem;
  zone: string;
  onCtaClick?: () => void;
}

function BannerSlide({ banner, zone, onCtaClick }: BannerSlideProps) {
  const cfg = banner.config ?? {};
  const imageUrl: string | undefined = cfg.imageUrl ?? banner.imageUrl ?? undefined;
  const isSidebar = zone === "sidebar";
  const containerHeight = ZONE_HEIGHTS[zone] ?? 90;

  const containerStyle: React.CSSProperties = {
    width: "100%",
    height: containerHeight,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: cfg.bgColor ?? "#4f46e5",
    position: "relative",
  };

  const imgStyle: React.CSSProperties = {
    maxWidth: "100%",
    maxHeight: "100%",
    width: "auto",
    height: "auto",
    display: "block",
  };

  if (imageUrl) {
    return (
      <div style={containerStyle}>
        <img src={imageUrl} alt={banner.name} style={imgStyle} draggable={false} />
        {(cfg.overlayText || cfg.overlaySubtext) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              padding: "8px 16px",
              alignItems: cfg.textAlignment === "center" ? "center" : cfg.textAlignment === "right" ? "flex-end" : "flex-start",
              justifyContent: cfg.textVertical === "top" ? "flex-start" : cfg.textVertical === "bottom" ? "flex-end" : "center",
            }}
          >
            {cfg.overlayText && (
              <p style={{ fontSize: cfg.headlineFontSize ?? (isSidebar ? 18 : 15), color: cfg.textColor ?? "#ffffff", fontWeight: 700, lineHeight: 1.2, textShadow: cfg.textShadow ? "0 1px 3px rgba(0,0,0,0.6)" : undefined, margin: 0 }}>
                {cfg.overlayText}
              </p>
            )}
            {cfg.overlaySubtext && (
              <p style={{ fontSize: cfg.subtextFontSize ?? (isSidebar ? 13 : 11), color: cfg.textColor ?? "#ffffff", margin: "4px 0 0", textShadow: cfg.textShadow ? "0 1px 3px rgba(0,0,0,0.5)" : undefined }}>
                {cfg.overlaySubtext}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px", width: "100%", flexDirection: isSidebar ? "column" : "row" }}>
        {cfg.heading && (
          <span style={{ color: cfg.textColor ?? "#ffffff", fontWeight: 600, fontSize: isSidebar ? 16 : 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: isSidebar ? "normal" : "nowrap", textAlign: isSidebar ? "center" : undefined }}>
            {cfg.heading}
          </span>
        )}
        {cfg.body && !isSidebar && (
          <span style={{ color: cfg.textColor ?? "#ffffff", opacity: 0.7, fontSize: 12, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cfg.body}
          </span>
        )}
        {cfg.ctaText && cfg.ctaUrl && (
          <a
            href={cfg.ctaUrl}
            target="_blank"
            rel="noreferrer"
            style={{ backgroundColor: cfg.textColor ?? "#ffffff", color: cfg.bgColor ?? "#4f46e5", padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700, textDecoration: "none", flexShrink: 0 }}
            onClick={e => { e.stopPropagation(); onCtaClick?.(); }}
          >
            {cfg.ctaText}
          </a>
        )}
      </div>
    </div>
  );
}

export function ZoneBanner({ banners, rotationIntervalSeconds = 5, zone, mobileBehavior = "hide", onBannerClick, journeyId, visitorToken }: ZoneBannerProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [visible, setVisible] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks the last banner ID for which an impression was fired in this instance.
  // Fires a new impression whenever the visible banner changes — including when
  // banners first load after an async fetch (handles empty-at-mount case) and
  // every subsequent rotation cycle.
  const prevImpressionBannerIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!banners.length) return;
    const banner = banners[Math.min(activeIdx, banners.length - 1)];
    if (!banner) return;
    if (prevImpressionBannerIdRef.current === banner.id) return;
    prevImpressionBannerIdRef.current = banner.id;
    fireBannerEvent(banner.id, "impression", { journeyId, visitorToken });
  }, [activeIdx, banners, journeyId, visitorToken]);

  useEffect(() => {
    if (banners.length <= 1) return;
    timerRef.current = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setActiveIdx(i => (i + 1) % banners.length);
        setVisible(true);
      }, 300);
    }, rotationIntervalSeconds * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [banners.length, rotationIntervalSeconds]);

  if (!banners.length || dismissed) return null;

  const activeBanner = banners[Math.min(activeIdx, banners.length - 1)];
  const cfg = activeBanner.config ?? {};
  const clickUrl = cfg.clickBehavior === "url" ? (cfg.clickUrl as string | undefined) : undefined;
  const showDismissButton = !!cfg.dismissButton;
  const isSidebar = zone === "sidebar";
  const containerHeight = ZONE_HEIGHTS[zone] ?? 90;
  const containerWidth = isSidebar ? 300 : undefined;

  const wrapperStyle: React.CSSProperties = {
    width: containerWidth ? `${containerWidth}px` : "100%",
    height: containerHeight,
    overflow: "hidden",
    flexShrink: 0,
    transition: "opacity 0.3s ease",
    opacity: visible ? 1 : 0,
    cursor: clickUrl || onBannerClick ? "pointer" : "default",
    position: "relative",
  };

  const responsiveClass = isSidebar
    ? mobileBehavior === "hide"
      ? "hidden md:block"
      : "w-full md:w-[300px] order-last md:order-none"
    : undefined;

  function handleClick() {
    if (clickUrl) {
      fireBannerEvent(activeBanner.id, "click", { journeyId, visitorToken });
      window.open(clickUrl, "_blank", "noreferrer");
    } else if (onBannerClick) {
      fireBannerEvent(activeBanner.id, "click", { journeyId, visitorToken });
      onBannerClick(activeBanner);
    }
  }

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    fireBannerEvent(activeBanner.id, "dismiss", { journeyId, visitorToken });
    setDismissed(true);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function handleCtaClick() {
    fireBannerEvent(activeBanner.id, "click", { journeyId, visitorToken });
  }

  return (
    <div
      style={isSidebar && mobileBehavior === "show"
        ? { ...wrapperStyle, width: undefined }
        : wrapperStyle}
      className={responsiveClass}
      onClick={handleClick}
    >
      <BannerSlide banner={activeBanner} zone={zone} onCtaClick={handleCtaClick} />
      {showDismissButton && (
        <button
          onClick={handleDismiss}
          aria-label="Dismiss banner"
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            background: "rgba(0,0,0,0.25)",
            border: "none",
            borderRadius: "50%",
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#ffffff",
            fontSize: 12,
            lineHeight: 1,
            padding: 0,
            zIndex: 10,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function TopBanner(props: Omit<ZoneBannerProps, "zone">) {
  return <ZoneBanner {...props} zone="top" />;
}

export function BottomBanner(props: Omit<ZoneBannerProps, "zone">) {
  return <ZoneBanner {...props} zone="bottom" />;
}

export function SidebarBanner(props: Omit<ZoneBannerProps, "zone">) {
  return <ZoneBanner {...props} zone="sidebar" />;
}

export function PopupBanner({
  banners,
  journeyId,
  visitorToken,
}: {
  banners: ZoneBannerItem[];
  journeyId?: number;
  visitorToken?: string;
}) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const visible = banners.filter(b => !dismissed.has(b.id));
  const banner = visible[0];
  if (!banner) return null;

  function close() {
    fireBannerEvent(banner.id, "dismiss", { journeyId, visitorToken });
    setDismissed(s => new Set([...s, banner.id]));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={close}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(560px, 92vw)",
          maxHeight: "min(420px, 85vh)",
          borderRadius: 20,
          overflow: "hidden",
          background: "#fff",
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        }}
      >
        <BannerSlide banner={banner} zone="popup" />
        <button
          onClick={close}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.45)",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
