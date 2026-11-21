interface Threshold { minScore: number; label: string; color: string; }

const FALLBACK_THRESHOLDS: Threshold[] = [
  { minScore: 0,  label: "Cold",     color: "slate"  },
  { minScore: 25, label: "Warm",     color: "blue"   },
  { minScore: 50, label: "Hot",      color: "orange" },
  { minScore: 75, label: "Very Hot", color: "red"    },
];

const COLOR_MAP: Record<string, { bg: string; text: string; dot: string }> = {
  slate:  { bg: "bg-slate-100",   text: "text-slate-700",  dot: "bg-slate-400"  },
  gray:   { bg: "bg-gray-100",    text: "text-gray-700",   dot: "bg-gray-400"   },
  blue:   { bg: "bg-blue-100",    text: "text-blue-700",   dot: "bg-blue-500"   },
  indigo: { bg: "bg-indigo-100",  text: "text-indigo-700", dot: "bg-indigo-500" },
  green:  { bg: "bg-green-100",   text: "text-green-700",  dot: "bg-green-500"  },
  yellow: { bg: "bg-yellow-100",  text: "text-yellow-700", dot: "bg-yellow-500" },
  orange: { bg: "bg-orange-100",  text: "text-orange-700", dot: "bg-orange-500" },
  red:    { bg: "bg-red-100",     text: "text-red-700",    dot: "bg-red-500"    },
  purple: { bg: "bg-purple-100",  text: "text-purple-700", dot: "bg-purple-500" },
};

export function resolveThreshold(score: number, thresholds?: Threshold[]): Threshold & { style: { bg: string; text: string; dot: string } } {
  const list = (thresholds && thresholds.length > 0 ? thresholds : FALLBACK_THRESHOLDS)
    .slice()
    .sort((a, b) => b.minScore - a.minScore);
  const matched = list.find((t) => score >= t.minScore) ?? list[list.length - 1];
  const style = COLOR_MAP[matched.color] ?? COLOR_MAP.gray;
  return { ...matched, style };
}

interface ScoreBadgeProps {
  score: number;
  thresholds?: Threshold[];
  showLabel?: boolean;
  size?: "sm" | "md";
}

export function ScoreBadge({ score, thresholds, showLabel = false, size = "md" }: ScoreBadgeProps) {
  const resolved = resolveThreshold(score, thresholds);
  const { bg, text, dot } = resolved.style;
  const px = size === "sm" ? "px-1.5 py-0.5" : "px-2 py-0.5";
  const textSize = size === "sm" ? "text-xs" : "text-xs";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${px} ${textSize} ${bg} ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {score}
      {showLabel && <span className="opacity-70">· {resolved.label}</span>}
    </span>
  );
}

export { FALLBACK_THRESHOLDS };
export type { Threshold };
