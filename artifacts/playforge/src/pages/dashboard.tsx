import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Building2, Zap, Users, Mail, FileText, TrendingUp,
  ArrowUpRight, ArrowDownRight, Minus, Activity, Target,
  Flame, Star, Copy, Check, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { Link } from "wouter";

const api = async (path: string) => {
  const response = await fetch(`/api${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
};

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  email_open:          { label: "Email opened",      color: "text-blue-500" },
  email_click:         { label: "Link clicked",      color: "text-indigo-500" },
  page_view:           { label: "Page viewed",       color: "text-violet-500" },
  video_half_watched:  { label: "Video 50%",         color: "text-amber-500" },
  video_completed:     { label: "Video completed",   color: "text-orange-500" },
  asset_download:      { label: "Asset downloaded",  color: "text-teal-500" },
  form_submit:         { label: "Form submitted",    color: "text-emerald-500" },
  email_bounced:       { label: "Email bounced",     color: "text-red-500" },
  inactivity_30d:      { label: "Inactivity 30d",    color: "text-gray-400" },
};

const STATUS_DOT: Record<string, string> = {
  active:   "bg-emerald-500",
  draft:    "bg-gray-400",
  paused:   "bg-amber-400",
  archived: "bg-red-400",
};

function TrendBadge({ pct }: { pct: number }) {
  if (pct === 0) return <span className="text-xs text-muted-foreground flex items-center gap-0.5"><Minus className="w-3 h-3" /> no change</span>;
  if (pct > 0)   return <span className="text-xs text-emerald-600 flex items-center gap-0.5"><ArrowUpRight className="w-3 h-3" /> +{pct}%</span>;
  return <span className="text-xs text-destructive flex items-center gap-0.5"><ArrowDownRight className="w-3 h-3" /> {pct}%</span>;
}

function KpiSkeleton() {
  return (
    <Card className="shadow-xs">
      <CardContent className="pt-4 pb-4 px-4">
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-7 w-16 mb-2" />
        <Skeleton className="h-3 w-28" />
      </CardContent>
    </Card>
  );
}

/* ── Top Opportunities helpers ─────────────────────────────────────────────── */

interface TopOpportunity {
  call_log_id: number;
  contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  sentiment: string | null;
  interest_score: number;
  follow_up_message: string | null;
}

function MiniInterestBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const col = score >= 8 ? "bg-emerald-500" : score >= 7 ? "bg-green-400" : "bg-amber-400";
  return (
    <div className="flex items-center gap-1 shrink-0">
      <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${col}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-bold tabular-nums text-slate-600">{score}/10</span>
    </div>
  );
}

function MiniSentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;
  const map: Record<string, { emoji: string; cls: string }> = {
    positive: { emoji: "😊", cls: "text-emerald-700" },
    neutral:  { emoji: "😐", cls: "text-slate-500"   },
    negative: { emoji: "😞", cls: "text-red-600"     },
  };
  const m = map[sentiment] ?? { emoji: "•", cls: "text-gray-500" };
  return (
    <span className={`text-[11px] shrink-0 ${m.cls}`} title={sentiment}>
      {m.emoji}
    </span>
  );
}

function MiniCopyFollowUpButton({ message }: { message: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!message) return null;
  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };
  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy follow-up message"}
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-semibold transition-colors whitespace-nowrap shrink-0",
        copied
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
      )}
    >
      {copied ? <Check size={9} /> : <Copy size={9} />}
      {copied ? "Copied!" : "Copy follow-up"}
    </button>
  );
}

/* ── Dashboard ─────────────────────────────────────────────────────────────── */

export default function DashboardPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["analytics", "dashboard", "summary"],
    queryFn: () => api("/analytics/dashboard/summary"),
    refetchInterval: 30_000,
  });
  const summarySettled = !!data || isError;
  const { data: panels, isPending: panelsPending, isError: panelsError } = useQuery({
    queryKey: ["analytics", "dashboard", "panels"],
    queryFn: () => api("/analytics/dashboard/panels"),
    enabled: summarySettled,
    refetchInterval: 60_000,
  });

  const { data: oppData, isPending: oppPending, isError: oppError } = useQuery<{ opportunities: TopOpportunity[] }>({
    queryKey: ["analytics", "top-opportunities-dashboard"],
    queryFn: () => api("/analytics/calls/top-opportunities?limit=3"),
    enabled: summarySettled && (!panelsPending || panelsError),
    refetchInterval: 60_000,
  });

  const opportunities = oppData?.opportunities ?? [];

  const kpiCards = [
    {
      label: "Total Clients", value: data?.totalClients ?? 0, icon: Building2,
      color: "text-indigo-600", iconBg: "bg-indigo-50",
      trendPct: 0, sub: "Active accounts",
    },
    {
      label: "Active Plays", value: data?.activePlays ?? 0, icon: Zap,
      color: "text-violet-600", iconBg: "bg-violet-50",
      trendPct: 0, sub: "Running campaigns",
    },
    {
      label: "Total Contacts", value: data?.totalContacts ?? 0, icon: Users,
      color: "text-sky-600", iconBg: "bg-sky-50",
      trendPct: data?.trends?.contacts ?? 0, sub: "Across all clients",
    },
    {
      label: "Emails Sent", value: data?.emailsSentThisMonth ?? 0, icon: Mail,
      color: "text-emerald-600", iconBg: "bg-emerald-50",
      trendPct: 0, sub: "This month",
    },
    {
      label: "Form Submissions", value: data?.formSubmissions ?? 0, icon: FileText,
      color: "text-orange-600", iconBg: "bg-orange-50",
      trendPct: data?.trends?.formSubs ?? 0, sub: "Journey conversions",
    },
    {
      label: "Hot Leads", value: data?.hotLeads ?? 0, icon: Flame,
      color: "text-rose-600", iconBg: "bg-rose-50",
      trendPct: data?.trends?.hotLeads ?? 0, sub: "Score ≥ 50",
    },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Overview of your ABM workspace activity</p>
      </div>
      {isError && <p role="alert" className="text-sm text-destructive">Could not load dashboard totals. Please refresh to try again.</p>}

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading || isError
          ? Array.from({ length: 6 }).map((_, i) => <KpiSkeleton key={i} />)
          : kpiCards.map(card => {
              const Icon = card.icon;
              return (
                <Card key={card.label} className="bg-card border shadow-xs hover:shadow-sm transition-shadow">
                  <CardHeader className="flex flex-row items-start justify-between pb-2 pt-4 px-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{card.label}</p>
                    <div className={`w-8 h-8 rounded-lg ${card.iconBg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-4 h-4 ${card.color}`} />
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="text-2xl font-bold text-foreground tracking-tight">
                      {typeof card.value === "number" ? card.value.toLocaleString() : card.value}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <TrendBadge pct={card.trendPct} />
                      <span className="text-xs text-muted-foreground">· {card.sub}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* Top Opportunities panel */}
      <Card className="shadow-xs border-2 border-emerald-200 bg-gradient-to-br from-emerald-50/50 to-white">
        <CardHeader className="px-0 py-0">
          <div className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-4 py-2.5 rounded-t-[calc(var(--radius)-2px)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Star size={14} className="text-yellow-300 fill-yellow-300" />
              <CardTitle className="text-sm font-semibold text-white">Top Opportunities</CardTitle>
              <span className="text-[10px] text-emerald-100 font-medium ml-1">Interest score ≥ 7 — act now</span>
            </div>
            <Link
              href="/analytics?section=calls"
              className="flex items-center gap-1 text-[10px] text-emerald-100 hover:text-white font-medium transition-colors"
            >
              View all <ExternalLink size={10} />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
           {oppPending ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <div className="flex-1 space-y-1">
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-2 w-24" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-16" />
                </div>
              ))}
            </div>
           ) : oppError ? (
             <p role="alert" className="p-4 text-xs text-destructive">Could not load top opportunities.</p>
           ) : opportunities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-1.5">
              <Star size={20} className="text-emerald-300" />
              <p className="text-sm font-medium">No high-interest calls yet</p>
              <p className="text-xs text-center max-w-xs">
                Calls with an LLM interest score of 7 or higher will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-emerald-100">
              {opportunities.slice(0, 3).map((opp, idx) => {
                const name = [opp.first_name, opp.last_name].filter(Boolean).join(" ") || opp.email || "Unknown";
                const rankColors = ["text-yellow-500", "text-slate-400", "text-amber-600"];
                return (
                  <div
                    key={opp.call_log_id}
                    className="px-4 py-2.5 flex items-center gap-3 hover:bg-emerald-50/60 transition-colors"
                  >
                    {/* Rank */}
                    <span className={cn("text-sm font-black tabular-nums w-4 shrink-0", rankColors[idx] ?? "text-slate-300")}>
                      #{idx + 1}
                    </span>

                    {/* Avatar */}
                    <div className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {name[0]?.toUpperCase() ?? "?"}
                    </div>

                    {/* Name + company */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">{name}</p>
                      {opp.company_name && (
                        <p className="text-[11px] text-muted-foreground truncate">{opp.company_name}</p>
                      )}
                    </div>

                    {/* Interest bar */}
                    <MiniInterestBar score={opp.interest_score} />

                    {/* Sentiment */}
                    <MiniSentimentBadge sentiment={opp.sentiment} />

                    {/* Copy follow-up */}
                    <MiniCopyFollowUpButton message={opp.follow_up_message} />
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bottom row: Top Plays + Activity Feed + Accounts to Watch */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Top Plays */}
        <Card className="shadow-xs">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-violet-600" /> Top Plays
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {panelsPending ? (
              <div className="space-y-2.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : panelsError ? (
              <p role="alert" className="text-xs text-destructive py-4">Could not load top plays.</p>
            ) : (panels?.topPlays ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No plays yet</p>
            ) : (
              <div className="space-y-1">
                {(panels?.topPlays ?? []).map((p: any, i: number) => (
                  <div key={p.id} className="flex items-center gap-2 py-1.5">
                    <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{p.name}</p>
                      <p className="text-[11px] text-muted-foreground">{p.pageViews.toLocaleString()} views · {p.contactsEnrolled} enrolled</p>
                    </div>
                    <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[p.status] ?? "bg-gray-300")} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card className="shadow-xs">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-600" /> Live Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {panelsPending ? (
              <div className="space-y-2.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
            ) : panelsError ? (
              <p role="alert" className="text-xs text-destructive py-4">Could not load recent activity.</p>
            ) : (panels?.activityFeed ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No activity yet</p>
            ) : (
              <div className="space-y-0 divide-y divide-border">
                {(panels?.activityFeed ?? []).slice(0, 8).map((ev: any) => {
                  const cfg = EVENT_LABELS[ev.eventType] ?? { label: ev.eventType, color: "text-muted-foreground" };
                  return (
                    <div key={ev.id} className="py-2 flex items-start gap-2.5">
                      <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", cfg.color.replace("text-", "bg-"))} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground font-medium truncate">{ev.contactName}</p>
                        <p className={cn("text-[11px]", cfg.color)}>{cfg.label}</p>
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Accounts to Watch */}
        <Card className="shadow-xs">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Target className="w-4 h-4 text-rose-600" /> Accounts to Watch
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {panelsPending ? (
              <div className="space-y-2.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : panelsError ? (
              <p role="alert" className="text-xs text-destructive py-4">Could not load accounts to watch.</p>
            ) : (panels?.accountsToWatch ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No accounts yet</p>
            ) : (
              <div className="space-y-1">
                {(panels?.accountsToWatch ?? []).map((acc: any) => {
                  const score = Math.round(acc.avg_score);
                  const heat = score >= 75 ? "text-red-600 bg-red-50" : score >= 50 ? "text-orange-600 bg-orange-50" : score >= 25 ? "text-blue-600 bg-blue-50" : "text-gray-600 bg-gray-50";
                  return (
                    <div key={acc.id} className="flex items-center gap-2 py-1.5">
                      <div className="w-6 h-6 rounded bg-slate-100 text-slate-600 flex items-center justify-center text-xs font-semibold shrink-0">
                        {acc.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{acc.name}</p>
                        <p className="text-[11px] text-muted-foreground">{acc.contact_count} contacts</p>
                      </div>
                      <span className={cn("text-[11px] font-semibold px-1.5 py-0.5 rounded-full", heat)}>
                        {score}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
