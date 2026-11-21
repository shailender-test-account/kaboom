import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, Calendar, Eye, Users, Mail, Zap, Loader2,
  BookOpen, GitBranch, Activity, BarChart2,
  ExternalLink, Search, Check, Link2Off, Link2, X, Map, Plus, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend,
} from "recharts";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { ScoreBadge } from "@/components/ScoreBadge";

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

interface Play {
  id: number; name: string; status: string; description: string | null;
  targetAudience: string | null; clientId: number; clientName: string | null;
  startDate: string | null; endDate: string | null;
  pageViews: number; contactsEnrolled: number; emailsSent: number; createdAt: string;
}

interface LinkedJourneyRow {
  id: number;
  name: string;
  status: string;
  slug: string;
  clientName: string | null;
  pageCount: number;
  totalViews: number;
}

interface JourneyOption {
  id: number;
  name: string;
  status: string;
  slug: string;
  clientName: string | null;
  pageCount: number;
  totalViews: number;
  linkedPlays: { id: number; name: string }[];
}

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  draft:    { label: "Draft",    classes: "bg-gray-100 text-gray-700 border-gray-200" },
  active:   { label: "Active",   classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  paused:   { label: "Paused",   classes: "bg-amber-50 text-amber-700 border-amber-200" },
  archived: { label: "Archived", classes: "bg-red-50 text-red-700 border-red-200" },
};
const STATUSES = ["draft", "active", "paused", "archived"] as const;

const JOURNEY_STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  draft:     { label: "Draft",     classes: "bg-gray-100 text-gray-700 border-gray-200" },
  active:    { label: "Active",    classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  published: { label: "Published", classes: "bg-blue-50 text-blue-700 border-blue-200" },
  archived:  { label: "Archived",  classes: "bg-red-50 text-red-700 border-red-200" },
};

