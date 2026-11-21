import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft, Building2, Globe, Users, FileText, Eye, Mail, Loader2, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScoreBadge } from "@/components/ScoreBadge";
import { formatDistanceToNow, format } from "date-fns";
import EngagementHistory from "@/components/EngagementHistory";
import DemoEngagementHistory from "@/components/demo-engagement/DemoEngagementHistory";
import { cn } from "@/lib/utils";

const getJson = (path: string) => fetch(`/api${path}`, { credentials: "include" }).then(r => r.json());

const STAGE_LABELS: Record<string, string> = {
  "pre-aware": "Pre-Aware", "aware": "Aware", "pre-engage": "Pre-Engage",
  "engage": "Engage", "advance-engage": "Adv-Engage", "action": "Action",
};
const STAGE_COLORS: Record<string, string> = {
  "pre-aware": "bg-slate-100 text-slate-700",
  "aware": "bg-blue-100 text-blue-700",
  "pre-engage": "bg-violet-100 text-violet-700",
  "engage": "bg-emerald-100 text-emerald-700",
  "advance-engage": "bg-amber-100 text-amber-700",
  "action": "bg-rose-100 text-rose-700",
};
const STAGE_DOT: Record<string, string> = {
  "pre-aware": "#94a3b8", "aware": "#60a5fa", "pre-engage": "#a78bfa",
  "engage": "#34d399", "advance-engage": "#f59e0b", "action": "#f43f5e",
};
const EVENT_ICONS: Record<string, string> = {
  email_open: "📧", email_click: "🔗", page_view: "👁", asset_download: "📥", form_submit: "📝",
};
const EVENT_LABELS: Record<string, string> = {
  email_open: "Email opened", email_click: "Link clicked",
  page_view: "Page viewed", asset_download: "Asset downloaded",
  form_submit: "Form submitted",
};

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold", STAGE_COLORS[stage] ?? "bg-gray-100 text-gray-700")}>
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

type Play = { id: number; name: string; status: string };
type Journey = { id: number; name: string; status: string };

interface Props { id?: string }

