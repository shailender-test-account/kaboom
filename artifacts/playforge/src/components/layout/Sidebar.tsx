import { useEffect, useId, useState } from "react";
import { useLocation } from "wouter";
import { useAuthContext } from "@/contexts/AuthContext";
import { canAccess, pageSection } from "@workspace/api-zod";
import { BrandLogo } from "@/components/BrandLogo";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { SignOutAllDevicesForm } from "@/components/settings/SignOutAllDevicesForm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, Users, BookOpen, BarChart2, Target, Radar,
  Settings, ChevronLeft, ChevronRight, LogOut, Building2,
  ChevronsUpDown, FileText, GitBranch, TrendingUp, Contact,
  Images, MousePointerClick, Megaphone, ClipboardList, ChevronDown,
  Database, Phone, Layers, PhoneOff, Trophy, ExternalLink, Inbox, Sparkles, Ellipsis, Flame, KeyRound,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  external?: boolean;
}

interface NavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
  defaultOpen?: boolean;
  collapseToMenu?: boolean;
}

// Main nav items (flat)
const mainNavItems: NavItem[] = [
  { label: "Dashboard",  icon: LayoutDashboard, href: "/" },
  { label: "Sales Dashboard", icon: Flame, href: "/sales-dashboard" },
  { label: "Analytics", icon: BarChart2, href: "/analytics" },
  { label: "Continuous Monitoring", icon: Radar, href: "/intent/monitoring" },
  { label: "Autonomous GTM OS", icon: Inbox, href: "/intent/inbound-accounts" },
  { label: "Buying Committee", icon: Users, href: "/intent/buying-committee" },
  { label: "AI Answer", icon: Sparkles, href: "/ai-answer" },
  { label: "Clients",    icon: Building2,        href: "/clients" },
  { label: "Plays",      icon: Target,           href: "/plays" },
  { label: "Journeys",   icon: BookOpen,         href: "/journeys" },
  { label: "Templates",  icon: FileText,         href: "/templates" },
  { label: "Sequences",  icon: GitBranch,        href: "/sequences" },
  { label: "Database",       icon: Database,  href: "/database" },
  { label: "Contacts",   icon: Contact,          href: "/crm/contacts" },
  { label: "Companies",  icon: Building2,        href: "/crm/companies" },
  { label: "Deals",      icon: TrendingUp,       href: "/crm/deals" },
];

const moreNavItems: NavItem[] = [
  { label: "Intent Engine", icon: Radar, href: "/intent" },
  { label: "Call Campaigns", icon: Phone, href: "/calls" },
  { label: "DNC / Negative List", icon: PhoneOff, href: "/calls/dnc" },
  { label: "HP Poly Contest", icon: Trophy, href: "/poly-contest-rescue.html", external: true },
];

function activeNavHref(items: NavItem[], location: string) {
  return items.filter(item => !item.external
    && (item.href !== "/intent" || pageSection(location) === "intent")
    && (location === item.href || location.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

// Library group
const libraryGroup: NavGroup = {
  label: "Library",
  icon: Images,
  defaultOpen: true,
  items: [
    { label: "Pitch Templates", icon: Layers,            href: "/library/pitch-templates" },
    { label: "CTA Buttons",     icon: MousePointerClick, href: "/library/cta-buttons" },
    { label: "Banners",         icon: Megaphone,         href: "/library/banners" },
    { label: "Forms",           icon: ClipboardList,     href: "/library/forms" },
    { label: "Media",           icon: Images,            href: "/library/media" },
  ],
};

const roleBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  admin: "default",
  manager: "secondary",
  editor: "outline",
  viewer: "outline",
};

function NavLinkExternal({ href, label, icon: Icon, collapsed, indent = false }: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  indent?: boolean;
}) {
  const content = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-100",
        "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        collapsed && "justify-center px-2",
        indent && !collapsed && "pl-6",
      )}
    >
      <Icon className="shrink-0 w-4 h-4 text-sidebar-foreground" />
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && <ExternalLink className="w-3 h-3 text-muted-foreground/60 shrink-0" />}
    </a>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="text-xs">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return content;
}

