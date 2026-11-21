import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, ChevronDown, ChevronUp, X, Zap } from "lucide-react";
import { useLocation } from "wouter";
import { useAuthContext } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const api = async (path: string) => {
  const response = await fetch(`/api${path}`, { credentials: "include" });
  if (!response.ok) throw new Error("Could not load onboarding progress");
  return response.json();
};

type ChecklistItem = {
  key: string;
  label: string;
  href: string;
  check: (data: any) => boolean;
};

const CHECKLIST: ChecklistItem[] = [
  { key: "client",   label: "Add your first client",     href: "/clients/new",    check: d => (d.totalClients ?? 0) >= 1 },
  { key: "play",     label: "Create an ABM play",         href: "/plays/new",     check: d => (d.activePlays ?? 0) >= 1 },
  { key: "journey",  label: "Build a content journey",    href: "/journeys",      check: d => (d.pageViewsThisMonth ?? 0) >= 1 },
  { key: "contact",  label: "Import your first contacts", href: "/crm/contacts",  check: d => (d.totalContacts ?? 0) >= 1 },
  { key: "sequence", label: "Set up an email sequence",   href: "/sequences/new", check: d => (d.emailsSentThisMonth ?? 0) >= 1 },
];

export function OnboardingChecklist() {
  const { user } = useAuthContext();
  const [, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  );
  const [dismissed, setDismissed] = useState(() =>
    localStorage.getItem("onboarding_dismissed") === "true"
  );
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDeferred(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  const { data } = useQuery({
    queryKey: ["analytics", "dashboard", "summary"],
    queryFn: () => api("/analytics/dashboard/summary"),
    staleTime: 60_000,
    enabled: (user as any)?.role === "admin" && !dismissed && deferred,
  });

  const role = (user as any)?.role;
  if (role !== "admin" || dismissed) return null;
  if (!data) return null;

  const items = CHECKLIST.map(item => ({
    ...item,
    done: data ? item.check(data) : false,
  }));
  const completedCount = items.filter(i => i.done).length;
  const allDone = completedCount === items.length;

  if (allDone) return null;

  function dismiss() {
    localStorage.setItem("onboarding_dismissed", "true");
    setDismissed(true);
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-72 rounded-xl border bg-card shadow-lg shadow-black/10">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-indigo-600 rounded-md flex items-center justify-center shrink-0">
            <Zap className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">Getting started</p>
            <p className="text-[11px] text-muted-foreground">{completedCount}/{items.length} complete</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setCollapsed(c => !c)}>
            {collapsed
              ? <ChevronUp className="w-3.5 h-3.5" />
              : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={dismiss}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-1 bg-indigo-600 transition-all duration-500"
          style={{ width: `${(completedCount / items.length) * 100}%` }}
        />
      </div>

      {/* Checklist */}
      {!collapsed && (
        <div className="p-3 space-y-1">
          {items.map(item => (
            <button
              key={item.key}
              onClick={() => !item.done && navigate(item.href)}
              className={cn(
                "w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors",
                item.done
                  ? "opacity-60 cursor-default"
                  : "hover:bg-muted cursor-pointer"
              )}
            >
              {item.done
                ? <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0" />
                : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />}
              <span className={cn("text-xs", item.done && "line-through text-muted-foreground")}>
                {item.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
