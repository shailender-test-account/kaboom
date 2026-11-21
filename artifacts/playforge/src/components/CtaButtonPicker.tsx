import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, ExternalLink, Check, Loader2, MousePointerClick } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CtaButtonPreview } from "@/components/CtaButtonPreview";

interface CtaButton {
  id: number;
  name: string;
  label: string;
  actionType: string;
  actionConfig: Record<string, any>;
  styleConfig: Record<string, any>;
  usedIn: number;
}

const ACTION_LABELS: Record<string, string> = {
  url: "URL",
  download: "Download",
  gated_form: "Gated Form",
  jump_page: "Jump to Page",
};

const ACTION_COLORS: Record<string, string> = {
  url: "bg-blue-50 text-blue-700 border-blue-200",
  download: "bg-emerald-50 text-emerald-700 border-emerald-200",
  gated_form: "bg-violet-50 text-violet-700 border-violet-200",
  jump_page: "bg-amber-50 text-amber-700 border-amber-200",
};

interface CtaButtonPickerProps {
  value?: number | null;
  onChange: (ctaButtonId: number | null) => void;
}

export function CtaButtonPicker({ value, onChange }: CtaButtonPickerProps) {
  const [search, setSearch] = useState("");

  const { data: ctaButtons = [], isLoading } = useQuery<CtaButton[]>({
    queryKey: ["cta-buttons"],
    queryFn: () => fetch("/api/cta-buttons", { credentials: "include" }).then(r => r.json()),
  });

  const filtered = ctaButtons.filter(b =>
    !search || b.name.toLowerCase().includes(search.toLowerCase()) || b.label.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search CTA buttons…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 pl-7 text-xs"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-4 space-y-2">
          <MousePointerClick className="w-6 h-6 mx-auto text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">No CTA buttons yet</p>
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7 gap-1"
            onClick={() => window.open("/library/cta-buttons?create=1", "_blank")}
          >
            <Plus className="w-3.5 h-3.5" /> Create one
          </Button>
        </div>
      ) : (
        <div className="space-y-1 max-h-52 overflow-y-auto">
          {filtered.map(btn => (
            <button
              key={btn.id}
              type="button"
              onClick={() => onChange(btn.id === value ? null : btn.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-md border text-left transition-colors",
                btn.id === value
                  ? "border-indigo-400 bg-indigo-50"
                  : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50",
              )}
            >
              {btn.id === value && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-medium text-foreground truncate">{btn.name}</span>
                  <span className={cn(
                    "text-[10px] px-1.5 py-0 rounded border shrink-0",
                    ACTION_COLORS[btn.actionType] ?? "bg-gray-50 text-gray-700 border-gray-200",
                  )}>
                    {ACTION_LABELS[btn.actionType] ?? btn.actionType}
                  </span>
                </div>
                <div className="pointer-events-none scale-75 origin-left">
                  <CtaButtonPreview label={btn.label} styleConfig={btn.styleConfig} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="w-full flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-1.5 justify-center border border-dashed border-gray-200 rounded-md hover:border-indigo-300 hover:bg-gray-50 transition-colors"
        onClick={() => window.open("/library/cta-buttons?create=1", "_blank")}
      >
        <ExternalLink className="w-3 h-3" />
        Create a new CTA button
      </button>
    </div>
  );
}
