import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function Collapsible({ title, summary, testId, children }: { title: string; summary?: ReactNode; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rounded-lg border border-[#c5d3df] bg-white text-xs text-[#41586e]" data-testid={testId}>
      <button type="button" aria-expanded={open} aria-controls={id} data-testid={`${testId}-toggle`} onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40 rounded-lg">
        <span className="min-w-0"><span className="block font-semibold text-[#0B2A4A]">{title}</span>{summary && !open && <span className="block mt-0.5 text-[11px] text-[#5d7388] truncate">{summary}</span>}</span>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <div id={id} hidden={!open} className="px-4 pb-3">{children}</div>
    </div>
  );
}
