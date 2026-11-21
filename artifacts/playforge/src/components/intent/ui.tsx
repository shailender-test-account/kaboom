import { cn } from "@/lib/utils";
import { ReactNode } from "react";
import { Download, RefreshCw, Plus, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export function IntentPageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
  stats,
  showUtilities = true
}: {
  title: ReactNode,
  subtitle?: ReactNode,
  breadcrumbs?: ReactNode,
  actions?: ReactNode,
  stats?: ReactNode,
  showUtilities?: boolean
}) {
  const [, setLocation] = useLocation();

  return (
    <div className="bg-[#F8F9F8] border-b border-stone-200 shrink-0 w-full relative">
      <div className="max-w-[1600px] mx-auto px-6 py-5 flex flex-col gap-5 relative z-10">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="pl-10 lg:pl-0">
            {breadcrumbs && <div className="text-[10px] font-bold tracking-widest uppercase text-stone-500 mb-1.5 flex items-center gap-1.5">{breadcrumbs}</div>}
            <h1 className="text-xl font-bold tracking-tight text-stone-900 flex items-center gap-2">
              {title}
            </h1>
            {subtitle && <div className="text-xs font-medium text-stone-500 mt-1 max-w-2xl leading-relaxed">{subtitle}</div>}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {showUtilities && (
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()} className="h-8 text-xs font-bold text-emerald-700 bg-emerald-50 border-emerald-100 hover:bg-emerald-100 hover:text-emerald-800">
                  <Download className="w-3.5 h-3.5 mr-1.5" /> Print / Save PDF
                </Button>
                <Button variant="outline" size="sm" onClick={() => setLocation(`/intent${window.location.search}#research`)} className="h-8 text-xs font-bold text-stone-600 bg-white border-stone-200 hover:bg-stone-50">
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Run fresh scan
                </Button>
                <Button variant="outline" size="sm" onClick={() => setLocation("/intent/ingest")} className="h-8 text-xs font-bold text-stone-600 bg-white border-stone-200 hover:bg-stone-50">
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add data
                </Button>
                <Button variant="outline" size="icon" disabled aria-label="Notifications" title="Notifications" className="h-8 w-8 text-stone-600 bg-white border-stone-200 relative cursor-not-allowed opacity-70">
                  <Bell className="w-4 h-4" />
                </Button>
              </>
            )}
            {actions && (
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-stone-200">
                {actions}
              </div>
            )}
          </div>
        </div>
        {stats && <div className="pt-4 border-t border-stone-200">{stats}</div>}
      </div>
    </div>
  );
}

export function LimeBadge({ children, className }: { children: ReactNode, className?: string }) {
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[9px] font-extrabold uppercase tracking-widest bg-[#bef264] text-[#0B2118]", className)}>{children}</span>;
}

export function ForestBadge({ children, className }: { children: ReactNode, className?: string }) {
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[9px] font-extrabold uppercase tracking-widest bg-[#1A382A] text-[#8BAA9D]", className)}>{children}</span>;
}

export function TierBadge({ tier, className }: { tier?: string, className?: string }) {
  if (!tier) return null;
  const t = tier.toLowerCase();
  if (t === "hot") return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[9px] font-extrabold uppercase tracking-widest bg-rose-50 text-rose-700 border border-rose-200", className)}>{tier}</span>;
  if (t === "warm") return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[9px] font-extrabold uppercase tracking-widest bg-amber-50 text-amber-700 border border-amber-200", className)}>{tier}</span>;
  return <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[9px] font-extrabold uppercase tracking-widest bg-stone-100 text-stone-600 border border-stone-200", className)}>{tier}</span>;
}