function NavLink({ item, collapsed, isActive, indent = false }: {
  item: NavItem;
  collapsed: boolean;
  isActive: boolean;
  indent?: boolean;
}) {
  const [, navigate] = useLocation();
  const Icon = item.icon;

  const content = (
    <button
      data-testid={`nav-link-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
      aria-label={item.label}
      aria-current={isActive ? "page" : undefined}
      onClick={() => navigate(item.href)}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-100",
        isActive
          ? "bg-sidebar-accent text-sidebar-primary"
          : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        collapsed && "justify-center px-2",
        indent && !collapsed && "pl-6",
      )}
    >
      <Icon className={cn("shrink-0 w-4 h-4", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")} />
      {!collapsed && <span className="min-w-0 flex-1 whitespace-nowrap text-left">{item.label}</span>}
      {!collapsed && isActive && (
        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-primary" />
      )}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="text-xs">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

function NavGroupSection({ group, collapsed, location }: {
  group: NavGroup;
  collapsed: boolean;
  location: string;
}) {
  const activeHref = activeNavHref(group.items, location);
  const isAnyActive = !!activeHref;
  const [open, setOpen] = useState(group.defaultOpen || isAnyActive);
  const [, navigate] = useLocation();
  const groupId = useId();
  useEffect(() => { if (isAnyActive) setOpen(true); }, [location, isAnyActive]);
  const GroupIcon = group.icon;

  if (collapsed && group.collapseToMenu) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label={group.label} title={group.label} data-testid="nav-group-more"
            className={cn("w-full flex justify-center rounded-md px-2 py-2 hover:bg-muted",
              isAnyActive ? "bg-sidebar-accent text-sidebar-primary" : "text-sidebar-foreground")}>
            <GroupIcon className="w-4 h-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-56">
          {group.items.map(item => item.external
            ? <DropdownMenuItem key={item.href} asChild><a href={item.href} target="_blank" rel="noopener noreferrer"><item.icon className="mr-2 h-4 w-4" />{item.label}<ExternalLink className="ml-auto h-3 w-3" /></a></DropdownMenuItem>
            : <DropdownMenuItem key={item.href} aria-current={activeHref === item.href ? "page" : undefined} onSelect={() => navigate(item.href)}>
                <item.icon className="mr-2 h-4 w-4" />{item.label}
              </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (collapsed) {
    // In collapsed mode, show all items directly with tooltips
    return (
      <>
        {group.items.map(item => {
          const isActive = activeHref === item.href;
          return <NavLink key={item.href} item={item} collapsed={collapsed} isActive={isActive} />;
        })}
      </>
    );
  }

  return (
    <div>
      <button
        aria-label={group.label}
        aria-expanded={!!open}
        aria-controls={groupId}
        onClick={() => setOpen(o => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors",
          "text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50",
          isAnyActive && "text-sidebar-primary",
        )}
      >
        <GroupIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform duration-150", open ? "rotate-0" : "-rotate-90")} />
      </button>
      {open && (
        <div id={groupId} className="mt-0.5 space-y-0.5">
          {group.items.map(item => {
            const isActive = activeHref === item.href;
            if (item.external) return <NavLinkExternal key={item.href} {...item} collapsed={collapsed} indent />;
            return <NavLink key={item.href} item={item} collapsed={collapsed} isActive={isActive} indent />;
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const compactViewport = window.matchMedia("(max-width: 767px)");
    const syncViewport = (event: MediaQueryListEvent) => setCollapsed(event.matches);
    compactViewport.addEventListener("change", syncViewport);
    return () => compactViewport.removeEventListener("change", syncViewport);
  }, []);
  const [location] = useLocation();
  const { user, logout } = useAuthContext();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const visible = (item: NavItem) => {
    const section = item.href === "/sales-dashboard" ? "sales" : pageSection(item.href);
    return !user || !section || canAccess(user, section);
  };
  const activeHref = activeNavHref(mainNavItems, location);
  const moreGroup: NavGroup = { label: "More", icon: Ellipsis, collapseToMenu: true,
    items: [...moreNavItems, ...(user?.role === "admin"
      ? [{ label: "Contest Entries", icon: ClipboardList, href: "/contest/entries" }] : [])].filter(visible) };

  const initials = user
    ? `${user.firstName[0] ?? ""}${user.lastName[0] ?? ""}`.toUpperCase()
    : "??";

  async function handleLogout() {
    await logout();
  }

  return (
    <aside
      className={cn(
        "relative flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 shrink-0",
        collapsed ? "w-14" : "w-64",
      )}
    >
      {/* Logo */}
      <div className={cn("flex items-center gap-2.5 h-14 px-4 border-b border-sidebar-border shrink-0", collapsed && "justify-center px-0")}>
        <BrandLogo compact={collapsed} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {/* Main items */}
        {mainNavItems.filter(visible).map((item) => {
          const isActive = activeHref === item.href;
          return (
            <NavLink key={item.href} item={item} collapsed={collapsed} isActive={isActive} />
          );
        })}

        {/* Secondary tools; contest entries remain admin-only. */}
        {moreGroup.items.length > 0 && <NavGroupSection group={moreGroup} collapsed={collapsed} location={location} />}

        {/* Divider before Library */}
        <div className="py-1">
          <div className={cn("border-t border-sidebar-border/60", collapsed && "mx-2")} />
        </div>

        {/* Library group */}
        {(!user || canAccess(user, "library")) && <NavGroupSection group={libraryGroup} collapsed={collapsed} location={location} />}

        {/* Settings at bottom of nav */}
        <div className="py-1">
          <div className={cn("border-t border-sidebar-border/60", collapsed && "mx-2")} />
        </div>
        {(!user || canAccess(user, "settings")) && <NavLink
          item={{ label: "Settings", icon: Settings, href: "/settings" }}
          collapsed={collapsed}
          isActive={location.startsWith("/settings")}
        />}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="absolute -right-3 top-[52px] z-10 w-6 h-6 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>

      {/* User footer */}
      <div className={cn("border-t border-sidebar-border p-2 shrink-0", collapsed && "flex justify-center")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-muted transition-colors text-left",
                collapsed && "justify-center w-auto",
              )}
            >
              <Avatar className="w-7 h-7 shrink-0">
                <AvatarFallback className="text-xs font-semibold bg-primary/10 text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                </div>
              )}
              {!collapsed && <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-52">
            <div className="px-2 py-1.5">
              <p className="text-xs font-semibold text-foreground">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
              <div className="mt-1.5">
                <Badge variant={roleBadgeVariant[user?.role ?? "viewer"] ?? "outline"} className="text-xs capitalize px-1.5 py-0">
                  {user?.role}
                </Badge>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs text-muted-foreground cursor-default">
              {user?.tenantName}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setAccountOpen(true)} className="text-xs cursor-pointer">
              <Settings className="w-3.5 h-3.5 mr-2" />Account settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPasswordOpen(true)} className="text-xs cursor-pointer">
              <KeyRound className="w-3.5 h-3.5 mr-2" />Change password
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleLogout}
              className="text-destructive focus:text-destructive focus:bg-destructive/8 text-xs cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5 mr-2" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Account settings</DialogTitle>
              <DialogDescription>Sign out all devices</DialogDescription>
            </DialogHeader>
            <SignOutAllDevicesForm onCancel={() => setAccountOpen(false)} />
          </DialogContent>
        </Dialog>
        <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change password</DialogTitle>
              <DialogDescription>Enter your current password and choose a new one.</DialogDescription>
            </DialogHeader>
            <ChangePasswordForm onSuccess={() => setPasswordOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  );
}
