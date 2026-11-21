import { ReactNode } from "react";
import { HP_BLUE, HP_MUTE } from "./format";

export function Panel({ title, note, right, children, className = "", id }: { title: string; note?: string; right?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section data-testid={id} className={`rounded-lg border border-[#d5e0ea] bg-white shadow-[0_1px_0_rgba(11,42,74,.04)] flex flex-col min-w-0 ${className}`}>
      <header className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A]">{title}</h3>
          {note && <p className="text-[11px] text-[#5d7388] mt-0.5 leading-snug">{note}</p>}
        </div>
        {right}
      </header>
      <div className="px-4 pb-4 flex-1 min-h-0">{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, accent = HP_BLUE, index = 0, testId, onClick }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string; index?: number; testId: string; onClick?: () => void }) {
  return (
    <div data-testid={testId} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} aria-label={onClick ? `${label}: open summary` : undefined} onKeyDown={onClick ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined} style={{ animationDelay: `${index * 50}ms`, borderTopColor: accent }}
      className={`hpbi-rise rounded-lg border border-[#d5e0ea] border-t-[3px] bg-white px-4 py-3 min-w-0 ${onClick ? "cursor-pointer hover:bg-[#eaf6fc] focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40" : ""}`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#5d7388] truncate">{label}</div>
      <div className="text-[26px] leading-tight font-semibold text-[#0B2A4A] tabular-nums mt-1 truncate" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{value}</div>
      {sub && <div className="text-[11px] text-[#5d7388] mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

export function HBar({ value, max, color = HP_BLUE, h = 8 }: { value: number; max: number; color?: string; h?: number }) {
  const w = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <div className="w-full rounded-sm bg-[#e8eef4] overflow-hidden" style={{ height: h }}>
      <div className="h-full origin-left hpbi-grow" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

export function Chip({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "hot" | "warm" | "blue" | "teal" | "amber" }) {
  const t = { gray: "bg-[#eaf0f5] text-[#41586e]", hot: "bg-[#fde4d6] text-[#a8400f]", warm: "bg-[#fcf0cf] text-[#8a6208]", blue: "bg-[#d8eefa] text-[#05628f]", teal: "bg-[#d5f0ea] text-[#0f6e5d]", amber: "bg-[#fbe6cf] text-[#8f4f0f]" }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium ${t}`}>{children}</span>;
}

export function Skel({ className = "" }: { className?: string }) {
  return <div className={`rounded bg-[#e3ebf2] hpbi-pulse ${className}`} />;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" data-testid="status-error" className="rounded-lg border border-[#e7b8a4] bg-[#fdf1ea] p-4 text-sm text-[#8a3511] flex items-center justify-between gap-4">
      <span>{message}</span>
      {onRetry && <button data-testid="button-retry" onClick={onRetry} className="rounded border border-[#c9805a] px-3 py-1 text-xs font-semibold hover:bg-[#fbe0d0]">Retry</button>}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6" data-testid="status-empty">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden><circle cx="24" cy="24" r="21" fill="none" stroke={HP_MUTE} strokeWidth="2" strokeDasharray="3 5" /><circle cx="24" cy="24" r="6" fill={HP_BLUE} opacity=".35" /></svg>
      <div className="mt-3 text-sm font-semibold text-[#0B2A4A]">{title}</div>
      <p className="text-xs text-[#5d7388] max-w-sm mt-1">{body}</p>
    </div>
  );
}
