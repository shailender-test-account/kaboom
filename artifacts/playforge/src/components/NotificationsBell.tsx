import { useEffect, useState } from "react";
import { useAuthContext } from "@/contexts/AuthContext";
import { canAccess } from "@workspace/api-zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, CheckCheck, Flame, FileText, Zap, Users } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useIntentInboundSource } from "@/hooks/use-intent";
import { driveImportWarning } from "./driveImportWarning";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

type Notification = {
  id: number; type: string; title: string; body: string | null;
  read: boolean; createdAt: string; contactId: number | null;
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  score_threshold_crossed: Flame,
  form_submitted: FileText,
  sequence_completed: Zap,
  new_contact: Users,
};
const TYPE_COLORS: Record<string, string> = {
  score_threshold_crossed: "text-orange-500",
  form_submitted: "text-blue-500",
  sequence_completed: "text-indigo-500",
  new_contact: "text-emerald-500",
};

function timeAgo(d: string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationsBell() {
  const { user } = useAuthContext();
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 2000);
    return () => window.clearTimeout(timer);
  }, []);

  const { data } = useQuery<{ notifications: Notification[]; unreadCount: number }>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const response = await api("/notifications");
      if (!response.ok) throw new Error("Could not load notifications");
      return response.json();
    },
    refetchInterval: 30_000,
    enabled: ready,
  });
  const { data: sourceData } = useIntentInboundSource(ready && !!user && canAccess(user, "gtm"));
  const driveWarning = driveImportWarning(sourceData?.source);

  const markRead = useMutation({
    mutationFn: () =>
      api("/notifications/mark-read", { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const notifications = data?.notifications ?? [];
  const unread = (data?.unreadCount ?? 0) + (driveWarning ? 1 : 0);

  return (
    <DropdownMenu onOpenChange={open => { if (open) setReady(true); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8" aria-label={`Notifications${unread ? `, ${unread} unread or active` : ""}`}>
          <Bell className="w-4 h-4" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 bg-indigo-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none pointer-events-none">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0" sideOffset={8}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {(data?.unreadCount ?? 0) > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2 text-muted-foreground hover:text-foreground"
              onClick={e => { e.stopPropagation(); markRead.mutate(); }}
              disabled={markRead.isPending}
            >
              <CheckCheck className="w-3 h-3 mr-1" />
              {driveWarning ? "Mark updates read" : "Mark all read"}
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-border">
          {driveWarning && (
            <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-3" data-testid="notification-drive-import-warning">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div className="min-w-0 text-xs text-amber-950">
                  <p className="font-semibold">{driveWarning.title}</p>
                  <p className="mt-1 leading-relaxed">{driveWarning.summary}</p>
                  <p className="mt-2 font-semibold">What to do</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 leading-relaxed">
                    {driveWarning.recommendations.map(recommendation => <li key={recommendation}>{recommendation}</li>)}
                  </ul>
                  {driveWarning.errors.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium">View sync errors ({driveWarning.errors.length})</summary>
                      <ul className="mt-1 list-disc space-y-1 pl-4 break-words">
                        {driveWarning.errors.map((error, index) => <li key={index}>{error}</li>)}
                      </ul>
                    </details>
                  )}
                  <Link href="/intent/inbound-accounts?driveSettings=1" className="mt-2 inline-block font-semibold underline underline-offset-2">
                    Review Drive source settings →
                  </Link>
                  <p className="mt-1.5 text-[11px] text-amber-800">This warning stays until the issue is resolved.</p>
                </div>
              </div>
            </div>
          )}
          {notifications.length === 0 && !driveWarning ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Bell className="w-6 h-6 mx-auto mb-2 opacity-40" />
              No notifications yet
            </div>
          ) : (
            notifications.map(n => {
              const Icon = TYPE_ICONS[n.type] ?? Bell;
              const iconColor = TYPE_COLORS[n.type] ?? "text-muted-foreground";
              return (
                <div
                  key={n.id}
                  className={cn(
                    "flex items-start gap-3 px-4 py-3",
                    !n.read && "bg-indigo-50/50"
                  )}
                >
                  <div className={cn("mt-0.5 shrink-0", iconColor)}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      "text-sm leading-snug",
                      !n.read ? "font-medium text-foreground" : "text-muted-foreground"
                    )}>
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground/60 mt-1">
                      {timeAgo(n.createdAt)}
                    </p>
                  </div>
                  {!n.read && (
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-600 mt-1.5 shrink-0" />
                  )}
                </div>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
