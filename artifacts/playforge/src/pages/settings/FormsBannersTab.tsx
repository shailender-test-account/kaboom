import { useLocation } from "wouter";
import { Megaphone, ClipboardList, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function FormsBannersTab() {
  const [, navigate] = useLocation();

  return (
    <div className="space-y-10">
      {/* ── Banners ── */}
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-amber-500" /> Banners
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Banners have moved to the Banner Library for a richer full-page builder experience.
          </p>
        </div>
        <div className="border rounded-xl p-5 bg-amber-50 border-amber-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center shrink-0">
              <Megaphone className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">Banner Library</p>
              <p className="text-xs text-amber-700 mt-0.5">
                Create and manage banners with the two-panel builder — live preview, image/GIF support, click behaviors, and tag targeting.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 shrink-0 gap-1.5"
            onClick={() => navigate("/library/banners")}
          >
            Open Banner Library <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Forms ── */}
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-sky-500" /> Forms
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Forms have moved to the Form Library for a richer three-panel builder experience.
          </p>
        </div>
        <div className="border rounded-xl p-5 bg-sky-50 border-sky-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-sky-100 rounded-lg flex items-center justify-center shrink-0">
              <ClipboardList className="w-5 h-5 text-sky-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-sky-900">Form Library</p>
              <p className="text-xs text-sky-700 mt-0.5">
                Build forms with the drag-and-drop three-panel editor — field palette, live canvas, and property controls.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-sky-600 hover:bg-sky-700 shrink-0 gap-1.5"
            onClick={() => navigate("/library/forms")}
          >
            Open Form Library <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
