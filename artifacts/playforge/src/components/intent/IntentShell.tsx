import { Link, useLocation, useSearch } from "wouter";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/contexts/AuthContext";
import { canAccess, pageSection } from "@workspace/api-zod";
import { AppShell } from "@/components/layout/AppShell";
import {
  Radar,
  Building2,
  Activity,
  Layers,
  Users,
  Upload,
  SlidersHorizontal,
  Gauge,
  BadgeIndianRupee,
} from "lucide-react";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
}

const navItems: NavItem[] = [
  { label: "Command center", icon: Radar, href: "/intent" },
  { label: "Sales dashboard", icon: Gauge, href: "/intent/sales-dashboard" },
  { label: "Accounts", icon: Building2, href: "/intent/accounts" },
  { label: "Signals", icon: Activity, href: "/intent/signals" },
  { label: "Categories", icon: Layers, href: "/intent/categories" },
  { label: "Contacts", icon: Users, href: "/intent/contacts" },
  { label: "Uploads", icon: Upload, href: "/intent/ingest" },
  { label: "Scoring", icon: SlidersHorizontal, href: "/intent/settings" },
  { label: "Pricing", icon: BadgeIndianRupee, href: "/intent/pipeline-pricing" },
];

export default function IntentShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();
  const { user } = useAuthContext();
  const query = search ? `?${search.replace(/^\?/, "")}` : "";

  const items = navItems.filter((item) => {
    const section = pageSection(item.href);
    return !user || !section || canAccess(user, section);
  });

  return (
    <AppShell>
      <div className="flex flex-col min-h-full">
        <div className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="flex items-center gap-3 px-4 h-11">
            <span className="hidden sm:inline text-[11px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
              Intent Engine
            </span>
            <span className="hidden sm:block h-4 w-px bg-border shrink-0" />
            <nav aria-label="Intent Engine sections" className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
              {items.map((item) => {
                const isActive =
                  item.href === "/intent"
                    ? location === "/intent" || location === "/intent/"
                    : location === item.href || location.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={`${item.href}${query}`}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 h-7 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
        <div className="flex-1 min-w-0 bg-background text-foreground">{children}</div>
      </div>
    </AppShell>
  );
}
