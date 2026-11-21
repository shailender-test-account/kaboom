import {
  ArrowRight, Download, ExternalLink, FileText, ChevronRight, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface StyleConfig {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  bgColor?: string;
  textColor?: string;
  borderColor?: string;
  noBorder?: boolean;
  sizePreset?: "small" | "medium" | "large" | "full";
  borderRadius?: "sharp" | "slightly_rounded" | "pill";
  icon?: string;
  iconPosition?: "left" | "right";
}

export function CtaButtonPreview({
  label,
  styleConfig,
  dark = false,
}: {
  label: string;
  styleConfig: StyleConfig;
  dark?: boolean;
}) {
  const {
    bgColor = "#4f46e5",
    textColor = "#ffffff",
    borderColor,
    noBorder = false,
    fontFamily = "inherit",
    fontSize = 14,
    fontWeight = "600",
    sizePreset = "medium",
    borderRadius = "slightly_rounded",
    icon = "none",
    iconPosition = "right",
  } = styleConfig;

  const sizeStyles: Record<string, string> = {
    small: "px-3 py-1.5 text-xs",
    medium: "px-4 py-2 text-sm",
    large: "px-6 py-2.5 text-base",
    full: "px-4 py-2 text-sm w-full",
  };
  const radiusStyles: Record<string, string> = {
    sharp: "rounded-none",
    slightly_rounded: "rounded-md",
    pill: "rounded-full",
  };

  const IconEl = () => {
    if (icon === "none" || !icon) return null;
    const cls = "w-3.5 h-3.5 shrink-0";
    if (icon === "arrow") return <ArrowRight className={cls} />;
    if (icon === "download") return <Download className={cls} />;
    if (icon === "external") return <ExternalLink className={cls} />;
    if (icon === "form") return <FileText className={cls} />;
    if (icon === "auto") return <Zap className={cls} />;
    return <ChevronRight className={cls} />;
  };

  return (
    <div
      role="presentation"
      style={{
        backgroundColor: bgColor,
        color: textColor,
        border: noBorder ? "none" : `1.5px solid ${borderColor || bgColor}`,
        fontFamily,
        fontSize: `${fontSize}px`,
        fontWeight,
      }}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium select-none",
        sizeStyles[sizePreset] ?? sizeStyles.medium,
        radiusStyles[borderRadius] ?? radiusStyles.slightly_rounded,
      )}
    >
      {iconPosition === "left" && <IconEl />}
      <span>{label || "Button"}</span>
      {iconPosition === "right" && <IconEl />}
    </div>
  );
}