export default function CompanyDetailPage({ id }: Props) {
  const [, navigate] = useLocation();
  const companyId = parseInt(id ?? "");
  const [playFilter, setPlayFilter] = useState("all");
  const [journeyFilter, setJourneyFilter] = useState("all");

  const { data, isLoading } = useQuery({
    queryKey: ["company-analytics", companyId, playFilter, journeyFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (playFilter !== "all") params.set("playId", playFilter);
      if (journeyFilter !== "all") params.set("journeyId", journeyFilter);
      const qs = params.toString();
      return getJson(`/companies/${companyId}/analytics${qs ? `?${qs}` : ""}`);
    },
    enabled: !isNaN(companyId),
  });
  const { data: thresholds = [] } = useQuery<any[]>({
    queryKey: ["score-thresholds"],
    queryFn: () => getJson("/score-thresholds"),
  });
  const { data: plays = [] } = useQuery<Play[]>({
    queryKey: ["plays-list"],
    queryFn: () => getJson("/plays"),
  });
  const { data: journeys = [] } = useQuery<Journey[]>({
    queryKey: ["journeys-list"],
    queryFn: () => getJson("/journeys"),
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!data?.company) {
    return <div className="p-6 text-muted-foreground">Company not found.</div>;
  }

  const { company, contacts, activities, stageDist, firstEngagement, kpi } = data;
  const initials = (name: string) => name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 shrink-0">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/crm/companies")} className="mt-0.5 shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="w-12 h-12 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center text-lg font-bold shrink-0">
            {initials(company.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight">{company.name}</h1>
              {company.industry && <Badge variant="outline" className="text-xs">{company.industry}</Badge>}
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
              {company.domain && (
                <a href={`https://${company.domain}`} target="_blank" rel="noopener"
                  className="flex items-center gap-1 text-indigo-600 hover:underline text-sm">
                  <Globe className="w-3 h-3" />{company.domain}
                </a>
              )}
              {company.size && <span className="flex items-center gap-1">{company.size} employees</span>}
              {firstEngagement && (
                <span className="flex items-center gap-1 text-xs">
                  First engaged {format(new Date(firstEngagement), "MMM d, yyyy")}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="border-b bg-muted/30 px-6 py-3 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Contacts", value: kpi.totalContacts, icon: Users, color: "text-indigo-600" },
            { label: "Page Views", value: kpi.pageViews, icon: Eye, color: "text-sky-600" },
            { label: "Email Opens", value: kpi.emailOpens, icon: Mail, color: "text-violet-600" },
            { label: "Form Fills", value: kpi.formFills, icon: FileText, color: "text-emerald-600" },
          ].map(k => (
            <div key={k.label} className="flex items-center gap-2">
              <k.icon className={cn("w-4 h-4 shrink-0", k.color)} />
              <div>
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className="text-sm font-bold">{k.value}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="contacts" className="h-full flex flex-col">
          <TabsList className="px-6 bg-card border-b rounded-none justify-start h-auto gap-0 shrink-0">
            {[
              { value: "contacts", label: `Contacts (${(contacts as any[]).length})`, icon: Users },
              { value: "activity", label: "Activity Feed", icon: Activity },
              { value: "qualification", label: "Qualification & History", icon: Activity },
            ].map(t => (
              <TabsTrigger key={t.value} value={t.value}
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-600 data-[state=active]:shadow-none px-4 py-3 text-sm">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Contacts tab */}
          <TabsContent value="contacts" className="flex-1 overflow-auto p-6 mt-0">
            <DemoEngagementHistory companyId={companyId} />
            <div className="space-y-4">
              {/* Play / Journey filters */}
              <div className="flex items-center gap-3 flex-wrap">
                <Select value={playFilter} onValueChange={v => { setPlayFilter(v); setJourneyFilter("all"); }}>
                  <SelectTrigger className="h-8 text-sm w-40">
                    <SelectValue placeholder="All plays" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All plays</SelectItem>
                    {plays.map((p: Play) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={journeyFilter} onValueChange={setJourneyFilter}>
                  <SelectTrigger className="h-8 text-sm w-44">
                    <SelectValue placeholder="All journeys" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All journeys</SelectItem>
                    {journeys.map((j: Journey) => <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {(playFilter !== "all" || journeyFilter !== "all") && (
                  <button
                    className="text-xs text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
                    onClick={() => { setPlayFilter("all"); setJourneyFilter("all"); }}
                  >
                    Clear filters
                  </button>
                )}
                {journeyFilter !== "all" && (
                  <span className="text-xs text-indigo-600 font-medium bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
                    Showing journey scores
                  </span>
                )}
              </div>

              {/* Stage distribution mini */}
              {(stageDist as any[]).length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-muted-foreground font-medium">Stage mix:</span>
                  {(stageDist as any[]).map((s: any) => (
                    <div key={s.stage} className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full" style={{ background: STAGE_DOT[s.stage] }} />
                      <span className="text-xs text-muted-foreground">{STAGE_LABELS[s.stage] ?? s.stage}: <strong>{s.count}</strong></span>
                    </div>
                  ))}
                </div>
              )}

              <div className="border rounded-lg overflow-hidden bg-card">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Contact</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Title</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Stage</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">
                        {journeyFilter !== "all" ? (
                          <span className="text-indigo-600">Journey Score</span>
                        ) : "Score"}
                      </th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">Events</th>
                      <th className="text-left text-xs font-medium text-muted-foreground py-2.5 px-4">First Engaged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(contacts as any[]).map((c: any) => (
                      <tr key={c.id}
                        className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => navigate(`/crm/contacts/${c.id}`)}>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                              {c.first_name?.[0]}{c.last_name?.[0]}
                            </div>
                            <div>
                              <p className="text-sm font-medium">{c.first_name} {c.last_name}</p>
                              <p className="text-[11px] text-muted-foreground">{c.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-sm text-muted-foreground">{c.title ?? "—"}</td>
                        <td className="py-3 px-4"><StageBadge stage={c.stage ?? "pre-aware"} /></td>
                        <td className="py-3 px-4">
                          {journeyFilter !== "all" ? (
                            <span className="inline-flex items-center gap-1 rounded-full font-medium px-2 py-0.5 text-xs bg-indigo-50 text-indigo-700">
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                              {c.journey_score ?? 0} pts
                            </span>
                          ) : (
                            <ScoreBadge score={c.lead_score} thresholds={thresholds} />
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">{c.activity_count}</td>
                        <td className="py-3 px-4 text-[11px] text-muted-foreground">
                          {c.first_engagement ? formatDistanceToNow(new Date(c.first_engagement), { addSuffix: true }) : "—"}
                        </td>
                      </tr>
                    ))}
                    {(contacts as any[]).length === 0 && (
                      <tr><td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No contacts found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="qualification" className="flex-1 overflow-auto p-6 mt-0">
            <div className="max-w-4xl"><EngagementHistory key={`co-${companyId}`} target={{ companyId }} /></div>
          </TabsContent>

          {/* Activity Feed tab */}
          <TabsContent value="activity" className="flex-1 overflow-auto p-6 mt-0">
            <div className="space-y-1 max-w-3xl">
              {(activities as any[]).length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-12">No activity recorded yet</div>
              )}
              {(activities as any[]).map((a: any) => (
                <div key={a.id} className="flex items-start gap-3 py-2.5 border-b last:border-0">
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-base shrink-0">
                    {EVENT_ICONS[a.event_type] ?? "•"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{a.description}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}</span>
                      {a.page_name && <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded">{a.page_name}</span>}
                      {a.stage && <StageBadge stage={a.stage} />}
                      {a.score_delta != null && a.score_delta > 0 && (
                        <span className="text-xs font-medium text-emerald-600">+{a.score_delta} pts</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
