import { useLocation } from "wouter";
import { Users, Building2, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Contacts",  href: "/crm/contacts",  icon: Users      },
  { label: "Companies", href: "/crm/companies", icon: Building2  },
  { label: "Deals",     href: "/crm/deals",     icon: TrendingUp },
];

export function CrmSubNav({ active }: { active: "contacts" | "companies" | "deals" }) {
  const [, navigate] = useLocation();
  return (
    <div className="border-b bg-card px-6 flex items-center gap-1 shrink-0">
      {TABS.map(t => {
        const isActive = active === t.label.toLowerCase();
        const Icon = t.icon;
        return (
          <button
            key={t.href}
            onClick={() => navigate(t.href)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors",
              isActive
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