// ── Analytics sub-components ────────────────────────────────────────────────
function AnalyticsKpi({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="text-center p-3 bg-muted/30 rounded-lg">
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn("text-xl font-bold", color ?? "text-foreground")}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function AnalyticsTab({ playId }: { playId: number }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo)   params.set("dateTo", dateTo);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const { data, isLoading } = useQuery({
    queryKey: ["analytics", "play", playId, dateFrom, dateTo],
    queryFn: () => api(`/analytics/plays/${playId}${qs}`).then(r => r.json()),
  });

  const clearDates = () => { setDateFrom(""); setDateTo(""); };
  const hasFilter = !!(dateFrom || dateTo);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground text-center py-12">No analytics data.</p>;

  const kpi = data.kpi ?? {};

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground shrink-0">Date range:</span>
        <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 text-xs w-36" />
        <span className="text-xs text-muted-foreground">–</span>
        <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 text-xs w-36" />
        {hasFilter && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={clearDates}>
            <X className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
        )}
        {hasFilter && (
          <span className="text-[11px] text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">Filtered</span>
        )}
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
        <AnalyticsKpi label="Enrolled"   value={kpi.enrolled ?? 0}     color="text-indigo-600" />
        <AnalyticsKpi label="Sent"       value={kpi.emailsSent ?? 0}   color="text-sky-600" />
        <AnalyticsKpi label="Open Rate"  value={`${kpi.openRate ?? 0}%`}  color="text-emerald-600" />
        <AnalyticsKpi label="Click Rate" value={`${kpi.clickRate ?? 0}%`} color="text-violet-600" />
        <AnalyticsKpi label="Page Views" value={kpi.pageViews ?? 0}    color="text-orange-600" />
        <AnalyticsKpi label="Form Subs"  value={kpi.formSubmits ?? 0}  color="text-teal-600" />
        <AnalyticsKpi label="Avg Score"  value={kpi.avgScore ?? 0}     color="text-rose-600" />
        <AnalyticsKpi label="Completion" value={`${kpi.completionRate ?? 0}%`} color="text-amber-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="shadow-xs">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Journey Funnel</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart layout="vertical" data={data.funnelStages ?? []} margin={{ left: 16, right: 8 }}>
                <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="stage" width={90} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [`${v}%`, "Rate"]} contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="pct" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="shadow-xs">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email Engagement (14 days)</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.emailEngagement ?? []} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={v => v.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="sent"   stroke="#94a3b8" dot={false} strokeWidth={1.5} name="Sent" />
                <Line type="monotone" dataKey="opens"  stroke="#6366f1" dot={false} strokeWidth={2}   name="Opens" />
                <Line type="monotone" dataKey="clicks" stroke="#10b981" dot={false} strokeWidth={2}   name="Clicks" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-xs">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top Contacts by Score</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          {(data.leaderboard ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No contacts enrolled yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {(data.leaderboard ?? []).map((c: any, i: number) => (
                <div key={c.id} className="flex items-center gap-3 py-2">
                  <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}</span>
                  <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                    {c.firstName[0]}{c.lastName[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground">{c.firstName} {c.lastName}</p>
                    <p className="text-[11px] text-muted-foreground">{c.email}</p>
                  </div>
                  <ScoreBadge score={c.leadScore} size="sm" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {(data.pageStats ?? []).length > 0 && (() => {
        const stats = data.pageStats as { pageId: number; title: string; views: number; ctaClicks: number; ctr: number; formStarts?: number; formCompletions?: number; bannerDismisses?: number }[];
        const hasFormData = stats.some(p => (p.formStarts ?? 0) > 0 || (p.formCompletions ?? 0) > 0);
        const hasBannerData = stats.some(p => (p.bannerDismisses ?? 0) > 0);
        return (
          <Card className="shadow-xs">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Page Engagement</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground w-6">#</th>
                      <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Page</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Views</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">CTA Clicks</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">CTR</th>
                      {hasFormData && <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Form Starts</th>}
                      {hasFormData && <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Form Completions</th>}
                      {hasBannerData && <th className="text-right py-1.5 font-medium text-muted-foreground">Banner Dismisses</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stats.map((p, i) => (
                      <tr key={p.pageId} className="hover:bg-muted/20 transition-colors">
                        <td className="py-2 pr-3 text-muted-foreground">{i + 1}</td>
                        <td className="py-2 pr-3 font-medium text-foreground max-w-[200px] truncate">{p.title}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-foreground">{p.views.toLocaleString()}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-foreground">{p.ctaClicks.toLocaleString()}</td>
                        <td className="py-2 pr-3 text-right">
                          <span className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium",
                            p.ctr >= 20 ? "bg-emerald-50 text-emerald-700" :
                            p.ctr >= 10 ? "bg-amber-50 text-amber-700" :
                            p.ctr > 0   ? "bg-orange-50 text-orange-700" :
                                          "bg-gray-50 text-muted-foreground"
                          )}>
                            {p.ctr}%
                          </span>
                        </td>
                        {hasFormData && <td className="py-2 pr-3 text-right tabular-nums text-foreground">{(p.formStarts ?? 0).toLocaleString()}</td>}
                        {hasFormData && <td className="py-2 pr-3 text-right tabular-nums text-foreground">{(p.formCompletions ?? 0).toLocaleString()}</td>}
                        {hasBannerData && <td className="py-2 text-right tabular-nums text-foreground">{(p.bannerDismisses ?? 0).toLocaleString()}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}

// ── Link Journey Dialog ───────────────────────────────────────────────────────
function LinkJourneyDialog({
  open,
  onClose,
  playId,
  clientId,
  linkedJourneyIds,
}: {
  open: boolean;
  onClose: () => void;
  playId: number;
  clientId: number;
  linkedJourneyIds: Set<number>;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [newName, setNewName] = useState("");

  const { data: journeys = [], isLoading } = useQuery<JourneyOption[]>({
    queryKey: ["journeys", { clientId }],
    queryFn: () => api(`/journeys?clientId=${clientId}`).then(r => r.json()),
    enabled: open,
  });

  const linkMutation = useMutation({
    mutationFn: async (journeyId: number) => {
      const r = await api(`/journeys/${journeyId}/plays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playId }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plays", playId, "journeys"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey linked" });
      onClose();
    },
    onError: () => toast({ title: "Failed to link journey", variant: "destructive" }),
  });

  const createAndLinkMutation = useMutation({
    mutationFn: async (name: string) => {
      const r = await api(`/plays/${playId}/journeys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, status: "draft" }),
      });
      let body: unknown;
      try { body = await r.json(); } catch { body = {}; }
      if (!r.ok) {
        const b = body as Record<string, unknown>;
        const msg = (typeof b?.error === "string" ? b.error : null)
          ?? (typeof b?.message === "string" ? b.message : null)
          ?? `Server error ${r.status}`;
        throw new Error(msg);
      }
      return body;
    },
    onSuccess: (body: unknown) => {
      qc.invalidateQueries({ queryKey: ["plays", playId, "journeys"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey created and linked" });
      onClose();
      const created = body as { id?: number } | null;
      if (created && typeof created.id === "number") {
        navigate(`/journeys/${created.id}`);
      }
    },
    onError: (err: Error) => toast({
      title: "Failed to create journey",
      description: err.message,
      variant: "destructive",
    }),
  });

  const filtered = journeys.filter(j =>
    !linkedJourneyIds.has(j.id) &&
    (j.name.toLowerCase().includes(search.toLowerCase()) ||
     (j.clientName ?? "").toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {mode === "create" ? "Create & Link Journey" : "Link a Journey"}
          </DialogTitle>
        </DialogHeader>

        {mode === "create" ? (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              A new draft journey will be created and linked to this play.
            </p>
            <Input
              placeholder="Journey name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="h-9 text-sm"
              autoFocus
              onKeyDown={e => {
                if (e.key === "Enter" && newName.trim()) createAndLinkMutation.mutate(newName.trim());
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setMode("pick")}>
                <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!newName.trim() || createAndLinkMutation.isPending}
                onClick={() => newName.trim() && createAndLinkMutation.mutate(newName.trim())}
              >
                {createAndLinkMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5 mr-1.5" />
                )}
                Create &amp; Link
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search journeys..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 text-xs pl-8"
                autoFocus
              />
            </div>

            <div className="max-h-52 overflow-y-auto space-y-0.5">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {journeys.filter(j => !linkedJourneyIds.has(j.id)).length === 0
                    ? "All journeys for this client are already linked"
                    : "No journeys found"}
                </p>
              ) : (
                filtered.map(j => {
                  const statusCfg = JOURNEY_STATUS_CONFIG[j.status] ?? JOURNEY_STATUS_CONFIG.draft;
                  return (
                    <button
                      key={j.id}
                      type="button"
                      disabled={linkMutation.isPending}
                      onClick={() => linkMutation.mutate(j.id)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
                    >
                      <BookOpen className="w-3.5 h-3.5 shrink-0 text-indigo-500" />
                      <span className="flex-1 min-w-0">
                        <span className="text-xs font-medium block truncate">{j.name}</span>
                        {j.clientName && (
                          <span className="text-[11px] text-muted-foreground block">{j.clientName}</span>
                        )}
                      </span>
                      <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border shrink-0", statusCfg.classes)}>
                        {statusCfg.label}
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">{j.pageCount}p</span>
                    </button>
                  );
                })
              )}
            </div>

            <button
              type="button"
              onClick={() => setMode("create")}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border border-dashed border-border"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              Create a new journey and link it
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Contacts Tab ─────────────────────────────────────────────────────────────

interface EnrolledContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  title: string | null;
  leadScore: number;
  stage: string;
  status: string;
  tags: string[];
  enrolledAt: string;
}

interface ClientContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  title: string | null;
  leadScore: number;
  stage: string;
}

function initials(c: { firstName: string | null; lastName: string | null }) {
  const f = (c.firstName ?? "?")[0] ?? "";
  const l = (c.lastName ?? "")[0] ?? "";
  return (f + l).toUpperCase() || "?";
}

function fullName(c: { firstName: string | null; lastName: string | null }) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
}

function AddContactsDialog({
  open,
  onClose,
  playId,
  clientId,
  enrolledIds,
}: {
  open: boolean;
  onClose: () => void;
  playId: number;
  clientId: number;
  enrolledIds: Set<number>;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data: contacts = [], isLoading, isError: isContactsError } = useQuery<ClientContact[]>({
    queryKey: ["contacts", { clientId }],
    queryFn: async () => {
      const r = await api(`/contacts?clientId=${clientId}&limit=200`);
      if (!r.ok) throw new Error(`Failed to load contacts (${r.status})`);
      return r.json();
    },
    enabled: open,
  });

  const enrollMutation = useMutation({
    mutationFn: async (contactIds: number[]) => {
      const r = await api(`/plays/${playId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data, contactIds) => {
      qc.invalidateQueries({ queryKey: ["plays", playId, "contacts"] });
      qc.invalidateQueries({ queryKey: ["plays", String(playId)] });
      const enrolled = contactIds.length - (data?.dncSkipped ?? 0);
      const dncNote = data?.dncSkipped > 0 ? ` (${data.dncSkipped} DNC contact${data.dncSkipped === 1 ? "" : "s"} skipped)` : "";
      toast({ title: `${enrolled} contact${enrolled === 1 ? "" : "s"} enrolled${dncNote}` });
      setSelected(new Set());
      onClose();
    },
    onError: () => toast({ title: "Failed to enroll contacts", variant: "destructive" }),
  });

  const unenrolled = contacts.filter(c => !enrolledIds.has(c.id));
  const filtered = unenrolled.filter(c =>
    fullName(c).toLowerCase().includes(search.toLowerCase()) ||
    (c.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (c.title ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.id)));
    }
  };

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleClose = () => {
    setSelected(new Set());
    setSearch("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Add Contacts to Play</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 text-xs pl-8"
              autoFocus
            />
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : isContactsError ? (
            <p className="text-xs text-destructive text-center py-6">
              Failed to load contacts. Please try again.
            </p>
          ) : contacts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No contacts found for this client yet.
            </p>
          ) : unenrolled.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              All contacts for this client are already enrolled.
            </p>
          ) : (
            <>
              {filtered.length > 0 && (
                <div className="flex items-center justify-between px-1">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    {selected.size === filtered.length ? "Deselect all" : `Select all (${filtered.length})`}
                  </button>
                  {selected.size > 0 && (
                    <span className="text-[11px] text-muted-foreground">{selected.size} selected</span>
                  )}
                </div>
              )}
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {filtered.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No contacts found</p>
                ) : (
                  filtered.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn(
                        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors",
                        selected.has(c.id) ? "bg-indigo-50 border border-indigo-200" : "hover:bg-muted/60 border border-transparent",
                      )}
                    >
                      <div className={cn(
                        "w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                        selected.has(c.id) ? "bg-indigo-600 border-indigo-600" : "border-border",
                      )}>
                        {selected.has(c.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-semibold shrink-0">
                        {initials(c)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{fullName(c)}</p>
                        {c.email && <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>}
                      </div>
                      <ScoreBadge score={c.leadScore} size="sm" />
                    </button>
                  ))
                )}
              </div>
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={selected.size === 0 || enrollMutation.isPending}
                  onClick={() => enrollMutation.mutate(Array.from(selected))}
                >
                  {enrollMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Enroll {selected.size > 0 ? selected.size : ""} Contact{selected.size !== 1 ? "s" : ""}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ContactsTab({ playId, clientId }: { playId: number; clientId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [search, setSearch] = useState("");

  const { data: contacts = [], isLoading, isError } = useQuery<EnrolledContact[]>({
    queryKey: ["plays", playId, "contacts"],
    queryFn: async () => {
      const r = await api(`/plays/${playId}/contacts`);
      if (!r.ok) throw new Error(`Failed to load contacts (${r.status})`);
      return r.json();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (contactId: number) => {
      const r = await api(`/plays/${playId}/contacts/${contactId}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plays", playId, "contacts"] });
      qc.invalidateQueries({ queryKey: ["plays", String(playId)] });
      toast({ title: "Contact removed" });
    },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const enrolledIds = new Set(contacts.map(c => c.id));

  const filtered = contacts.filter(c =>
    fullName(c).toLowerCase().includes(search.toLowerCase()) ||
    (c.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (c.title ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center">
        <p className="text-sm text-muted-foreground">Failed to load contacts. Please try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {contacts.length === 0
            ? "No contacts enrolled yet."
            : `${contacts.length} contact${contacts.length === 1 ? "" : "s"} enrolled`}
        </p>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 shrink-0" onClick={() => setShowAddDialog(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add Contacts
        </Button>
      </div>

      {contacts.length > 0 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search enrolled contacts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-xs pl-8"
          />
        </div>
      )}

      {contacts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Users className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium text-foreground mb-1">No contacts enrolled</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Add contacts from this play's client to start tracking engagement.
          </p>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add Contacts
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-6">No contacts match your search.</p>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(c => (
            <div
              key={c.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-background group"
            >
              <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                {initials(c)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{fullName(c)}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {c.email && <span className="text-[11px] text-muted-foreground truncate">{c.email}</span>}
                  {c.title && <span className="text-[11px] text-muted-foreground">· {c.title}</span>}
                </div>
              </div>
              <ScoreBadge score={c.leadScore} size="sm" />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove from play"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate(c.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AddContactsDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        playId={playId}
        clientId={clientId}
        enrolledIds={enrolledIds}
      />
    </div>
  );
}

// ── Linked Journeys Tab ───────────────────────────────────────────────────────
function LinkedJourneysTab({ playId, clientId }: { playId: number; clientId: number }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showLinkDialog, setShowLinkDialog] = useState(false);

  const { data: journeys = [], isLoading, isError } = useQuery<LinkedJourneyRow[]>({
    queryKey: ["plays", playId, "journeys"],
    queryFn: async () => {
      const r = await api(`/plays/${playId}/journeys`);
      if (!r.ok) throw new Error(`Failed to load journeys (${r.status})`);
      return r.json();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (journeyId: number) => {
      const r = await api(`/journeys/${journeyId}/plays/${playId}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plays", playId, "journeys"] });
      qc.invalidateQueries({ queryKey: ["journeys"] });
      toast({ title: "Journey unlinked" });
    },
    onError: () => toast({ title: "Failed to unlink journey", variant: "destructive" }),
  });

  const linkedIds = new Set(journeys.map(j => j.id));

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center">
        <p className="text-sm text-muted-foreground">Failed to load linked journeys. Please try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {journeys.length === 0
            ? "No journeys linked to this play yet."
            : `${journeys.length} ${journeys.length === 1 ? "journey" : "journeys"} linked`}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs gap-1.5"
          onClick={() => setShowLinkDialog(true)}
        >
          <Link2 className="w-3.5 h-3.5" />
          Link Journey
        </Button>
      </div>

      {journeys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Map className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-sm font-medium text-foreground mb-1">No journeys linked</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Link a content journey to this play to track page engagement and conversions.
          </p>
          <Button size="sm" onClick={() => setShowLinkDialog(true)}>
            <Link2 className="w-3.5 h-3.5 mr-1.5" />
            Link Journey
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {journeys.map(j => {
            const statusCfg = JOURNEY_STATUS_CONFIG[j.status] ?? JOURNEY_STATUS_CONFIG.draft;
            return (
              <div
                key={j.id}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-background group"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/journeys/${j.id}`)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                    <Map className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate group-hover:text-indigo-600 transition-colors">
                      {j.name}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {j.clientName && (
                        <span className="text-[11px] text-muted-foreground">{j.clientName}</span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {j.pageCount} {j.pageCount === 1 ? "page" : "pages"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {j.totalViews.toLocaleString()} views
                      </span>
                    </div>
                  </div>
                </button>
                <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border shrink-0", statusCfg.classes)}>
                  {statusCfg.label}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0"
                  title="Open in builder"
                  onClick={() => navigate(`/journeys/${j.id}`)}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                  title="Unlink journey"
                  disabled={unlinkMutation.isPending}
                  onClick={() => unlinkMutation.mutate(j.id)}
                >
                  {unlinkMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <LinkJourneyDialog
        open={showLinkDialog}
        onClose={() => setShowLinkDialog(false)}
        playId={playId}
        clientId={clientId}
        linkedJourneyIds={linkedIds}
      />
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
interface PlayDetailPageProps { id: string }

export default function PlayDetailPage({ id }: PlayDetailPageProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState(() => {
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("tab");
      if (param) return param;
    }
    return "overview";
  });

  const { data: play, isLoading } = useQuery<Play>({
    queryKey: ["plays", id],
    queryFn: () => api(`/plays/${id}`).then(r => r.json()),
  });

  const { data: linkedJourneys = [] } = useQuery<LinkedJourneyRow[]>({
    queryKey: ["plays", Number(id), "journeys"],
    queryFn: async () => {
      const r = await api(`/plays/${id}/journeys`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!play,
  });

  const { data: linkedSequences = [] } = useQuery<Array<{ id: number; name: string; playId: number | null; stepCount: number }>>({
    queryKey: ["plays", Number(id), "sequences"],
    queryFn: async () => {
      const r = await api(`/email-sequences`);
      if (!r.ok) return [];
      const all = await r.json();
      return all.filter((s: any) => s.playId === Number(id));
    },
    enabled: !!play,
  });
  const primarySequence = linkedSequences[0];

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      api(`/plays/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plays", id] });
      qc.invalidateQueries({ queryKey: ["plays"] });
      toast({ title: "Status updated" });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!play) return <div className="p-6 text-sm text-muted-foreground text-center">Play not found.</div>;

  const statusCfg = STATUS_CONFIG[play.status] ?? STATUS_CONFIG.draft;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3 mb-6">
        <Button variant="ghost" size="icon" className="h-8 w-8 mt-0.5" onClick={() => navigate("/plays")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-foreground tracking-tight">{play.name}</h1>
            <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", statusCfg.classes)}>
              {statusCfg.label}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {play.clientName && <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {play.clientName}</span>}
            {(play.startDate || play.endDate) && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {play.startDate && format(new Date(play.startDate), "MMM d")}
                {play.startDate && play.endDate && " – "}
                {play.endDate && format(new Date(play.endDate), "MMM d, yyyy")}
              </span>
            )}
            <span className="text-muted-foreground/60">Created {format(new Date(play.createdAt), "MMM d, yyyy")}</span>
          </div>
        </div>
        <Select value={play.status} onValueChange={v => statusMutation.mutate(v)}>
          <SelectTrigger className="h-8 text-xs w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map(s => <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: "Page Views",  value: play.pageViews,         icon: Eye,   color: "text-indigo-600", bg: "bg-indigo-50" },
          { label: "Enrolled",    value: play.contactsEnrolled,  icon: Users, color: "text-violet-600", bg: "bg-violet-50" },
          { label: "Emails Sent", value: play.emailsSent,        icon: Mail,  color: "text-sky-600",    bg: "bg-sky-50" },
          { label: "Status",      value: statusCfg.label,        icon: Zap,   color: "text-emerald-600",bg: "bg-emerald-50" },
        ].map(kpi => (
          <Card key={kpi.label} className="shadow-xs">
            <CardContent className="pt-3 pb-3 px-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{kpi.label}</p>
                  <p className="text-lg font-bold text-foreground mt-0.5">{kpi.value}</p>
                </div>
                <div className={`w-8 h-8 rounded-lg ${kpi.bg} flex items-center justify-center`}>
                  <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-8 text-xs">
          <TabsTrigger value="overview"  className="text-xs gap-1.5"><Zap className="w-3 h-3" /> Overview</TabsTrigger>
          <TabsTrigger value="analytics" className="text-xs gap-1.5"><BarChart2 className="w-3 h-3" /> Analytics</TabsTrigger>
          <TabsTrigger value="journeys"  className="text-xs gap-1.5"><Map className="w-3 h-3" /> Journeys {linkedJourneys.length > 0 && <span className="ml-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-semibold px-1.5 py-0.5 rounded-full">{linkedJourneys.length}</span>}</TabsTrigger>
          <TabsTrigger value="sequence"  className="text-xs gap-1.5"><GitBranch className="w-3 h-3" /> Sequence</TabsTrigger>
          <TabsTrigger value="contacts"  className="text-xs gap-1.5"><Users className="w-3 h-3" /> Contacts {play.contactsEnrolled > 0 && <span className="ml-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-semibold px-1.5 py-0.5 rounded-full">{play.contactsEnrolled}</span>}</TabsTrigger>
          <TabsTrigger value="activity"  className="text-xs gap-1.5"><Activity className="w-3 h-3" /> Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {play.description && (
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm text-foreground">{play.description}</p>
              </CardContent>
            </Card>
          )}
          {play.targetAudience && (
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Target Audience</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm text-foreground">{play.targetAudience}</p>
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-4">
            {/* Journeys summary card */}
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Journeys</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                      <Map className="w-4 h-4 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-lg font-bold text-foreground leading-none">
                        {linkedJourneys.length}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {linkedJourneys.length === 1 ? "journey linked" : "journeys linked"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs shrink-0"
                    onClick={() => setTab("journeys")}
                  >
                    Manage
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Sequence card */}
            <Card className="shadow-xs">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sequence</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex items-center justify-between gap-2">
                  {primarySequence ? (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                          <GitBranch className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => setTab("sequence")}
                            className="text-sm font-medium text-foreground truncate hover:text-indigo-600 hover:underline text-left leading-none"
                          >
                            {primarySequence.name}
                          </button>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {primarySequence.stepCount} {primarySequence.stepCount === 1 ? "step" : "steps"}
                          </p>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => setTab("sequence")}>Manage</Button>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">No sequence linked</p>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setTab("sequence")}>Link</Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <AnalyticsTab playId={Number(id)} />
        </TabsContent>

        <TabsContent value="journeys" className="mt-4">
          <LinkedJourneysTab playId={Number(id)} clientId={play.clientId} />
        </TabsContent>

        <TabsContent value="contacts" className="mt-4">
          <ContactsTab playId={Number(id)} clientId={play.clientId} />
        </TabsContent>

        {["sequence", "activity"].map(t => (
          <TabsContent key={t} value={t} className="mt-4">
            <div className="rounded-lg border border-dashed border-border p-12 text-center">
              {t === "sequence"  && <GitBranch className="w-8 h-8 text-muted-foreground mx-auto mb-3" />}
              {t === "activity"  && <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-3" />}
              <h3 className="text-sm font-medium text-foreground mb-1 capitalize">{t}</h3>
              <p className="text-xs text-muted-foreground">
                {t === "sequence" && "Link an Email Sequence to track outreach"}
                {t === "activity" && "Activity timeline will appear here"}
              </p>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
